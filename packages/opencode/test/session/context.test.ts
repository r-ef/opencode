import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session.context", () => {
  test("lists context by cursor id when timestamps match", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const left = await Session.branch({ sessionID: root.id })
        const right = await Session.branch({ sessionID: root.id })
        const prev = Date.now
        using _ = {
          [Symbol.dispose]() {
            Date.now = prev
          },
        }
        Date.now = () => 123

        const a = await Session.contextWrite({
          session_id: left.id,
          kind: "task_result",
          title: "a",
          body: "first",
        })
        const b = await Session.contextWrite({
          session_id: left.id,
          kind: "task_result",
          title: "b",
          body: "second",
        })
        const rows = await Session.contextList({
          session_id: right.id,
          after: 0,
          limit: 10,
          include_self: true,
        })

        expect(rows.map((row) => row.id)).toEqual([a.id, b.id])
        expect(rows.map((row) => row.data.body)).toEqual(["first", "second"])
      },
    })
  })

  test("stores consumed cursor after prompt injection", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const left = await Session.branch({ sessionID: root.id })
        const right = await Session.branch({ sessionID: root.id })

        const a = await Session.contextWrite({
          session_id: left.id,
          kind: "task_result",
          title: "left done",
          body: "first update",
        })
        const b = await Session.contextWrite({
          session_id: left.id,
          kind: "task_result",
          title: "left done again",
          body: "second update",
        })

        const msg = await SessionPrompt.prompt({
          sessionID: right.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "continue" }],
        })
        if (msg.info.role !== "user") throw new Error("expected user message")

        const text = msg.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(text).toContain(`context=${a.id}`)
        expect(text).toContain(`context=${b.id}`)

        const state = await Session.contextState(right.id)
        expect(state.cursor).toBe(b.id)

        const next = await SessionPrompt.prompt({
          sessionID: right.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "continue again" }],
        })
        if (next.info.role !== "user") throw new Error("expected user message")

        const body = next.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(body).not.toContain("Shared session context updates:")
      },
    })
  })

  test("reconciles and trims acknowledged context safely", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const left = await Session.branch({ sessionID: root.id })
        const right = await Session.branch({ sessionID: root.id })

        const a = await Session.contextWrite({
          session_id: left.id,
          kind: "task_result",
          title: "a",
          body: "first",
        })
        const b = await Session.contextWrite({
          session_id: left.id,
          kind: "task_error",
          title: "b",
          body: "second",
        })
        const c = await Session.contextReconcile({
          session_id: right.id,
          sources: [a.id, b.id],
          strategy: "summary",
          body: "Use the combined conclusion.",
        })

        await Session.contextMark({
          session_id: right.id,
          cursor: c.id,
        })

        const trim = await Session.contextTrim({
          session_id: right.id,
          limit: 1,
          buffer: 0,
          force: true,
        })
        const rows = await Session.contextList({
          session_id: right.id,
          after: 0,
          limit: 10,
          include_self: true,
        })

        expect(trim.deleted).toBe(2)
        expect(rows.map((row) => row.id)).toEqual([c.id])
        expect(rows[0]?.data.kind).toBe("context_resolution")
      },
    })
  })
})

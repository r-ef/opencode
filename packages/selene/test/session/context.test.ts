import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { TaskRun } from "../../src/task/run"

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

  test("injects directed coordination only into the targeted sibling and stores its cursor", async () => {
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
        const other = await Session.branch({ sessionID: root.id })

        const row = await Session.coordinationWrite({
          session_id: left.id,
          target_session_id: right.id,
          kind: "request",
          title: "Need review",
          body: "Check parser edge cases.",
          request_id: "req_parser",
        })

        const hit = await Session.messages({ sessionID: right.id }).then((rows) => rows.findLast((item) => item.info.role === "user"))
        if (!hit || hit.info.role !== "user") throw new Error("expected user message")
        const text = hit.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(text).toContain("Agent collaboration updates:")
        expect(text).toContain("Sibling request")
        expect(text).toContain("Need review")
        expect(text).toContain("Check parser edge cases.")

        const state = await Session.coordinationState(right.id)
        expect(state.cursor).toBe(row.id)

        const miss = await Session.messages({ sessionID: other.id }).then((rows) => rows.findLast((item) => item.info.role === "user"))
        expect(miss).toBeUndefined()
      },
    })
  })

  test("routes coordination by agent and replays recent request thread context", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
          review: {
            model: "openai/gpt-5.2",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const asker = await Session.create({ parentID: root.id, title: "asker" })
        const reviewer = await Session.create({ parentID: root.id, title: "reviewer" })
        const other = await Session.create({ parentID: root.id, title: "other" })

        await SessionPrompt.prompt({
          sessionID: asker.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start asker" }],
        })
        await SessionPrompt.prompt({
          sessionID: reviewer.id,
          agent: "review",
          noReply: true,
          parts: [{ type: "text", text: "start reviewer" }],
        })
        await SessionPrompt.prompt({
          sessionID: other.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start other" }],
        })

        await TaskRun.upsert({
          session: reviewer,
          parent: root,
          description: "review work",
          prompt: "review work",
          agent: "review",
          background: true,
          model: { providerID: "openai", modelID: "gpt-5.2" },
        })
        await TaskRun.upsert({
          session: other,
          parent: root,
          description: "other work",
          prompt: "other work",
          agent: "build",
          background: true,
          model: { providerID: "openai", modelID: "gpt-5.2" },
        })

        const req = await Session.coordinationWrite({
          session_id: asker.id,
          target_agent: "review",
          kind: "request",
          title: "Review parser",
          body: "Please inspect parser edge cases.",
          request_id: "req_review",
        })

        const feed = await Session.messages({ sessionID: reviewer.id }).then((rows) =>
          rows.findLast((item) => item.info.role === "user"),
        )
        if (!feed || feed.info.role !== "user") throw new Error("expected reviewer wake")
        const wake = feed.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(wake).toContain("Agent collaboration updates:")
        expect(wake).toContain("Sibling request")
        expect(wake).toContain("Please inspect parser edge cases.")

        const miss = await Session.messages({ sessionID: other.id }).then((rows) =>
          rows.findLast((item) => item.info.role === "user"),
        )
        const body = miss?.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? ""
        expect(body).not.toContain("Agent collaboration updates:")

        await Session.coordinationWrite({
          session_id: reviewer.id,
          target_session_id: asker.id,
          kind: "answer",
          body: "Parser looks safe; null input still needs a test.",
          request_id: "req_review",
        })

        const msg = await Session.messages({ sessionID: asker.id }).then((rows) => rows.findLast((item) => item.info.role === "user"))
        if (!msg || msg.info.role !== "user") throw new Error("expected user message")
        const text = msg.parts.filter((item) => item.type === "text").map((item) => item.text).join("\n")
        expect(text).toContain("Sibling answer")
        expect(text).toContain("Parser looks safe; null input still needs a test.")
        expect(text).toContain("Sibling request")
        expect(text).toContain("Please inspect parser edge cases.")
      },
    })
  })
})

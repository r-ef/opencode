import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider/provider"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionContextBuilder } from "../../src/session/context-builder"
import { SessionMemory } from "../../src/session/memory"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function model(): Provider.Model {
  return {
    id: "gpt-5.2",
    providerID: "openai",
    name: "GPT-5.2",
    limit: {
      context: 200_000,
      input: 160_000,
      output: 32_000,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai" },
    options: {},
  } as Provider.Model
}

type Part =
  | Omit<MessageV2.TextPart, "id" | "sessionID" | "messageID">
  | Omit<MessageV2.ToolPart, "id" | "sessionID" | "messageID">
  | Omit<MessageV2.CompactionPart, "id" | "sessionID" | "messageID">

async function user(sessionID: string, text: string) {
  const msg = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    model: {
      providerID: "openai",
      modelID: "gpt-5.2",
    },
    time: {
      created: Date.now(),
    },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg as MessageV2.User
}

async function assistant(sessionID: string, parentID: string, parts: Part[], extra?: Partial<MessageV2.Assistant>) {
  const msg: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    parentID,
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: "gpt-5.2",
    providerID: "openai",
    time: {
      created: Date.now(),
    },
    finish: "stop",
    ...extra,
  }
  await Session.updateMessage(msg)
  for (const part of parts) {
    await Session.updatePart({
      ...part,
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID,
    })
  }
  return msg
}

describe("session.memory", () => {
  test("extracts durable memory from completed turns and tool results", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const turn = await user(
          session.id,
          "Fix src/app.ts. Always run bun test before finishing. Keep responses concise.",
        )
        await assistant(session.id, turn.id, [
          {
            type: "text",
            text: "Decided to update src/app.ts. Verified with bun test. Next follow up: remove the old helper.",
          },
          {
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: {
              status: "completed",
              input: { cmd: "bun test", path: "src/app.ts" },
              output: "1 pass",
              title: "bun test",
              metadata: { task_id: "ses_task", branch_id: "branch_1" },
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            },
          },
        ])

        const rows = await SessionMemory.extract({
          sessionID: session.id,
          messageID: turn.id,
        })

        expect(rows.some((row) => row.kind === "goal" && row.text.includes("Fix src/app.ts"))).toBe(true)
        expect(rows.some((row) => row.kind === "instruction" && row.text.includes("Always run bun test"))).toBe(true)
        expect(rows.some((row) => row.kind === "preference" && row.text.includes("Keep responses concise"))).toBe(true)
        expect(rows.some((row) => row.kind === "file" && row.text.includes("src/app.ts"))).toBe(true)
        expect(rows.some((row) => row.kind === "validation" && row.text.includes("bun test"))).toBe(true)
        expect(rows.some((row) => row.source.branchID === "branch_1")).toBe(true)
      },
    })
  })

  test("rebuilds prompt context from memory after a compaction boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const first = await user(session.id, "Continue editing src/app.ts and always run bun test before you stop.")
        await assistant(session.id, first.id, [
          {
            type: "text",
            text: "Decided to keep the current structure. Pending: rerun bun test after the cleanup.",
          },
        ])
        await SessionMemory.extract({
          sessionID: session.id,
          messageID: first.id,
        })
        await SessionMemory.checkpoint({
          sessionID: session.id,
          model: model(),
          note: "Continue from src/app.ts with the cleanup and rerun bun test.",
        })

        const compact = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-5.2",
          },
          time: {
            created: Date.now(),
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: compact.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })
        await assistant(
          session.id,
          compact.id,
          [{ type: "text", text: "checkpoint" }],
          { summary: true },
        )

        const current = await user(session.id, "Finish the cleanup in src/app.ts.")
        const msgs = await MessageV2.filterCompacted(MessageV2.stream(session.id))
        const built = await SessionContextBuilder.build({
          sessionID: session.id,
          model: model(),
          user: current,
          messages: msgs,
        })

        const text = JSON.stringify(built.messages[0])
        expect(text).toContain("<session-memory>")
        expect(text).toContain("Continue from src/app.ts with the cleanup")
        expect(text).toContain("always run bun test")
        expect(text).toContain("src/app.ts")
      },
    })
  })

  test("captures openai response ids into provider checkpoint state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const part: MessageV2.StepFinishPart = {
          id: Identifier.ascending("part"),
          sessionID: "ses_test",
          messageID: "msg_test",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          metadata: {
            openai: {
              responseId: "resp_123",
            },
          },
        }

        expect(
          SessionMemory.provider({
            parts: [part],
            model: model(),
            strategy: "openai",
          }),
        ).toEqual({
          openai: {
            response_id: "resp_123",
          },
        })
      },
    })
  })

  test("captures tool output as memory before pruning compacted parts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const first = await user(session.id, "Run verification.")
        const old = await assistant(session.id, first.id, [
          {
            type: "tool",
            tool: "bash",
            callID: "call_old_1",
            state: {
              status: "completed",
              input: { cmd: "bun test", path: "src/app.ts" },
              output: "a".repeat(100_000),
              title: "bun test",
              metadata: {},
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            },
          },
          {
            type: "tool",
            tool: "bash",
            callID: "call_old_2",
            state: {
              status: "completed",
              input: { cmd: "bun typecheck", path: "src/app.ts" },
              output: "b".repeat(100_000),
              title: "bun typecheck",
              metadata: {},
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            },
          },
        ])
        const next = await user(session.id, "What changed?")
        await assistant(session.id, next.id, [{ type: "text", text: "Recent response." }])
        const tail = await user(session.id, "Anything left?")
        await assistant(session.id, tail.id, [{ type: "text", text: "One more recent response." }])

        await SessionCompaction.prune({ sessionID: session.id })

        const parts = await MessageV2.parts(old.id)
        const tool = parts.find(
          (part): part is MessageV2.ToolPart =>
            part.type === "tool" && part.state.status === "completed" && Boolean(part.state.time.compacted),
        )
        const rows = await SessionMemory.list(session.id)

        expect(tool).toBeDefined()
        expect(rows.some((row) => row.source.partID === tool?.id && row.kind === "validation")).toBe(true)
      },
    })
  })
})

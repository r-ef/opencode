import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import {
  TaskBranchApplyTool,
  TaskBranchStatusTool,
  TaskCancelTool,
  TaskContextReconcileTool,
  TaskStatusTool,
  TaskWatchTool,
} from "../../src/tool/task"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"

const base = {
  sessionID: "session_parent",
  messageID: "message_parent",
  callID: "call_parent",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

describe("tool.task status/cancel", () => {
  test("reports busy background task status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const task = await Session.create({ parentID: parent.id, title: "task" })
        SessionStatus.set(task.id, { type: "busy" })

        expect(task.kind).toBe("subagent")
        expect(task.rootID).toBe(parent.id)

        const tool = await TaskStatusTool.init()
        const result = await tool.execute({ task_id: task.id }, { ...base, ask: async () => {}, sessionID: parent.id })

        expect(result.title).toBe("Task busy")
        expect(result.output).toContain("status: busy")
        expect(result.output).toContain("Task still running.")
      },
    })
  })

  test("includes shared context publication details in task status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const task = await Session.create({ parentID: parent.id, title: "task" })
        const row = await Session.contextWrite({
          session_id: task.id,
          kind: "task_result",
          title: "done",
          body: "finished",
        })
        SessionStatus.set(task.id, { type: "idle" })

        const tool = await TaskStatusTool.init()
        const result = await tool.execute({ task_id: task.id }, { ...base, ask: async () => {}, sessionID: parent.id })

        expect(result.output).toContain(`shared_context_published: 1 latest=${row.id} kind=task_result`)
        expect(result.output).toContain(`shared_context_latest: ${row.id}`)
      },
    })
  })

  test("cancels task and returns idle status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const task = await Session.create({ parentID: parent.id, title: "task" })
        SessionStatus.set(task.id, { type: "busy" })

        let asked = false
        const tool = await TaskCancelTool.init()
        const result = await tool.execute(
          { task_id: task.id },
          {
            ...base,
            sessionID: parent.id,
            ask: async () => {
              asked = true
            },
          },
        )

        expect(asked).toBe(true)
        expect(result.output).toContain("status: idle")
        expect(SessionStatus.get(task.id).type).toBe("idle")
      },
    })
  })

  test("streams incremental task events with cursor", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const task = await Session.create({ parentID: parent.id, title: "task" })

        const msg = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: task.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: Identifier.ascending("message"),
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
        } as unknown as MessageV2.Assistant)

        const part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msg.id,
          sessionID: task.id,
          type: "tool",
          callID: "call_test",
          tool: "glob",
          state: {
            status: "running",
            input: {},
            title: "Scanning",
            time: { start: Date.now() },
          },
        } as unknown as MessageV2.ToolPart)) as MessageV2.ToolPart

        SessionStatus.set(task.id, { type: "busy" })

        const tool = await TaskWatchTool.init()
        const first = await tool.execute(
          { task_id: task.id, cursor: 0, limit: 10 },
          { ...base, ask: async () => {}, sessionID: parent.id },
        )

        expect(first.output).toContain("[running] glob: Scanning")
        const cursor = Number((first.metadata as { cursor?: number }).cursor)
        expect(cursor > 0).toBe(true)

        await Session.updatePart({
          id: part.id,
          messageID: msg.id,
          sessionID: task.id,
          type: "tool",
          callID: "call_test",
          tool: "glob",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "Scanning",
            metadata: {},
            time: {
              start: (part.state as MessageV2.ToolStateRunning).time.start,
              end: Date.now(),
            },
          },
        } as unknown as MessageV2.ToolPart)

        SessionStatus.set(task.id, { type: "idle" })
        const next = await tool.execute(
          { task_id: task.id, cursor, limit: 10 },
          { ...base, ask: async () => {}, sessionID: parent.id },
        )

        expect(next.output).toContain("[done] glob")
        expect(next.output).toContain("status: idle")
      },
    })
  })

  test("aggregates branch watcher output", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const left = await Session.create({ parentID: parent.id, title: "left" })
        const right = await Session.create({ parentID: parent.id, title: "right" })

        const msg = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: left.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: Identifier.ascending("message"),
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
        } as unknown as MessageV2.Assistant)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: msg.id,
          sessionID: left.id,
          type: "tool",
          callID: "call_branch",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "bun test" },
            title: "Running checks",
            time: { start: Date.now() },
          },
        } as unknown as MessageV2.ToolPart)

        SessionStatus.set(left.id, { type: "busy" })

        const id = Identifier.ascending("tool")
        await Storage.write(["task_branch", id], {
          id,
          sessionId: parent.id,
          messageId: Identifier.ascending("message"),
          description: "branch run",
          prompt: "test",
          subagent: "build",
          background: true,
          created: Date.now(),
          status: "running",
          base: { dir: tmp.path, root: tmp.path, snapshot: "snap" },
          model: { providerID: "test", modelID: "test" },
          winner: null,
          applied: null,
          branches: [
            {
              name: "left",
              prompt: "run tests first",
              sessionId: left.id,
              status: "running",
            },
            {
              name: "right",
              prompt: "edit first",
              sessionId: right.id,
              status: "completed",
              output: "done",
              diff: [],
              eval: {
                score: 70,
                confidence: 0.7,
                reason: "passed 1 test command",
                tests: { passed: 1, failed: 0 },
                tools: { done: 2, err: 0, edit: 1 },
                diff: { files: 0, additions: 0, deletions: 0 },
                notes: ["passed 1 test command"],
              },
            },
          ],
        })

        const tool = await TaskBranchStatusTool.init()
        const result = await tool.execute(
          { branch_id: id, cursor: 0, limit: 10 },
          { ...base, ask: async () => {}, sessionID: parent.id },
        )

        expect(result.output).toContain("status: running")
        expect(result.output).toContain("left ·")
        expect(result.output).toContain("[left] [running] bash: Running checks")
      },
    })
  })

  test("applies branch winner diff with safety checks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bun.write(`${tmp.path}/a.txt`, "old\n")
        const parent = await Session.create({ title: "parent" })
        const task = await Session.create({ parentID: parent.id, title: "winner" })
        const id = Identifier.ascending("tool")

        await Storage.write(["task_branch", id], {
          id,
          sessionId: parent.id,
          messageId: Identifier.ascending("message"),
          description: "branch run",
          prompt: "test",
          subagent: "build",
          background: false,
          created: Date.now(),
          status: "completed",
          base: { dir: tmp.path, root: tmp.path, snapshot: "snap" },
          model: { providerID: "test", modelID: "test" },
          winner: {
            name: "winner",
            sessionId: task.id,
            score: 88,
            confidence: 0.82,
            reason: "passed 1 test command",
          },
          applied: null,
          branches: [
            {
              name: "winner",
              prompt: "ship it",
              sessionId: task.id,
              status: "completed",
              output: "done",
              diff: [
                {
                  file: "a.txt",
                  before: "old\n",
                  after: "new\n",
                  additions: 1,
                  deletions: 1,
                  status: "modified",
                },
              ],
              eval: {
                score: 88,
                confidence: 0.82,
                reason: "passed 1 test command",
                tests: { passed: 1, failed: 0 },
                tools: { done: 2, err: 0, edit: 1 },
                diff: { files: 1, additions: 1, deletions: 1 },
                notes: ["passed 1 test command"],
              },
            },
          ],
        })

        let asked = false
        const tool = await TaskBranchApplyTool.init()
        const result = await tool.execute(
          { branch_id: id },
          {
            ...base,
            sessionID: parent.id,
            ask: async () => {
              asked = true
            },
          },
        )

        expect(asked).toBe(true)
        expect(await Bun.file(`${tmp.path}/a.txt`).text()).toBe("new\n")
        expect(result.output).toContain("status: applied")
      },
    })
  })

  test("reconciles shared context entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const left = await Session.create({ parentID: root.id, title: "left" })
        const right = await Session.create({ parentID: root.id, title: "right" })
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

        const tool = await TaskContextReconcileTool.init()
        const result = await tool.execute(
          {
            sources: [a.id, b.id],
            strategy: "winner",
            body: "Use the first outcome.",
            winner_context_id: a.id,
            winner_session_id: left.id,
          },
          { ...base, ask: async () => {}, sessionID: right.id },
        )

        const rows = await Session.contextList({
          session_id: right.id,
          after: 0,
          limit: 10,
          include_self: true,
        })
        const row = rows.at(-1)

        expect(result.output).toContain("kind: context_resolution")
        expect(result.output).toContain(`winner_context_id: ${a.id}`)
        expect(row?.data.kind).toBe("context_resolution")
        expect(row?.data.metadata?.["sources"]).toEqual([a.id, b.id])
      },
    })
  })
})

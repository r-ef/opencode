import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import {
  TaskBranchApplyTool,
  TaskBranchStatusTool,
  TaskCancelTool,
  TaskCoordinateTool,
  TaskContextReconcileTool,
  TaskStatusTool,
  TaskWatchTool,
  branchApply,
  branchCancel,
  branchSettle,
} from "../../src/tool/task"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { PermissionNext } from "../../src/permission/next"
import { TaskLineage } from "../../src/task/lineage"
import { TaskRecovery } from "../../src/task/recovery"
import { TaskRun } from "../../src/task/run"
import { TaskBranch } from "../../src/task/branch"
import { TaskApply } from "../../src/task/apply"
import { TaskRoutes } from "../../src/server/routes/task"

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

        expect(result.title).toBe("Task running")
        expect(result.output).toContain("status: running")
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

  test("publishes durable coordination entries through task_coordinate", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const left = await Session.create({ parentID: parent.id, title: "left" })
        const right = await Session.create({ parentID: parent.id, title: "right" })

        const tool = await TaskCoordinateTool.init()
        const result = await tool.execute(
          {
            mode: "request",
            target_session_id: right.id,
            request_id: "req_sync",
            title: "Need check",
            body: "Confirm the edge case.",
          },
          { ...base, ask: async () => {}, sessionID: left.id },
        )

        expect(result.output).toContain("<task_coordinate>")
        expect(result.output).toContain("kind: request")
        expect(result.output).toContain("status: open")
        expect(result.output).toContain(`target_session_id: ${right.id}`)

        const rows = await Session.coordinationList({
          session_id: right.id,
          include_self: true,
          limit: 10,
        })
        expect(rows).toHaveLength(1)
        expect(rows[0]?.from_session_id).toBe(left.id)
        expect(rows[0]?.to_session_id).toBe(right.id)
        expect(rows[0]?.request_id).toBe("req_sync")
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
        expect(result.output).toContain("status: cancelled")
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

  test("prefers durable task events in task watch output", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const task = await Session.create({ parentID: parent.id, title: "task" })
        await TaskRun.upsert({
          session: task,
          parent,
          description: "task",
          prompt: "do work",
          agent: "build",
          background: true,
          model: { providerID: "test", modelID: "test" },
        })
        await TaskRun.append(task.id, {
          progress: {
            kind: "text",
            text: "saved from durable events",
          },
        })

        const tool = await TaskWatchTool.init()
        const result = await tool.execute(
          { task_id: task.id, cursor: 0, limit: 10 },
          { ...base, ask: async () => {}, sessionID: parent.id },
        )

        expect(result.output).toContain("[text] saved from durable events")
      },
    })
  })

  test("long-polls task event route until a durable event arrives", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const task = await Session.create({ parentID: parent.id, title: "task" })
        await TaskRun.upsert({
          session: task,
          parent,
          description: "task",
          prompt: "do work",
          agent: "build",
          background: true,
          model: { providerID: "test", modelID: "test" },
        })

        const wait = TaskRoutes().request(`/${task.id}/events?cursor=1&wait_ms=500&limit=10`)
        await Bun.sleep(50)
        await TaskRun.append(task.id, {
          progress: {
            kind: "text",
            text: "arrived later",
          },
        })

        const res = await wait
        const rows = (await res.json()) as TaskRun.Info["events"]
        expect(rows).toHaveLength(1)
        expect(rows[0]?.progress?.kind).toBe("text")
        expect(rows[0]?.progress && "text" in rows[0].progress ? rows[0].progress.text : "").toBe("arrived later")
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

  test("prefers durable branch and child task events in branch status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const left = await Session.create({ parentID: parent.id, title: "left" })
        await TaskRun.upsert({
          session: left,
          parent,
          description: "left",
          prompt: "do work",
          agent: "build",
          background: true,
          model: { providerID: "test", modelID: "test" },
        })
        await TaskRun.append(left.id, {
          progress: {
            kind: "tool_started",
            tool: "bash",
            title: "Running checks",
          },
        })

        const id = Identifier.ascending("tool")
        await TaskBranch.create({
          id,
          sessionId: parent.id,
          rootSessionId: parent.rootID,
          projectID: parent.projectID,
          directory: parent.directory,
          messageId: Identifier.ascending("message"),
          description: "branch run",
          prompt: "test",
          subagent: "build",
          background: true,
          created: Date.now(),
          status: "running",
          error: undefined,
          base: { dir: tmp.path, root: tmp.path },
          model: { providerID: "test", modelID: "test" },
          branches: [
            {
              name: "left",
              prompt: "run tests first",
              sessionId: left.id,
              status: "running",
            },
          ],
          winner: null,
          applied: null,
        })
        await TaskBranch.append(id, {
          progress: {
            kind: "branch_started",
            name: "left",
            sessionId: left.id,
          },
        })

        const tool = await TaskBranchStatusTool.init()
        const result = await tool.execute(
          { branch_id: id, cursor: 0, limit: 10 },
          { ...base, ask: async () => {}, sessionID: parent.id },
        )

        expect(result.output).toContain("[left] [running] bash: Running checks")
      },
    })
  })

  test("mirrors child task progress into branch events", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ parentID: parent.id, title: "task" })
        await TaskRun.upsert({
          session: child,
          parent,
          description: "child",
          prompt: "do work",
          agent: "build",
          background: true,
          model: { providerID: "test", modelID: "test" },
        })

        const id = Identifier.ascending("tool")
        await TaskBranch.create({
          id,
          sessionId: parent.id,
          rootSessionId: parent.rootID,
          projectID: parent.projectID,
          directory: parent.directory,
          messageId: Identifier.ascending("message"),
          description: "branch run",
          prompt: "test",
          subagent: "build",
          background: true,
          created: Date.now(),
          status: "running",
          error: undefined,
          base: { dir: tmp.path, root: tmp.path },
          model: { providerID: "test", modelID: "test" },
          branches: [
            {
              name: "left",
              prompt: "a",
              sessionId: child.id,
              status: "running",
            },
          ],
          winner: null,
          applied: null,
        })

        await TaskBranch.watch(id, async () => {
          await TaskRun.append(child.id, {
            progress: {
              kind: "tool_started",
              tool: "bash",
              title: "Running checks",
            },
          })
          await Bun.sleep(50)
        })

        const info = await TaskBranch.get(id)
        expect(info.events.some((item) => item.progress?.kind === "branch_tool_started")).toBe(true)
      },
    })
  })

  test("reports terminal branch apply state in branch status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
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
          background: true,
          created: Date.now(),
          status: "cancelled",
          error: "stopped by user",
          base: { dir: tmp.path, root: tmp.path, snapshot: "snap" },
          model: { providerID: "test", modelID: "test" },
          winner: {
            name: "winner",
            sessionId: task.id,
            score: 88,
            confidence: 0.82,
            reason: "passed 1 test command",
          },
          applied: {
            status: "error",
            name: "winner",
            sessionId: task.id,
            files: 1,
            time: Date.now(),
            error: "Apply blocked by local changes",
          },
          branches: [
            {
              name: "winner",
              prompt: "ship it",
              sessionId: task.id,
              status: "cancelled",
            },
          ],
        })

        const tool = await TaskBranchStatusTool.init()
        const result = await tool.execute(
          { branch_id: id, cursor: 0, limit: 10 },
          { ...base, ask: async () => {}, sessionID: parent.id },
        )

        expect(result.output).toContain("status: cancelled")
        expect(result.output).toContain("apply: error Apply blocked by local changes")
        expect(result.output).toContain("stopped by user")
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

  test("rolls back partial branch apply failures", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bun.write(`${tmp.path}/a.txt`, "old\n")
        await Bun.write(`${tmp.path}/dir`, "blocker\n")
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
                {
                  file: "dir/b.txt",
                  before: "",
                  after: "next\n",
                  additions: 1,
                  deletions: 0,
                  status: "added",
                },
              ],
              eval: {
                score: 88,
                confidence: 0.82,
                reason: "passed 1 test command",
                tests: { passed: 1, failed: 0 },
                tools: { done: 2, err: 0, edit: 1 },
                diff: { files: 2, additions: 2, deletions: 1 },
                notes: ["passed 1 test command"],
              },
            },
          ],
        })

        await expect(branchApply({ branch_id: id })).rejects.toThrow()
        expect(await Bun.file(`${tmp.path}/a.txt`).text()).toBe("old\n")
        expect(await Bun.file(`${tmp.path}/dir`).text()).toBe("blocker\n")
        expect((await TaskBranch.get(id)).applied?.status).toBe("error")
        await expect(TaskApply.get(id)).rejects.toThrow()
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

describe("task lineage and recovery", () => {
  test("rejects resume across projects", async () => {
    await using left = await tmpdir({ git: true })
    await using right = await tmpdir({ git: true })

    const task = await Instance.provide({
      directory: left.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ parentID: parent.id, title: "task" })
        await TaskRun.upsert({
          session: child,
          parent,
          description: "task",
          prompt: "do work",
          agent: "general",
          background: false,
          model: { providerID: "test", modelID: "test" },
        })
        return child
      },
    })

    await Instance.provide({
      directory: right.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        await expect(
          TaskLineage.validate({
            taskID: task.id,
            parentID: parent.id,
            agent: "general",
          }),
        ).rejects.toThrow("Task not found in current project")
      },
    })
  })

  test("rejects resume for interactive sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        await expect(
          TaskLineage.validate({
            taskID: parent.id,
            parentID: parent.id,
            agent: "general",
          }),
        ).rejects.toThrow("Task is not a subagent session")
      },
    })
  })

  test("rejects resume for a different agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ parentID: parent.id, title: "task" })
        await TaskRun.upsert({
          session: child,
          parent,
          description: "task",
          prompt: "do work",
          agent: "general",
          background: false,
          model: { providerID: "test", modelID: "test" },
        })

        await expect(
          TaskLineage.validate({
            taskID: child.id,
            parentID: parent.id,
            agent: "build",
          }),
        ).rejects.toThrow(`Task ${child.id} belongs to @general, not @build`)
      },
    })
  })

  test("inherits parent session restrictions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({
          title: "parent",
          permission: [
            {
              permission: "edit",
              pattern: "*",
              action: "deny",
            },
          ],
        })
        const rules = await TaskLineage.permission({ parent, allow: false })

        expect(PermissionNext.evaluate("edit", "*", rules).action).toBe("deny")
        expect(PermissionNext.evaluate("task", "*", rules).action).toBe("deny")
        expect(PermissionNext.evaluate("todowrite", "*", rules).action).toBe("deny")
      },
    })
  })

  test("marks stale task and branch runs interrupted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ parentID: parent.id, title: "task" })
        await TaskRun.upsert({
          session: child,
          parent,
          description: "task",
          prompt: "do work",
          agent: "general",
          background: true,
          model: { providerID: "test", modelID: "test" },
        })
        await Storage.update(["task_run", child.id], (draft: TaskRun.Info) => {
          if (!draft.runtime) return
          draft.runtime.heartbeat = 1
        })

        const branch = Identifier.ascending("tool")
        await TaskBranch.create({
          id: branch,
          sessionId: parent.id,
          rootSessionId: parent.rootID,
          projectID: parent.projectID,
          directory: parent.directory,
          messageId: Identifier.ascending("message"),
          description: "branch run",
          prompt: "test",
          subagent: "general",
          background: true,
          created: Date.now(),
          status: "running",
          error: undefined,
          base: { dir: tmp.path, root: tmp.path },
          model: { providerID: "test", modelID: "test" },
          branches: [
            {
              name: "left",
              prompt: "a",
              sessionId: child.id,
              status: "running",
            },
          ],
          winner: null,
          applied: null,
        })
        await Storage.update(["task_branch", branch], (draft: TaskBranch.Info) => {
          if (!draft.runtime) return
          draft.runtime.heartbeat = 1
        })

        await TaskRecovery.recover()

        expect((await TaskRun.get(child.id)).status).toBe("interrupted")
        expect((await TaskBranch.get(branch)).status).toBe("interrupted")
      },
    })
  })

  test("keeps cancelled branch rows cancelled after late results", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ parentID: parent.id, title: "task" })
        const id = Identifier.ascending("tool")

        await TaskBranch.create({
          id,
          sessionId: parent.id,
          rootSessionId: parent.rootID,
          projectID: parent.projectID,
          directory: parent.directory,
          messageId: Identifier.ascending("message"),
          description: "branch run",
          prompt: "test",
          subagent: "general",
          background: true,
          created: Date.now(),
          status: "running",
          error: undefined,
          base: { dir: tmp.path, root: tmp.path },
          model: { providerID: "test", modelID: "test" },
          branches: [
            {
              name: "left",
              prompt: "a",
              sessionId: child.id,
              status: "running",
            },
          ],
          winner: null,
          applied: null,
        })

        await branchCancel(id)
        await branchSettle({
          branchID: id,
          sessionID: child.id,
          status: "completed",
          output: "done",
          diff: [],
          eval: {
            score: 80,
            confidence: 0.8,
            reason: "passed",
            tests: { passed: 1, failed: 0 },
            tools: { done: 1, err: 0, edit: 0 },
            diff: { files: 0, additions: 0, deletions: 0 },
            notes: ["passed"],
          },
        })

        const info = await TaskBranch.get(id)
        expect(info.status).toBe("cancelled")
        expect(info.branches[0]?.status).toBe("cancelled")
        expect(info.branches[0]?.output).toBeUndefined()
      },
    })
  })

  test("appends branch cancelled progress events", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ parentID: parent.id, title: "task" })
        const id = Identifier.ascending("tool")

        await TaskBranch.create({
          id,
          sessionId: parent.id,
          rootSessionId: parent.rootID,
          projectID: parent.projectID,
          directory: parent.directory,
          messageId: Identifier.ascending("message"),
          description: "branch run",
          prompt: "test",
          subagent: "general",
          background: true,
          created: Date.now(),
          status: "running",
          error: undefined,
          base: { dir: tmp.path, root: tmp.path },
          model: { providerID: "test", modelID: "test" },
          branches: [
            {
              name: "left",
              prompt: "a",
              sessionId: child.id,
              status: "running",
            },
          ],
          winner: null,
          applied: null,
        })

        await branchCancel(id)

        const info = await TaskBranch.get(id)
        expect(info.events.some((item) => item.progress?.kind === "branch_cancelled")).toBe(true)
      },
    })
  })

  test("rolls back stale branch apply journals", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bun.write(`${tmp.path}/a.txt`, "old\n")
        const parent = await Session.create({ title: "parent" })
        const task = await Session.create({ parentID: parent.id, title: "winner" })
        const id = Identifier.ascending("tool")

        await TaskBranch.create({
          id,
          sessionId: parent.id,
          rootSessionId: parent.rootID,
          projectID: parent.projectID,
          directory: parent.directory,
          messageId: Identifier.ascending("message"),
          description: "branch run",
          prompt: "test",
          subagent: "general",
          background: false,
          created: Date.now(),
          status: "completed",
          error: undefined,
          base: { dir: tmp.path, root: tmp.path },
          model: { providerID: "test", modelID: "test" },
          branches: [
            {
              name: "winner",
              prompt: "ship it",
              sessionId: task.id,
              status: "completed",
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
            },
          ],
          winner: {
            name: "winner",
            sessionId: task.id,
            score: 90,
            confidence: 0.9,
            reason: "best",
          },
          applied: null,
        })

        const state = await TaskBranch.get(id)
        const item = state.branches[0]
        if (!item) throw new Error("missing branch")
        await TaskApply.create({ state, item })
        await TaskBranch.setApply(id, {
          status: "running",
          name: item.name,
          sessionId: item.sessionId,
          files: 1,
          time: Date.now(),
        })
        await Bun.write(`${tmp.path}/a.txt`, "new\n")
        await Storage.update(["task_branch_apply", id], (draft: TaskApply.Info) => {
          draft.runtime.heartbeat = 1
        })

        await TaskRecovery.recover()

        expect(await Bun.file(`${tmp.path}/a.txt`).text()).toBe("old\n")
        expect((await TaskBranch.get(id)).applied?.status).toBe("error")
        await expect(TaskApply.get(id)).rejects.toThrow()
      },
    })
  })
})

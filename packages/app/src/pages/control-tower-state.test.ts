import { describe, expect, test } from "bun:test"
import type { Session, ToolPart } from "@opencode-ai/sdk/v2/client"
import { applyState, famNote, runNote } from "./control-tower-state"

const tool = (state: ToolPart["state"]): ToolPart => ({
  id: "part_1",
  sessionID: "session_1",
  messageID: "message_1",
  type: "tool",
  callID: "call_1",
  tool: "task_branch_apply",
  state,
})

const session = (compacting?: number) =>
  ({
    time: { created: 1, updated: 1, compacting },
  }) as Pick<Session, "time">

describe("applyState", () => {
  test("matches running apply from tool input", () => {
    const list = [
      tool({
        status: "running",
        input: { branch_id: "branch_1" },
        metadata: {},
        time: { start: 1 },
      }),
    ]

    expect(applyState(list, "branch_1")).toBe("running")
  })

  test("prefers the latest matching apply result", () => {
    const list = [
      tool({
        status: "error",
        input: { branch_id: "branch_1" },
        error: "blocked",
        metadata: {},
        time: { start: 1, end: 2 },
      }),
      tool({
        status: "completed",
        input: { branch_id: "branch_1" },
        output: "ok",
        title: "Applied",
        metadata: { branchId: "branch_1" },
        time: { start: 3, end: 4 },
      }),
    ]

    expect(applyState(list, "branch_1")).toBe("done")
  })

  test("ignores apply records for other tournaments", () => {
    const list = [
      tool({
        status: "completed",
        input: { branch_id: "branch_2" },
        output: "ok",
        title: "Applied",
        metadata: { branchId: "branch_2" },
        time: { start: 1, end: 2 },
      }),
    ]

    expect(applyState(list, "branch_1")).toBe("idle")
  })
})

describe("famNote", () => {
  test("explains missing model", () => {
    expect(famNote(session(), false)).toBe("Connect a provider to summarize this family.")
  })

  test("explains active compaction", () => {
    expect(famNote(session(123), true)).toBe("Family summary already in progress.")
  })
})

describe("runNote", () => {
  test("explains missing winner", () => {
    expect(runNote({}, { model: true, apply: "idle" })).toBe("Wait for a winner before opening or applying it.")
  })

  test("explains missing model", () => {
    expect(runNote({ win: { sessionId: "session_1" } }, { model: false, apply: "idle" })).toBe(
      "Connect a provider to apply the winner.",
    )
  })

  test("explains apply progress and prior results", () => {
    expect(runNote({ win: { sessionId: "session_1" } }, { model: true, apply: "running" })).toBe(
      "Winner apply already in progress.",
    )
    expect(runNote({ win: { sessionId: "session_1" } }, { model: true, apply: "done" })).toBe(
      "Winner already applied from this tournament.",
    )
    expect(runNote({ win: { sessionId: "session_1" } }, { model: true, apply: "error" })).toBe(
      "Last apply attempt failed. Review the root session and retry when ready.",
    )
  })
})

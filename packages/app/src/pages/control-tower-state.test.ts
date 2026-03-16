import { describe, expect, test } from "bun:test"
import type { Session } from "@selene-ai/sdk/v2/client"
import type { TaskBranchRun } from "@selene-ai/sdk/v2/client"
import { famNote, runEvent, runNote, runPatch } from "./control-tower-state"

const session = (compacting?: number) =>
  ({
    time: { created: 1, updated: 1, compacting },
  }) as Pick<Session, "time">

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
    expect(runNote({}, { apply: "idle" })).toBe("Wait for a winner before opening or applying it.")
  })

  test("explains apply progress and prior results", () => {
    expect(runNote({ win: { sessionId: "session_1" } }, { apply: "running" })).toBe(
      "Winner apply already in progress.",
    )
    expect(runNote({ win: { sessionId: "session_1" } }, { apply: "done" })).toBe(
      "Winner already applied from this tournament.",
    )
    expect(runNote({ win: { sessionId: "session_1" } }, { apply: "error" })).toBe(
      "Last apply attempt failed. Review the root session and retry when ready.",
    )
  })
})

describe("runEvent", () => {
  test("formats mirrored branch progress", () => {
    expect(
      runEvent({
        id: 1,
        time: 1,
        type: "progress",
        progress: {
          kind: "branch_tool_started",
          name: "left",
          sessionId: "session_1",
          tool: "bash",
          title: "Running checks",
        },
      }),
    ).toBe("left running bash: Running checks")
  })

  test("formats apply and winner events", () => {
    expect(
      runEvent({
        id: 2,
        time: 1,
        type: "winner",
        data: { winner: "session_2" },
      }),
    ).toBe("Winner selected: session_2")

    expect(
      runEvent({
        id: 3,
        time: 1,
        type: "apply_error",
        data: { error: "blocked" },
      }),
    ).toBe("Apply failed: blocked")
  })
})

describe("runPatch", () => {
  const run = () =>
    ({
      id: "tool_1",
      sessionId: "session_root",
      rootSessionId: "session_root",
      projectID: "project_1",
      directory: "/tmp",
      messageId: "message_1",
      description: "run",
      prompt: "test",
      subagent: "build",
      background: true,
      created: 1,
      updated: 1,
      status: "running",
      base: { dir: "/tmp", root: "/tmp" },
      model: { providerID: "test", modelID: "test" },
      branches: [
        {
          name: "left",
          prompt: "a",
          sessionId: "session_left",
          status: "running",
        },
      ],
      winner: null,
      applied: null,
      events: [],
    }) as TaskBranchRun

  test("updates branch rows from branch progress", () => {
    const next = runPatch(run(), {
      id: 2,
      time: 2,
      type: "progress",
      progress: {
        kind: "branch_error",
        name: "left",
        sessionId: "session_left",
        error: "failed",
      },
    })
    expect(next.branches[0]?.status).toBe("error")
    expect(next.branches[0]?.error).toBe("failed")
  })

  test("updates winner and apply state", () => {
    const win = runPatch(run(), {
      id: 3,
      time: 3,
      type: "winner",
      data: { winner: "session_left" },
    })
    expect(win.winner?.sessionId).toBe("session_left")

    const applied = runPatch(win, {
      id: 4,
      time: 4,
      type: "applied",
      data: { branch: "session_left", status: "running" },
    })
    expect(applied.applied?.status).toBe("running")
    expect(applied.applied?.name).toBe("left")
  })
})

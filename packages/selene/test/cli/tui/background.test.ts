import { describe, expect, test } from "bun:test"
import { active, line, recent, summary } from "../../../src/cli/cmd/tui/util/background"

describe("tui background", () => {
  test("counts only running items as active work", () => {
    const items = [
      { kind: "task" as const, title: "inspect parser", status: "running", time: 1 },
      { kind: "branch" as const, title: "compare fixes", status: "completed", time: 2 },
      { kind: "task" as const, title: "write docs", status: "error", time: 3 },
    ]

    expect(active(items)).toEqual([items[0]])
  })

  test("sorts newest work first", () => {
    const items = [
      { kind: "task" as const, title: "a", status: "completed", time: 1 },
      { kind: "branch" as const, title: "b", status: "running", time: 3 },
      { kind: "task" as const, title: "c", status: "running", time: 2 },
    ]

    expect(recent(items).map((item) => item.title)).toEqual(["b", "c", "a"])
  })

  test("formats work lines and summary text", () => {
    const items = [
      { kind: "task" as const, title: "inspect parser", status: "running", time: 1 },
      { kind: "branch" as const, title: "compare fixes", status: "running", time: 2 },
    ]

    expect(line(items[0])).toBe("task running · inspect parser")
    expect(summary(items)).toBe("1 task running · 1 branch run active")
    expect(summary([{ kind: "task", title: "done", status: "completed", time: 1 }])).toBe("Recent background work available")
    expect(summary([])).toBe("No background work yet")
  })
})

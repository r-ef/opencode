import { describe, expect, test } from "bun:test"
import { line, open, recent, summary } from "../../../src/cli/cmd/tui/util/coordination"

describe("tui coordination", () => {
  test("counts open and claimed items as active coordination", () => {
    const items = [
      { id: 1, kind: "request", status: "open" },
      { id: 2, kind: "claim", status: "claimed" },
      { id: 3, kind: "answer", status: "answered" },
      { id: 4, kind: "resolution", status: "resolved" },
    ]

    expect(open(items).map((item) => item.id)).toEqual([1, 2])
  })

  test("shows newest coordination entries first and limits the panel to four rows", () => {
    const items = [
      { id: 1, kind: "request", status: "open" },
      { id: 2, kind: "update", status: "open" },
      { id: 3, kind: "claim", status: "claimed" },
      { id: 4, kind: "conflict", status: "open" },
      { id: 5, kind: "resolution", status: "resolved" },
    ]

    expect(recent(items).map((item) => item.id)).toEqual([5, 4, 3, 2])
  })

  test("formats coordination lines with optional titles", () => {
    expect(line({ kind: "request", status: "open", title: "Inspect parser" })).toBe("request open · Inspect parser")
    expect(line({ kind: "resolution", status: "resolved" })).toBe("resolution resolved")
  })

  test("summarizes idle and active collaboration states", () => {
    expect(summary([])).toBe("No coordination yet")
    expect(summary([{ status: "resolved" }])).toBe("Recent agent collaboration available")
    expect(summary([{ status: "open" }, { status: "claimed" }])).toBe("2 active coordination items")
  })
})

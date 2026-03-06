import { describe, expect, test } from "bun:test"
import { build } from "../../../src/cli/cmd/tui/routes/session/branch-tree"

describe("branch tree", () => {
  test("renders depth-first lineage for nested branches", () => {
    const rows = build({
      items: [
        {
          id: "root",
          title: "root",
          rootID: "root",
          time: { created: 1, updated: 1 },
        },
        {
          id: "left",
          title: "left",
          rootID: "root",
          branchFromSessionID: "root",
          time: { created: 2, updated: 2 },
        },
        {
          id: "leaf",
          title: "leaf",
          rootID: "root",
          branchFromSessionID: "left",
          branchFromMessageID: "msg_1",
          time: { created: 3, updated: 3 },
        },
        {
          id: "right",
          title: "right",
          rootID: "root",
          branchFromSessionID: "root",
          time: { created: 4, updated: 4 },
        },
      ],
    })

    expect(rows.map((row) => [row.item.id, row.prefix])).toEqual([
      ["root", ""],
      ["left", "├── "],
      ["leaf", "│   └── "],
      ["right", "└── "],
    ])
  })

  test("treats missing parents as top-level rows", () => {
    const rows = build({
      items: [
        {
          id: "root",
          title: "root",
          rootID: "root",
          time: { created: 1, updated: 1 },
        },
        {
          id: "orphan",
          title: "orphan",
          rootID: "root",
          branchFromSessionID: "missing",
          time: { created: 2, updated: 2 },
        },
      ],
    })

    expect(rows.map((row) => [row.item.id, row.prefix])).toEqual([
      ["root", ""],
      ["orphan", ""],
    ])
  })
})

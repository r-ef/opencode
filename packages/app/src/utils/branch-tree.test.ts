import { describe, expect, test } from "bun:test"
import { build, type Row } from "./branch-tree"

const row = (input: Partial<Row> & Pick<Row, "id" | "title" | "rootID">): Row => ({
  directory: "/repo",
  branchFromMessageID: undefined,
  branchFromSessionID: undefined,
  time: { created: 0, updated: 0 },
  ...input,
})

describe("branch-tree", () => {
  test("builds a branch family tree in creation order", () => {
    const rows = build({
      items: [
        row({
          id: "b",
          title: "branch b",
          rootID: "root",
          branchFromSessionID: "root",
          time: { created: 2, updated: 2 },
        }),
        row({ id: "root", title: "root", rootID: "root", time: { created: 1, updated: 1 } }),
        row({
          id: "c",
          title: "branch c",
          rootID: "root",
          branchFromSessionID: "b",
          time: { created: 3, updated: 3 },
        }),
      ],
    })

    expect(rows.map((item) => [item.prefix, item.item.id])).toEqual([
      ["", "root"],
      ["└── ", "b"],
      ["    └── ", "c"],
    ])
  })
})

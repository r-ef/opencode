import type { Session } from "@opencode-ai/sdk/v2/client"

export type Row = Pick<
  Session,
  "id" | "title" | "directory" | "rootID" | "branchFromSessionID" | "branchFromMessageID" | "time"
>

export type Tree = {
  item: Row
  prefix: string
}

function sort(a: Row, b: Row) {
  if (a.id === a.rootID && b.id !== b.rootID) return -1
  if (b.id === b.rootID && a.id !== a.rootID) return 1
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

function prefix(input: { trail: boolean[]; last: boolean; depth: number }) {
  if (input.depth === 0) return ""
  return input.trail.map((item) => (item ? "    " : "│   ")).join("") + (input.last ? "└── " : "├── ")
}

export function build(input: { items: Row[] }) {
  const nodes = new Map(
    input.items.map((item) => [
      item.id,
      {
        item,
        child: [] as Row[],
      },
    ]),
  )
  const roots = [] as Row[]

  for (const item of input.items.toSorted(sort)) {
    const parent = item.branchFromSessionID ? nodes.get(item.branchFromSessionID) : undefined
    if (!parent || parent.item.id === item.id) {
      roots.push(item)
      continue
    }
    parent.child.push(item)
  }

  const seen = new Set<string>()
  const rows = [] as Tree[]
  const walk = (list: Row[], trail: boolean[], depth: number) => {
    list.toSorted(sort).forEach((item, i, all) => {
      if (seen.has(item.id)) return
      seen.add(item.id)
      const last = i === all.length - 1
      rows.push({
        item,
        prefix: prefix({ trail, last, depth }),
      })
      const child = nodes.get(item.id)?.child ?? []
      walk(child, depth === 0 ? [] : [...trail, last], depth + 1)
    })
  }

  walk(roots, [], 0)
  walk(
    input.items.filter((item) => !seen.has(item.id)).toSorted(sort),
    [],
    0,
  )

  return rows
}

type Coord = {
  kind: string
  status: string
  title?: string
  body: string
  time: number
}

type Work = {
  kind: "task" | "branch"
  status: string
  title: string
  time: number
}

function body(item: Work) {
  if (item.kind === "task") {
    if (item.status === "running") return "Subagent task is running."
    if (item.status === "completed") return "Subagent task finished."
    if (item.status === "error") return "Subagent task failed."
    if (item.status === "cancelled") return "Subagent task was cancelled."
    if (item.status === "interrupted") return "Subagent task was interrupted."
  }
  if (item.status === "running") return "Branch run is active."
  if (item.status === "completed") return "Branch run finished."
  if (item.status === "error") return "Branch run failed."
  if (item.status === "cancelled") return "Branch run was cancelled."
  if (item.status === "interrupted") return "Branch run was interrupted."
  return `${item.kind} ${item.status}`
}

export function merge(
  coord: {
    kind: string
    status: string
    title?: string
    body: string
    time_updated: number
  }[],
  work: Work[],
): Coord[] {
  return [
    ...coord.map((item) => ({
      kind: item.kind,
      status: item.status,
      title: item.title,
      body: item.body,
      time: item.time_updated,
    })),
    ...work.map((item) => ({
      kind: item.kind,
      status: item.status,
      title: item.title,
      body: body(item),
      time: item.time,
    })),
  ].toSorted((a, b) => b.time - a.time)
}

export function open<T extends { status: string }>(items: T[]) {
  return items.filter((item) => item.status === "open" || item.status === "claimed" || item.status === "running")
}

export function recent<T>(items: T[], limit = 4) {
  if (items.every((item) => typeof (item as { time?: number }).time === "number")) {
    return [...items]
      .toSorted((a, b) => ((b as { time: number }).time ?? 0) - ((a as { time: number }).time ?? 0))
      .slice(0, limit)
  }
  return items.slice(-limit).reverse()
}

export function line(item: { kind: string; status: string; title?: string }) {
  return `${item.kind} ${item.status}${item.title ? ` · ${item.title}` : ""}`
}

export function summary(items: { status: string; kind?: string }[]) {
  const count = open(items).length
  if (count > 0) return `${count} active coordination item${count === 1 ? "" : "s"}`
  if (items.some((item) => item.kind === "task" || item.kind === "branch")) return "Recent subagent activity available"
  if (items.length > 0) return "Recent agent collaboration available"
  return "No coordination yet"
}

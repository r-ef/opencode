type Item = {
  kind: "task" | "branch"
  title: string
  status: string
  time: number
}

export function active(items: Item[]) {
  return items.filter((item) => item.status === "running")
}

export function recent(items: Item[], limit = 4) {
  return items.toSorted((a, b) => b.time - a.time).slice(0, limit)
}

export function line(item: Item) {
  const kind = item.kind === "branch" ? "branch" : "task"
  return `${kind} ${item.status} · ${item.title}`
}

export function summary(items: Item[]) {
  const live = active(items)
  const task = live.filter((item) => item.kind === "task").length
  const branch = live.filter((item) => item.kind === "branch").length
  const out = [
    task ? `${task} task${task === 1 ? "" : "s"} running` : "",
    branch ? `${branch} branch ${branch === 1 ? "run" : "runs"} active` : "",
  ].filter(Boolean)
  if (out.length) return out.join(" · ")
  if (items.length > 0) return "Recent background work available"
  return "No background work yet"
}

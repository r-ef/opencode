import type { TaskBranchRun, TaskRun } from "@opencode-ai/sdk/v2/client"

export type Work = {
  kind: "task" | "branch"
  title: string
  status: string
  time: number
}

export function items(input: { task: TaskRun[]; branch: TaskBranchRun[] }) {
  return [
    ...input.task
      .filter((item) => item.background)
      .map((item) => ({
        kind: "task" as const,
        title: item.description,
        status: item.status,
        time: item.time.updated,
      })),
    ...input.branch
      .filter((item) => item.background)
      .map((item) => ({
        kind: "branch" as const,
        title: item.description,
        status: item.status,
        time: item.updated,
      })),
  ].sort((a, b) => b.time - a.time)
}

export function active(items: Work[]) {
  return items.filter((item) => item.status === "running")
}

export function summary(items: Work[]) {
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

export function line(item: Work) {
  return `${item.kind === "branch" ? "branch" : "task"} ${item.status} · ${item.title}`
}

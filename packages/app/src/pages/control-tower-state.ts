import type { Session, TaskBranchRun, TaskEvent } from "@opencode-ai/sdk/v2/client"

export type Apply = "idle" | "running" | "done" | "error"

export const famNote = (session: Pick<Session, "time">, model: boolean) => {
  if (!model) return "Connect a provider to summarize this family."
  if (session.time.compacting) return "Family summary already in progress."
}

export const runNote = (run: { win?: { sessionId?: string } | null }, input: { apply: Apply }) => {
  if (!run.win?.sessionId) return "Wait for a winner before opening or applying it."
  if (input.apply === "running") return "Winner apply already in progress."
  if (input.apply === "done") return "Winner already applied from this tournament."
  if (input.apply === "error") return "Last apply attempt failed. Review the root session and retry when ready."
}

export const runEvent = (item: TaskEvent) => {
  if (item.type === "progress" && item.progress) {
    if (item.progress.kind === "branch_started") return `${item.progress.name} started`
    if (item.progress.kind === "branch_completed") return `${item.progress.name} completed`
    if (item.progress.kind === "branch_error") return `${item.progress.name} failed${item.progress.error ? `: ${item.progress.error}` : ""}`
    if (item.progress.kind === "branch_cancelled") return `${item.progress.name} cancelled`
    if (item.progress.kind === "branch_tool_started") {
      const title = item.progress.title ? `: ${item.progress.title}` : ""
      return `${item.progress.name} running ${item.progress.tool}${title}`
    }
    if (item.progress.kind === "branch_tool_completed") return `${item.progress.name} finished ${item.progress.tool}`
    if (item.progress.kind === "branch_tool_error") return `${item.progress.name} ${item.progress.tool} failed: ${item.progress.error}`
    if (item.progress.kind === "branch_reasoning") return `${item.progress.name} thinking: ${item.progress.text}`
    if (item.progress.kind === "branch_text") return `${item.progress.name}: ${item.progress.text}`
    if (item.progress.kind === "branch_context_published") {
      return `${item.progress.name} published ${item.progress.event}`
    }
  }
  if (item.type === "winner" && item.data?.["winner"]) return `Winner selected: ${String(item.data["winner"])}`
  if (item.type === "applied") {
    const state = item.data?.["status"]
    const branch = String(item.data?.["branch"] ?? "")
    if (state === "running") return `Applying ${branch}`
    if (state === "completed") return `Applied ${branch}`
  }
  if (item.type === "apply_error") return `Apply failed: ${String(item.data?.["error"] ?? item.data?.["branch"] ?? "")}`
  if (item.type === "completed") return "Run completed"
  if (item.type === "cancelled") return "Run cancelled"
  if (item.type === "interrupted") return "Run interrupted"
  if (item.type === "error") return `Run failed${item.data?.["error"] ? `: ${String(item.data["error"])}` : ""}`
}

export const runPatch = (run: TaskBranchRun, item: TaskEvent): TaskBranchRun => {
  const next = {
    ...run,
    updated: Math.max(run.updated, item.time),
  } satisfies TaskBranchRun

  const progress = item.type === "progress" ? item.progress : undefined

  if (progress) {
    if (progress.kind === "branch_completed") {
      return {
        ...next,
        branches: next.branches.map((row) =>
          row.sessionId === progress.sessionId ? { ...row, status: "completed", error: undefined } : row,
        ),
      }
    }
    if (progress.kind === "branch_error") {
      return {
        ...next,
        branches: next.branches.map((row) =>
          row.sessionId === progress.sessionId
            ? { ...row, status: "error", error: progress.error ?? row.error }
            : row,
        ),
      }
    }
    if (progress.kind === "branch_cancelled") {
      return {
        ...next,
        branches: next.branches.map((row) =>
          row.sessionId === progress.sessionId ? { ...row, status: "cancelled" } : row,
        ),
      }
    }
    return next
  }

  if (item.type === "winner") {
    const id = typeof item.data?.["winner"] === "string" ? item.data["winner"] : undefined
    const row = next.branches.find((item) => item.sessionId === id)
    return {
      ...next,
      winner: id
        ? {
            name: row?.name ?? id,
            sessionId: id,
            score: next.winner?.sessionId === id ? next.winner.score : 0,
            confidence: next.winner?.sessionId === id ? next.winner.confidence : 0,
            reason: next.winner?.sessionId === id ? next.winner.reason : "",
          }
        : null,
    }
  }

  if (item.type === "applied" || item.type === "apply_error") {
    const id = typeof item.data?.["branch"] === "string" ? item.data["branch"] : undefined
    const row = next.branches.find((item) => item.sessionId === id)
    return {
      ...next,
      applied: id
        ? {
            status: item.type === "apply_error" ? "error" : item.data?.["status"] === "running" ? "running" : "completed",
            name: row?.name ?? id,
            sessionId: id,
            files: next.applied?.sessionId === id ? next.applied.files : 0,
            time: item.time,
            error: typeof item.data?.["error"] === "string" ? item.data["error"] : undefined,
          }
        : next.applied,
    }
  }

  if (item.type === "completed" || item.type === "cancelled" || item.type === "interrupted" || item.type === "error") {
    return {
      ...next,
      status: item.type,
      error: typeof item.data?.["error"] === "string" ? item.data["error"] : next.error,
    }
  }

  return next
}

import type { Session, ToolPart } from "@opencode-ai/sdk/v2/client"

export type Apply = "idle" | "running" | "done" | "error"

const branch = (part: ToolPart) => {
  const meta = (part.state.status === "running" || part.state.status === "completed" || part.state.status === "error"
    ? part.state.metadata
    : undefined) as { branchId?: string; branch_id?: string } | undefined
  const input = part.state.input as { branch_id?: string } | undefined
  return meta?.branchId ?? meta?.branch_id ?? input?.branch_id
}

export const applyState = (list: ToolPart[], id: string): Apply => {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item.tool !== "task_branch_apply") continue
    if (branch(item) !== id) continue
    if (item.state.status === "running") return "running"
    if (item.state.status === "completed") return "done"
    if (item.state.status === "error") return "error"
  }
  return "idle"
}

export const famNote = (session: Pick<Session, "time">, model: boolean) => {
  if (!model) return "Connect a provider to summarize this family."
  if (session.time.compacting) return "Family summary already in progress."
}

export const runNote = (
  run: { win?: { sessionId?: string } | null },
  input: { model: boolean; apply: Apply },
) => {
  if (!run.win?.sessionId) return "Wait for a winner before opening or applying it."
  if (!input.model) return "Connect a provider to apply the winner."
  if (input.apply === "running") return "Winner apply already in progress."
  if (input.apply === "done") return "Winner already applied from this tournament."
  if (input.apply === "error") return "Last apply attempt failed. Review the root session and retry when ready."
}

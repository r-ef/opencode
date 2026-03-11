export function summarizeCoordinatorPrompt(text: string) {
  if (!text.includes("You are part of a deterministic analysis plan for this root session.")) return text
  const clean = (input?: string) => input?.trim().replace(/\.$/, "")
  const role = clean(text.match(/^Workstream role:\s*(.+?)\.$/m)?.[1])
  const scope = clean(text.match(/^Scope:\s*(.+)$/m)?.[1])
  const goal = clean(text.match(/^Goal:\s*(.+)$/m)?.[1])
  const query = clean(text.match(/^User query:\s*(.+)$/m)?.[1])
  return [
    "Coordinator workstream",
    role ? `Role: ${role}` : undefined,
    scope ? `Scope: ${scope}` : undefined,
    goal ? `Goal: ${goal}` : undefined,
    query ? `Query: ${query}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

export function open<T extends { status: string }>(items: T[]) {
  return items.filter((item) => item.status === "open" || item.status === "claimed")
}

export function recent<T>(items: T[], limit = 4) {
  return items.slice(-limit).reverse()
}

export function line(item: { kind: string; status: string; title?: string }) {
  return `${item.kind} ${item.status}${item.title ? ` · ${item.title}` : ""}`
}

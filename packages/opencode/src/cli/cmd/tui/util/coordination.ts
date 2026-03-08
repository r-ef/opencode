export function open<T extends { status: string }>(items: T[]) {
  return items.filter((item) => item.status === "open" || item.status === "claimed")
}

export function recent<T>(items: T[], limit = 4) {
  return items.slice(-limit).reverse()
}

export function line(item: { kind: string; status: string; title?: string }) {
  return `${item.kind} ${item.status}${item.title ? ` · ${item.title}` : ""}`
}

export function summary(items: { status: string }[]) {
  const count = open(items).length
  if (count > 0) return `${count} open coordination item${count === 1 ? "" : "s"}`
  if (items.length > 0) return "Recent agent collaboration available"
  return "No coordination yet"
}

import { sortBy, pipe } from "remeda"

export namespace Wildcard {
  const cache = new Map<string, RegExp>()
  const LIMIT = 512

  function regex(pattern: string) {
    pattern = pattern.replaceAll("\\", "/")
    const flags = process.platform === "win32" ? "si" : "s"
    const key = `${flags}\0${pattern}`
    const hit = cache.get(key)
    if (hit) return hit

    let escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")

    if (escaped.endsWith(" .*")) {
      escaped = escaped.slice(0, -3) + "( .*)?"
    }

    const out = new RegExp("^" + escaped + "$", flags)
    cache.set(key, out)
    if (cache.size > LIMIT) {
      const first = cache.keys().next().value
      if (first) cache.delete(first)
    }
    return out
  }

  export function match(str: string, pattern: string) {
    if (str) str = str.replaceAll("\\", "/")
    return regex(pattern).test(str)
  }

  export function all(input: string, patterns: Record<string, any>) {
    const sorted = pipe(patterns, Object.entries, sortBy([([key]) => key.length, "asc"], [([key]) => key, "asc"]))
    let result = undefined
    for (const [pattern, value] of sorted) {
      if (match(input, pattern)) {
        result = value
        continue
      }
    }
    return result
  }

  export function allStructured(input: { head: string; tail: string[] }, patterns: Record<string, any>) {
    const sorted = pipe(patterns, Object.entries, sortBy([([key]) => key.length, "asc"], [([key]) => key, "asc"]))
    let result = undefined
    for (const [pattern, value] of sorted) {
      const parts = pattern.split(/\s+/)
      if (!match(input.head, parts[0])) continue
      if (parts.length === 1 || matchSequence(input.tail, parts.slice(1))) {
        result = value
        continue
      }
    }
    return result
  }

  function matchSequence(items: string[], patterns: string[]): boolean {
    if (patterns.length === 0) return true
    const [pattern, ...rest] = patterns
    if (pattern === "*") return matchSequence(items, rest)
    for (let i = 0; i < items.length; i++) {
      if (match(items[i], pattern) && matchSequence(items.slice(i + 1), rest)) {
        return true
      }
    }
    return false
  }
}

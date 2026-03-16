type ErrorInfo = {
  name: string
  data?: {
    message?: string
    statusCode?: number
    responseBody?: string
    metadata?: Record<string, unknown>
  }
}

function clip(input: string, max = 200) {
  const text = input.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "…"
}

function generic(input: string) {
  return /provider returned error|unknown error|request failed|api call failed/i.test(input.trim())
}

export function formatSessionError(input?: ErrorInfo) {
  if (!input?.data?.message) return []
  const out = [input.data.message]
  if (input.name !== "APIError") return out
  if (input.data.statusCode) out.push(`status ${input.data.statusCode}`)
  const url = typeof input.data.metadata?.["url"] === "string" ? input.data.metadata["url"] : undefined
  if (url) out.push(url)
  const body = input.data.responseBody?.trim()
  if (body) {
    if (generic(input.data.message)) {
      out.push(`body ${clip(body)}`)
      return out
    }
    if (!body.startsWith("{") && !body.startsWith("<!doctype") && !body.startsWith("<html")) {
      out.push(clip(body))
    }
  }
  return out
}

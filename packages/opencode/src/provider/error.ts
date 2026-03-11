import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"

export namespace ProviderError {
  // Adapted from overflow detection patterns in:
  // https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
  const OVERFLOW_PATTERNS = [
    /prompt is too long/i, // Anthropic
    /input is too long for requested model/i, // Amazon Bedrock
    /exceeds the context window/i, // OpenAI (Completions + Responses API message text)
    /input token count.*exceeds the maximum/i, // Google (Gemini)
    /maximum prompt length is \d+/i, // xAI (Grok)
    /reduce the length of the messages/i, // Groq
    /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek
    /exceeds the limit of \d+/i, // GitHub Copilot
    /exceeds the available context size/i, // llama.cpp server
    /greater than the context length/i, // LM Studio
    /context window exceeds limit/i, // MiniMax
    /exceeded model token limit/i, // Kimi For Coding, Moonshot
    /context[_ ]length[_ ]exceeded/i, // Generic fallback
    /request entity too large/i, // HTTP 413
  ]

  function isOpenAiErrorRetryable(e: APICallError) {
    const status = e.statusCode
    if (!status) return e.isRetryable
    // openai sometimes returns 404 for models that are actually available
    return status === 404 || e.isRetryable
  }

  // Providers not reliably handled in this function:
  // - z.ai: can accept overflow silently (needs token-count/context-window checks)
  function isOverflow(message: string) {
    if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return true

    // Providers/status patterns handled outside of regex list:
    // - Cerebras: often returns "400 (no body)" / "413 (no body)"
    // - Mistral: often returns "400 (no body)" / "413 (no body)"
    return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
  }

  function error(providerID: string, error: APICallError) {
    if (providerID.includes("github-copilot") && error.statusCode === 403) {
      return "Please reauthenticate with the copilot provider to ensure your credentials work properly with OpenCode."
    }

    return error.message
  }

  function clip(input: string, max = 240) {
    const text = input.replace(/\s+/g, " ").trim()
    if (text.length <= max) return text
    return text.slice(0, max - 1) + "…"
  }

  function pick(input: unknown): string | undefined {
    if (typeof input === "string") {
      const text = clip(input)
      return text ? text : undefined
    }
    if (Array.isArray(input)) {
      for (const item of input) {
        const found = pick(item)
        if (found) return found
      }
      return
    }
    if (!input || typeof input !== "object") return
    const row = input as Record<string, unknown>
    const direct = ["message", "detail", "title", "reason", "error_description", "description"]
      .map((key) => row[key])
      .map((value) => pick(value))
      .find(Boolean)
    if (direct) return direct
    return ["error", "errors", "details", "response"]
      .map((key) => row[key])
      .map((value) => pick(value))
      .find(Boolean)
  }

  function generic(input: string) {
    return /provider returned error|unknown error|request failed|api call failed/i.test(input.trim())
  }

  function status(input?: number) {
    if (!input) return
    const text = STATUS_CODES[input]
    return text ? `${input} ${text}` : String(input)
  }

  function message(providerID: string, e: APICallError) {
    return iife(() => {
      const msg = e.message
      const body = json(e.responseBody)
      const detail = pick(body) ?? (typeof e.responseBody === "string" && !/^\s*<!doctype|^\s*<html/i.test(e.responseBody) ? clip(e.responseBody) : undefined)
      const code = status(e.statusCode)
      if (msg === "") {
        if (detail) return code ? `${code}: ${detail}` : detail
        if (code) return code
        return "Unknown error"
      }

      const transformed = error(providerID, e)
      if (transformed !== msg) {
        return transformed
      }
      if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody ?? "")) {
        if (e.statusCode === 401) {
          return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
        }
        if (e.statusCode === 403) {
          return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
        }
        return code && generic(msg) ? `Provider error ${code}` : msg
      }
      if (detail) {
        if (generic(msg)) return code ? `Provider error ${code}: ${detail}` : detail
        if (detail !== msg) return `${msg}: ${detail}`
      }
      if (code && generic(msg)) return `Provider error ${code}`
      if (code && msg === STATUS_CODES[e.statusCode!]) return `Provider error ${code}`
      return msg
    }).trim()
  }

  function json(input: unknown) {
    if (typeof input === "string") {
      try {
        const result = JSON.parse(input)
        if (result && typeof result === "object") return result
        return undefined
      } catch {
        return undefined
      }
    }
    if (typeof input === "object" && input !== null) {
      return input
    }
    return undefined
  }

  export type ParsedStreamError =
    | {
        type: "context_overflow"
        message: string
        responseBody: string
      }
    | {
        type: "api_error"
        message: string
        isRetryable: false
        responseBody: string
      }

  export function parseStreamError(input: unknown): ParsedStreamError | undefined {
    const body = json(input)
    if (!body) return

    const responseBody = JSON.stringify(body)
    if (body.type !== "error") return

    switch (body?.error?.code) {
      case "context_length_exceeded":
        return {
          type: "context_overflow",
          message: "Input exceeds context window of this model",
          responseBody,
        }
      case "insufficient_quota":
        return {
          type: "api_error",
          message: "Quota exceeded. Check your plan and billing details.",
          isRetryable: false,
          responseBody,
        }
      case "usage_not_included":
        return {
          type: "api_error",
          message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
          isRetryable: false,
          responseBody,
        }
      case "invalid_prompt":
        return {
          type: "api_error",
          message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
          isRetryable: false,
          responseBody,
        }
    }
  }

  export type ParsedAPICallError =
    | {
        type: "context_overflow"
        message: string
        responseBody?: string
      }
    | {
        type: "api_error"
        message: string
        statusCode?: number
        isRetryable: boolean
        responseHeaders?: Record<string, string>
        responseBody?: string
        metadata?: Record<string, string>
      }

  export function parseAPICallError(input: { providerID: string; error: APICallError }): ParsedAPICallError {
    const m = message(input.providerID, input.error)
    if (isOverflow(m) || input.error.statusCode === 413) {
      return {
        type: "context_overflow",
        message: m,
        responseBody: input.error.responseBody,
      }
    }

    const metadata = input.error.url ? { url: input.error.url } : undefined
    return {
      type: "api_error",
      message: m,
      statusCode: input.error.statusCode,
      isRetryable: input.providerID.startsWith("openai")
        ? isOpenAiErrorRetryable(input.error)
        : input.error.isRetryable,
      responseHeaders: input.error.responseHeaders,
      responseBody: input.error.responseBody,
      metadata,
    }
  }
}

import { describe, expect, test } from "bun:test"
import { summarizeCoordinatorPrompt } from "../../../src/cli/cmd/tui/util/session-display"

describe("tui session display", () => {
  test("summarizes coordinator prompts in subagent view", () => {
    const text = [
      "You are part of a deterministic analysis plan for this root session.",
      "Workstream role: primary.",
      "Scope: Quality.",
      "Goal: Inspect tests, risks, gaps, and architectural weak spots relevant to: analyze the codebase, use coordination.",
      "User query: analyze the codebase, use coordination",
      'Return your final answer in two parts:',
      "1. A short prose summary.",
    ].join("\n")

    expect(summarizeCoordinatorPrompt(text)).toBe(
      [
        "Coordinator workstream",
        "Role: primary",
        "Scope: Quality",
        "Goal: Inspect tests, risks, gaps, and architectural weak spots relevant to: analyze the codebase, use coordination",
        "Query: analyze the codebase, use coordination",
      ].join("\n"),
    )
  })

  test("leaves normal user prompts unchanged", () => {
    expect(summarizeCoordinatorPrompt("hello")).toBe("hello")
  })
})

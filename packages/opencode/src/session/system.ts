import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"

const PROMPT_COORDINATION = `
## Global coordination
- For repo-wide analysis, architecture review, broad codebase exploration, or any task that requires reading more than a few files, coordination is mandatory.
- When the task is not a needle query for a specific file, class, or function, prefer the Task tool over doing all exploration directly in the parent agent.
- If the work can be partitioned safely, launch at least 3 subagents in parallel in a single response and give each one a distinct scope.
- If the user asks to analyze a codebase or to work in parallel, you must use multiple Task tool calls in a single response when the workstreams are independent.
- For broad analysis, do not finalize after the first wave of subagent results. Run at least one independent verification pass over the most important conclusions.
- When sibling findings conflict or one result appears weak, ask a sibling or verifier to check it, then use task coordination or shared-context reconciliation before finalizing.
- Before launching coordinated work, briefly state the planned workstreams. After the subagents finish, synthesize their results into one answer.
- If sibling coordination is needed, use the task coordination tools instead of waiting idly.
`.trim()

export namespace SystemPrompt {
  export function instructions() {
    return [PROMPT_COORDINATION, PROMPT_CODEX.trim()].join("\n\n")
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_COORDINATION, PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_COORDINATION, PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_COORDINATION, PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_COORDINATION, PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_COORDINATION, PROMPT_TRINITY]
    return [PROMPT_COORDINATION, PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }
}

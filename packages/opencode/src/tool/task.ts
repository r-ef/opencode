import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { Log } from "@/util/log"
import { SessionStatus } from "@/session/status"
import { Instance } from "@/project/instance"
import { Snapshot } from "@/snapshot"
import { Worktree } from "@/worktree"
import { TaskApply } from "@/task/apply"
import { TaskRun } from "@/task/run"
import { TaskBranch } from "@/task/branch"
import { TaskEvent } from "@/task/event"
import { TaskLineage } from "@/task/lineage"
import { SessionAmbient } from "@/session/ambient"
import { SessionCoordinator } from "@/session/coordinator"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "bun"
import STATUS_DESCRIPTION from "./task_status.txt"
import CANCEL_DESCRIPTION from "./task_cancel.txt"
import WATCH_DESCRIPTION from "./task_watch.txt"
import BRANCH_DESCRIPTION from "./task_branch.txt"
import BRANCH_STATUS_DESCRIPTION from "./task_branch_status.txt"
import BRANCH_APPLY_DESCRIPTION from "./task_branch_apply.txt"
import CONTEXT_RECONCILE_DESCRIPTION from "./task_context_reconcile.txt"
import COORDINATE_DESCRIPTION from "./task_coordinate.txt"

const log = Log.create({ service: "tool.task" })

const part = z.discriminatedUnion("type", [
  MessageV2.TextPart.omit({
    messageID: true,
    sessionID: true,
  })
    .partial({
      id: true,
    })
    .meta({
      ref: "TaskTextPart",
    }),
  MessageV2.FilePart.omit({
    messageID: true,
    sessionID: true,
  })
    .partial({
      id: true,
    })
    .meta({
      ref: "TaskFilePart",
    }),
  MessageV2.AgentPart.omit({
    messageID: true,
    sessionID: true,
  })
    .partial({
      id: true,
    })
    .meta({
      ref: "TaskAgentPart",
    }),
])

function output(id: string, text: string) {
  return [
    `task_id: ${id} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

function check(id: string) {
  return [`task_id: ${id} (for resuming to continue this task if needed)`, "", "<task_status>"].join("\n")
}

async function shared(sessionId: string, sourceId = sessionId, kind?: string) {
  return Session.contextStats({
    session_id: sessionId,
    source_session_id: sourceId,
    kind,
  })
}

function sharedRows(stats: Session.ContextStats) {
  return [
    `shared_context_cursor: ${stats.cursor}`,
    `shared_context_latest: ${stats.latest}`,
    `shared_context_unread: ${stats.unread}`,
    `shared_context_pending: ${stats.pending}`,
    stats.latest_published
      ? `shared_context_published: ${stats.published} latest=${stats.latest_published.id} kind=${stats.latest_published.data.kind}`
      : `shared_context_published: ${stats.published}`,
  ]
}

async function branchContext(branchId: string, sessionId: string) {
  const rows = await Session.contextList({
    session_id: sessionId,
    after: 0,
    limit: 100,
    source_session_id: sessionId,
    kind: "task_branch",
    include_self: true,
  })
  return rows.findLast((row) => row.data.metadata?.["branch_id"] === branchId)
}

function toolset(config: Awaited<ReturnType<typeof Config.get>>, allow: boolean) {
  return {
    todowrite: false,
    todoread: false,
    ...(allow
      ? {}
      : {
          task: false,
          task_branch: false,
          task_branch_status: false,
          task_branch_apply: false,
        }),
    ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((item) => [item, false])),
  }
}

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  background: z
    .boolean()
    .describe(
      "When true, starts the subagent in the background and returns immediately with a task_id instead of waiting for the final result.",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  parts: z
    .array(part)
    .optional()
    .describe("Optional structured prompt parts. If provided, these are used instead of resolving parts from prompt."),
})

const branchParameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the branch run"),
  prompt: z.string().describe("The base task to evaluate across branches"),
  subagent_type: z.string().describe("The type of specialized agent to use for all branches"),
  branches: z
    .array(
      z.object({
        name: z.string().optional().describe("Optional label for this branch"),
        prompt: z.string().describe("Counterfactual strategy instruction for this branch"),
      }),
    )
    .min(2)
    .max(5)
    .describe("List of 2-5 counterfactual branches to run from the same snapshot"),
  background: z
    .boolean()
    .optional()
    .describe("When true, starts all branches in the background and returns branch task IDs immediately."),
  command: z.string().describe("The command that triggered this task").optional(),
  parts: z
    .array(part)
    .optional()
    .describe("Optional structured prompt parts. If provided, these are used instead of resolving parts from prompt."),
})

const branchStatusParameters = z.object({
  branch_id: z.string().describe("Branch run ID returned by task_branch"),
  cursor: z.number().int().min(0).default(0).optional().describe("Return events after this event cursor"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(30000)
    .default(0)
    .optional()
    .describe("Optional long-poll wait timeout in milliseconds"),
  limit: z.number().int().min(1).max(100).default(20).optional().describe("Max number of events to return"),
})

const branchApplyParameters = z.object({
  branch_id: z.string().describe("Branch run ID returned by task_branch"),
  branch: z
    .string()
    .optional()
    .describe("Optional branch name or task_id. Defaults to the evaluator-selected winner."),
})

const contextReconcileParameters = z.object({
  sources: z.array(z.number().int().positive()).min(1).max(32).describe("Shared context entry ids to reconcile"),
  strategy: z
    .enum(["summary", "winner", "conflict"])
    .default("summary")
    .describe("How to frame the resolution for downstream sessions"),
  title: z.string().optional().describe("Optional short title for the reconciliation entry"),
  body: z.string().describe("Authoritative summary or resolution that should be shared with sibling sessions"),
  winner_context_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional winning context id when strategy=winner"),
  winner_session_id: z
    .string()
    .optional()
    .describe("Optional winning session id when strategy=winner and the source session should be explicit"),
  keep_sources: z
    .boolean()
    .optional()
    .describe("When true, keep the source entries as still independently relevant after this resolution"),
})

const coordinationParameters = z.object({
  mode: z
    .enum(["request", "update", "answer", "claim", "release", "resolve"])
    .describe("Coordination action to publish"),
  target_session_id: z.string().optional().describe("Optional target sibling session id"),
  target_agent: z.string().optional().describe("Optional target sibling agent type within the same root session"),
  request_id: z.string().optional().describe("Optional request thread id that this update belongs to"),
  title: z.string().optional().describe("Optional short title for the coordination entry"),
  body: z.string().describe("Actionable coordination message body"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Optional structured metadata for the coordination entry"),
})

function label(item: z.infer<typeof branchParameters>["branches"][number], idx: number) {
  const name = item.name?.trim()
  if (name) return name
  return `branch ${idx + 1}`
}

function branchPrompt(input: { base: z.infer<typeof part>[]; task: string; name: string; prompt: string }) {
  const text = [
    "",
    `Counterfactual branch: ${input.name}`,
    `Strategy: ${input.prompt}`,
    "",
    "Treat this branch as isolated. Follow this strategy fully, even if alternatives might exist.",
    "Do not self-score this branch.",
    "Return your strongest result, plus concrete verification evidence when available.",
  ].join("\n")
  const parts = input.base.map((item) => ({ ...item }))
  const idx = parts.findIndex((item) => item.type === "text")
  if (idx === -1) {
    parts.push({
      type: "text",
      text: [input.task, text].join("\n\n"),
    })
    return parts
  }
  const match = parts[idx]
  if (match.type !== "text") return parts
  parts[idx] = {
    ...match,
    text: match.text + "\n" + text,
  }
  return parts
}

type BranchMeta = {
  name: string
  sessionId: string
  prompt: string
  status: "pending" | "running" | "completed" | "error" | "cancelled" | "interrupted"
  score?: number
  confidence?: number
  reason?: string
  diff?: {
    files: number
    additions: number
    deletions: number
  }
  tests?: {
    passed: number
    failed: number
  }
}

const evalInfo = z.object({
  score: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  tests: z.object({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  tools: z.object({
    done: z.number().int().min(0),
    err: z.number().int().min(0),
    edit: z.number().int().min(0),
  }),
  diff: z.object({
    files: z.number().int().min(0),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  }),
  notes: z.array(z.string()),
})

const branchInfo = z.object({
  name: z.string(),
  prompt: z.string(),
  sessionId: Identifier.schema("session"),
  status: z.enum(["pending", "running", "completed", "error", "cancelled"]),
  output: z.string().optional(),
  error: z.string().optional(),
  snapshot: z.string().optional(),
  diff: Snapshot.FileDiff.array().optional(),
  eval: evalInfo.optional(),
  dir: z.string().optional(),
  branch: z.string().optional(),
  cleanup: z
    .object({
      done: z.boolean(),
      error: z.string().optional(),
    })
    .optional(),
})

const branchWinner = z.object({
  name: z.string(),
  sessionId: Identifier.schema("session"),
  score: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
})

const branchState = z.object({
  id: Identifier.schema("tool"),
  sessionId: Identifier.schema("session"),
  messageId: Identifier.schema("message"),
  description: z.string(),
  prompt: z.string(),
  subagent: z.string(),
  background: z.boolean(),
  created: z.number(),
  status: z.enum(["running", "completed", "error", "cancelled"]),
  base: z.object({
    dir: z.string(),
    root: z.string(),
    snapshot: z.string().optional(),
  }),
  model: z.object({
    providerID: z.string(),
    modelID: z.string(),
  }),
  branches: z.array(branchInfo),
  winner: branchWinner.nullable(),
  applied: z
    .object({
      name: z.string(),
      sessionId: Identifier.schema("session"),
      files: z.number().int().min(0),
      time: z.number(),
    })
    .nullable()
    .optional(),
})

type EvalInfo = TaskBranch.Eval
type BranchInfo = TaskBranch.Row
type BranchState = TaskBranch.Info
type BranchWinner = TaskBranch.Winner
type TaskPart = z.infer<typeof part>

type BranchOutput = {
  title: string
  metadata: {
    branchId?: string
    model: {
      modelID: string
      providerID: string
    }
    background: boolean
    branches: BranchMeta[]
    winner: BranchWinner | null
    sharedContext?: Session.ContextStats
    sharedContextEntry?: Session.ContextInfo
  }
  output: string
}

type WatchRow = {
  id: number
  time: number
  text: string
}

async function branchLoad(id: string) {
  return TaskBranch.get(id)
}

async function branchSave(state: Omit<BranchState, "updated" | "runtime" | "events">) {
  return TaskBranch.create({
    id: state.id,
    sessionId: state.sessionId,
    rootSessionId: state.rootSessionId,
    projectID: state.projectID,
    directory: state.directory,
    messageId: state.messageId,
    description: state.description,
    prompt: state.prompt,
    subagent: state.subagent,
    background: state.background,
    created: state.created,
    status: state.status,
    error: state.error,
    base: state.base,
    model: state.model,
    branches: state.branches,
    winner: state.winner,
    applied: state.applied,
  })
}

async function branchUpdate(id: string, fn: (draft: BranchState) => void) {
  return TaskBranch.update(id, fn)
}

export async function branchSettle(input: {
  branchID: string
  sessionID: string
  status: "completed" | "error"
  output?: string
  error?: string
  snapshot?: string
  diff?: Snapshot.FileDiff[]
  eval?: EvalInfo
}) {
  let name = ""
  let done = false
  const next = await branchUpdate(input.branchID, (draft) => {
    if (draft.status !== "running") return
    const row = draft.branches.find((entry) => entry.sessionId === input.sessionID)
    if (!row) return
    if (row.status !== "running" && row.status !== "pending") return
    name = row.name
    done = true
    row.status = input.status
    row.output = input.output
    row.error = input.error
    row.snapshot = input.snapshot
    row.diff = input.diff
    row.eval = input.eval
  })
  if (!done) return next
  await TaskBranch.append(input.branchID, {
    progress:
      input.status === "completed"
        ? {
            kind: "branch_completed",
            name,
            sessionId: input.sessionID,
          }
        : {
            kind: "branch_error",
            name,
            sessionId: input.sessionID,
            error: input.error,
          },
  })
  return next
}

function copy(input: z.infer<typeof part>[], from: string, to: string) {
  return input.map((item) => {
    if (item.type !== "file" || !item.url.startsWith("file:")) return { ...item }
    const file = fileURLToPath(item.url)
    const rel = path.relative(from, file)
    if (!rel || rel === ".") {
      return {
        ...item,
        url: pathToFileURL(to).href,
      }
    }
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { ...item }
    return {
      ...item,
      url: pathToFileURL(path.join(to, rel)).href,
    }
  })
}

function pick(text: string, list: RegExp[]) {
  return list.some((item) => item.test(text))
}

function evalBranch(input: { msgs: MessageV2.WithParts[]; diff: Snapshot.FileDiff[]; text: string; err?: string }) {
  if (input.err) {
    return {
      score: 0,
      confidence: 0.95,
      reason: `failed: ${input.err}`,
      tests: { passed: 0, failed: 1 },
      tools: { done: 0, err: 1, edit: 0 },
      diff: { files: 0, additions: 0, deletions: 0 },
      notes: ["branch errored before completion"],
    } satisfies EvalInfo
  }

  const tools = input.msgs.flatMap((msg) => msg.parts).filter((item): item is MessageV2.ToolPart => item.type === "tool")
  const done = tools.filter((item) => item.state.status === "completed")
  const errs = tools.filter((item) => item.state.status === "error")
  const edit = done.filter((item) => ["edit", "write", "apply_patch"].includes(item.tool)).length
  const bash = tools.filter((item) => item.tool === "bash")
  const test = bash.filter((item) => {
    const state = item.state
    const cmd = state.input.command
    return typeof cmd === "string" && /\b(test|vitest|jest|pytest|cargo test|go test|rspec|bun test|npm test|pnpm test)\b/i.test(cmd)
  })
  const passed = test.filter((item) => item.state.status === "completed").length
  const failed = test.filter((item) => item.state.status === "error").length
  const diff = {
    files: input.diff.length,
    additions: input.diff.reduce((sum, item) => sum + item.additions, 0),
    deletions: input.diff.reduce((sum, item) => sum + item.deletions, 0),
  }

  const notes = [] as string[]
  if (passed) notes.push(`passed ${passed} test command${passed === 1 ? "" : "s"}`)
  if (failed) notes.push(`failed ${failed} test command${failed === 1 ? "" : "s"}`)
  if (edit) notes.push(`used ${edit} edit toolcall${edit === 1 ? "" : "s"}`)
  if (diff.files) notes.push(`changed ${diff.files} file${diff.files === 1 ? "" : "s"}`)
  if (errs.length) notes.push(`${errs.length} tool error${errs.length === 1 ? "" : "s"}`)

  const warn = pick(input.text, [
    /\b(i could not|i couldn't|unable to|not enough context|not possible|blocked)\b/i,
    /\bneeds follow-up\b/i,
  ])
  if (warn) notes.push("output still sounds blocked or incomplete")

  const quiet = !diff.files && edit === 0 && done.length === 0
  if (quiet) notes.push("produced little execution evidence")

  let score = 35
  if (input.text.trim()) score += 10
  if (done.length) score += 10
  if (edit) score += Math.min(12, edit * 4)
  if (diff.files) score += Math.min(20, diff.files * 4)
  if (diff.additions || diff.deletions) score += Math.min(8, Math.floor((diff.additions + diff.deletions) / 25))
  if (passed) score += Math.min(20, passed * 12)
  if (failed) score -= Math.min(35, failed * 18)
  if (errs.length) score -= Math.min(25, errs.length * 10)
  if (warn) score -= 12
  if (quiet) score -= 15

  const reason = notes[0] ?? "completed with limited evidence"
  const confidence = Math.max(
    0.2,
    Math.min(
      0.98,
      0.35 +
        (passed ? 0.25 : 0) +
        (diff.files ? 0.15 : 0) +
        (edit ? 0.1 : 0) +
        (done.length ? 0.08 : 0) -
        (failed ? 0.15 : 0) -
        (errs.length ? 0.1 : 0) -
        (warn ? 0.05 : 0),
    ),
  )

  return {
    score: Math.max(0, Math.min(100, score)),
    confidence,
    reason,
    tests: { passed, failed },
    tools: { done: done.length, err: errs.length, edit },
    diff,
    notes,
  } satisfies EvalInfo
}

function pickWinner(rows: BranchInfo[]) {
  const done = rows.filter((item) => item.status === "completed" && item.eval)
  const base = done.length ? done : rows.filter((item) => item.eval)
  if (!base.length) return null
  const ordered = [...base].sort((a, b) => {
    const as = a.eval?.score ?? 0
    const bs = b.eval?.score ?? 0
    if (as !== bs) return bs - as
    if ((a.eval?.confidence ?? 0) !== (b.eval?.confidence ?? 0)) return (b.eval?.confidence ?? 0) - (a.eval?.confidence ?? 0)
    if ((b.diff?.length ?? 0) !== (a.diff?.length ?? 0)) return (b.diff?.length ?? 0) - (a.diff?.length ?? 0)
    return a.name.localeCompare(b.name)
  })
  const win = ordered[0]
  if (!win?.eval) return null
  const next = ordered[1]
  const gap = Math.max(0, win.eval.score - (next?.eval?.score ?? 0))
  return {
    name: win.name,
    sessionId: win.sessionId,
    score: win.eval.score,
    confidence: Math.min(0.99, win.eval.confidence + Math.min(0.15, gap / 100)),
    reason: win.eval.reason,
  } satisfies BranchWinner
}

function choose(state: BranchState, value?: string) {
  if (!value?.trim()) return state.branches.find((item) => item.sessionId === state.winner?.sessionId) ?? state.branches[0]
  return state.branches.find((item) => item.sessionId === value || item.name === value)
}

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const allow = agent.permission.some((rule) => rule.permission === "task")
      const parent = await Session.get(ctx.sessionID)
      const permission = await TaskLineage.permission({ parent, allow })

      const session = await iife(async () => {
        if (!params.task_id) {
          return Session.create({
            parentID: ctx.sessionID,
            title: params.description + ` (@${agent.name} subagent)`,
            permission,
          })
        }

        const found = await TaskLineage.validate({
          taskID: params.task_id,
          parentID: ctx.sessionID,
          agent: agent.name,
        }).then((item) => item.task)
        await Session.setPermission({ sessionID: found.id, permission })
        return {
          ...found,
          permission,
        }
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const background = params.background === true
      const messageID = Identifier.ascending("message")
      const bound = await SessionCoordinator.bind({
        parent_session_id: ctx.sessionID,
        session_id: session.id,
        agent: agent.name,
        description: params.description,
        prompt: params.prompt,
      })
      const promptParts = params.parts?.length ? params.parts : await SessionPrompt.resolvePromptParts(bound.prompt)
      await TaskRun.upsert({
        session,
        parent,
        description: params.description,
        prompt: bound.prompt,
        agent: agent.name,
        background,
        model,
        resumed: Boolean(params.task_id),
      })

      const run = () =>
        TaskRun.watch(session.id, () =>
          SessionPrompt.prompt({
            messageID,
            sessionID: session.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            agent: agent.name,
            tools: toolset(config, allow),
            permission,
            parts: promptParts,
          }),
        )

      const info = await shared(session.id)

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
          background,
          sharedContext: info,
        },
      })

      if (background) {
        SessionAmbient.track({
          kind: "task",
          id: session.id,
          parentID: ctx.sessionID,
          rootID: ctx.sessionID,
          title: params.description,
        })
        run()
          .then(async (done) => {
            const structured = done.info.role === "assistant" ? done.info.structured : undefined
            const text =
              (structured && typeof structured === "object" && structured && "summary" in structured && typeof structured.summary === "string"
                ? structured.summary
                : undefined) ??
              done.parts.findLast((item) => item.type === "text")?.text ??
              ""
            await TaskRun.finish(session.id, { status: "completed", output: clip(text || "Task completed.") })
            const row = await Session.contextWrite({
              session_id: session.id,
              kind: "task_result",
              title: params.description,
              body: clip(text || "Task completed."),
              metadata: {
                task_id: session.id,
                parent_id: ctx.sessionID,
                agent: agent.name,
              },
            }).catch(() => undefined)
            await SessionCoordinator.complete({
              session_id: session.id,
              text,
              structured,
              context_id: row?.id,
            }).catch(() => undefined)
          })
          .catch(async (err) => {
            log.error("background task failed", {
              sessionID: session.id,
              agent: agent.name,
              error: err,
            })
            await TaskRun.finish(session.id, { status: "error", error: errText(err) })
            const row = await Session.contextWrite({
              session_id: session.id,
              kind: "task_error",
              title: params.description,
              body: clip(errText(err)),
              metadata: {
                task_id: session.id,
                parent_id: ctx.sessionID,
                agent: agent.name,
              },
            }).catch(() => undefined)
            await SessionCoordinator.fail({
              session_id: session.id,
              error: errText(err),
              context_id: row?.id,
            }).catch(() => undefined)
          })
        return {
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
            background: true,
            sharedContext: info,
          },
          output: output(
            session.id,
            "Background subagent started. Selene will track important progress automatically and bring back high-signal updates. Use task_status/task_watch only if the user explicitly wants task internals.",
          ),
        }
      }

      function cancel() {
        SessionPrompt.cancel(session.id)
        void TaskRun.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

      try {
        const result = await run()
        const structured = result.info.role === "assistant" ? result.info.structured : undefined
        const text =
          (structured && typeof structured === "object" && structured && "summary" in structured && typeof structured.summary === "string"
            ? structured.summary
            : undefined) ??
          result.parts.findLast((x) => x.type === "text")?.text ??
          ""
        await TaskRun.finish(session.id, { status: "completed", output: clip(text || "Task completed.") })
        const row = await Session.contextWrite({
          session_id: session.id,
          kind: "task_result",
          title: params.description,
          body: clip(text || "Task completed."),
          metadata: {
            task_id: session.id,
            parent_id: ctx.sessionID,
            agent: agent.name,
          },
        }).catch(() => undefined)
        await SessionCoordinator.complete({
          session_id: session.id,
          text,
          structured,
          context_id: row?.id,
        }).catch(() => undefined)
        const sharedContext = await shared(session.id)

        return {
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
            background: false,
            sharedContext,
          },
          output: output(session.id, text),
        }
      } catch (err) {
        await TaskRun.finish(session.id, { status: ctx.abort.aborted ? "cancelled" : "error", error: errText(err) })
        await SessionCoordinator.fail({
          session_id: session.id,
          error: errText(err),
        }).catch(() => undefined)
        throw err
      }
    },
  }
})

function errText(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function clip(text: string, max = 3000) {
  if (text.length <= max) return text
  return text.slice(0, max) + "\n…[truncated]"
}

function toMeta(item: BranchInfo): BranchMeta {
  return {
    name: item.name,
    sessionId: item.sessionId,
    prompt: item.prompt,
    status: item.status,
    score: item.eval?.score,
    confidence: item.eval?.confidence,
    reason: item.eval?.reason,
    diff: item.eval?.diff,
    tests: item.eval?.tests,
  }
}

async function gather(input: { sessionId: string; dir: string; snap?: string; iso: boolean }) {
  return Instance.provide({
    directory: input.dir,
    fn: async () => {
      const msgs = await Session.messages({ sessionID: input.sessionId })
      const text = latest(msgs)
      if (!input.snap || !input.iso) {
        return {
          msgs,
          text,
          diff: [] as Snapshot.FileDiff[],
          snapshot: undefined as string | undefined,
        }
      }
      const snapshot = await Snapshot.track()
      const diff = input.snap && snapshot ? await Snapshot.diffFull(input.snap, snapshot) : []
      return { msgs, text, diff, snapshot }
    },
  })
}

function branchRow(input: { item: BranchInfo; stat?: SessionStatus.Info; tool?: string }) {
  const bits = [input.item.name, input.item.sessionId, input.item.status]
  if (input.tool && input.item.status === "running") bits.push(`tool=${input.tool}`)
  if (input.item.eval) {
    bits.push(`score=${input.item.eval.score}`)
    bits.push(`conf=${Math.round(input.item.eval.confidence * 100)}%`)
    if (input.item.eval.tests.passed || input.item.eval.tests.failed) {
      bits.push(`tests=${input.item.eval.tests.passed}/${input.item.eval.tests.failed}`)
    }
    if (input.item.eval.diff.files) bits.push(`files=${input.item.eval.diff.files}`)
    if (input.item.eval.reason) bits.push(input.item.eval.reason)
  } else if (input.stat && input.item.status === "running") {
    bits.push(state(input.stat))
  }
  if (input.item.error && input.item.status === "error") bits.push(input.item.error)
  return `- ${bits.join(" · ")}`
}

function branchWinnerLine(input: BranchState) {
  if (!input.winner) return
  return `winner: ${input.winner.name} (${input.winner.sessionId}) score=${input.winner.score} confidence=${Math.round(
    input.winner.confidence * 100,
  )}% · ${input.winner.reason}`
}

function branchApplyLine(input: BranchState) {
  if (input.applied?.status === "completed") return `apply: completed ${input.applied.name}`
  if (input.applied?.status === "running") return `apply: running ${input.applied.name}`
  if (input.applied?.status === "error") return `apply: error ${input.applied.error ?? input.applied.name}`
}

function branchText(state: BranchState) {
  const win = choose(state)
  const body = win?.output || "No branch output."
  const applied = state.applied
    ? state.applied.status === "completed"
      ? `applied: ${state.applied.name} at ${new Date(state.applied.time).toISOString()}`
      : state.applied.status === "running"
        ? `applying: ${state.applied.name}`
        : `apply_error: ${state.applied.error ?? state.applied.name}`
    : undefined
  const winner = branchWinnerLine(state)
  return [
    `branch_id: ${state.id}`,
    "<task_branch>",
    `status: ${state.status}`,
    ...state.branches.map((item) => branchRow({ item })),
    ...(winner ? [winner] : []),
    ...(applied ? [applied] : []),
    "</task_branch>",
    "",
    output(win?.sessionId ?? state.branches[0]?.sessionId ?? state.sessionId, body),
  ].join("\n")
}

function branchSummary(state: BranchState) {
  const rows = state.branches.map((item) => {
    const bits = [item.name, item.status]
    if (item.eval) bits.push(`score=${item.eval.score}`, `conf=${Math.round(item.eval.confidence * 100)}%`)
    if (item.error) bits.push(item.error)
    return `- ${bits.join(" · ")}`
  })
  const winner = state.winner
    ? `winner: ${state.winner.name} (${state.winner.sessionId}) score=${state.winner.score} conf=${Math.round(state.winner.confidence * 100)}%`
    : "winner: none"
  const applied = branchApplyLine(state)
  return clip([`branch_id: ${state.id}`, `status: ${state.status}`, winner, ...(applied ? [applied] : []), ...rows].join("\n"))
}

function branchDone(state: BranchState) {
  if (state.status === "completed") return "Branch run completed."
  if (state.status === "cancelled") return "Branch run cancelled."
  if (state.status === "interrupted") return state.error ?? "Branch run interrupted."
  if (state.status === "error") return state.error ?? "Branch run failed."
  return "No new updates yet."
}

function taskDone(run: TaskRun.Info, text?: string) {
  if (run.status === "completed") return run.output ?? text ?? "Task completed."
  if (run.status === "cancelled") return "Task cancelled."
  if (run.status === "interrupted") return run.error ?? "Task interrupted. Reuse the task_id to continue the same subagent session."
  if (run.status === "error") return run.error ?? "Task failed."
  return undefined
}

export const TaskBranchTool = Tool.define("task_branch", async (ctx) => {
  const agents = await Agent.list().then((list) => list.filter((item) => item.mode !== "primary"))
  const caller = ctx?.agent
  const allowed = caller
    ? agents.filter((item) => PermissionNext.evaluate("task", item.name, caller.permission).action !== "deny")
    : agents
  const description = BRANCH_DESCRIPTION.replace(
    "{agents}",
    allowed
      .map(
        (item) => `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
      )
      .join("\n"),
  )

  return {
    description,
    parameters: branchParameters,
    async execute(params: z.infer<typeof branchParameters>, ctx): Promise<BranchOutput> {
      const config = await Config.get()

      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
            branches: params.branches.length,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
      const allow = agent.permission.some((item) => item.permission === "task")
      const parent = await Session.get(ctx.sessionID)
      const permission = await TaskLineage.permission({ parent, allow })

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")
      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      const id = Identifier.ascending("tool")
      const root = Instance.directory
      const base = Instance.worktree
      const snap = Instance.project.vcs === "git" ? await Snapshot.track() : undefined

      const runs = await Promise.all(
        params.branches.map(async (item, idx) => {
          const name = label(item, idx)
          const prep =
            snap && Instance.project.vcs === "git"
              ? await Worktree.makeWorktreeInfo(`${params.description}-${name}`)
                  .then(async (info) => {
                    await Worktree.createFromInfo(info)
                    await Worktree.boot(info)
                    return { dir: info.directory, work: info, err: undefined as Error | undefined }
                  })
                  .catch((err) => {
                    log.error("branch worktree setup failed", { name, error: err })
                    return {
                      dir: root,
                      work: undefined as Worktree.Info | undefined,
                      err: err instanceof Error ? err : new Error(String(err)),
                    }
                  })
              : { dir: root, work: undefined as Worktree.Info | undefined, err: undefined as Error | undefined }

          const session = await Instance.provide({
            directory: prep.dir,
            fn: () =>
              Session.create({
                parentID: ctx.sessionID,
                title: `${params.description} [${name}] (@${agent.name} subagent)`,
                permission,
              }),
          })

          return {
            name,
            prompt: item.prompt,
            session,
            run: () =>
              TaskRun.upsert({
                session,
                parent,
                description: `${params.description} [${name}]`,
                prompt: [params.prompt, item.prompt].join("\n\n"),
                agent: agent.name,
                background: true,
                model,
              })
                .then(() =>
                  TaskRun.watch(session.id, () =>
                    Promise.resolve()
                      .then(async () => {
                        if (prep.err) throw prep.err
                        return Instance.provide({
                          directory: prep.dir,
                          fn: async () => {
                            if (snap && prep.work) {
                              const patch = await Snapshot.patch(snap)
                              await Snapshot.revert([patch])
                            }
                            const raw = params.parts?.length
                              ? copy(params.parts, base, prep.dir)
                              : await SessionPrompt.resolvePromptParts(params.prompt)
                            const parts = branchPrompt({
                              base: raw.filter((row): row is TaskPart => {
                                return row.type === "text" || row.type === "file" || row.type === "agent"
                              }),
                              task: params.prompt,
                              name,
                              prompt: item.prompt,
                            })
                            return SessionPrompt.prompt({
                              messageID: Identifier.ascending("message"),
                              sessionID: session.id,
                              model,
                              agent: agent.name,
                              tools: toolset(config, allow),
                              permission,
                              parts,
                            })
                          },
                        })
                      })
                      .then(async () => {
                        const data = await gather({
                          sessionId: session.id,
                          dir: prep.dir,
                          snap,
                          iso: Boolean(prep.work),
                        })
                        const evaled = evalBranch({
                          msgs: data.msgs,
                          diff: data.diff,
                          text: data.text,
                        })
                        await TaskRun.finish(session.id, { status: "completed", output: clip(data.text || "Task completed.") })
                        await branchSettle({
                          branchID: id,
                          sessionID: session.id,
                          status: "completed",
                          output: data.text,
                          snapshot: data.snapshot,
                          diff: data.diff,
                          eval: evaled,
                        })
                      })
                      .catch(async (err) => {
                        const data = await gather({
                          sessionId: session.id,
                          dir: prep.dir,
                          snap,
                          iso: Boolean(prep.work) && !prep.err,
                        }).catch(() => ({
                          msgs: [] as MessageV2.WithParts[],
                          text: "",
                          diff: [] as Snapshot.FileDiff[],
                          snapshot: undefined as string | undefined,
                        }))
                        const error = errText(err)
                        const evaled = evalBranch({
                          msgs: data.msgs,
                          diff: data.diff,
                          text: data.text,
                          err: error,
                        })
                        await TaskRun.finish(session.id, { status: "error", error })
                        await branchSettle({
                          branchID: id,
                          sessionID: session.id,
                          status: "error",
                          output: data.text,
                          error,
                          snapshot: data.snapshot,
                          diff: data.diff,
                          eval: evaled,
                        })
                      })
                      .finally(async () => {
                        if (!prep.work) return
                        const err = await Worktree.remove({ directory: prep.work.directory }).catch((err) => err)
                        await branchUpdate(id, (draft) => {
                          const row = draft.branches.find((entry) => entry.sessionId === session.id)
                          if (!row) return
                          row.cleanup = {
                            done: !err,
                            error: err ? errText(err) : undefined,
                          }
                        })
                      }),
                  ),
                ),
            work: prep.work,
          }
        }),
      )

      const first = {
        id,
        sessionId: ctx.sessionID,
        rootSessionId: parent.rootID,
        projectID: parent.projectID,
        directory: parent.directory,
        messageId: ctx.messageID,
        description: params.description,
        prompt: params.prompt,
        subagent: params.subagent_type,
        background: params.background === true,
        created: Date.now(),
        status: "running" as const,
        error: undefined,
        base: {
          dir: root,
          root: base,
          snapshot: snap,
        },
        model,
        branches: runs.map((item) => ({
          name: item.name,
          prompt: item.prompt,
          sessionId: item.session.id,
          status: "running" as const,
          dir: item.work?.directory,
          branch: item.work?.branch,
        })),
        winner: null,
        applied: null,
      }
      await branchSave(first)
      await Promise.all(
        first.branches.map((item) =>
          TaskBranch.append(id, {
            progress: {
              kind: "branch_started",
              name: item.name,
              sessionId: item.sessionId,
            },
          }),
        ),
      )

      function cancel() {
        void branchCancel(id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

      const info = await shared(ctx.sessionID, ctx.sessionID, "task_branch")

      ctx.metadata({
        title: params.description,
        metadata: {
          branchId: id,
          model,
          background: params.background === true,
          branches: first.branches.map(toMeta),
          winner: null,
          sharedContext: info,
        },
      })

      const wait = TaskBranch.watch(id, () => Promise.allSettled(runs.map((item) => item.run()))).then(async () => {
        const next = await branchLoad(id)
        if (next.status !== "running") return next
        const winner = pickWinner(next.branches)
        if (winner) await TaskBranch.markWinner(id, winner)
        const final = await TaskBranch.finish(id, {
          status: next.branches.some((item) => item.status === "completed") ? "completed" : "error",
          winner,
        })
        if (final.status !== "completed" && final.status !== "error") return final
        await Session.contextWrite({
          session_id: ctx.sessionID,
          kind: "task_branch",
          title: params.description,
          body: branchSummary(final),
          metadata: {
            branch_id: id,
            winner: final.winner?.sessionId,
          },
        }).catch(() => undefined)
        return final
      })

      if (params.background) {
        SessionAmbient.track({
          kind: "branch",
          id,
          parentID: ctx.sessionID,
          rootID: ctx.sessionID,
          title: params.description,
        })
        void wait.catch((err) => {
          log.error("background branch failed", {
            branchID: id,
            agent: agent.name,
            error: err,
          })
        })
        return {
          title: params.description,
          metadata: {
            branchId: id,
            model,
            background: true,
            branches: first.branches.map(toMeta),
            winner: null,
            sharedContext: info,
          },
          output: [
            `branch_id: ${id}`,
            "task_branch: started",
            "",
            ...first.branches.map((item) => `- ${item.name}: ${item.sessionId}`),
            "",
            "Selene will track the tournament automatically and surface important milestones.",
            "Use task_branch_status or task_watch only if the user explicitly wants branch internals.",
          ].join("\n"),
        }
      }

      const state = await wait
      const sharedContext = await shared(ctx.sessionID, ctx.sessionID, "task_branch")
      const published = await branchContext(id, ctx.sessionID)
      return {
        title: params.description,
        metadata: {
          branchId: id,
          model,
          background: false,
          winner: state.winner,
          branches: state.branches.map(toMeta),
          sharedContext,
          sharedContextEntry: published,
        },
        output: branchText(state),
      }
    },
  }
})

function latest(msgs: MessageV2.WithParts[]) {
  const msg = msgs.findLast((item) => item.info.role === "assistant")
  if (!msg) return ""
  return msg.parts.findLast((part) => part.type === "text")?.text ?? ""
}

function active(msgs: MessageV2.WithParts[]) {
  const msg = msgs.findLast((item) => item.info.role === "assistant")
  if (!msg) return
  const part = msg.parts
    .filter(
      (item): item is MessageV2.ToolPart =>
        item.type === "tool" && (item.state.status === "running" || item.state.status === "pending"),
    )
    .at(-1)
  if (!part) return
  return part.tool
}

function running(msgs: MessageV2.WithParts[]) {
  const tool = active(msgs)
  if (tool) return `Task still running. Active tool: ${tool}.`

  const msg = msgs.findLast((item) => item.info.role === "assistant")
  if (!msg) return "Task still running."

  const text = msg.parts.findLast((part) => part.type === "text")?.text
  if (text) return text

  const reason = msg.parts.findLast((part) => part.type === "reasoning")?.text
  if (reason) return reason

  return "Task still running."
}

function state(stat: SessionStatus.Info) {
  if (stat.type === "retry") return `retry (${stat.attempt})`
  return stat.type
}

function taskEvent(item: TaskEvent.Info) {
  if (item.type === "progress" && item.progress) {
    if (item.progress.kind === "tool_started") {
      const title = item.progress.title ? `: ${item.progress.title}` : ""
      return `[running] ${item.progress.tool}${title}`
    }
    if (item.progress.kind === "tool_completed") return `[done] ${item.progress.tool}`
    if (item.progress.kind === "tool_error") return `[error] ${item.progress.tool}: ${item.progress.error}`
    if (item.progress.kind === "reasoning") return `[thinking] ${item.progress.text}`
    if (item.progress.kind === "text") return `[text] ${item.progress.text}`
    if (item.progress.kind === "context_published") {
      return `[context] published ${item.progress.event} (${item.progress.id})`
    }
    return
  }
  if (item.type === "completed") return "status: idle"
  if (item.type === "error") return "status: idle"
  if (item.type === "cancelled") return "status: idle"
  if (item.type === "interrupted") return "status: idle"
}

function branchEvent(item: TaskEvent.Info) {
  if (item.type === "progress" && item.progress) {
    if (item.progress.kind === "branch_started") return `[${item.progress.name}] branch started`
    if (item.progress.kind === "branch_completed") return `[${item.progress.name}] branch completed`
    if (item.progress.kind === "branch_error") {
      return `[${item.progress.name}] branch error${item.progress.error ? `: ${item.progress.error}` : ""}`
    }
    if (item.progress.kind === "branch_cancelled") return `[${item.progress.name}] branch cancelled`
    if (item.progress.kind === "branch_tool_started") {
      const title = item.progress.title ? `: ${item.progress.title}` : ""
      return `[${item.progress.name}] [running] ${item.progress.tool}${title}`
    }
    if (item.progress.kind === "branch_tool_completed") return `[${item.progress.name}] [done] ${item.progress.tool}`
    if (item.progress.kind === "branch_tool_error") {
      return `[${item.progress.name}] [error] ${item.progress.tool}: ${item.progress.error}`
    }
    if (item.progress.kind === "branch_reasoning") return `[${item.progress.name}] [thinking] ${item.progress.text}`
    if (item.progress.kind === "branch_text") return `[${item.progress.name}] [text] ${item.progress.text}`
    if (item.progress.kind === "branch_context_published") {
      return `[${item.progress.name}] [context] published ${item.progress.event} (${item.progress.id})`
    }
    return
  }
  if (item.type === "winner" && item.data?.["winner"]) return `winner: ${String(item.data["winner"])}`
  if (item.type === "applied") {
    const state = item.data?.["status"]
    const branch = item.data?.["branch"]
    if (state === "completed") return `apply: completed ${String(branch)}`
    if (state === "running") return `apply: running ${String(branch)}`
  }
  if (item.type === "apply_error") return `apply: error ${String(item.data?.["error"] ?? item.data?.["branch"] ?? "")}`
}

function rows(input: TaskEvent.Info[], fn: (item: TaskEvent.Info) => string | undefined) {
  return input.flatMap((item) => {
    const text = fn(item)
    if (!text) return []
    return [
      {
        id: item.id,
        time: item.time,
        text,
      },
    ]
  })
}

function taskRows(run: TaskRun.Info, msgs: MessageV2.WithParts[], stat: SessionStatus.Info) {
  const next = rows(run.events, taskEvent)
  if (next.length) return next
  return events(msgs, stat)
}

function branchRows(state: BranchState) {
  const next = rows(state.events, branchEvent)
  if (
    state.events.some(
      (item) =>
        item.type === "progress" &&
        (item.progress?.kind === "branch_tool_started" ||
          item.progress?.kind === "branch_tool_completed" ||
          item.progress?.kind === "branch_tool_error" ||
          item.progress?.kind === "branch_reasoning" ||
          item.progress?.kind === "branch_text" ||
          item.progress?.kind === "branch_context_published"),
    )
  ) {
    return next
  }
  return
}

function events(msgs: MessageV2.WithParts[], stat: SessionStatus.Info) {
  const rows = msgs.flatMap((msg) => {
    if (msg.info.role !== "assistant") return [] as { time: number; key: string; text: string }[]
    return msg.parts.flatMap((part) => {
      if (part.type === "tool") {
        if (part.state.status === "running") {
          const title = part.state.title ? `: ${part.state.title}` : ""
          return [
            {
              time: part.state.time.start,
              key: `${msg.info.id}:${part.id}:1`,
              text: `[running] ${part.tool}${title}`,
            },
          ]
        }
        if (part.state.status === "completed") {
          return [
            {
              time: part.state.time.start,
              key: `${msg.info.id}:${part.id}:1`,
              text: `[running] ${part.tool}${part.state.title ? `: ${part.state.title}` : ""}`,
            },
            {
              time: part.state.time.end,
              key: `${msg.info.id}:${part.id}:2`,
              text: `[done] ${part.tool}`,
            },
          ]
        }
        if (part.state.status === "error") {
          return [
            {
              time: part.state.time.start,
              key: `${msg.info.id}:${part.id}:1`,
              text: `[running] ${part.tool}`,
            },
            {
              time: part.state.time.end,
              key: `${msg.info.id}:${part.id}:3`,
              text: `[error] ${part.tool}: ${part.state.error}`,
            },
          ]
        }
        return []
      }

      if (part.type === "reasoning") {
        const text = part.text.trim().replace(/\s+/g, " ")
        if (!text || !part.time?.end) return []
        return [
          {
            time: part.time.end,
            key: `${msg.info.id}:${part.id}:4`,
            text: `[thinking] ${text}`,
          },
        ]
      }

      if (part.type === "text") {
        const text = part.text.trim().replace(/\s+/g, " ")
        if (!text || !part.time?.end) return []
        return [
          {
            time: part.time.end,
            key: `${msg.info.id}:${part.id}:5`,
            text: `[text] ${text}`,
          },
        ]
      }

      return []
    })
  })

  const all = [...rows].sort((a, b) => a.time - b.time || a.key.localeCompare(b.key))
  const time = (all.at(-1)?.time ?? 0) + 1
  if (stat.type === "idle") {
    all.push({
      time,
      key: "status:idle",
      text: "status: idle",
    })
  }

  return all
    .sort((a, b) => a.time - b.time || a.key.localeCompare(b.key))
    .map((item, idx) => ({
      id: idx + 1,
      time: item.time,
      text: item.text,
    }))
}

function slice(rows: WatchRow[], cursor: number, limit: number) {
  const next = cursor > 0 ? rows.filter((item) => item.id > cursor).slice(0, limit) : rows.slice(-limit)
  return {
    rows: next.map((item) => item.text),
    cursor: next.at(-1)?.id ?? cursor,
  }
}

export const TaskStatusTool = Tool.define("task_status", {
  description: STATUS_DESCRIPTION,
  parameters: z.object({
    task_id: z.string().describe("Task ID returned from the task tool"),
  }),
  async execute(params) {
    const id = params.task_id
    const run = await TaskRun.ensure(id)
    const stat = SessionStatus.get(id)
    const msgs = await Session.messages({ sessionID: id, limit: 20 })
    const text = latest(msgs)
    const done = run.status !== "running"
    const tool = active(msgs)
    const body = taskDone(run, text) ?? running(msgs)
    const info = await shared(id)

    return {
      title: `Task ${run.status}`,
      metadata: {
        sessionId: id,
        status: stat,
        run,
        done,
        sharedContext: info,
      },
      output: [
        check(id),
        `status: ${run.status}`,
        ...(tool ? [`active_tool: ${tool}`] : []),
        ...sharedRows(info),
        body,
        "</task_status>",
      ].join("\n"),
    }
  },
})

export async function taskCancel(id: string) {
  const task = await Session.get(id)
  if (task.projectID !== Instance.project.id) {
    throw new Error(`Task not found in current project: ${id}`)
  }
  SessionPrompt.cancel(id)
  await TaskRun.cancel(id)
  return TaskRun.ensure(id)
}

export const TaskCancelTool = Tool.define("task_cancel", {
  description: CANCEL_DESCRIPTION,
  parameters: z.object({
    task_id: z.string().describe("Task ID returned from the task tool"),
  }),
  async execute(params, ctx) {
    const id = params.task_id

    await ctx.ask({
      permission: "task",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        task_id: id,
      },
    })

    await taskCancel(id)
    return {
      title: "Task cancelled",
      metadata: {
        sessionId: id,
        cancelled: true,
      },
      output: [check(id), "status: cancelled", "Task cancelled.", "</task_status>"].join("\n"),
    }
  },
})

export const TaskWatchTool = Tool.define("task_watch", {
  description: WATCH_DESCRIPTION,
  parameters: z.object({
    task_id: z.string().describe("Task ID returned from the task tool"),
    cursor: z.number().int().min(0).default(0).optional().describe("Return events after this event cursor"),
    wait_ms: z
      .number()
      .int()
      .min(0)
      .max(30000)
      .default(0)
      .optional()
      .describe("Optional long-poll wait timeout in milliseconds"),
    limit: z.number().int().min(1).max(100).default(20).optional().describe("Max number of events to return"),
  }),
  async execute(params) {
    const id = params.task_id
    const wait = params.wait_ms ?? 0
    const limit = params.limit ?? 20
    let cursor = params.cursor ?? 0
    const end = Date.now() + wait

    while (true) {
      const run = await TaskRun.ensure(id)
      const stat = SessionStatus.get(id)
      const msgs = await Session.messages({ sessionID: id })
      const next = slice(taskRows(run, msgs, stat), cursor, limit)
      const done = run.status !== "running"
      const info = await shared(id)

      if (next.rows.length || done || Date.now() >= end) {
        cursor = next.cursor
        return {
          title: `Task watch ${run.status}`,
          metadata: {
            sessionId: id,
            status: stat,
            run,
            done,
            cursor,
            sharedContext: info,
          },
          output: [
            check(id),
            `status: ${run.status}`,
            `cursor: ${cursor}`,
            ...sharedRows(info),
            ...(next.rows.length
              ? next.rows
              : [
                  done ? taskDone(run) ?? `Task ${run.status}.` : "No new updates yet.",
                ]),
            "</task_status>",
          ].join("\n"),
        }
      }

      await Bun.sleep(250)
    }
  },
})

export const TaskBranchStatusTool = Tool.define("task_branch_status", {
  description: BRANCH_STATUS_DESCRIPTION,
  parameters: branchStatusParameters,
  async execute(params) {
    const wait = params.wait_ms ?? 0
    const limit = params.limit ?? 20
    let cursor = params.cursor ?? 0
    const end = Date.now() + wait

    while (true) {
      const state = await branchLoad(params.branch_id)
      const flow = branchRows(state)
      const parts = await Promise.all(
        state.branches.map(async (item) => {
          const stat = SessionStatus.get(item.sessionId)
          const msgs = flow ? [] : await Session.messages({ sessionID: item.sessionId })
          return {
            item,
            stat,
            tool: flow ? undefined : active(msgs),
            rows: flow
              ? []
              : taskRows(await TaskRun.ensure(item.sessionId), msgs, stat).map((row) => ({
                  time: row.time,
                  key: `${item.sessionId}:${row.id}`,
                  text: `[${item.name}] ${row.text}`,
                })),
          }
        }),
      )
      const merged = flow
        ? flow
        : parts
            .flatMap((item) => item.rows)
            .sort((a, b) => a.time - b.time || a.key.localeCompare(b.key))
            .map((item, idx) => ({
              id: idx + 1,
              time: item.time,
              text: item.text,
            }))
      const next = slice(merged, cursor, limit)
      const done = state.status !== "running"
      const info = await shared(state.sessionId, state.sessionId, "task_branch")
      const published = await branchContext(state.id, state.sessionId)

      if (next.rows.length || done || Date.now() >= end) {
        cursor = next.cursor
        return {
          title: `Task branch ${state.status}`,
          metadata: {
            branchId: state.id,
            status: state.status,
            done,
            cursor,
            winner: state.winner,
            sharedContext: info,
            sharedContextEntry: published,
          },
          output: [
            `branch_id: ${state.id}`,
            "<task_branch_status>",
            `status: ${state.status}`,
            ...(state.error ? [`error: ${state.error}`] : []),
            ...sharedRows(info),
            ...(published ? [`shared_context_entry: ${published.id} kind=${published.data.kind}`] : []),
            ...parts.map((item) => branchRow({ item: item.item, stat: item.stat, tool: item.tool })),
            ...(state.winner
              ? [branchWinnerLine(state)!]
              : []),
            ...(branchApplyLine(state) ? [branchApplyLine(state)!] : []),
            `cursor: ${cursor}`,
            ...(next.rows.length ? next.rows : [done ? branchDone(state) : "No new updates yet."]),
            "</task_branch_status>",
          ].join("\n"),
        }
      }

      await Bun.sleep(250)
    }
  },
})

export const TaskContextReconcileTool = Tool.define("task_context_reconcile", {
  description: CONTEXT_RECONCILE_DESCRIPTION,
  parameters: contextReconcileParameters,
  async execute(params, ctx) {
    const info = await Session.contextReconcile({
      session_id: ctx.sessionID,
      sources: params.sources,
      strategy: params.strategy,
      title: params.title,
      body: params.body,
      winner_context_id: params.winner_context_id,
      winner_session_id: params.winner_session_id,
      keep_sources: params.keep_sources ?? false,
    })
    const sharedContext = await shared(ctx.sessionID)
    return {
      title: params.title ?? "Context reconciled",
      metadata: {
        sessionId: ctx.sessionID,
        context: info,
        sharedContext,
      },
      output: [
        `context_id: ${info.id}`,
        "<task_context_reconcile>",
        `kind: ${info.data.kind}`,
        `strategy: ${params.strategy}`,
        `sources: ${params.sources.join(", ")}`,
        ...(params.winner_context_id ? [`winner_context_id: ${params.winner_context_id}`] : []),
        ...(params.winner_session_id ? [`winner_session_id: ${params.winner_session_id}`] : []),
        `shared_context_cursor: ${sharedContext.cursor}`,
        `shared_context_latest: ${sharedContext.latest}`,
        "</task_context_reconcile>",
      ].join("\n"),
    }
  },
})

export const TaskCoordinateTool = Tool.define("task_coordinate", {
  description: COORDINATE_DESCRIPTION,
  parameters: coordinationParameters,
  async execute(params, ctx) {
    const map = {
      request: { kind: "request", status: "open" },
      update: { kind: "update", status: "open" },
      answer: { kind: "answer", status: "answered" },
      claim: { kind: "claim", status: "claimed" },
      release: { kind: "release", status: "open" },
      resolve: { kind: "resolution", status: "resolved" },
    } as const
    const row = map[params.mode]
    const info = await Session.coordinationWrite({
      session_id: ctx.sessionID,
      target_session_id: params.target_session_id,
      target_agent: params.target_agent,
      request_id: params.request_id,
      title: params.title,
      body: params.body,
      metadata: params.metadata,
      kind: row.kind,
      status: row.status,
    })
    return {
      title: params.title ?? `Coordination ${params.mode}`,
      metadata: {
        sessionId: ctx.sessionID,
        coordination: info,
      },
      output: [
        `coordination_id: ${info.id}`,
        "<task_coordinate>",
        `kind: ${info.kind}`,
        `status: ${info.status}`,
        ...(info.request_id ? [`request_id: ${info.request_id}`] : []),
        ...(info.to_session_id ? [`target_session_id: ${info.to_session_id}`] : []),
        ...(info.to_agent ? [`target_agent: ${info.to_agent}`] : []),
        "</task_coordinate>",
      ].join("\n"),
    }
  },
})

async function read(file: string) {
  return Bun.file(file)
    .text()
    .catch(() => undefined)
}

export async function branchCancel(id: string) {
  const state = await branchLoad(id)
  if (state.projectID !== Instance.project.id) {
    throw new Error(`Branch run not found in current project: ${id}`)
  }
  if (state.status !== "running") return state
  state.branches.forEach((item) => {
    SessionPrompt.cancel(item.sessionId)
    void TaskRun.cancel(item.sessionId)
  })
  await TaskBranch.cancel(id)
  const seen = [] as { name: string; sessionId: string }[]
  const next = await branchUpdate(id, (draft) => {
    draft.status = "cancelled"
    draft.branches.forEach((item) => {
      if (item.status !== "running" && item.status !== "pending") return
      item.status = "cancelled"
      seen.push({
        name: item.name,
        sessionId: item.sessionId,
      })
    })
  })
  await Promise.all(
    seen.map((item) =>
      TaskBranch.append(id, {
        progress: {
          kind: "branch_cancelled",
          name: item.name,
          sessionId: item.sessionId,
        },
      }),
    ),
  )
  return next
}

export async function branchApply(input: z.infer<typeof branchApplyParameters>) {
  const state = await branchLoad(input.branch_id)
  if (state.status === "running") throw new Error(`Branch run still running: ${state.id}`)

  const item = choose(state, input.branch)
  if (!item) throw new Error(`Branch not found in run: ${input.branch ?? state.id}`)
  if (!item.diff) throw new Error(`Branch has no captured diff: ${item.name}`)
  const diff = item.diff

  const clash = [] as string[]
  for (const row of diff) {
    const file = path.join(state.base.root, row.file)
    const cur = await read(file)
    const now = cur ?? ""
    if (row.status === "deleted" && cur === undefined) continue
    if (row.status !== "deleted" && now === row.after) continue
    if (now !== row.before) clash.push(row.file)
  }
  if (clash.length) throw new Error(`Apply blocked by local changes: ${clash.join(", ")}`)

  await TaskApply.create({ state, item })
  await TaskBranch.setApply(state.id, {
    status: "running",
    name: item.name,
    sessionId: item.sessionId,
    files: diff.length,
    time: Date.now(),
  })

  try {
    await TaskApply.watch(state.id, async () => {
      for (const row of diff) {
        const file = path.join(state.base.root, row.file)
        if (row.status === "deleted") {
          await fs.rm(file, { force: true })
          continue
        }
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, row.after)
      }
    })
  } catch (err) {
    const fail = errText(err)
    const text = await TaskApply.rollback(state.id)
      .then(async () => {
        await TaskApply.clear(state.id)
        return fail
      })
      .catch((roll) => `${fail}; rollback failed: ${errText(roll)}`)
    await TaskBranch.setApply(state.id, {
      status: "error",
      name: item.name,
      sessionId: item.sessionId,
      files: diff.length,
      time: Date.now(),
      error: text,
    })
    if (text === fail) throw err
    throw new Error(text)
  }

  await TaskApply.clear(state.id)
  await TaskBranch.setApply(state.id, {
    status: "completed",
    name: item.name,
    sessionId: item.sessionId,
    files: diff.length,
    time: Date.now(),
  })
  return { state: await branchLoad(state.id), item }
}

export const TaskBranchApplyTool = Tool.define("task_branch_apply", {
  description: BRANCH_APPLY_DESCRIPTION,
  parameters: branchApplyParameters,
  async execute(params, ctx) {
    const state = await branchLoad(params.branch_id)
    const item = choose(state, params.branch)
    if (!item) throw new Error(`Branch not found in run: ${params.branch ?? state.id}`)
    if (!item.diff) throw new Error(`Branch has no captured diff: ${item.name}`)

    const files = item.diff.map((row) => row.file)
    await ctx.ask({
      permission: "edit",
      patterns: files,
      always: files,
      metadata: {
        branch_id: state.id,
        task_id: item.sessionId,
      },
    })

    const next = await branchApply(params)

    return {
      title: `Applied ${item.name}`,
      metadata: {
        branchId: next.state.id,
        sessionId: item.sessionId,
        files: item.diff.length,
      },
      output: [
        `branch_id: ${next.state.id}`,
        "<task_branch_apply>",
        `status: applied`,
        `branch: ${item.name}`,
        `task_id: ${item.sessionId}`,
        `files: ${item.diff.length}`,
        "</task_branch_apply>",
      ].join("\n"),
    }
  },
})

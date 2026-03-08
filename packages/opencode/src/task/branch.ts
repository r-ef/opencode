import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import z from "zod"
import { Snapshot } from "@/snapshot"
import { TaskEvent } from "./event"
import { TaskRun } from "./run"

export namespace TaskBranch {
  const log = Log.create({ service: "task.branch" })
  const tick = 1000

  export const Eval = z.object({
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
  export type Eval = z.infer<typeof Eval>

  export const RowStatus = z.enum(["pending", "running", "completed", "error", "cancelled", "interrupted"])
  export type RowStatus = z.infer<typeof RowStatus>

  export const Row = z.object({
    name: z.string(),
    prompt: z.string(),
    sessionId: Identifier.schema("session"),
    status: RowStatus,
    output: z.string().optional(),
    error: z.string().optional(),
    snapshot: z.string().optional(),
    diff: Snapshot.FileDiff.array().optional(),
    eval: Eval.optional(),
    dir: z.string().optional(),
    branch: z.string().optional(),
    cleanup: z
      .object({
        done: z.boolean(),
        error: z.string().optional(),
      })
      .optional(),
  })
  export type Row = z.infer<typeof Row>

  export const Winner = z.object({
    name: z.string(),
    sessionId: Identifier.schema("session"),
    score: z.number().int().min(0).max(100),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
  })
  export type Winner = z.infer<typeof Winner>

  export const Apply = z
    .object({
      status: z.enum(["running", "completed", "error"]),
      name: z.string(),
      sessionId: Identifier.schema("session"),
      files: z.number().int().min(0),
      time: z.number().int(),
      error: z.string().optional(),
    })
    .nullable()
    .optional()
  export type Apply = z.infer<typeof Apply>

  export const Status = z.enum(["running", "completed", "error", "cancelled", "interrupted"])
  export type Status = z.infer<typeof Status>

  export const Info = z
    .object({
      id: Identifier.schema("tool"),
      sessionId: Identifier.schema("session"),
      rootSessionId: Identifier.schema("session"),
      projectID: z.string(),
      directory: z.string(),
      messageId: Identifier.schema("message"),
      description: z.string(),
      prompt: z.string(),
      subagent: z.string(),
      background: z.boolean(),
      created: z.number().int(),
      updated: z.number().int(),
      status: Status,
      error: z.string().optional(),
      base: z.object({
        dir: z.string(),
        root: z.string(),
        snapshot: z.string().optional(),
      }),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      branches: z.array(Row),
      winner: Winner.nullable(),
      applied: Apply,
      runtime: TaskRun.Runtime.optional(),
      events: TaskEvent.Info.array(),
    })
    .meta({
      ref: "TaskBranchRun",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "task.branch.updated",
      z.object({
        info: Info,
      }),
    ),
    Entry: BusEvent.define(
      "task.branch.event",
      z.object({
        branchID: Identifier.schema("tool"),
        event: TaskEvent.Info,
      }),
    ),
  }

  function key(id: string) {
    return ["task_branch", id]
  }

  function owner() {
    return `${process.pid}:${Instance.directory}`
  }

  function running(now = Date.now()) {
    return {
      owner: owner(),
      pid: process.pid,
      started: now,
      heartbeat: now,
    } satisfies TaskRun.Runtime
  }

  function norm(raw: unknown) {
    const row = raw as {
      sessionId?: string
      projectID?: string
      directory?: string
      rootSessionId?: string
      updated?: number
      base?: {
        dir?: string
        root?: string
      }
      applied?:
        | {
            status?: "running" | "completed" | "error"
            name: string
            sessionId: string
            files: number
            time: number
            error?: string
          }
        | {
            name: string
            sessionId: string
            files: number
            time: number
          }
        | null
      events?: TaskEvent.Info[]
    }
    return {
      ...row,
      rootSessionId: row.rootSessionId ?? row.sessionId,
      projectID: row.projectID ?? Instance.project.id,
      directory: row.directory ?? row.base?.dir ?? row.base?.root ?? Instance.directory,
      updated: row.updated ?? Date.now(),
      applied:
        row.applied === null || row.applied === undefined
          ? row.applied
          : {
              ...row.applied,
              status: ("status" in row.applied ? row.applied.status : undefined) ?? "completed",
            },
      events: row.events ?? [],
    }
  }

  async function save(info: Info) {
    await Storage.write(key(info.id), info)
    await Bus.publish(Event.Updated, { info })
    const event = info.events.at(-1)
    if (event) await Bus.publish(Event.Entry, { branchID: info.id, event })
    return info
  }

  export async function get(id: string) {
    const raw = await Storage.read<unknown>(key(id))
    return Info.parse(norm(raw))
  }

  export async function list(input?: {
    directory?: string
    sessionId?: string
    status?: Status
    limit?: number
  }) {
    const keys = await Storage.list(["task_branch"])
    const rows = await Promise.all(
      keys.map(async (item) => {
        const id = item.at(-1)
        if (!id) return
        return get(id).catch((err) => {
          log.warn("failed to read task branch", { id, error: err })
        })
      }),
    )
    return rows
      .filter((item): item is Info => Boolean(item))
      .filter((item) => item.projectID === Instance.project.id)
      .filter((item) => (input?.directory ? item.directory === input.directory : true))
      .filter((item) => (input?.sessionId ? item.sessionId === input.sessionId : true))
      .filter((item) => (input?.status ? item.status === input.status : true))
      .toSorted((a, b) => b.updated - a.updated || b.id.localeCompare(a.id))
      .slice(0, input?.limit ?? 100)
  }

  export async function create(input: Omit<Info, "updated" | "events" | "runtime">) {
    const now = Date.now()
    const info = Info.parse({
      ...input,
      updated: now,
      runtime: running(now),
      events: TaskEvent.push(undefined, {
        type: "created",
        title: input.description,
      }),
    })
    return save(info)
  }

  export async function update(id: string, fn: (draft: Info) => void) {
    const next = await Storage.update<Info>(key(id), (draft) => {
      const item = Info.parse(norm(draft))
      fn(item)
      Object.assign(draft, item, {
        updated: Date.now(),
      })
    })
    const info = Info.parse(norm(next))
    await Bus.publish(Event.Updated, { info })
    return info
  }

  export async function beat(id: string) {
    const info = await get(id).catch(() => undefined)
    if (!info || info.status !== "running") return info
    const now = Date.now()
    const next = Info.parse({
      ...info,
      updated: now,
      runtime: info.runtime
        ? {
            ...info.runtime,
            owner: owner(),
            pid: process.pid,
            heartbeat: now,
          }
        : running(now),
    })
    await Storage.write(key(id), next)
    await Bus.publish(Event.Updated, { info: next })
    return next
  }

  export async function finish(id: string, input: { status: Exclude<Status, "running">; error?: string; winner?: Winner | null }) {
    const info = await get(id)
    if (info.status !== "running") return info
    const next = Info.parse({
      ...info,
      status: input.status,
      error: input.error,
      winner: input.winner ?? info.winner,
      updated: Date.now(),
      runtime: undefined,
      events: TaskEvent.push(info.events, {
        type: input.status === "completed" ? "completed" : input.status,
        title: info.description,
        data: {
          winner: input.winner?.sessionId,
          error: input.error,
        },
      }),
    })
    return save(next)
  }

  export async function append(
    id: string,
    input: {
      title?: string
      data?: Record<string, unknown>
      progress: TaskEvent.Progress
      time?: number
    },
  ) {
    const info = await get(id).catch(() => undefined)
    if (!info) return info
    const next = Info.parse({
      ...info,
      updated: input.time ?? Date.now(),
      events: TaskEvent.push(info.events, {
        type: "progress",
        title: input.title,
        data: input.data,
        progress: input.progress,
        time: input.time,
      }),
    })
    return save(next)
  }

  export async function cancel(id: string) {
    return finish(id, { status: "cancelled" })
  }

  export async function interrupt(id: string, error = "Branch runtime heartbeat expired") {
    const info = await get(id).catch(() => undefined)
    if (!info || info.status !== "running") return info
    return finish(id, { status: "interrupted", error })
  }

  export async function markWinner(id: string, winner: Winner | null) {
    const info = await update(id, (draft) => {
      draft.winner = winner
      draft.events = TaskEvent.push(draft.events, {
        type: "winner",
        title: draft.description,
        data: {
          winner: winner?.sessionId,
        },
      })
    })
    const event = info.events.at(-1)
    if (event) await Bus.publish(Event.Entry, { branchID: id, event })
    return info
  }

  export async function setApply(
    id: string,
    applied:
      | {
          status: "running" | "completed" | "error"
          name: string
          sessionId: string
          files: number
          time: number
          error?: string
        }
      | null,
  ) {
    const info = await update(id, (draft) => {
      draft.applied = applied
      draft.events = TaskEvent.push(draft.events, {
        type: applied?.status === "error" ? "apply_error" : "applied",
        title: draft.description,
        data: {
          branch: applied?.sessionId,
          status: applied?.status,
          error: applied?.error,
        },
      })
    })
    const event = info.events.at(-1)
    if (event) await Bus.publish(Event.Entry, { branchID: id, event })
    return info
  }

  export async function watch<T>(id: string, fn: () => Promise<T>) {
    const info = await get(id)
    const map = new Map(info.branches.map((item) => [item.sessionId, item.name]))
    const seen = new Set<string>()
    const timer = setInterval(() => {
      void beat(id)
    }, tick)
    timer.unref()
    const off = Bus.subscribe(TaskRun.Event.Entry, (event) => {
      const name = map.get(event.properties.taskID)
      if (!name) return
      const row = event.properties.event
      const key = `${event.properties.taskID}:${row.id}`
      if (seen.has(key)) return
      seen.add(key)
      if (row.type !== "progress" || !row.progress) return
      if (row.progress.kind === "tool_started") {
        void append(id, {
          progress: {
            kind: "branch_tool_started",
            name,
            sessionId: event.properties.taskID,
            tool: row.progress.tool,
            title: row.progress.title,
          },
          time: row.time,
        })
        return
      }
      if (row.progress.kind === "tool_completed") {
        void append(id, {
          progress: {
            kind: "branch_tool_completed",
            name,
            sessionId: event.properties.taskID,
            tool: row.progress.tool,
            title: row.progress.title,
          },
          time: row.time,
        })
        return
      }
      if (row.progress.kind === "tool_error") {
        void append(id, {
          progress: {
            kind: "branch_tool_error",
            name,
            sessionId: event.properties.taskID,
            tool: row.progress.tool,
            error: row.progress.error,
          },
          time: row.time,
        })
        return
      }
      if (row.progress.kind === "reasoning") {
        void append(id, {
          progress: {
            kind: "branch_reasoning",
            name,
            sessionId: event.properties.taskID,
            text: row.progress.text,
          },
          time: row.time,
        })
        return
      }
      if (row.progress.kind === "text") {
        void append(id, {
          progress: {
            kind: "branch_text",
            name,
            sessionId: event.properties.taskID,
            text: row.progress.text,
          },
          time: row.time,
        })
        return
      }
      if (row.progress.kind !== "context_published") return
      void append(id, {
        progress: {
          kind: "branch_context_published",
          name,
          sessionId: event.properties.taskID,
          id: row.progress.id,
          event: row.progress.event,
        },
        time: row.time,
      })
    })
    try {
      return await fn()
    } finally {
      off()
      clearInterval(timer)
    }
  }

  export async function root(id: string) {
    const info = await get(id)
    return Session.get(info.sessionId)
  }
}

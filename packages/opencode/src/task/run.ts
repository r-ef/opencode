import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import z from "zod"
import { TaskEvent } from "./event"

export namespace TaskRun {
  const log = Log.create({ service: "task.run" })
  const tick = 1000

  export const Status = z
    .enum(["running", "completed", "error", "cancelled", "interrupted"])
    .meta({
      ref: "TaskRunStatus",
    })
  export type Status = z.infer<typeof Status>

  export const Runtime = z
    .object({
      owner: z.string(),
      pid: z.number().int(),
      started: z.number().int(),
      heartbeat: z.number().int(),
    })
    .meta({
      ref: "TaskRuntime",
    })
  export type Runtime = z.infer<typeof Runtime>

  export const Info = z
    .object({
      id: Identifier.schema("session"),
      sessionID: Identifier.schema("session"),
      parentSessionID: Identifier.schema("session"),
      rootSessionID: Identifier.schema("session"),
      projectID: z.string(),
      directory: z.string(),
      description: z.string(),
      prompt: z.string(),
      agent: z.string(),
      background: z.boolean(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      status: Status,
      output: z.string().optional(),
      error: z.string().optional(),
      runtime: Runtime.optional(),
      time: z.object({
        created: z.number().int(),
        updated: z.number().int(),
        completed: z.number().int().optional(),
      }),
      events: TaskEvent.Info.array(),
    })
    .meta({
      ref: "TaskRun",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "task.updated",
      z.object({
        info: Info,
      }),
    ),
    Entry: BusEvent.define(
      "task.event",
      z.object({
        taskID: Identifier.schema("session"),
        event: TaskEvent.Info,
      }),
    ),
  }

  function key(id: string) {
    return ["task_run", id]
  }

  function owner() {
    return `${process.pid}:${Instance.directory}`
  }

  async function save(info: Info) {
    await Storage.write(key(info.id), info)
    await Bus.publish(Event.Updated, { info })
    const event = info.events.at(-1)
    if (event) await Bus.publish(Event.Entry, { taskID: info.id, event })
    return info
  }

  function running(now = Date.now()) {
    return {
      owner: owner(),
      pid: process.pid,
      started: now,
      heartbeat: now,
    } satisfies Runtime
  }

  export async function get(id: string) {
    const raw = await Storage.read<Info>(key(id))
    return Info.parse(raw)
  }

  export async function fromSession(id: string) {
    const session = await Session.get(id)
    if (session.kind !== "subagent") throw new Error(`Task is not a subagent session: ${id}`)
    if (session.projectID !== Instance.project.id) throw new Error(`Task not found in current project: ${id}`)

    const msgs = await Session.messages({ sessionID: id })
    const user = msgs.find((item): item is MessageV2.WithParts & { info: MessageV2.User } => item.info.role === "user")?.info
    const last = msgs.findLast((item) => item.info.role === "assistant")
    const text = last?.parts.findLast((item) => item.type === "text")
    const stat = SessionStatus.get(id)
    const status = (() => {
      if (stat.type !== "idle") return "running" as const
      if (last?.info.role === "assistant" && last.info.error) return "error" as const
      return "completed" as const
    })()

    return Info.parse({
      id,
      sessionID: id,
      parentSessionID: session.parentID,
      rootSessionID: session.rootID,
      projectID: session.projectID,
      directory: session.directory,
      description: session.title,
      prompt: text?.text ?? "",
      agent: user?.agent ?? "build",
      background: false,
      model: user?.model ?? { providerID: "unknown", modelID: "unknown" },
      status,
      output: text?.text,
      error: last?.info.role === "assistant" ? last.info.error?.data?.message : undefined,
      runtime: status === "running" ? running(session.time.updated) : undefined,
      time: {
        created: session.time.created,
        updated: session.time.updated,
        completed: last?.info.role === "assistant" ? last.info.time.completed : undefined,
      },
      events: [],
    })
  }

  export async function ensure(id: string) {
    return get(id).catch(() => fromSession(id))
  }

  export async function list(input?: {
    directory?: string
    parentSessionID?: string
    rootSessionID?: string
    status?: Status
    limit?: number
  }) {
    const keys = await Storage.list(["task_run"])
    const rows = await Promise.all(
      keys.map(async (item) => {
        const id = item.at(-1)
        if (!id) return
        return get(id).catch((err) => {
          log.warn("failed to read task run", { id, error: err })
        })
      }),
    )
    return rows
      .filter((item): item is Info => Boolean(item))
      .filter((item) => item.projectID === Instance.project.id)
      .filter((item) => (input?.directory ? item.directory === input.directory : true))
      .filter((item) => (input?.parentSessionID ? item.parentSessionID === input.parentSessionID : true))
      .filter((item) => (input?.rootSessionID ? item.rootSessionID === input.rootSessionID : true))
      .filter((item) => (input?.status ? item.status === input.status : true))
      .toSorted((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
      .slice(0, input?.limit ?? 100)
  }

  export async function upsert(input: {
    session: Session.Info
    parent: Session.Info
    description: string
    prompt: string
    agent: string
    background: boolean
    model: {
      providerID: string
      modelID: string
    }
    resumed?: boolean
  }) {
    const now = Date.now()
    const existing = await get(input.session.id).catch(() => undefined)
    const event = input.resumed ? "resumed" : existing ? "running" : "created"
    const info = Info.parse({
      id: input.session.id,
      sessionID: input.session.id,
      parentSessionID: input.parent.id,
      rootSessionID: input.parent.rootID,
      projectID: input.session.projectID,
      directory: input.session.directory,
      description: input.description,
      prompt: input.prompt,
      agent: input.agent,
      background: input.background,
      model: input.model,
      status: "running",
      output: undefined,
      error: undefined,
      runtime: existing?.runtime
        ? {
            ...existing.runtime,
            owner: owner(),
            pid: process.pid,
            heartbeat: now,
          }
        : running(now),
      time: {
        created: existing?.time.created ?? now,
        updated: now,
      },
      events: TaskEvent.push(existing?.events, {
        type: event,
        title: input.description,
        data: {
          agent: input.agent,
          background: input.background,
        },
      }),
    })
    return save(info)
  }

  export async function beat(id: string) {
    const info = await get(id).catch(() => undefined)
    if (!info || info.status !== "running") return info
    const now = Date.now()
    const next = Info.parse({
      ...info,
      runtime: info.runtime
        ? {
            ...info.runtime,
            owner: owner(),
            pid: process.pid,
            heartbeat: now,
          }
        : running(now),
      time: {
        ...info.time,
        updated: now,
      },
    })
    await Storage.write(key(id), next)
    await Bus.publish(Event.Updated, { info: next })
    return next
  }

  export async function finish(id: string, input: { status: Exclude<Status, "running">; output?: string; error?: string }) {
    const info = await ensure(id)
    if (info.status !== "running") return info
    const next = Info.parse({
      ...info,
      status: input.status,
      output: input.output ?? info.output,
      error: input.error,
      runtime: undefined,
      time: {
        ...info.time,
        updated: Date.now(),
        completed: Date.now(),
      },
      events: TaskEvent.push(info.events, {
        type: input.status === "completed" ? "completed" : input.status,
        title: info.description,
        data: {
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
      time: {
        ...info.time,
        updated: input.time ?? Date.now(),
      },
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

  export async function interrupt(id: string, error = "Task runtime heartbeat expired") {
    const info = await get(id).catch(() => undefined)
    if (!info || info.status !== "running") return info
    return finish(id, { status: "interrupted", error })
  }

  export async function watch<T>(id: string, fn: () => Promise<T>) {
    const seen = new Set<string>()
    const timer = setInterval(() => {
      void beat(id)
    }, tick)
    timer.unref()
    const off = [
      Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
        const part = event.properties.part
        if (part.sessionID !== id) return
        if (part.type === "tool") {
          if (part.state.status === "running") {
            const key = `${part.id}:tool:running`
            if (seen.has(key)) return
            seen.add(key)
            void append(id, {
              progress: {
                kind: "tool_started",
                tool: part.tool,
                title: part.state.title,
              },
            })
            return
          }
          if (part.state.status === "completed") {
            const key = `${part.id}:tool:completed`
            if (seen.has(key)) return
            seen.add(key)
            void append(id, {
              progress: {
                kind: "tool_completed",
                tool: part.tool,
                title: part.state.title,
              },
            })
            return
          }
          if (part.state.status === "error") {
            const key = `${part.id}:tool:error`
            if (seen.has(key)) return
            seen.add(key)
            void append(id, {
              progress: {
                kind: "tool_error",
                tool: part.tool,
                error: part.state.error,
              },
            })
            return
          }
          return
        }
        if (part.type === "reasoning") {
          const text = part.text.trim().replace(/\s+/g, " ")
          if (!text || !part.time?.end) return
          const key = `${part.id}:reasoning`
          if (seen.has(key)) return
          seen.add(key)
          void append(id, {
            progress: {
              kind: "reasoning",
              text,
            },
            time: part.time.end,
          })
          return
        }
        if (part.type !== "text") return
        const text = part.text.trim().replace(/\s+/g, " ")
        if (!text || !part.time?.end) return
        const key = `${part.id}:text`
        if (seen.has(key)) return
        seen.add(key)
        void append(id, {
          progress: {
            kind: "text",
            text,
          },
          time: part.time.end,
        })
      }),
      Bus.subscribe(Session.Event.Context, (event) => {
        const info = event.properties.info
        if (info.session_id !== id) return
        const key = `context:${info.id}`
        if (seen.has(key)) return
        seen.add(key)
        void append(id, {
          progress: {
            kind: "context_published",
            id: info.id,
            event: info.data.kind,
          },
          time: info.time_created,
        })
      }),
    ]
    try {
      return await fn()
    } finally {
      off.forEach((fn) => fn())
      clearInterval(timer)
    }
  }
}

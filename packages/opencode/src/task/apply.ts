import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { TaskRun } from "./run"
import { TaskBranch } from "./branch"
import fs from "fs/promises"
import path from "path"
import z from "zod"

export namespace TaskApply {
  const log = Log.create({ service: "task.apply" })
  const tick = 1000

  export const File = z.object({
    file: z.string(),
    exists: z.boolean(),
    text: z.string().optional(),
  })
  export type File = z.infer<typeof File>

  export const Info = z.object({
    branchID: Identifier.schema("tool"),
    projectID: z.string(),
    directory: z.string(),
    apply: z.object({
      name: z.string(),
      sessionId: Identifier.schema("session"),
      files: z.number().int().min(0),
      time: z.number().int(),
    }),
    files: File.array(),
    runtime: TaskRun.Runtime,
  })
  export type Info = z.infer<typeof Info>

  function key(id: string) {
    return ["task_branch_apply", id]
  }

  function owner() {
    return `${process.pid}:${Instance.directory}`
  }

  function live(now = Date.now()) {
    return {
      owner: owner(),
      pid: process.pid,
      started: now,
      heartbeat: now,
    } satisfies TaskRun.Runtime
  }

  export async function get(id: string) {
    return Info.parse(await Storage.read<Info>(key(id)))
  }

  export async function list() {
    const keys = await Storage.list(["task_branch_apply"])
    const rows = await Promise.all(
      keys.map(async (item) => {
        const id = item.at(-1)
        if (!id) return
        return get(id).catch((err) => {
          log.warn("failed to read task apply", { id, error: err })
        })
      }),
    )
    return rows.filter((item): item is Info => Boolean(item)).filter((item) => item.projectID === Instance.project.id)
  }

  export async function create(input: { state: TaskBranch.Info; item: TaskBranch.Row }) {
    if (!input.item.diff) throw new Error(`Branch has no captured diff: ${input.item.name}`)
    const now = Date.now()
    const files = await Promise.all(
      input.item.diff.map(async (row) => {
        const file = path.join(input.state.base.root, row.file)
        const text = await Bun.file(file)
          .text()
          .catch(() => undefined)
        return {
          file: row.file,
          exists: text !== undefined,
          text,
        } satisfies File
      }),
    )
    const info = Info.parse({
      branchID: input.state.id,
      projectID: input.state.projectID,
      directory: input.state.base.root,
      apply: {
        name: input.item.name,
        sessionId: input.item.sessionId,
        files: input.item.diff.length,
        time: now,
      },
      files,
      runtime: live(now),
    })
    await Storage.write(key(input.state.id), info)
    return info
  }

  export async function beat(id: string) {
    const info = await get(id).catch(() => undefined)
    if (!info) return info
    const now = Date.now()
    const next = Info.parse({
      ...info,
      runtime: {
        ...info.runtime,
        owner: owner(),
        pid: process.pid,
        heartbeat: now,
      },
    })
    await Storage.write(key(id), next)
    return next
  }

  export async function clear(id: string) {
    await Storage.remove(key(id)).catch(() => undefined)
  }

  export async function rollback(id: string, info?: Info) {
    const row = info ?? (await get(id))
    await Instance.provide({
      directory: row.directory,
      fn: async () => {
        for (const file of row.files) {
          const target = path.join(row.directory, file.file)
          if (!file.exists) {
            await fs.rm(target, { force: true }).catch(() => undefined)
            continue
          }
          await fs.mkdir(path.dirname(target), { recursive: true })
          await Bun.write(target, file.text ?? "")
        }
      },
    })
    return row
  }

  export async function watch<T>(id: string, fn: () => Promise<T>) {
    const timer = setInterval(() => {
      void beat(id)
    }, tick)
    timer.unref()
    try {
      return await fn()
    } finally {
      clearInterval(timer)
    }
  }
}

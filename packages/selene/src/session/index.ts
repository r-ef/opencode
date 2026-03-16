import { Slug } from "@selene-ai/util/slug"
import { $, fileURLToPath, pathToFileURL } from "bun"
import fs from "fs/promises"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata } from "ai"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Identifier } from "../id/id"
import { Installation } from "../installation"

import { Database, NotFoundError, eq, and, or, gte, gt, isNull, desc, asc, like, inArray, lt } from "../storage/db"
import type { SQL } from "../storage/db"
import {
  SessionTable,
  MessageTable,
  PartTable,
  SessionContextTable,
  SessionContextStateTable,
  SessionCoordinationTable,
  SessionCoordinationStateTable,
} from "./session.sql"
import { ProjectTable } from "../project/project.sql"
import { Storage } from "@/storage/storage"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { Instance } from "../project/instance"
import { InstanceBootstrap } from "../project/bootstrap"
import { SessionPrompt } from "./prompt"
import { fn } from "@/util/fn"
import { Command } from "../command"
import { Snapshot } from "@/snapshot"
import { WorkspaceContext } from "../control-plane/workspace-context"

import type { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { Global } from "@/global"
import type { LanguageModelV2Usage } from "@ai-sdk/provider"
import { iife } from "@/util/iife"
import { Worktree } from "@/worktree"

export namespace Session {
  const log = Log.create({ service: "session" })

  const parentTitlePrefix = "New session - "
  const childTitlePrefix = "Child session - "

  function createDefaultTitle(isChild = false) {
    return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
  }

  export function isDefaultTitle(title: string) {
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  type SessionRow = typeof SessionTable.$inferSelect

  export function fromRow(row: SessionRow): Info {
    const summary =
      row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
        ? {
            additions: row.summary_additions ?? 0,
            deletions: row.summary_deletions ?? 0,
            files: row.summary_files ?? 0,
            diffs: row.summary_diffs ?? undefined,
          }
        : undefined
    const share = row.share_url ? { url: row.share_url } : undefined
    const revert = row.revert ?? undefined
    return {
      id: row.id,
      slug: row.slug,
      projectID: row.project_id,
      workspaceID: row.workspace_id ?? undefined,
      kind: row.kind === "subagent" ? "subagent" : "interactive",
      rootID: row.root_id ?? row.id,
      directory: row.directory,
      parentID: row.parent_id ?? undefined,
      branchFromSessionID: row.branch_from_session_id ?? undefined,
      branchFromMessageID: row.branch_from_message_id ?? undefined,
      title: row.title,
      version: row.version,
      summary,
      share,
      revert,
      permission: row.permission ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
        compacting: row.time_compacting ?? undefined,
        archived: row.time_archived ?? undefined,
      },
    }
  }

  export function toRow(info: Info) {
    return {
      id: info.id,
      project_id: info.projectID,
      workspace_id: info.workspaceID,
      kind: info.kind,
      root_id: info.rootID,
      parent_id: info.parentID,
      branch_from_session_id: info.branchFromSessionID,
      branch_from_message_id: info.branchFromMessageID,
      slug: info.slug,
      directory: info.directory,
      title: info.title,
      version: info.version,
      share_url: info.share?.url,
      summary_additions: info.summary?.additions,
      summary_deletions: info.summary?.deletions,
      summary_files: info.summary?.files,
      summary_diffs: info.summary?.diffs,
      revert: info.revert ?? null,
      permission: info.permission,
      time_created: info.time.created,
      time_updated: info.time.updated,
      time_compacting: info.time.compacting,
      time_archived: info.time.archived,
    }
  }

  function branchBase(title: string) {
    return title.replace(/ \((?:branch|fork) #\d+\)$/, "")
  }

  async function getBranchedTitle(session: Info) {
    const base = branchBase(session.title)
    const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\((?:branch|fork) #(\\d+)\\)$`)
    const rows = Database.use((db) =>
      db
        .select({ title: SessionTable.title })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, session.projectID),
            eq(SessionTable.root_id, session.rootID),
            eq(SessionTable.kind, "interactive"),
          ),
        )
        .all(),
    )
    const next = rows
      .map((row) => row.title.match(pattern)?.[1])
      .filter((row): row is string => Boolean(row))
      .map((row) => parseInt(row, 10))
      .reduce((max, row) => Math.max(max, row), 0)
    return `${base} (branch #${next + 1})`
  }

  export const Info = z
    .object({
      id: Identifier.schema("session"),
      slug: z.string(),
      projectID: z.string(),
      workspaceID: z.string().optional(),
      kind: z.enum(["interactive", "subagent"]),
      rootID: Identifier.schema("session"),
      directory: z.string(),
      parentID: Identifier.schema("session").optional(),
      branchFromSessionID: Identifier.schema("session").optional(),
      branchFromMessageID: Identifier.schema("message").optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      share: z
        .object({
          url: z.string(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      permission: PermissionNext.Ruleset.optional(),
      revert: z
        .object({
          messageID: z.string(),
          partID: z.string().optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
        })
        .optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  export const ProjectInfo = z
    .object({
      id: z.string(),
      name: z.string().optional(),
      worktree: z.string(),
    })
    .meta({
      ref: "ProjectSummary",
    })
  export type ProjectInfo = z.output<typeof ProjectInfo>

  export const GlobalInfo = Info.extend({
    project: ProjectInfo.nullable(),
  }).meta({
    ref: "GlobalSession",
  })
  export type GlobalInfo = z.output<typeof GlobalInfo>

  export const ContextData = z.object({
    kind: z.string(),
    title: z.string().optional(),
    body: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  export const ContextInfo = z.object({
    id: z.number().int(),
    root_session_id: z.string(),
    session_id: z.string(),
    time_created: z.number().int(),
    time_updated: z.number().int(),
    data: ContextData,
  })
  export type ContextInfo = z.infer<typeof ContextInfo>

  export const ContextState = z.object({
    session_id: z.string(),
    root_session_id: z.string(),
    cursor: z.number().int(),
    time_created: z.number().int(),
    time_updated: z.number().int(),
  })
  export type ContextState = z.infer<typeof ContextState>

  export const ContextStats = z.object({
    session_id: z.string(),
    root_session_id: z.string(),
    cursor: z.number().int(),
    latest: z.number().int(),
    unread: z.number().int(),
    pending: z.number().int(),
    published: z.number().int(),
    latest_entry: ContextInfo.optional(),
    latest_published: ContextInfo.optional(),
  })
  export type ContextStats = z.infer<typeof ContextStats>

  export const ContextTrim = z.object({
    session_id: z.string(),
    root_session_id: z.string(),
    cursor: z.number().int(),
    before: z.number().int(),
    after: z.number().int(),
    deleted: z.number().int(),
  })
  export type ContextTrim = z.infer<typeof ContextTrim>

  export const CoordinationKind = z.enum([
    "request",
    "update",
    "answer",
    "claim",
    "release",
    "conflict",
    "resolution",
  ])
  export type CoordinationKind = z.infer<typeof CoordinationKind>

  export const CoordinationStatus = z.enum(["open", "claimed", "answered", "resolved", "cancelled"])
  export type CoordinationStatus = z.infer<typeof CoordinationStatus>

  export const CoordinationInfo = z.object({
    id: z.number().int(),
    root_session_id: z.string(),
    from_session_id: z.string(),
    to_session_id: z.string().optional(),
    to_agent: z.string().optional(),
    request_id: z.string().optional(),
    kind: CoordinationKind,
    status: CoordinationStatus,
    title: z.string().optional(),
    body: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    time_created: z.number().int(),
    time_updated: z.number().int(),
  })
  export type CoordinationInfo = z.infer<typeof CoordinationInfo>

  export const CoordinationState = z.object({
    session_id: z.string(),
    root_session_id: z.string(),
    cursor: z.number().int(),
    time_created: z.number().int(),
    time_updated: z.number().int(),
  })
  export type CoordinationState = z.infer<typeof CoordinationState>

  export const CoordinationFeed = z.object({
    session_id: z.string(),
    root_session_id: z.string(),
    cursor: z.number().int(),
    latest: z.number().int(),
    unread: z.number().int(),
    entries: CoordinationInfo.array(),
  })
  export type CoordinationFeed = z.infer<typeof CoordinationFeed>

  export const Event = {
    Created: BusEvent.define(
      "session.created",
      z.object({
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        info: Info,
      }),
    ),
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        info: Info,
      }),
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: z.string(),
        diff: Snapshot.FileDiff.array(),
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: z.string().optional(),
        error: MessageV2.Assistant.shape.error,
      }),
    ),
    Context: BusEvent.define(
      "session.context",
      z.object({
        info: ContextInfo,
      }),
    ),
    ContextTrimmed: BusEvent.define(
      "session.context.trimmed",
      z.object({
        info: ContextTrim,
      }),
    ),
    Coordination: BusEvent.define(
      "session.coordination",
      z.object({
        action: z.enum(["created", "updated", "resolved"]),
        info: CoordinationInfo,
      }),
    ),
  }

  export const create = fn(
    z
      .object({
        parentID: Identifier.schema("session").optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
      })
      .optional(),
    async (input) => {
      return createNext({
        parentID: input?.parentID,
        directory: Instance.directory,
        title: input?.title,
        permission: input?.permission,
      })
    },
  )

  const branchInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
  })

  export async function provide<R>(input: {
    session?: Info
    sessionID?: string
    fn: (session: Info) => Promise<R> | R
  }) {
    const session = input.session ?? (input.sessionID ? await get(input.sessionID) : undefined)
    if (!session) throw new Error("Session not found")
    return WorkspaceContext.provide({
      workspaceID: session.workspaceID,
      fn: async () =>
        Instance.provide({
          directory: session.directory,
          init: InstanceBootstrap,
          fn: () => input.fn(session),
        }),
    })
  }

  function rewrite(input: { url: string; from: string; to: string }) {
    if (!input.url.startsWith("file:")) return
    const src = fileURLToPath(input.url)
    const rel = path.relative(input.from, src)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return
    const abs = path.join(input.to, rel)
    return { rel, abs, url: pathToFileURL(abs).href }
  }

  function cloneSource<T extends { path: string }>(value: T, next: { rel: string; abs: string }) {
    return {
      ...value,
      path: path.isAbsolute(value.path) ? next.abs : next.rel,
    }
  }

  function clonePart(input: { part: MessageV2.Part; from: string; to: string }): MessageV2.Part {
    const part = input.part
    if (part.type === "file") {
      const next = rewrite({
        url: part.url,
        from: input.from,
        to: input.to,
      })
      if (!next) return part
      return {
        ...part,
        url: next.url,
        source:
          part.source?.type === "file" || part.source?.type === "symbol" ? cloneSource(part.source, next) : part.source,
      }
    }
    if (part.type !== "subtask" || !part.parts?.length) return part
    return {
      ...part,
      parts: part.parts.map((item) => {
        if (item.type !== "file") return item
        const next = rewrite({
          url: item.url,
          from: input.from,
          to: input.to,
        })
        if (!next) return item
        return {
          ...item,
          url: next.url,
          source:
            item.source?.type === "file" || item.source?.type === "symbol"
              ? cloneSource(item.source, next)
              : item.source,
        }
      }),
    }
  }

  async function changes() {
    const text = await $`git status --porcelain=v1 -z --untracked-files=normal --ignored=no`
      .quiet()
      .cwd(Instance.worktree)
      .text()
    if (!text) return []

    const result = new Set<string>()
    const items = text.split("\0")
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item) continue
      const code = item.slice(0, 2)
      const first = item.slice(3)
      if (first) result.add(path.join(Instance.worktree, first))
      if (!/[RC]/.test(code[0] ?? "") && !/[RC]/.test(code[1] ?? "")) continue
      const next = items[i + 1]
      if (next) result.add(path.join(Instance.worktree, next))
      i++
    }
    return [...result]
  }

  async function sync(input: { from: string; to: string; files: string[] }) {
    await Promise.all(
      input.files.map(async (src) => {
        const rel = path.relative(input.from, src)
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return
        const dst = path.join(input.to, rel)
        const stat = await fs.lstat(src).catch(() => undefined)
        if (!stat) {
          await fs.rm(dst, { recursive: true, force: true }).catch(() => undefined)
          return
        }
        await fs.mkdir(path.dirname(dst), { recursive: true })
        await fs.rm(dst, { recursive: true, force: true }).catch(() => undefined)
        await fs.cp(src, dst, {
          recursive: stat.isDirectory(),
          force: true,
          dereference: false,
        })
      }),
    )
  }

  export const branch = fn(branchInput, async (input) => {
    const original = await get(input.sessionID)
    return provide({
      session: original,
      fn: async () => {
        if (Instance.project.vcs !== "git") {
          throw new Error("Interactive branch isolation requires a git project")
        }
        const title = await getBranchedTitle(original)
        const msgs = await messages({ sessionID: input.sessionID })
        const files = await changes()
        let work: Worktree.Info | undefined

        try {
          work = await Worktree.makeWorktreeInfo(title)
          const dir = work.directory
          await Worktree.createFromInfo(work)
          await Worktree.ready(work)

          if (files.length) {
            await sync({
              from: original.directory,
              to: dir,
              files,
            })
          }

          const session = await Instance.provide({
            directory: dir,
            init: InstanceBootstrap,
            fn: () =>
              createNext({
                directory: dir,
                title,
                permission: original.permission,
                kind: "interactive",
                rootID: original.rootID,
                branchFromSessionID: input.sessionID,
                branchFromMessageID: input.messageID,
              }),
          })
          const idMap = new Map<string, string>()

          for (const msg of msgs) {
            if (input.messageID && msg.info.id >= input.messageID) break
            const id = Identifier.ascending("message")
            idMap.set(msg.info.id, id)

            const parentID =
              msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
            const cloned = await updateMessage({
              ...msg.info,
              sessionID: session.id,
              id,
              ...(msg.info.role === "assistant"
                ? {
                    path: {
                      cwd: session.directory,
                      root: Instance.worktree,
                    },
                  }
                : {}),
              ...(parentID && { parentID }),
            })

            for (const item of msg.parts.map((part) =>
              clonePart({ part, from: original.directory, to: session.directory }),
            )) {
              await updatePart({
                ...item,
                id: Identifier.ascending("part"),
                messageID: cloned.id,
                sessionID: session.id,
              })
            }
          }
          return session
        } catch (err) {
          if (work) {
            await Worktree.remove({ directory: work.directory }).catch(() => undefined)
          }
          throw err
        }
      },
    })
  })

  export const fork = branch

  export const touch = fn(Identifier.schema("session"), async (sessionID) => {
    const now = Date.now()
    Database.use((db) => {
      const row = db
        .update(SessionTable)
        .set({ time_updated: now })
        .where(eq(SessionTable.id, sessionID))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Updated, { info }))
    })
  })

  export async function createNext(input: {
    id?: string
    title?: string
    parentID?: string
    directory: string
    permission?: PermissionNext.Ruleset
    kind?: Info["kind"]
    rootID?: string
    branchFromSessionID?: string
    branchFromMessageID?: string
  }) {
    if (input.kind === "interactive" && input.parentID) {
      throw new Error("Interactive sessions cannot have a parent session")
    }
    if (input.kind === "subagent" && !input.parentID) {
      throw new Error("Subagent sessions require a parent session")
    }
    const id = Identifier.descending("session", input.id)
    const parent = input.parentID ? await get(input.parentID) : undefined
    const kind = input.kind ?? (parent ? "subagent" : "interactive")
    const result: Info = {
      id,
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory: input.directory,
      workspaceID: WorkspaceContext.workspaceID,
      kind,
      rootID: input.rootID ?? parent?.rootID ?? id,
      parentID: input.parentID,
      branchFromSessionID: input.branchFromSessionID,
      branchFromMessageID: input.branchFromMessageID,
      title: input.title ?? createDefaultTitle(kind === "subagent"),
      permission: input.permission,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    }
    log.info("created", result)
    Database.use((db) => {
      db.insert(SessionTable).values(toRow(result)).run()
      Database.effect(() =>
        Bus.publish(Event.Created, {
          info: result,
        }),
      )
    })
    const cfg = await Config.get()
    if (
      result.kind === "interactive" &&
      !result.branchFromSessionID &&
      (Flag.SELENE_AUTO_SHARE || cfg.share === "auto")
    )
      share(result.id).catch(() => {
        // Silently ignore sharing errors during session creation
      })
    Bus.publish(Event.Updated, {
      info: result,
    })
    return result
  }

  export function plan(input: { slug: string; time: { created: number } }) {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, ".selene", "plans")
      : path.join(Global.Path.data, "plans")
    return path.join(base, [input.time.created, input.slug].join("-") + ".md")
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
    return fromRow(row)
  })

  export const share = fn(Identifier.schema("session"), async (id) => {
    const cfg = await Config.get()
    if (cfg.share === "disabled") {
      throw new Error("Sharing is disabled in configuration")
    }
    const { ShareNext } = await import("@/share/share-next")
    const share = await ShareNext.create(id)
    Database.use((db) => {
      const row = db.update(SessionTable).set({ share_url: share.url }).where(eq(SessionTable.id, id)).returning().get()
      if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Updated, { info }))
    })
    return share
  })

  export const unshare = fn(Identifier.schema("session"), async (id) => {
    // Use ShareNext to remove the share (same as share function uses ShareNext to create)
    const { ShareNext } = await import("@/share/share-next")
    await ShareNext.remove(id)
    Database.use((db) => {
      const row = db.update(SessionTable).set({ share_url: null }).where(eq(SessionTable.id, id)).returning().get()
      if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Updated, { info }))
    })
  })

  export const setTitle = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      title: z.string(),
    }),
    async (input) => {
      return Database.use((db) => {
        const row = db
          .update(SessionTable)
          .set({ title: input.title })
          .where(eq(SessionTable.id, input.sessionID))
          .returning()
          .get()
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const setArchived = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      time: z.number().optional(),
    }),
    async (input) => {
      return Database.use((db) => {
        const row = db
          .update(SessionTable)
          .set({ time_archived: input.time })
          .where(eq(SessionTable.id, input.sessionID))
          .returning()
          .get()
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const setPermission = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      permission: PermissionNext.Ruleset,
    }),
    async (input) => {
      return Database.use((db) => {
        const row = db
          .update(SessionTable)
          .set({ permission: input.permission, time_updated: Date.now() })
          .where(eq(SessionTable.id, input.sessionID))
          .returning()
          .get()
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const setRevert = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      revert: Info.shape.revert,
      summary: Info.shape.summary,
    }),
    async (input) => {
      return Database.use((db) => {
        const row = db
          .update(SessionTable)
          .set({
            revert: input.revert ?? null,
            summary_additions: input.summary?.additions,
            summary_deletions: input.summary?.deletions,
            summary_files: input.summary?.files,
            time_updated: Date.now(),
          })
          .where(eq(SessionTable.id, input.sessionID))
          .returning()
          .get()
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const clearRevert = fn(Identifier.schema("session"), async (sessionID) => {
    return Database.use((db) => {
      const row = db
        .update(SessionTable)
        .set({
          revert: null,
          time_updated: Date.now(),
        })
        .where(eq(SessionTable.id, sessionID))
        .returning()
        .get()
      if (!row) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Updated, { info }))
      return info
    })
  })

  export const setSummary = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      summary: Info.shape.summary,
    }),
    async (input) => {
      return Database.use((db) => {
        const row = db
          .update(SessionTable)
          .set({
            summary_additions: input.summary?.additions,
            summary_deletions: input.summary?.deletions,
            summary_files: input.summary?.files,
            time_updated: Date.now(),
          })
          .where(eq(SessionTable.id, input.sessionID))
          .returning()
          .get()
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    try {
      return await Storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID])
    } catch {
      return []
    }
  })

  export const messages = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      limit: z.number().optional(),
    }),
    async (input) => {
      const result = [] as MessageV2.WithParts[]
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (input.limit && result.length >= input.limit) break
        result.push(msg)
      }
      result.reverse()
      return result
    },
  )

  export function* list(input?: {
    directory?: string
    workspaceID?: string
    roots?: boolean
    start?: number
    search?: string
    limit?: number
  }) {
    const project = Instance.project
    const conditions = [eq(SessionTable.project_id, project.id)]

    if (WorkspaceContext.workspaceID) {
      conditions.push(eq(SessionTable.workspace_id, WorkspaceContext.workspaceID))
    }
    if (input?.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
    if (input?.roots) {
      conditions.push(eq(SessionTable.kind, "interactive"))
    }
    if (input?.start) {
      conditions.push(gte(SessionTable.time_updated, input.start))
    }
    if (input?.search) {
      conditions.push(like(SessionTable.title, `%${input.search}%`))
    }

    const limit = input?.limit ?? 100

    const rows = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(...conditions))
        .orderBy(desc(SessionTable.time_updated))
        .limit(limit)
        .all(),
    )
    for (const row of rows) {
      yield fromRow(row)
    }
  }

  export function* listGlobal(input?: {
    directory?: string
    roots?: boolean
    start?: number
    cursor?: number
    search?: string
    limit?: number
    archived?: boolean
  }) {
    const conditions: SQL[] = []

    if (input?.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
    if (input?.roots) {
      conditions.push(eq(SessionTable.kind, "interactive"))
    }
    if (input?.start) {
      conditions.push(gte(SessionTable.time_updated, input.start))
    }
    if (input?.cursor) {
      conditions.push(lt(SessionTable.time_updated, input.cursor))
    }
    if (input?.search) {
      conditions.push(like(SessionTable.title, `%${input.search}%`))
    }
    if (!input?.archived) {
      conditions.push(isNull(SessionTable.time_archived))
    }

    const limit = input?.limit ?? 100

    const rows = Database.use((db) => {
      const query =
        conditions.length > 0
          ? db
              .select()
              .from(SessionTable)
              .where(and(...conditions))
          : db.select().from(SessionTable)
      return query.orderBy(desc(SessionTable.time_updated), desc(SessionTable.id)).limit(limit).all()
    })

    const ids = [...new Set(rows.map((row) => row.project_id))]
    const projects = new Map<string, ProjectInfo>()

    if (ids.length > 0) {
      const items = Database.use((db) =>
        db
          .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
          .from(ProjectTable)
          .where(inArray(ProjectTable.id, ids))
          .all(),
      )
      for (const item of items) {
        projects.set(item.id, {
          id: item.id,
          name: item.name ?? undefined,
          worktree: item.worktree,
        })
      }
    }

    for (const row of rows) {
      const project = projects.get(row.project_id) ?? null
      yield { ...fromRow(row), project }
    }
  }

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    const project = Instance.project
    const rows = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, project.id),
            eq(SessionTable.parent_id, parentID),
            eq(SessionTable.kind, "subagent"),
          ),
        )
        .all(),
    )
    return rows.map(fromRow)
  })

  export const branches = fn(Identifier.schema("session"), async (sessionID) => {
    const session = await get(sessionID)
    const rows = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, session.projectID),
            eq(SessionTable.root_id, session.rootID),
            eq(SessionTable.kind, "interactive"),
          ),
        )
        .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
        .all(),
    )
    return rows.map(fromRow)
  })

  export const root = fn(Identifier.schema("session"), async (id) => {
    const session = await get(id)
    if (session.rootID === session.id) return session
    return get(session.rootID)
  })

  async function tree(id: string): Promise<string[]> {
    const top = await root(id)
    const rows = Database.use((db) =>
      db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.root_id, top.id)).all(),
    )
    return rows.map((row) => row.id)
  }

  function parseContext(row: typeof SessionContextTable.$inferSelect) {
    return ContextInfo.parse(row)
  }

  function parseState(row: typeof SessionContextStateTable.$inferSelect) {
    return ContextState.parse(row)
  }

  function parseCoord(row: typeof SessionCoordinationTable.$inferSelect) {
    return CoordinationInfo.parse({
      ...row,
      to_session_id: row.to_session_id ?? undefined,
      to_agent: row.to_agent ?? undefined,
      request_id: row.request_id ?? undefined,
      title: row.title ?? undefined,
      metadata: row.metadata ?? undefined,
    })
  }

  function parseCoordState(row: typeof SessionCoordinationStateTable.$inferSelect) {
    return CoordinationState.parse(row)
  }

  function coordStatus(kind: CoordinationKind, status?: CoordinationStatus) {
    if (status) return status
    if (kind === "claim") return "claimed" as const
    if (kind === "answer") return "answered" as const
    if (kind === "resolution") return "resolved" as const
    return "open" as const
  }

  function coordAction(info: CoordinationInfo) {
    if (info.status === "resolved") return "resolved" as const
    return "created" as const
  }

  const contextKeep = new Set(["context_resolution", "context_summary"])

  export const contextState = fn(Identifier.schema("session"), async (session_id) => {
    const top = await root(session_id)
    const row = Database.use((db) =>
      db.select().from(SessionContextStateTable).where(eq(SessionContextStateTable.session_id, session_id)).get(),
    )
    if (row) return parseState(row)
    const now = Date.now()
    return ContextState.parse({
      session_id,
      root_session_id: top.id,
      cursor: 0,
      time_created: now,
      time_updated: now,
    })
  })

  export const contextMark = fn(
    z.object({
      session_id: Identifier.schema("session"),
      cursor: z.number().int().min(0),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const prev = Database.use((db) =>
        db
          .select()
          .from(SessionContextStateTable)
          .where(eq(SessionContextStateTable.session_id, input.session_id))
          .get(),
      )
      const now = Date.now()
      const next = Math.max(prev?.cursor ?? 0, input.cursor)
      if (!prev) {
        const row = Database.use((db) =>
          db
            .insert(SessionContextStateTable)
            .values({
              session_id: input.session_id,
              root_session_id: top.id,
              cursor: next,
              time_created: now,
              time_updated: now,
            })
            .returning()
            .get(),
        )
        return parseState(row)
      }
      const row = Database.use((db) =>
        db
          .update(SessionContextStateTable)
          .set({
            root_session_id: top.id,
            cursor: next,
            time_updated: now,
          })
          .where(eq(SessionContextStateTable.session_id, input.session_id))
          .returning()
          .get(),
      )
      return parseState(row)
    },
  )

  export const contextWrite = fn(
    z.object({
      session_id: Identifier.schema("session"),
      kind: z.string(),
      title: z.string().optional(),
      body: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    async (input) => {
      const now = Date.now()
      const top = await root(input.session_id)
      const row = Database.use((db) =>
        db
          .insert(SessionContextTable)
          .values({
            root_session_id: top.id,
            session_id: input.session_id,
            time_created: now,
            time_updated: now,
            data: {
              kind: input.kind,
              title: input.title,
              body: input.body,
              metadata: input.metadata,
            },
          })
          .returning()
          .get(),
      )
      const info = parseContext(row)
      Database.effect(() =>
        Bus.publish(Event.Context, {
          info,
        }),
      )
      await contextTrim({
        session_id: input.session_id,
      }).catch(() => undefined)
      return info
    },
  )

  export const contextList = fn(
    z.object({
      session_id: Identifier.schema("session"),
      after: z.number().int().default(0).optional(),
      limit: z.number().int().min(1).max(100).default(20).optional(),
      source_session_id: Identifier.schema("session").optional(),
      kind: z.string().optional(),
      include_self: z.boolean().optional(),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const after = input.after ?? 0
      const limit = input.limit ?? 20
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionContextTable)
          .where(and(eq(SessionContextTable.root_session_id, top.id), gt(SessionContextTable.id, after)))
          .orderBy(asc(SessionContextTable.id))
          .all(),
      )
      return rows
        .filter((row) => ((input.include_self ?? true) ? true : row.session_id !== input.session_id))
        .filter((row) => (input.source_session_id ? row.session_id === input.source_session_id : true))
        .filter((row) => (input.kind ? row.data.kind === input.kind : true))
        .slice(0, limit)
        .map(parseContext)
    },
  )

  export const contextStats = fn(
    z.object({
      session_id: Identifier.schema("session"),
      source_session_id: Identifier.schema("session").optional(),
      kind: z.string().optional(),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const state = await contextState(input.session_id)
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionContextTable)
          .where(eq(SessionContextTable.root_session_id, top.id))
          .orderBy(asc(SessionContextTable.id))
          .all(),
      )
      const latest = rows.at(-1)
      const unread = rows.filter((row) => row.id > state.cursor)
      const src = input.source_session_id ?? input.session_id
      const own = rows
        .filter((row) => row.session_id === src)
        .filter((row) => (input.kind ? row.data.kind === input.kind : true))
      return ContextStats.parse({
        session_id: input.session_id,
        root_session_id: top.id,
        cursor: state.cursor,
        latest: latest?.id ?? 0,
        unread: unread.length,
        pending: unread.filter((row) => row.session_id !== input.session_id).length,
        published: own.length,
        latest_entry: latest ? parseContext(latest) : undefined,
        latest_published: own.at(-1) ? parseContext(own.at(-1)!) : undefined,
      })
    },
  )

  export const contextReconcile = fn(
    z.object({
      session_id: Identifier.schema("session"),
      sources: z.array(z.number().int().positive()).min(1).max(32),
      strategy: z.enum(["summary", "winner", "conflict"]).default("summary"),
      title: z.string().optional(),
      body: z.string(),
      winner_context_id: z.number().int().positive().optional(),
      winner_session_id: Identifier.schema("session").optional(),
      keep_sources: z.boolean().optional(),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const ids = [...new Set(input.sources)].sort((a, b) => a - b)
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionContextTable)
          .where(inArray(SessionContextTable.id, ids))
          .orderBy(asc(SessionContextTable.id))
          .all(),
      )
      if (rows.length !== ids.length) {
        const miss = ids.filter((id) => !rows.find((row) => row.id === id))
        throw new Error(`Context entries not found: ${miss.join(", ")}`)
      }
      if (rows.some((row) => row.root_session_id !== top.id)) {
        throw new Error(`Context entries must belong to the same root session: ${top.id}`)
      }
      return contextWrite({
        session_id: input.session_id,
        kind: "context_resolution",
        title: input.title,
        body: input.body,
        metadata: {
          strategy: input.strategy,
          sources: ids,
          winner_context_id: input.winner_context_id,
          winner_session_id: input.winner_session_id,
          keep_sources: input.keep_sources ?? false,
        },
      })
    },
  )

  export const contextTrim = fn(
    z.object({
      session_id: Identifier.schema("session"),
      limit: z.number().int().min(1).max(2048).default(256).optional(),
      buffer: z.number().int().min(0).max(256).default(32).optional(),
      force: z.boolean().optional(),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const limit = input.limit ?? 256
      const buffer = input.buffer ?? 32
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionContextTable)
          .where(eq(SessionContextTable.root_session_id, top.id))
          .orderBy(asc(SessionContextTable.id))
          .all(),
      )
      if (input.force !== true && rows.length <= limit) {
        return ContextTrim.parse({
          session_id: input.session_id,
          root_session_id: top.id,
          cursor: 0,
          before: rows.length,
          after: rows.length,
          deleted: 0,
        })
      }

      const ids = await tree(top.id)
      const states =
        ids.length === 0
          ? []
          : Database.use((db) =>
              db.select().from(SessionContextStateTable).where(inArray(SessionContextStateTable.session_id, ids)).all(),
            )
      const cuts = states.map((row) => row.cursor).filter((row) => row > 0)
      const cut = cuts.length ? Math.max(0, Math.min(...cuts) - buffer) : 0
      const drop = rows.filter((row) => row.id <= cut && !contextKeep.has(row.data.kind))

      if (!drop.length) {
        return ContextTrim.parse({
          session_id: input.session_id,
          root_session_id: top.id,
          cursor: cut,
          before: rows.length,
          after: rows.length,
          deleted: 0,
        })
      }

      Database.use((db) => {
        db.delete(SessionContextTable)
          .where(
            and(
              eq(SessionContextTable.root_session_id, top.id),
              inArray(
                SessionContextTable.id,
                drop.map((row) => row.id),
              ),
            ),
          )
          .run()
      })

      const info = ContextTrim.parse({
        session_id: input.session_id,
        root_session_id: top.id,
        cursor: cut,
        before: rows.length,
        after: rows.length - drop.length,
        deleted: drop.length,
      })
      Database.effect(() =>
        Bus.publish(Event.ContextTrimmed, {
          info,
        }),
      )
      return info
    },
  )

  export const coordinationState = fn(Identifier.schema("session"), async (session_id) => {
    const top = await root(session_id)
    const row = Database.use((db) =>
      db.select().from(SessionCoordinationStateTable).where(eq(SessionCoordinationStateTable.session_id, session_id)).get(),
    )
    if (row) return parseCoordState(row)
    const now = Date.now()
    return CoordinationState.parse({
      session_id,
      root_session_id: top.id,
      cursor: 0,
      time_created: now,
      time_updated: now,
    })
  })

  export const coordinationMark = fn(
    z.object({
      session_id: Identifier.schema("session"),
      cursor: z.number().int().min(0),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const prev = Database.use((db) =>
        db
          .select()
          .from(SessionCoordinationStateTable)
          .where(eq(SessionCoordinationStateTable.session_id, input.session_id))
          .get(),
      )
      const now = Date.now()
      const next = Math.max(prev?.cursor ?? 0, input.cursor)
      if (!prev) {
        const row = Database.use((db) =>
          db
            .insert(SessionCoordinationStateTable)
            .values({
              session_id: input.session_id,
              root_session_id: top.id,
              cursor: next,
              time_created: now,
              time_updated: now,
            })
            .returning()
            .get(),
        )
        return parseCoordState(row)
      }
      const row = Database.use((db) =>
        db
          .update(SessionCoordinationStateTable)
          .set({
            root_session_id: top.id,
            cursor: next,
            time_updated: now,
          })
          .where(eq(SessionCoordinationStateTable.session_id, input.session_id))
          .returning()
          .get(),
      )
      return parseCoordState(row)
    },
  )

  export const coordinationList = fn(
    z.object({
      session_id: Identifier.schema("session"),
      after: z.number().int().default(0).optional(),
      limit: z.number().int().min(1).max(100).default(20).optional(),
      source_session_id: Identifier.schema("session").optional(),
      target_session_id: Identifier.schema("session").optional(),
      target_agent: z.string().optional(),
      request_id: z.string().optional(),
      kind: CoordinationKind.optional(),
      status: CoordinationStatus.optional(),
      include_self: z.boolean().optional(),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const after = input.after ?? 0
      const limit = input.limit ?? 20
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionCoordinationTable)
          .where(and(eq(SessionCoordinationTable.root_session_id, top.id), gt(SessionCoordinationTable.id, after)))
          .orderBy(asc(SessionCoordinationTable.id))
          .all(),
      )
      return rows
        .filter((row) => ((input.include_self ?? true) ? true : row.from_session_id !== input.session_id))
        .filter((row) => (input.source_session_id ? row.from_session_id === input.source_session_id : true))
        .filter((row) => (input.target_session_id ? row.to_session_id === input.target_session_id : true))
        .filter((row) => (input.target_agent ? row.to_agent === input.target_agent : true))
        .filter((row) => (input.request_id ? row.request_id === input.request_id : true))
        .filter((row) => (input.kind ? row.kind === input.kind : true))
        .filter((row) => (input.status ? row.status === input.status : true))
        .slice(0, limit)
        .map(parseCoord)
    },
  )

  export const coordinationUpdate = fn(
    z.object({
      session_id: Identifier.schema("session"),
      coordination_id: z.number().int().positive(),
      status: CoordinationStatus.optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const prev = Database.use((db) =>
        db.select().from(SessionCoordinationTable).where(eq(SessionCoordinationTable.id, input.coordination_id)).get(),
      )
      if (!prev) throw new NotFoundError({ message: `Coordination entry not found: ${input.coordination_id}` })
      if (prev.root_session_id !== top.id) {
        throw new Error(`Coordination entry must belong to the same root session: ${top.id}`)
      }
      const row = Database.use((db) =>
        db
          .update(SessionCoordinationTable)
          .set({
            status: input.status ?? prev.status,
            title: input.title ?? prev.title,
            body: input.body ?? prev.body,
            metadata: input.metadata ?? prev.metadata,
            time_updated: Date.now(),
          })
          .where(eq(SessionCoordinationTable.id, input.coordination_id))
          .returning()
          .get(),
      )
      const info = parseCoord(row)
      Database.effect(() =>
        Bus.publish(Event.Coordination, {
          action: info.status === "resolved" ? "resolved" : "updated",
          info,
        }),
      )
      return info
    },
  )

  export const coordinationWrite = fn(
    z.object({
      session_id: Identifier.schema("session"),
      target_session_id: Identifier.schema("session").optional(),
      target_agent: z.string().optional(),
      kind: CoordinationKind,
      status: CoordinationStatus.optional(),
      title: z.string().optional(),
      body: z.string(),
      request_id: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    async (input) => {
      const now = Date.now()
      const top = await root(input.session_id)
      const prev = Database.use((db) =>
        db
          .select()
          .from(SessionCoordinationTable)
          .where(
            and(
              eq(SessionCoordinationTable.root_session_id, top.id),
              eq(SessionCoordinationTable.from_session_id, input.session_id),
            ),
          )
          .orderBy(desc(SessionCoordinationTable.id))
          .all(),
      )
        .map(parseCoord)
        .find(
          (row) =>
            now - row.time_created < 30_000 &&
            row.to_session_id === input.target_session_id &&
            row.to_agent === input.target_agent &&
            row.request_id === input.request_id &&
            row.kind === input.kind &&
            row.status === coordStatus(input.kind, input.status) &&
            row.title === input.title &&
            row.body === input.body,
        )
      if (prev) return prev
      if (input.target_session_id) {
        const target = await get(input.target_session_id)
        if (target.rootID !== top.id) {
          throw new Error(`Coordination target must belong to the same root session: ${top.id}`)
        }
      }
      const row = Database.use((db) =>
        db
          .insert(SessionCoordinationTable)
          .values({
            root_session_id: top.id,
            from_session_id: input.session_id,
            to_session_id: input.target_session_id,
            to_agent: input.target_agent,
            request_id: input.request_id,
            kind: input.kind,
            status: coordStatus(input.kind, input.status),
            title: input.title,
            body: input.body,
            metadata: input.metadata,
            time_created: now,
            time_updated: now,
          })
          .returning()
          .get(),
      )
      const info = parseCoord(row)
      Database.effect(() =>
        Bus.publish(Event.Coordination, {
          action: coordAction(info),
          info,
        }),
      )
      const list = await coordSessions({ sessionID: input.session_id, info }).catch(() => [] as string[])
      await Promise.all(
        list.map((sessionID) =>
          SessionPrompt.followup({
            sessionID,
            text: [
              "<system-reminder>",
              "A sibling session has a collaboration update that may affect your next step.",
              "Review the latest agent collaboration updates, respond if needed, and resolve material conflicts before finalizing.",
              "</system-reminder>",
            ].join("\n"),
            metadata: {
              coordination_id: info.id,
              request_id: info.request_id,
              kind: info.kind,
              status: info.status,
            },
          }).catch(() => undefined),
        ),
      )
      return info
    },
  )

  async function coordSessions(input: { sessionID: string; info: CoordinationInfo }) {
    if (input.info.to_session_id) return [input.info.to_session_id]
    if (!input.info.to_agent) {
      const top = await root(input.sessionID)
      return input.sessionID === top.id ? [] : [top.id]
    }
    const { TaskRun } = await import("@/task/run")
    const top = await root(input.sessionID)
    return TaskRun.list({ rootSessionID: top.id })
      .then((rows) =>
        rows
          .filter((row) => row.sessionID !== input.sessionID)
          .filter((row) => row.agent === input.info.to_agent)
          .map((row) => row.sessionID),
      )
      .then((rows) => [...new Set(rows)])
  }

  export const coordinationActionable = fn(
    z.object({
      session_id: Identifier.schema("session"),
      agent: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20).optional(),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const state = await coordinationState(input.session_id)
      const limit = input.limit ?? 20
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionCoordinationTable)
          .where(and(eq(SessionCoordinationTable.root_session_id, top.id), gt(SessionCoordinationTable.id, state.cursor)))
          .orderBy(asc(SessionCoordinationTable.id))
          .all(),
      )
      const entries = rows
        .filter((row) => row.from_session_id !== input.session_id)
        .filter((row) => {
          if (row.to_session_id) return row.to_session_id === input.session_id
          if (row.to_agent) return row.to_agent === input.agent
          return input.session_id === top.id
        })
        .slice(0, limit)
        .map(parseCoord)
      return CoordinationFeed.parse({
        session_id: input.session_id,
        root_session_id: top.id,
        cursor: entries.at(-1)?.id ?? state.cursor,
        latest: rows.at(-1)?.id ?? state.cursor,
        unread: entries.length,
        entries,
      })
    },
  )

  export const coordinationThread = fn(
    z.object({
      session_id: Identifier.schema("session"),
      request_id: z.string(),
      before: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(20).default(6).optional(),
    }),
    async (input) => {
      const top = await root(input.session_id)
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionCoordinationTable)
          .where(eq(SessionCoordinationTable.root_session_id, top.id))
          .orderBy(asc(SessionCoordinationTable.id))
          .all(),
      )
      return rows
        .filter((row) => row.request_id === input.request_id)
        .filter((row) => (input.before ? row.id <= input.before : true))
        .slice(-(input.limit ?? 6))
        .map(parseCoord)
    },
  )

  async function reroot(session: Info) {
    if (session.kind !== "interactive" || session.rootID !== session.id) return
    const next = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.root_id, session.id), eq(SessionTable.kind, "interactive")))
        .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
        .all()
        .map(fromRow)
        .find((item) => item.id !== session.id),
    )
    if (!next) return
    const now = Date.now()
    Database.use((db) => {
      db.update(SessionTable)
        .set({
          root_id: next.id,
          time_updated: now,
        })
        .where(eq(SessionTable.root_id, session.id))
        .run()
      db.update(SessionContextTable)
        .set({
          root_session_id: next.id,
          time_updated: now,
        })
        .where(eq(SessionContextTable.root_session_id, session.id))
        .run()
      db.update(SessionContextStateTable)
        .set({
          root_session_id: next.id,
          time_updated: now,
        })
        .where(eq(SessionContextStateTable.root_session_id, session.id))
        .run()
      db.update(SessionCoordinationTable)
        .set({
          root_session_id: next.id,
          time_updated: now,
        })
        .where(eq(SessionCoordinationTable.root_session_id, session.id))
        .run()
      db.update(SessionCoordinationStateTable)
        .set({
          root_session_id: next.id,
          time_updated: now,
        })
        .where(eq(SessionCoordinationStateTable.root_session_id, session.id))
        .run()
      const rows = db.select().from(SessionTable).where(eq(SessionTable.root_id, next.id)).all().map(fromRow)
      Database.effect(() => rows.forEach((info) => Bus.publish(Event.Updated, { info })))
    })
  }

  async function cleanup(session: Info) {
    if (session.kind !== "interactive" || !session.branchFromSessionID) return
    await provide({
      session,
      fn: async () => {
        if (Instance.project.vcs !== "git") return
        if (session.directory === Instance.project.worktree) return
        await Worktree.remove({ directory: session.directory })
      },
    })
  }

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    try {
      const session = await get(sessionID)
      for (const child of await children(sessionID)) {
        await remove(child.id)
      }
      await reroot(session)
      await unshare(sessionID).catch(() => {})
      // CASCADE delete handles messages and parts automatically
      Database.use((db) => {
        db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
        Database.effect(() =>
          Bus.publish(Event.Deleted, {
            info: session,
          }),
        )
      })
      await cleanup(session).catch((error) => {
        log.error("failed to clean session worktree", {
          sessionID,
          directory: session.directory,
          error,
        })
      })
    } catch (e) {
      log.error(e)
    }
  })

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    const time_created = msg.time.created
    const { id, sessionID, ...data } = msg
    Database.use((db) => {
      db.insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          time_created,
          data,
        })
        .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
        .run()
      Database.effect(() =>
        Bus.publish(MessageV2.Event.Updated, {
          info: msg,
        }),
      )
    })
    return msg
  })

  export const removeMessage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      // CASCADE delete handles parts automatically
      Database.use((db) => {
        db.delete(MessageTable)
          .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
          .run()
        Database.effect(() =>
          Bus.publish(MessageV2.Event.Removed, {
            sessionID: input.sessionID,
            messageID: input.messageID,
          }),
        )
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      Database.use((db) => {
        db.delete(PartTable)
          .where(and(eq(PartTable.id, input.partID), eq(PartTable.session_id, input.sessionID)))
          .run()
        Database.effect(() =>
          Bus.publish(MessageV2.Event.PartRemoved, {
            sessionID: input.sessionID,
            messageID: input.messageID,
            partID: input.partID,
          }),
        )
      })
      return input.partID
    },
  )

  const UpdatePartInput = MessageV2.Part

  export const updatePart = fn(UpdatePartInput, async (part) => {
    const { id, messageID, sessionID, ...data } = part
    const time = Date.now()
    Database.use((db) => {
      db.insert(PartTable)
        .values({
          id,
          message_id: messageID,
          session_id: sessionID,
          time_created: time,
          data,
        })
        .onConflictDoUpdate({ target: PartTable.id, set: { data } })
        .run()
      Database.effect(() =>
        Bus.publish(MessageV2.Event.PartUpdated, {
          part: structuredClone(part),
        }),
      )
    })
    return part
  })

  export const updatePartDelta = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
      partID: z.string(),
      field: z.string(),
      delta: z.string(),
    }),
    async (input) => {
      Bus.publish(MessageV2.Event.PartDelta, input)
    },
  )

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelV2Usage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }
      const inputTokens = safe(input.usage.inputTokens ?? 0)
      const outputTokens = safe(input.usage.outputTokens ?? 0)
      const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

      const cacheReadInputTokens = safe(input.usage.cachedInputTokens ?? 0)
      const cacheWriteInputTokens = safe(
        (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
          0) as number,
      )

      // OpenRouter provides inputTokens as the total count of input tokens (including cached).
      // AFAIK other providers (OpenRouter/OpenAI/Gemini etc.) do it the same way e.g. vercel/ai#8794 (comment)
      // Anthropic does it differently though - inputTokens doesn't include cached tokens.
      // It looks like Selene's cost calculation assumes all providers return inputTokens the same way Anthropic does (I'm guessing getUsage logic was originally implemented with anthropic), so it's causing incorrect cost calculation for OpenRouter and others.
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = safe(
        excludesCachedTokens ? inputTokens : inputTokens - cacheReadInputTokens - cacheWriteInputTokens,
      )

      const total = iife(() => {
        // Anthropic doesn't provide total_tokens, also ai sdk will vastly undercount if we
        // don't compute from components
        if (
          input.model.api.npm === "@ai-sdk/anthropic" ||
          input.model.api.npm === "@ai-sdk/amazon-bedrock" ||
          input.model.api.npm === "@ai-sdk/google-vertex/anthropic"
        ) {
          return adjustedInputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens
        }
        return input.usage.totalTokens
      })

      const tokens = {
        total,
        input: adjustedInputTokens,
        output: outputTokens,
        reasoning: reasoningTokens,
        cache: {
          write: cacheWriteInputTokens,
          read: cacheReadInputTokens,
        },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            // TODO: update models.dev to have better pricing model, for now:
            // charge reasoning tokens at the same rate as output tokens
            .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      modelID: z.string(),
      providerID: z.string(),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await SessionPrompt.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}

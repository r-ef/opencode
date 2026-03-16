import z from "zod"
import { fn } from "@/util/fn"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import type { Provider } from "@/provider/provider"
import { SessionSummary } from "./summary"

export namespace SessionMemory {
  export const Kind = z.enum([
    "goal",
    "instruction",
    "decision",
    "artifact",
    "file",
    "validation",
    "pending",
    "preference",
    "style",
  ])
  export type Kind = z.infer<typeof Kind>

  export const Source = z.object({
    sessionID: Identifier.schema("session"),
    userID: Identifier.schema("message").optional(),
    assistantID: Identifier.schema("message").optional(),
    partID: Identifier.schema("part").optional(),
    taskID: Identifier.schema("session").optional(),
    branchID: z.string().optional(),
    files: z.array(z.string()).optional(),
  })
  export type Source = z.infer<typeof Source>

  export const Entry = z.object({
    id: z.string(),
    rootID: Identifier.schema("session"),
    sessionID: Identifier.schema("session"),
    kind: Kind,
    text: z.string(),
    time: z.number().int(),
    source: Source,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  export type Entry = z.infer<typeof Entry>

  export const Hint = z.object({
    terms: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
  })
  export type Hint = z.infer<typeof Hint>

  export const State = z.object({
    goal: z.array(z.string()),
    instruction: z.array(z.string()),
    decision: z.array(z.string()),
    artifact: z.array(z.string()),
    file: z.array(z.string()),
    validation: z.array(z.string()),
    pending: z.array(z.string()),
    preference: z.array(z.string()),
    style: z.array(z.string()),
  })
  export type State = z.infer<typeof State>

  export const Replay = z.object({
    messageID: Identifier.schema("message"),
    agent: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
    format: MessageV2.Format.optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({ id: true, sessionID: true, messageID: true }),
        MessageV2.FilePart.omit({ id: true, sessionID: true, messageID: true }),
        MessageV2.AgentPart.omit({ id: true, sessionID: true, messageID: true }),
        MessageV2.SubtaskPart.omit({ id: true, sessionID: true, messageID: true }),
      ]),
    ),
  })
  export type Replay = z.infer<typeof Replay>

  export const Checkpoint = z.object({
    id: z.string(),
    rootID: Identifier.schema("session"),
    sessionID: Identifier.schema("session"),
    time: z.number().int(),
    strategy: z.enum(["hybrid", "openai", "anthropic", "local"]),
    note: z.string(),
    state: State,
    replay: Replay.optional(),
    hints: Hint.optional(),
    provider: z
      .object({
        openai: z
          .object({
            response_id: z.string(),
          })
          .optional(),
      })
      .optional(),
  })
  export type Checkpoint = z.infer<typeof Checkpoint>

  export function strategy(model: Provider.Model): Checkpoint["strategy"] {
    if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai") return "openai"
    if (model.providerID === "anthropic" || model.api.npm === "@ai-sdk/anthropic") return "anthropic"
    return "hybrid"
  }

  function words(text: string) {
    return new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 3),
    )
  }

  function overlap(a: Set<string>, b: Set<string>) {
    let out = 0
    for (const item of a) {
      if (b.has(item)) out++
    }
    return out
  }

  function trim(text: string, max = 420) {
    const out = text.replace(/\s+/g, " ").trim()
    if (out.length <= max) return out
    return out.slice(0, max - 1) + "…"
  }

  function lines(text: string) {
    return text
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
  }

  function uniq(list: string[]) {
    return [...new Set(list.filter(Boolean))]
  }

  function empty(): State {
    return {
      goal: [],
      instruction: [],
      decision: [],
      artifact: [],
      file: [],
      validation: [],
      pending: [],
      preference: [],
      style: [],
    }
  }

  function refs(parts: MessageV2.Part[]) {
    const out = new Set<string>()
    for (const part of parts) {
      if (part.type === "file" && part.filename) out.add(part.filename)
      if (part.type === "patch") {
        for (const file of part.files) out.add(file)
      }
      if (part.type === "tool") {
        const input = part.state.input
        if (typeof input?.["filePath"] === "string") out.add(input["filePath"])
        if (typeof input?.["path"] === "string") out.add(input["path"])
        if (Array.isArray(input?.["files"])) {
          for (const file of input["files"]) if (typeof file === "string") out.add(file)
        }
      }
    }
    return [...out]
  }

  function textParts(parts: MessageV2.Part[]) {
    return parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter(Boolean)
  }

  async function root(sessionID: string) {
    return Session.root(sessionID).then((item) => item.id)
  }

  async function put(entry: Entry) {
    return Storage.write(["session_memory", entry.rootID, entry.id], entry)
  }

  export async function remember(input: {
    sessionID: string
    entries: Array<{
      kind: Kind
      text: string
      source?: Partial<Source>
      metadata?: Record<string, unknown>
      id?: string
      time?: number
    }>
  }) {
    const rootID = await root(input.sessionID)
    const rows = input.entries.flatMap((item, idx) => {
      const text = trim(item.text)
      if (!text) return []
      return [
        Entry.parse({
          id: item.id ?? `memory_${Date.now()}_${idx}`,
          rootID,
          sessionID: input.sessionID,
          kind: item.kind,
          text,
          time: item.time ?? Date.now(),
          source: Source.parse({
            sessionID: input.sessionID,
            ...item.source,
          }),
          metadata: item.metadata,
        }),
      ]
    })
    await Promise.all(rows.map((row) => put(row)))
    return rows
  }

  export async function list(sessionID: string) {
    const id = await root(sessionID)
    const keys = await Storage.list(["session_memory", id])
    const rows = await Promise.all(
      keys.map((key) => Storage.read<Entry>(key).catch(() => undefined)),
    )
    return rows.filter((item): item is Entry => Boolean(item)).toSorted((a, b) => a.time - b.time)
  }

  export async function latest(sessionID: string) {
    return Storage.read<Checkpoint>(["session_checkpoint", await root(sessionID), sessionID]).catch(() => undefined)
  }

  export async function checkpoint(input: {
    sessionID: string
    model: Provider.Model
    note: string
    replay?: Replay
    hints?: Hint
    strategy?: Checkpoint["strategy"]
    provider?: Checkpoint["provider"]
  }) {
    const rows = await list(input.sessionID)
    const id = await root(input.sessionID)
    const state = empty()
    for (const kind of Kind.options) {
      state[kind] = rows
        .filter((row) => row.kind === kind)
        .map((row) => row.text)
        .filter(Boolean)
        .toReversed()
        .filter((item, idx, arr) => arr.indexOf(item) === idx)
        .slice(0, kind === "file" ? 12 : 8)
    }
    const row = Checkpoint.parse({
      id: `memory_${Date.now()}`,
      rootID: id,
      sessionID: input.sessionID,
      time: Date.now(),
      strategy: input.strategy ?? strategy(input.model),
      note: trim(input.note, 1_800),
      state,
      replay: input.replay,
      hints: input.hints,
      provider: input.provider,
    })
    await Storage.write(["session_checkpoint", id, input.sessionID], row)
    return row
  }

  export function provider(input: {
    parts: MessageV2.Part[]
    model: Provider.Model
    strategy?: Checkpoint["strategy"]
  }): Checkpoint["provider"] | undefined {
    const strategy = input.strategy ?? SessionMemory.strategy(input.model)
    if (strategy !== "openai") return
    const part = input.parts.toReversed().find(
      (item): item is MessageV2.StepFinishPart =>
        item.type === "step-finish" && typeof item.metadata?.["openai"]?.["responseId"] === "string",
    )
    if (!part) return
    return {
      openai: {
        response_id: part.metadata!.openai.responseId,
      },
    }
  }

  function add(list: Entry[], input: {
    id: string
    rootID: string
    sessionID: string
    kind: Kind
    text: string
    time: number
    source: Source
    metadata?: Record<string, unknown>
  }) {
    const text = trim(input.text)
    if (!text) return
    list.push(
      Entry.parse({
        ...input,
        text,
      }),
    )
  }

  function classify(text: string) {
    const rows = lines(text)
    return {
      instruction: uniq(
        rows.filter((row) => /\b(always|never|must|should|avoid|use|keep|do not|don't)\b/i.test(row)).slice(0, 6),
      ),
      preference: uniq(rows.filter((row) => /\b(prefer|style|tone|concise|verbose)\b/i.test(row)).slice(0, 6)),
      pending: uniq(rows.filter((row) => /\b(next|todo|remaining|left|pending|follow up)\b/i.test(row)).slice(0, 6)),
      validation: uniq(rows.filter((row) => /\b(test|lint|typecheck|verified|pass|fail)\b/i.test(row)).slice(0, 6)),
      decision: uniq(rows.filter((row) => /\b(decided|choose|chosen|using|switched|keep)\b/i.test(row)).slice(0, 6)),
      style: uniq(rows.filter((row) => /\b(style|tone|voice|format)\b/i.test(row)).slice(0, 6)),
    }
  }

  export async function extract(input: { sessionID: string; messageID: string; messages?: MessageV2.WithParts[] }) {
    const rootID = await root(input.sessionID)
    const all = input.messages ?? (await Session.messages({ sessionID: input.sessionID }))
    const user = all.find((msg) => msg.info.id === input.messageID)
    if (!user || user.info.role !== "user") return []

    const out: Entry[] = []
    const time = Date.now()
    const rows = textParts(user.parts)
    const body = trim(rows.join("\n\n"), 900)
    const files = refs(user.parts)
    const src = {
      sessionID: input.sessionID,
      userID: user.info.id,
      files: files.length ? files : undefined,
    } satisfies Source
    if (body && !user.parts.every((part) => part.type === "text" && part.synthetic)) {
      add(out, {
        id: `${user.info.id}-goal`,
        rootID,
        sessionID: input.sessionID,
        kind: "goal",
        text: body,
        time,
        source: src,
      })
    }

    const cls = classify(rows.join("\n"))
    for (const [idx, text] of cls.instruction.entries()) {
      add(out, {
        id: `${user.info.id}-instruction-${idx}`,
        rootID,
        sessionID: input.sessionID,
        kind: "instruction",
        text,
        time,
        source: src,
      })
    }
    for (const [idx, text] of cls.preference.entries()) {
      add(out, {
        id: `${user.info.id}-preference-${idx}`,
        rootID,
        sessionID: input.sessionID,
        kind: "preference",
        text,
        time,
        source: src,
      })
    }
    if (user.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.["shared_context"])) {
      add(out, {
        id: `${user.info.id}-artifact-shared`,
        rootID,
        sessionID: input.sessionID,
        kind: "artifact",
        text: body,
        time,
        source: src,
        metadata: { shared: true },
      })
    }

    const kids = all.filter(
      (msg) =>
        msg.info.role === "assistant" &&
        msg.info.parentID === user.info.id &&
        msg.info.summary !== true &&
        !msg.info.error,
    )
    for (const msg of kids) {
      const txt = trim(textParts(msg.parts).join("\n\n"), 1_200)
      const files = refs(msg.parts)
      const src = {
        sessionID: input.sessionID,
        userID: user.info.id,
        assistantID: msg.info.id,
        files: files.length ? files : undefined,
      } satisfies Source
      if (txt) {
        add(out, {
          id: `${msg.info.id}-artifact`,
          rootID,
          sessionID: input.sessionID,
          kind: "artifact",
          text: txt,
          time,
          source: src,
        })
      }
      const cls = classify(txt)
      for (const [idx, text] of cls.pending.entries()) {
        add(out, {
          id: `${msg.info.id}-pending-${idx}`,
          rootID,
          sessionID: input.sessionID,
          kind: "pending",
          text,
          time,
          source: src,
        })
      }
      for (const [idx, text] of cls.validation.entries()) {
        add(out, {
          id: `${msg.info.id}-validation-${idx}`,
          rootID,
          sessionID: input.sessionID,
          kind: "validation",
          text,
          time,
          source: src,
        })
      }
      for (const [idx, text] of cls.decision.entries()) {
        add(out, {
          id: `${msg.info.id}-decision-${idx}`,
          rootID,
          sessionID: input.sessionID,
          kind: "decision",
          text,
          time,
          source: src,
        })
      }
      for (const [idx, text] of cls.style.entries()) {
        add(out, {
          id: `${msg.info.id}-style-${idx}`,
          rootID,
          sessionID: input.sessionID,
          kind: "style",
          text,
          time,
          source: src,
        })
      }
      for (const [idx, file] of files.entries()) {
        add(out, {
          id: `${msg.info.id}-file-${idx}`,
          rootID,
          sessionID: input.sessionID,
          kind: "file",
          text: file,
          time,
          source: src,
        })
      }
      for (const part of msg.parts) {
        if (part.type !== "tool") continue
        if (part.state.status !== "completed" && part.state.status !== "error") continue
        await capturePart({
          sessionID: input.sessionID,
          userID: user.info.id,
          assistantID: msg.info.id,
          part,
          time,
          rootID,
        }).then((rows) => out.push(...rows))
      }
    }

    await Promise.all(out.map((row) => put(row)))
    return out
  }

  export async function capturePart(input: {
    sessionID: string
    userID?: string
    assistantID?: string
    part: MessageV2.ToolPart
    time?: number
    rootID?: string
  }) {
    const rootID = input.rootID ?? (await root(input.sessionID))
    const time = input.time ?? Date.now()
    const out: Entry[] = []
    const files = refs([input.part])
    const meta = "metadata" in input.part.state ? input.part.state.metadata : undefined
    const taskID =
      typeof meta?.["task_id"] === "string" ? meta["task_id"] : undefined
    const branchID =
      typeof meta?.["branch_id"] === "string" ? meta["branch_id"] : undefined
    const src = {
      sessionID: input.sessionID,
      userID: input.userID,
      assistantID: input.assistantID,
      partID: input.part.id,
      taskID,
      branchID,
      files: files.length ? files : undefined,
    } satisfies Source

    if (files.length) {
      for (const [idx, file] of files.entries()) {
        add(out, {
          id: `${input.part.id}-file-${idx}`,
          rootID,
          sessionID: input.sessionID,
          kind: "file",
          text: file,
          time,
          source: src,
        })
      }
    }

    const text =
      input.part.state.status === "completed"
        ? trim(`${input.part.tool}: ${input.part.state.title}\n${input.part.state.output}`, 480)
        : input.part.state.status === "error"
          ? trim(`${input.part.tool}: ${input.part.state.error}`, 480)
          : ""
    if (text) {
      add(out, {
        id: `${input.part.id}-artifact`,
        rootID,
        sessionID: input.sessionID,
        kind: "artifact",
        text,
        time,
        source: src,
      })
    }

    if (input.part.tool === "bash") {
      const cmd =
        typeof input.part.state.input?.["command"] === "string"
          ? input.part.state.input["command"]
          : typeof input.part.state.input?.["cmd"] === "string"
            ? input.part.state.input["cmd"]
            : ""
      const outText =
        input.part.state.status === "completed"
          ? trim(input.part.state.output, 240)
          : input.part.state.status === "error"
            ? trim(input.part.state.error, 240)
            : ""
      add(out, {
        id: `${input.part.id}-validation`,
        rootID,
        sessionID: input.sessionID,
        kind: "validation",
        text: trim([cmd, outText].filter(Boolean).join(" => "), 480),
        time,
        source: src,
      })
    }

    if (taskID || branchID) {
      add(out, {
        id: `${input.part.id}-lineage`,
        rootID,
        sessionID: input.sessionID,
        kind: "artifact",
        text: trim(
          [
            branchID ? `branch_id=${branchID}` : "",
            taskID ? `task_id=${taskID}` : "",
            input.part.tool,
            input.part.state.status,
          ]
            .filter(Boolean)
            .join(" "),
        ),
        time,
        source: src,
      })
    }

    await Promise.all(out.map((row) => put(row)))
    return out
  }

  export const RetrieveInput = z.object({
    sessionID: Identifier.schema("session"),
    query: z.string().optional(),
    files: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(64).default(12).optional(),
    hints: Hint.optional(),
  })

  export const retrieve = fn(RetrieveInput, async (input) => {
    const rows = await list(input.sessionID)
    const files = uniq([...(input.files ?? []), ...(input.hints?.files ?? [])])
    const fileSet = new Set(files)
    const query = words([input.query ?? "", ...(input.hints?.terms ?? [])].join(" "))
    const now = Date.now()
    const ranked = rows
      .map((row) => {
        const ownFiles = new Set(row.source.files ?? [])
        const text = words(row.text)
        const age = Math.max(1, Math.floor((now - row.time) / 60_000))
        const base = 1000 / age
        const file = overlap(fileSet, ownFiles) * 80
        const lex = overlap(query, text) * 20
        const sticky =
          row.kind === "goal" || row.kind === "instruction" || row.kind === "preference" || row.kind === "pending"
            ? 25
            : 0
        return {
          row,
          score: base + file + lex + sticky,
        }
      })
      .filter((item) => item.score > 0)
      .toSorted((a, b) => b.score - a.score)

    const keep = new Map<string, Entry>()
    for (const item of ranked.slice(0, input.limit ?? 12)) keep.set(item.row.id, item.row)
    for (const kind of ["goal", "instruction", "preference", "pending"] as const) {
      const row = rows.toReversed().find((item) => item.kind === kind)
      if (row) keep.set(row.id, row)
    }
    return [...keep.values()].toSorted((a, b) => a.time - b.time)
  })

  export async function active(sessionID: string, messages: MessageV2.WithParts[]) {
    const out = empty()
    const files = uniq([
      ...messages.flatMap((msg) => refs(msg.parts)),
      ...(await SessionSummary.diff({ sessionID }).then((rows) => rows.map((row) => row.file)).catch(() => [])),
    ])
    out.file = files.slice(-12)
    const txt = messages
      .flatMap((msg) => textParts(msg.parts))
      .join("\n")
    const cls = classify(txt)
    out.pending = cls.pending.slice(0, 6)
    out.validation = cls.validation.slice(0, 6)
    return out
  }
}

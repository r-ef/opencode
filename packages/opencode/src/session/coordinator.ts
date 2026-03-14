import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Database, asc, desc, eq, inArray } from "@/storage/db"
import { TaskRun } from "@/task/run"
import { fn } from "@/util/fn"
import z from "zod"
import {
  SessionContextTable,
  SessionCoordinatorClaimTable,
  SessionCoordinatorPlanTable,
  SessionCoordinatorWorkTable,
  SessionTable,
} from "./session.sql"

const DEFAULT_PRIMARY = 2
const MAX_PRIMARY = 8
const DEFAULT_VERIFIER = 0

function requirements(query: string) {
  const match = query.match(/\b(\d+)\s*(?:sub-?agents?|agents?|workstreams?|parallel)\b/i)
  const requested = match ? Math.min(Math.max(parseInt(match[1], 10), DEFAULT_PRIMARY), MAX_PRIMARY) : DEFAULT_PRIMARY
  return { primary: requested, verifier: DEFAULT_VERIFIER }
}

const ANALYSIS_TAG = "analysis_json"
const WORK_TAG = "coordination-workstream"
const WORK_TIMEOUT = 90 * 1000
const WORK_ATTEMPTS = 2
const EVIDENCE_LIMIT = 6
const CLAIM_LIMIT = 10

export namespace SessionCoordinator {
  export const PlanStatus = z.enum([
    "planned",
    "running",
    "awaiting_verification",
    "awaiting_reconcile",
    "ready_to_finalize",
    "finalized",
  ])
  export type PlanStatus = z.infer<typeof PlanStatus>

  export const WorkRole = z.enum(["primary", "verifier", "reconciler"])
  export type WorkRole = z.infer<typeof WorkRole>

  export const WorkStatus = z.enum(["planned", "running", "completed", "verified", "conflict", "resolved", "cancelled", "failed"])
  export type WorkStatus = z.infer<typeof WorkStatus>

  export const Confidence = z.enum(["low", "medium", "high"])
  export type Confidence = z.infer<typeof Confidence>

  export const ClaimVerdict = z.enum(["report", "confirm", "contradict"])
  export type ClaimVerdict = z.infer<typeof ClaimVerdict>

  export const ClaimStatus = z.enum(["reported", "verified", "conflict", "resolved", "rejected"])
  export type ClaimStatus = z.infer<typeof ClaimStatus>

  export const PlanInfo = z.object({
    id: z.number().int().positive(),
    root_session_id: z.string(),
    session_id: z.string(),
    mode: z.literal("analysis"),
    status: PlanStatus,
    query: z.string(),
    requirements: z.object({
      primary: z.number().int().positive(),
      verifier: z.number().int().nonnegative(),
    }),
    summary: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    time_created: z.number().int(),
    time_updated: z.number().int(),
  })
  export type PlanInfo = z.infer<typeof PlanInfo>

  export const WorkInfo = z.object({
    id: z.string(),
    plan_id: z.number().int().positive(),
    root_session_id: z.string(),
    session_id: z.string().optional(),
    role: WorkRole,
    agent: z.string(),
    scope: z.string(),
    goal: z.string(),
    status: WorkStatus,
    depends_on: z.array(z.string()).optional(),
    verify_against: z.string().optional(),
    metadata: z
      .object({
        summary: z.string().optional(),
        context_id: z.number().int().positive().optional(),
        risks: z.array(z.string()).optional(),
        query: z.string().optional(),
        attempt: z.number().int().positive().optional(),
        retry_of: z.string().optional(),
        timeout_at: z.number().int().positive().optional(),
        error: z.string().optional(),
        verify_topics: z.array(z.string()).optional(),
        invalid_claims: z.array(z.string()).optional(),
        source_files: z.array(z.string()).optional(),
      })
      .optional(),
    time_created: z.number().int(),
    time_updated: z.number().int(),
  })
  export type WorkInfo = z.infer<typeof WorkInfo>

  export const ClaimInfo = z.object({
    id: z.string(),
    plan_id: z.number().int().positive(),
    work_id: z.string(),
    root_session_id: z.string(),
    session_id: z.string().optional(),
    topic: z.string(),
    statement: z.string(),
    evidence: z.array(z.string()),
    confidence: Confidence,
    status: ClaimStatus,
    metadata: z
      .object({
        verdict: ClaimVerdict.optional(),
        normalized: z.string().optional(),
        score: z.number().optional(),
        issue: z.string().optional(),
        source_files: z.array(z.string()).optional(),
      })
      .optional(),
    time_created: z.number().int(),
    time_updated: z.number().int(),
  })
  export type ClaimInfo = z.infer<typeof ClaimInfo>

  export const Conflict = z.object({
    topic: z.string(),
    claim_ids: z.array(z.string()),
    work_ids: z.array(z.string()),
  })
  export type Conflict = z.infer<typeof Conflict>

  export const Snapshot = z.object({
    plan: PlanInfo.optional(),
    works: WorkInfo.array(),
    claims: ClaimInfo.array(),
    conflicts: Conflict.array(),
    counts: z.object({
      primary: z.object({
        required: z.number().int().positive(),
        completed: z.number().int().nonnegative(),
      }),
      verifier: z.object({
        required: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
      }),
    }),
    ready: z.boolean(),
    summary: z.string(),
  })
  export type Snapshot = z.infer<typeof Snapshot>

  export const Event = {
    Updated: BusEvent.define(
      "session.coordinator",
      z.object({
        root_session_id: z.string(),
        snapshot: Snapshot,
      }),
    ),
  }

  const Report = z.object({
    summary: z.string().optional(),
    claims: z
      .array(
        z.object({
          topic: z.string(),
          statement: z.string(),
          evidence: z.array(z.string()).default([]),
          confidence: Confidence.default("medium"),
          verdict: ClaimVerdict.default("report"),
        }),
      )
      .default([]),
    risks: z.array(z.string()).default([]),
    verify_topics: z.array(z.string()).default([]),
  })
  type Report = z.infer<typeof Report>

  export function reportSchema() {
    return {
      type: "object",
      additionalProperties: false,
      required: ["summary", "claims", "risks", "verify_topics"],
      properties: {
        summary: {
          type: "string",
        },
        claims: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["topic", "statement", "evidence", "confidence", "verdict"],
            properties: {
              topic: { type: "string" },
              statement: { type: "string" },
              evidence: {
                type: "array",
                items: { type: "string" },
              },
              confidence: {
                type: "string",
                enum: ["low", "medium", "high"],
              },
              verdict: {
                type: "string",
                enum: ["report", "confirm", "contradict"],
              },
            },
          },
        },
        risks: {
          type: "array",
          items: { type: "string" },
        },
        verify_topics: {
          type: "array",
          items: { type: "string" },
        },
      },
    } satisfies Record<string, unknown>
  }

  const Marker = z.object({
    id: z.string(),
  })

  const Schedule = z.object({
    description: z.string(),
    prompt: z.string(),
    agent: z.string(),
  })
  type Schedule = z.infer<typeof Schedule>

  function now() {
    return Date.now()
  }

  function work(id: string, role: WorkRole, scope: string, goal: string, agent: string, root: string, plan: number, verify?: string) {
    const time = now()
    return {
      id,
      plan_id: plan,
      root_session_id: root,
      session_id: null,
      role,
      agent,
      scope,
      goal,
      status: "planned",
      depends_on: verify ? [verify] : null,
      verify_against: verify ?? null,
      metadata: {
        attempt: 1,
        timeout_at: time + WORK_TIMEOUT,
      },
      time_created: time,
      time_updated: time,
    } satisfies typeof SessionCoordinatorWorkTable.$inferInsert
  }

  function root(input: { id: string; root_id: string | null; kind: string }) {
    return {
      id: input.root_id ?? input.id,
      kind: input.kind === "subagent" ? "subagent" : "interactive",
    }
  }

  function plain(input: string) {
    return input
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  }

  function broad(text: string) {
    if (!/(analy[sz]e|review|audit|architecture|codebase|repo|repository|trace how|understand this project|map the project)/i.test(text)) return false
    if (/[\w\/.-]+\.[a-z]{1,10}\b/i.test(text) && !/\bcodebase\b|\brepo(sitory)?\b|\bproject\b|\ball\b|\bevery\b|\bwhole\b/i.test(text)) return false
    return true
  }

  function marker(input: { id: string }) {
    return `<${WORK_TAG}>${JSON.stringify(input)}</${WORK_TAG}>`
  }

  function strip(text: string) {
    return text.replace(new RegExp(`<${WORK_TAG}>[\\s\\S]*?<\\/${WORK_TAG}>\\s*`), "").trim()
  }

  function parseMarker(text: string) {
    const match = new RegExp(`<${WORK_TAG}>([\\s\\S]*?)<\\/${WORK_TAG}>`).exec(text)
    if (!match) return
    return Marker.parse(JSON.parse(match[1]))
  }

  function parseReport(text: string) {
    const match = new RegExp(`<${ANALYSIS_TAG}>([\\s\\S]*?)<\\/${ANALYSIS_TAG}>`).exec(text)
    if (!match) return { error: `Missing <${ANALYSIS_TAG}> block.` } as const
    try {
      const raw = JSON.parse(match[1])
      const parsed = Report.safeParse(raw)
      if (!parsed.success) {
        return {
          error: parsed.error.issues.map((item) => `${item.path.join(".") || "root"}: ${item.message}`).join("; "),
        } as const
      }
      return { report: parsed.data } as const
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      } as const
    }
  }

  function stem(input: string) {
    if (input.endsWith("ies") && input.length > 4) return input.slice(0, -3) + "y"
    if (input.endsWith("ing") && input.length > 5) return input.slice(0, -3)
    if (input.endsWith("ed") && input.length > 4) return input.slice(0, -2)
    if (input.endsWith("s") && input.length > 3) return input.slice(0, -1)
    return input
  }

  function token(input: string) {
    const map = {
      repository: "repo",
      project: "repo",
      codebase: "repo",
      packages: "package",
      modules: "module",
      runtime: "flow",
      behavior: "flow",
      control: "flow",
      execution: "flow",
      architectural: "architecture",
      design: "architecture",
      tests: "test",
      testing: "test",
      ci: "build",
      pipeline: "build",
      builds: "build",
      docs: "doc",
      documentation: "doc",
      configs: "config",
      configuration: "config",
      risks: "risk",
      issues: "risk",
      bugs: "risk",
      gaps: "gap",
      parsing: "parser",
    } as const
    const stop = new Set(["the", "a", "an", "this", "that", "and", "for", "with", "from", "into", "about", "main"])
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((item) => stem(item))
      .map((item) => map[item as keyof typeof map] ?? item)
      .filter(Boolean)
      .filter((item) => !stop.has(item))
  }

  function normalize(topic: string, statement?: string) {
    const list = [...new Set(token(topic || statement || ""))]
    if (!list.length) return plain(topic || statement || "finding")
    return list.toSorted().join(" ")
  }

  function parseRef(input: string) {
    const text = input.trim()
    const match = /^(\/.+?)(?::(\d+)(?:-(\d+)|:(\d+))?)?$/.exec(text)
    if (!match) return
    return {
      raw: text,
      file: match[1]!,
      line: match[2] ? Number(match[2]) : undefined,
      col: match[4] ? Number(match[4]) : undefined,
    }
  }

  async function source(file: string, cache: Map<string, Promise<number | undefined>>) {
    const seen = cache.get(file)
    if (seen) return seen
    const next = (async () => {
      if (!(await Bun.file(file).exists())) return
      const text = await Bun.file(file).text()
      return text.split("\n").length
    })()
    cache.set(file, next)
    return next
  }

  async function evidence(list: string[]) {
    const cache = new Map<string, Promise<number | undefined>>()
    const valid: string[] = []
    const files: string[] = []
    const bad: string[] = []
    for (const raw of [...new Set(list)].slice(0, EVIDENCE_LIMIT)) {
      const ref = parseRef(raw)
      if (!ref) {
        bad.push(`${raw}: expected /abs/path[:line[:col]]`)
        continue
      }
      const lines = await source(ref.file, cache)
      if (!lines) {
        bad.push(`${raw}: file not found`)
        continue
      }
      if (ref.line && ref.line > lines) {
        bad.push(`${raw}: line ${ref.line} exceeds ${lines}`)
        continue
      }
      valid.push(ref.raw)
      files.push(ref.file)
    }
    return {
      valid,
      files: [...new Set(files)],
      bad,
    }
  }

  function score(input: {
    confidence: Confidence
    verdict: ClaimVerdict
    evidence: number
  }) {
    const base = input.confidence === "high" ? 0.92 : input.confidence === "medium" ? 0.72 : 0.52
    const bump = Math.min(0.08, input.evidence * 0.02)
    const verdict = input.verdict === "confirm" ? 0.05 : input.verdict === "contradict" ? 0.04 : 0
    return Number(Math.min(0.99, base + bump + verdict).toFixed(2))
  }

  function claimKey(input: ClaimInfo) {
    return input.metadata?.normalized ?? normalize(input.topic, input.statement)
  }

  function label(input: ClaimInfo[]) {
    return (
      input
        .map((item) => item.topic.trim())
        .filter(Boolean)
        .toSorted((a, b) => a.length - b.length)[0] ?? input[0]?.metadata?.normalized ?? "finding"
    )
  }

  function accepted(input: ClaimInfo[]) {
    const map = new Map<string, ClaimInfo[]>()
    for (const item of input.filter((item) => !["rejected", "conflict"].includes(item.status))) {
      const key = claimKey(item)
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    const entries = [...map.entries()]
    const merged = new Set<number>()
    for (let i = 0; i < entries.length; i++) {
      if (merged.has(i)) continue
      const [keyA, listA] = entries[i]
      const tokensA = new Set(keyA.split(" "))
      for (let j = i + 1; j < entries.length; j++) {
        if (merged.has(j)) continue
        const [keyB, listB] = entries[j]
        const tokensB = new Set(keyB.split(" "))
        const inter = [...tokensA].filter((t) => tokensB.has(t)).length
        const union = new Set([...tokensA, ...tokensB]).size
        const subset = inter === tokensA.size || inter === tokensB.size
        const jaccard = union > 0 ? inter / union : 0
        if (subset || jaccard >= 0.7) {
          const shorter = keyA.length <= keyB.length ? i : j
          const longer = shorter === i ? j : i
          entries[shorter][1].push(...(shorter === i ? listB : listA))
          merged.add(longer)
        }
      }
    }
    return entries
      .filter((_, idx) => !merged.has(idx))
      .map(([key, list]) => ({
        key,
        topic: label(list),
        row: [...list].toSorted((a, b) => {
          const as = a.metadata?.score ?? 0
          const bs = b.metadata?.score ?? 0
          if (as !== bs) return bs - as
          if (a.status !== b.status) return a.status === "verified" ? -1 : 1
          return b.time_updated - a.time_updated
        })[0]!,
      }))
  }

  async function stale(plan: PlanInfo) {
    const rows = await works(plan.id)
    let dirty = false
    for (const item of rows.filter((row) => row.status === "running" && row.session_id)) {
      const run = await TaskRun.ensure(item.session_id!).catch(() => undefined)
      const due = item.metadata?.timeout_at ?? item.time_updated + WORK_TIMEOUT
      if (!run) continue
      const beat = run.runtime?.heartbeat ?? run.time.updated
      if (run.status === "running" && due > beat && due > now()) continue
      dirty = true
      if (run.status === "running") await TaskRun.interrupt(item.session_id!, "Coordinator workstream timed out.")
      Database.use((db) =>
        db
          .update(SessionCoordinatorWorkTable)
          .set({
            status: "failed",
            metadata: {
              ...(item.metadata ?? {}),
              error: run.status === "running" ? "Coordinator workstream timed out." : run.error ?? `Task ${run.status}.`,
              summary: run.status === "running" ? "Coordinator workstream timed out." : run.error ?? `Task ${run.status}.`,
              timeout_at: now() + WORK_TIMEOUT,
            },
            time_updated: now(),
          })
          .where(eq(SessionCoordinatorWorkTable.id, item.id))
          .run(),
      )
    }
    return dirty
  }

    function stripMeta(query: string) {
      return query
        .replace(/@[\w.\-\/]+/g, "")
        .replace(/\b(?:use|spawn|launch|run|create|start)\s+\d+\s*(?:sub-?agents?|agents?|workstreams?|parallel\s*(?:agents?|workstreams?)?)\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim()
    }

    function formatPrompt(input: { work: WorkInfo; query: string; extra?: string }) {
      return [
        marker({ id: input.work.id }),
        `You are part of a deterministic analysis plan for this root session.`,
        `Workstream role: ${input.work.role}.`,
        `Scope: ${input.work.scope}.`,
        `Goal: ${input.work.goal}.`,
        `User query: ${stripMeta(input.query)}`,
      input.extra ?? "",
      `Return your final answer in two parts:`,
      `1. A short prose summary.`,
      `2. A <${ANALYSIS_TAG}> JSON block with this exact shape:`,
      `{"summary":"short summary","claims":[{"topic":"string","statement":"string","evidence":["/abs/path/file.ts:10"],"confidence":"low|medium|high","verdict":"report|confirm|contradict"}],"risks":["string"],"verify_topics":["string"]}`,
      `Only include evidence you actually inspected.`,
      `Missing or invalid <${ANALYSIS_TAG}> output will be treated as a failed run and automatically retried on another workstream.`,
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  const SCOPES: { scope: string; goal: (q: string) => string; agent: string }[] = [
    { scope: "Structure", goal: (q) => `Map the repository structure, major packages, and important entrypoints relevant to: ${q}`, agent: "explore" },
    { scope: "Behavior", goal: (q) => `Trace the main control flow, runtime behavior, and critical paths relevant to: ${q}`, agent: "explore" },
    { scope: "Quality", goal: (q) => `Inspect tests, risks, gaps, and architectural weak spots relevant to: ${q}`, agent: "explore" },
    { scope: "Security", goal: (q) => `Audit authentication, authorization, input validation, and data exposure relevant to: ${q}`, agent: "explore" },
    { scope: "Performance", goal: (q) => `Profile hot paths, resource usage, and scalability bottlenecks relevant to: ${q}`, agent: "explore" },
    { scope: "Dependencies", goal: (q) => `Evaluate external dependencies, version hygiene, and supply chain risks relevant to: ${q}`, agent: "explore" },
    { scope: "API", goal: (q) => `Review public API surface, contracts, backward compatibility, and documentation relevant to: ${q}`, agent: "explore" },
    { scope: "Error handling", goal: (q) => `Inspect error propagation, recovery paths, and failure modes relevant to: ${q}`, agent: "explore" },
  ]

  function primary(plan: PlanInfo) {
    const count = Math.min(plan.requirements.primary, SCOPES.length)
    const rows = SCOPES.slice(0, count).map((item) => ({
      id: Identifier.ascending("tool"),
      scope: item.scope,
      goal: item.goal(plan.query),
      agent: item.agent,
    }))
    return rows.map((item) => ({
      row: work(item.id, "primary", item.scope, item.goal, item.agent, plan.root_session_id, plan.id),
      task: {
        description: item.scope.toLowerCase(),
        prompt: formatPrompt({
          work: WorkInfo.parse({
            ...work(item.id, "primary", item.scope, item.goal, item.agent, plan.root_session_id, plan.id),
            session_id: undefined,
            depends_on: undefined,
            verify_against: undefined,
            metadata: undefined,
          }),
          query: plan.query,
        }),
        agent: item.agent,
      } satisfies Schedule,
    }))
  }

  function extra(plan: PlanInfo, idx: number) {
    const id = Identifier.ascending("tool")
    const row = work(
      id,
      "primary",
      `Coverage ${idx}`,
      `Fill remaining evidence gaps for: ${plan.query}`,
      "explore",
      plan.root_session_id,
      plan.id,
    )
    return {
      row,
      task: {
        description: `coverage ${idx}`,
        prompt: formatPrompt({
          work: WorkInfo.parse({
            ...row,
            session_id: undefined,
            depends_on: undefined,
            verify_against: undefined,
            metadata: undefined,
          }),
          query: plan.query,
        }),
        agent: "explore",
      } satisfies Schedule,
    }
  }

  function verifier(plan: PlanInfo, works: WorkInfo[], claims: ClaimInfo[]) {
    const topics = [...new Set(claims.filter((item) => item.status !== "rejected").map((item) => item.topic))].slice(0, 8)
    const evidence = claims
      .filter((item) => topics.includes(item.topic))
      .map((item) => `- ${item.topic}: ${item.statement}`)
      .join("\n")
    const against = works.filter((item) => item.role === "primary").map((item) => item.id)
    const id = Identifier.ascending("tool")
    const row = work(
      id,
      "verifier",
      "Verification",
      `Independently verify the strongest primary claims for: ${plan.query}`,
      "general",
      plan.root_session_id,
      plan.id,
      against[0],
    )
    return {
      row,
      task: {
        description: "verify findings",
        prompt: formatPrompt({
          work: WorkInfo.parse({
            ...row,
            session_id: undefined,
            depends_on: row.depends_on ?? undefined,
            verify_against: row.verify_against ?? undefined,
            metadata: undefined,
          }),
          query: plan.query,
          extra: [
            "Independently verify the following topics and challenge weak claims.",
            topics.length ? `Topics:\n${topics.map((item) => `- ${item}`).join("\n")}` : "",
            evidence ? `Current claims:\n${evidence}` : "",
            "Use verdict=confirm when a claim holds up independently and verdict=contradict when it does not.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        }),
        agent: "general",
      } satisfies Schedule,
    }
  }

  function reconciler(plan: PlanInfo, conflict: Conflict, claims: ClaimInfo[]) {
    const id = Identifier.ascending("tool")
    const lines = claims
      .filter((item) => conflict.claim_ids.includes(item.id))
      .map((item) => `- ${item.topic}: ${item.statement} [${item.metadata?.verdict ?? "report"}]`)
      .join("\n")
    const row = work(
      id,
      "reconciler",
      `Resolve ${conflict.topic}`,
      `Resolve the conflict on topic "${conflict.topic}" and produce an authoritative conclusion.`,
      "general",
      plan.root_session_id,
      plan.id,
    )
    return {
      row,
      task: {
        description: "resolve conflict",
        prompt: formatPrompt({
          work: WorkInfo.parse({
            ...row,
            session_id: undefined,
            depends_on: undefined,
            verify_against: undefined,
            metadata: undefined,
          }),
          query: plan.query,
          extra: [
            `Conflicting topic: ${conflict.topic}`,
            `Claims:\n${lines}`,
            "Produce the authoritative conclusion. Use verdict=confirm for the winning statement and contradict for rejected alternatives.",
          ].join("\n\n"),
        }),
        agent: "general",
      } satisfies Schedule,
    }
  }

  async function session(session_id: string) {
    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, session_id)).get())
    if (!row) throw new Error(`Session not found: ${session_id}`)
    return row
  }

  async function active(session_id: string) {
    const item = root(await session(session_id))
    const row = Database.use((db) =>
      db
        .select()
        .from(SessionCoordinatorPlanTable)
        .where(eq(SessionCoordinatorPlanTable.root_session_id, item.id))
        .orderBy(desc(SessionCoordinatorPlanTable.id))
        .get(),
    )
    return row
      ? PlanInfo.parse({
          ...row,
          summary: row.summary ?? undefined,
          metadata: row.metadata ?? undefined,
        })
      : undefined
  }

  async function works(plan_id: number) {
    return Database.use((db) =>
      db.select().from(SessionCoordinatorWorkTable).where(eq(SessionCoordinatorWorkTable.plan_id, plan_id)).orderBy(asc(SessionCoordinatorWorkTable.time_created)).all(),
    ).map((item) =>
      WorkInfo.parse({
        ...item,
        session_id: item.session_id ?? undefined,
        depends_on: item.depends_on ?? undefined,
        verify_against: item.verify_against ?? undefined,
        metadata: item.metadata ?? undefined,
      }),
    )
  }

  async function claims(plan_id: number) {
    return Database.use((db) =>
      db.select().from(SessionCoordinatorClaimTable).where(eq(SessionCoordinatorClaimTable.plan_id, plan_id)).orderBy(asc(SessionCoordinatorClaimTable.time_created)).all(),
    ).map((item) =>
      ClaimInfo.parse({
        ...item,
        session_id: item.session_id ?? undefined,
        metadata: item.metadata ?? undefined,
      }),
    )
  }

  function conflicts(input: { works: WorkInfo[]; claims: ClaimInfo[] }) {
    const topics = new Map<string, ClaimInfo[]>()
    for (const item of input.claims.filter((item) => item.status !== "rejected")) {
      const list = topics.get(claimKey(item)) ?? []
      list.push(item)
      topics.set(claimKey(item), list)
    }
    const out: Conflict[] = []
    for (const [key, rows] of topics) {
      const states = [...new Set(rows.map((item) => plain(item.statement)))]
      const verdicts = new Set(rows.map((item) => item.metadata?.verdict ?? "report"))
      if (states.length > 1 || verdicts.has("contradict")) {
        out.push({
          topic: label(rows) || key,
          claim_ids: rows.map((item) => item.id),
          work_ids: [...new Set(rows.map((item) => item.work_id))],
        })
      }
    }
    return out
  }

  async function updateClaimStatus(plan_id: number, conflict: Conflict[]) {
    const all = await claims(plan_id)
    const bad = new Set(conflict.flatMap((item) => item.claim_ids))
    for (const item of all) {
      const next =
        item.status === "rejected" || item.status === "resolved"
          ? item.status
          : bad.has(item.id)
            ? "conflict"
            : item.metadata?.verdict === "confirm"
              ? "verified"
              : "reported"
      if (next === item.status) continue
      Database.use((db) =>
        db
          .update(SessionCoordinatorClaimTable)
          .set({
            status: next,
            time_updated: now(),
          })
          .where(eq(SessionCoordinatorClaimTable.id, item.id))
          .run(),
      )
    }
  }

  async function publish(session_id: string) {
    const snapshot = await get(session_id)
    if (!snapshot.plan) return snapshot
    Database.effect(() =>
      Bus.publish(Event.Updated, {
        root_session_id: snapshot.plan!.root_session_id,
        snapshot,
      }),
    )
    return snapshot
  }

  async function exhausted(plan: PlanInfo) {
    const rows = await works(plan.id)
    if (!rows.length) return false
    const live = rows.some((item) => ["planned", "running", "completed", "verified", "resolved"].includes(item.status))
    if (live) return false
    return rows.every((item) => item.status === "failed" || item.status === "cancelled")
  }

  export const ensure = fn(
    z.object({
      session_id: z.string(),
      query: z.string(),
    }),
    async (input) => {
      const row = await session(input.session_id)
      const top = root(row)
      if (top.kind !== "interactive" || !broad(input.query)) return
      const found = await active(input.session_id)
      if (found && !(await exhausted(found))) return found
      const time = now()
      const created = Database.use((db) =>
        db
          .insert(SessionCoordinatorPlanTable)
          .values({
            root_session_id: top.id,
            session_id: input.session_id,
            mode: "analysis",
            status: "planned",
            query: input.query,
            requirements: requirements(input.query),
            summary: null,
            metadata: null,
            time_created: time,
            time_updated: time,
          })
          .returning()
          .get(),
      )
      const plan = PlanInfo.parse({
        ...created,
        summary: created.summary ?? undefined,
        metadata: created.metadata ?? undefined,
      })
      await publish(input.session_id)
      return plan
    },
  )

  export const bind = fn(
    z.object({
      parent_session_id: z.string(),
      session_id: z.string(),
      agent: z.string(),
      description: z.string(),
      prompt: z.string(),
    }),
    async (input) => {
      const plan = await active(input.parent_session_id)
      if (!plan || plan.status === "finalized") return { prompt: input.prompt }
      const tag = parseMarker(input.prompt)
      const time = now()
      if (tag) {
        const row = (await works(plan.id)).find((item) => item.id === tag.id)
        Database.use((db) =>
          db
            .update(SessionCoordinatorWorkTable)
            .set({
              session_id: input.session_id,
              status: "running",
              metadata: {
                ...(row?.metadata ?? {}),
                timeout_at: time + WORK_TIMEOUT,
              },
              time_updated: time,
            })
            .where(eq(SessionCoordinatorWorkTable.id, tag.id))
            .run(),
        )
        await publish(input.parent_session_id)
        return {
          prompt: strip(input.prompt),
          work_id: tag.id,
        }
      }
      const id = Identifier.ascending("tool")
      Database.use((db) =>
        db
          .insert(SessionCoordinatorWorkTable)
          .values(
            work(id, "primary", input.description, input.description, input.agent, plan.root_session_id, plan.id),
          )
          .run(),
      )
      Database.use((db) =>
        db
          .update(SessionCoordinatorWorkTable)
          .set({
            session_id: input.session_id,
            status: "running",
            metadata: {
              attempt: 1,
              timeout_at: time + WORK_TIMEOUT,
            },
            time_updated: time,
          })
          .where(eq(SessionCoordinatorWorkTable.id, id))
          .run(),
      )
      await refresh({ session_id: input.parent_session_id })
      return {
        prompt: strip(
          formatPrompt({
            work: WorkInfo.parse({
              ...work(id, "primary", input.description, input.description, input.agent, plan.root_session_id, plan.id),
              session_id: input.session_id,
              status: "running",
              depends_on: undefined,
              verify_against: undefined,
              metadata: undefined,
            }),
            query: plan.query,
            extra: input.prompt,
          }),
        ),
        work_id: id,
      }
    },
  )

  export const complete = fn(
    z.object({
      session_id: z.string(),
      text: z.string(),
      structured: z.unknown().optional(),
      context_id: z.number().int().positive().optional(),
    }),
    async (input) => {
      const row = Database.use((db) =>
        db.select().from(SessionCoordinatorWorkTable).where(eq(SessionCoordinatorWorkTable.session_id, input.session_id)).orderBy(desc(SessionCoordinatorWorkTable.time_updated)).get(),
      )
      if (!row) return
      const work = WorkInfo.parse({
        ...row,
        session_id: row.session_id ?? undefined,
        depends_on: row.depends_on ?? undefined,
        verify_against: row.verify_against ?? undefined,
        metadata: row.metadata ?? undefined,
      })
      const parsed = input.structured
        ? (() => {
            const result = Report.safeParse(input.structured)
            if (result.success) return { report: result.data } as const
            return {
              error: result.error.issues.map((item) => `${item.path.join(".") || "root"}: ${item.message}`).join("; "),
            } as const
          })()
        : parseReport(input.text)
      const time = now()
      if (!("report" in parsed)) {
        Database.use((db) =>
          db
            .update(SessionCoordinatorWorkTable)
            .set({
              status: "failed",
              metadata: {
                ...(work.metadata ?? {}),
                summary: `Invalid structured report: ${parsed.error}`,
                error: `Invalid structured report: ${parsed.error}`,
                context_id: input.context_id,
                timeout_at: time + WORK_TIMEOUT,
              },
              time_updated: time,
            })
            .where(eq(SessionCoordinatorWorkTable.id, work.id))
            .run(),
        )
        return refresh({ session_id: work.root_session_id })
      }
      const report = parsed.report
      if (!report) {
        Database.use((db) =>
          db
            .update(SessionCoordinatorWorkTable)
            .set({
              status: "failed",
              metadata: {
                ...(work.metadata ?? {}),
                summary: "Invalid structured report.",
                error: "Invalid structured report.",
                context_id: input.context_id,
                timeout_at: time + WORK_TIMEOUT,
              },
              time_updated: time,
            })
            .where(eq(SessionCoordinatorWorkTable.id, work.id))
            .run(),
        )
        return refresh({ session_id: work.root_session_id })
      }
      const text = report.summary?.trim() ?? ""
      const next: Array<{
        topic: string
        statement: string
        evidence: string[]
        confidence: Confidence
        status: "reported"
        metadata: {
          verdict: ClaimVerdict
          normalized: string
          score: number
          source_files: string[]
        }
      }> = []
      const bad = [] as string[]
      const files = new Set<string>()
      for (const item of report.claims.slice(0, CLAIM_LIMIT)) {
        const refs = await evidence(item.evidence)
        if (!refs.valid.length) {
          bad.push(`${item.topic || item.statement}: ${refs.bad.join(", ") || "missing valid evidence"}`)
          continue
        }
        refs.files.forEach((file) => files.add(file))
        next.push({
          topic: item.topic.trim() || item.statement.trim(),
          statement: item.statement.trim(),
          evidence: refs.valid,
          confidence: item.confidence,
          status: "reported" as const,
          metadata: {
            verdict: item.verdict,
            normalized: normalize(item.topic, item.statement),
            score: score({
              confidence: item.confidence,
              verdict: item.verdict,
              evidence: refs.valid.length,
            }),
            source_files: refs.files,
          },
        })
      }
      if (!text && next.length === 0) {
        Database.use((db) =>
          db
            .update(SessionCoordinatorWorkTable)
            .set({
              status: "failed",
              metadata: {
                ...(work.metadata ?? {}),
                summary: "Empty analysis report.",
                error: "Empty analysis report.",
                context_id: input.context_id,
                invalid_claims: bad,
                timeout_at: time + WORK_TIMEOUT,
              },
              time_updated: time,
            })
            .where(eq(SessionCoordinatorWorkTable.id, work.id))
            .run(),
        )
        return refresh({ session_id: work.root_session_id })
      }
      if (report.claims.length > 0 && next.length === 0) {
        Database.use((db) =>
          db
            .update(SessionCoordinatorWorkTable)
            .set({
              status: "failed",
              metadata: {
                ...(work.metadata ?? {}),
                summary: "All structured claims were rejected during evidence validation.",
                error: "All structured claims were rejected during evidence validation.",
                context_id: input.context_id,
                invalid_claims: bad,
                timeout_at: time + WORK_TIMEOUT,
              },
              time_updated: time,
            })
            .where(eq(SessionCoordinatorWorkTable.id, work.id))
            .run(),
        )
        return refresh({ session_id: work.root_session_id })
      }
      Database.use((db) =>
        db
          .update(SessionCoordinatorWorkTable)
          .set({
            status: "completed",
            metadata: {
              ...(work.metadata ?? {}),
              summary: text,
              context_id: input.context_id,
              risks: report.risks ?? work.metadata?.risks,
              error: undefined,
              verify_topics: report.verify_topics,
              invalid_claims: bad.length ? bad : undefined,
              source_files: [...files],
              timeout_at: time + WORK_TIMEOUT,
            },
            time_updated: time,
          })
          .where(eq(SessionCoordinatorWorkTable.id, work.id))
          .run(),
      )
      Database.use((db) => db.delete(SessionCoordinatorClaimTable).where(eq(SessionCoordinatorClaimTable.work_id, work.id)).run())
      if (work.role === "reconciler") {
        const prev = await claims(work.plan_id)
        const bad = conflicts({
          works: await works(work.plan_id),
          claims: prev,
        })
        const ids = bad.flatMap((item) => item.claim_ids)
        if (ids.length) {
          Database.use((db) =>
            db
              .update(SessionCoordinatorClaimTable)
              .set({
                status: "rejected",
                time_updated: time,
              })
              .where(inArray(SessionCoordinatorClaimTable.id, ids))
              .run(),
          )
        }
      }
      if (next.length) {
        Database.use((db) =>
          db
            .insert(SessionCoordinatorClaimTable)
            .values(
              next.map((item) => ({
                id: Identifier.ascending("tool"),
                plan_id: work.plan_id,
                work_id: work.id,
                root_session_id: work.root_session_id,
                session_id: work.session_id ?? null,
                topic: item.topic,
                statement: item.statement,
                evidence: item.evidence,
                confidence: item.confidence,
                status: "reported",
                metadata: item.metadata,
                time_created: time,
                time_updated: time,
              })),
            )
            .run(),
        )
      }
      const plan = await refresh({ session_id: work.root_session_id })
      if (work.role === "reconciler" && plan.conflicts.length === 0) {
        const source = await works(work.plan_id)
        const ids = source
          .map((item) => item.metadata?.context_id)
          .filter((item): item is number => Boolean(item))
          .slice(-6)
        if (ids.length > 1 && text) {
          await contextResolve({
            session_id: work.root_session_id,
            sources: ids,
            body: text,
          })
        }
      }
      return plan
    },
  )

  export const fail = fn(
    z.object({
      session_id: z.string(),
      error: z.string(),
      context_id: z.number().int().positive().optional(),
    }),
    async (input) => {
      const row = Database.use((db) =>
        db.select().from(SessionCoordinatorWorkTable).where(eq(SessionCoordinatorWorkTable.session_id, input.session_id)).orderBy(desc(SessionCoordinatorWorkTable.time_updated)).get(),
      )
      if (!row) return
      Database.use((db) =>
        db
          .update(SessionCoordinatorWorkTable)
          .set({
            status: "failed",
            metadata: {
              ...(row.metadata ?? {}),
              summary: input.error,
              error: input.error,
              context_id: input.context_id,
              timeout_at: now() + WORK_TIMEOUT,
            },
            time_updated: now(),
          })
          .where(eq(SessionCoordinatorWorkTable.id, row.id))
          .run(),
      )
      return refresh({ session_id: row.root_session_id })
    },
  )

  async function contextResolve(input: { session_id: string; sources: number[]; body: string }) {
    const top = root(await session(input.session_id))
    const time = now()
    Database.use((db) =>
      db
        .insert(SessionContextTable)
        .values({
          root_session_id: top.id,
          session_id: input.session_id,
          time_created: time,
          time_updated: time,
          data: {
            kind: "context_resolution",
            title: "Coordinator resolution",
            body: input.body,
            metadata: {
              strategy: "summary",
              sources: input.sources,
              coordinator: true,
            },
          },
        })
        .run(),
    )
  }

  export const refresh = fn(
    z.object({
      session_id: z.string(),
    }),
    async (input) => {
      const plan = await active(input.session_id)
      if (!plan) return get(input.session_id)
      await stale(plan)
      const ws = await works(plan.id)
      const cs = await claims(plan.id)
      const bad = conflicts({ works: ws, claims: cs })
      await updateClaimStatus(plan.id, bad)
      const nextClaims = await claims(plan.id)
      const primaryDone = ws.filter((item) => item.role === "primary" && ["completed", "verified", "resolved"].includes(item.status)).length
      const verifierDone = ws.filter((item) => item.role === "verifier" && ["completed", "verified", "resolved"].includes(item.status)).length
      const reconActive = ws.some((item) => item.role === "reconciler" && ["planned", "running"].includes(item.status))
      const verifyActive = ws.some((item) => item.role === "verifier" && ["planned", "running"].includes(item.status))
      const status: PlanStatus =
        plan.status === "finalized"
          ? "finalized"
          : bad.length > 0 || reconActive
            ? "awaiting_reconcile"
            : primaryDone < plan.requirements.primary
              ? ws.some((item) => item.role === "primary" && ["running", "completed", "verified", "resolved"].includes(item.status))
                ? "running"
                : "planned"
              : verifierDone < plan.requirements.verifier || verifyActive
                ? "awaiting_verification"
                : "ready_to_finalize"
      Database.use((db) =>
        db
          .update(SessionCoordinatorPlanTable)
          .set({
            status,
            summary: summary({
              plan,
              works: ws,
              conflicts: bad,
            }),
            time_updated: now(),
          })
          .where(eq(SessionCoordinatorPlanTable.id, plan.id))
          .run(),
      )
      const snapshot = Snapshot.parse({
        plan: {
          ...plan,
          status,
          summary: summary({
            plan,
            works: ws,
            conflicts: bad,
          }),
          time_updated: now(),
        },
        works: ws,
        claims: nextClaims,
        conflicts: bad,
        counts: {
          primary: {
            required: plan.requirements.primary,
            completed: primaryDone,
          },
          verifier: {
            required: plan.requirements.verifier,
            completed: verifierDone,
          },
        },
        ready: status === "ready_to_finalize" || status === "finalized",
        summary: summary({
          plan: {
            ...plan,
            status,
          },
          works: ws,
          conflicts: bad,
        }),
      })
      await publish(input.session_id)
      return snapshot
    },
  )

  function summary(input: { plan: Pick<PlanInfo, "status" | "requirements">; works: WorkInfo[]; conflicts: Conflict[] }) {
    const primaryDone = input.works.filter((item) => item.role === "primary" && ["completed", "verified", "resolved"].includes(item.status)).length
    const verifierDone = input.works.filter((item) => item.role === "verifier" && ["completed", "verified", "resolved"].includes(item.status)).length
    const failed = input.works.filter((item) => item.status === "failed").length
    return [
      `analysis ${input.plan.status}`,
      `${primaryDone}/${input.plan.requirements.primary} primary`,
      `${verifierDone}/${input.plan.requirements.verifier} verifier`,
      `${failed} failed`,
      `${input.conflicts.length} conflict${input.conflicts.length === 1 ? "" : "s"}`,
    ].join(" · ")
  }

  function retry(plan: PlanInfo, row: WorkInfo) {
    const id = Identifier.ascending("tool")
    const time = now()
    const attempt = (row.metadata?.attempt ?? 1) + 1
    const next = {
      ...work(id, row.role, row.scope, row.goal, row.agent, plan.root_session_id, plan.id, row.verify_against),
      metadata: {
        ...(row.metadata ?? {}),
        attempt,
        retry_of: row.id,
        timeout_at: time + WORK_TIMEOUT,
      },
    } satisfies typeof SessionCoordinatorWorkTable.$inferInsert
    const extra =
      row.role === "verifier"
        ? verifier(plan, [row], [])
        : row.role === "reconciler"
          ? undefined
          : undefined
    return {
      row: next,
      task: {
        description:
          row.role === "verifier" ? "retry verification" : row.role === "reconciler" ? "retry reconcile" : row.scope.toLowerCase(),
        prompt: formatPrompt({
          work: WorkInfo.parse({
            ...next,
            session_id: undefined,
            depends_on: next.depends_on ?? undefined,
            verify_against: next.verify_against ?? undefined,
            metadata: next.metadata ?? undefined,
          }),
          query: plan.query,
          extra: [
            row.role === "verifier"
              ? "This is a retry after the previous verification run failed validation or timed out."
              : row.role === "reconciler"
                ? "This is a retry after the previous reconciliation run failed validation or timed out."
                : "This is a retry after the previous workstream failed validation or timed out.",
            row.metadata?.error ? `Previous failure: ${row.metadata.error}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        }),
        agent: extra?.task.agent ?? row.agent,
      } satisfies Schedule,
    }
  }

  export const schedule = fn(
    z.object({
      session_id: z.string(),
    }),
    async (input) => {
      const plan = await active(input.session_id)
      if (!plan || plan.status === "finalized") {
        return { plan: undefined, tasks: [] as Schedule[] }
      }
      await stale(plan)
      const ws = await works(plan.id)
      const cs = await claims(plan.id)
      const bad = conflicts({ works: ws, claims: cs })
      const out: Schedule[] = []
      const redo = ws.filter(
        (item) =>
          item.status === "failed" &&
          (item.metadata?.attempt ?? 1) < WORK_ATTEMPTS &&
          !ws.some(
            (next) =>
              next.status !== "failed" &&
              (next.metadata?.retry_of === item.id ||
                (next.metadata?.retry_of === item.metadata?.retry_of && next.metadata?.retry_of !== undefined)),
          ),
      )
      if (redo.length) {
        const rows = redo.map((item) => retry(plan, item))
        Database.use((db) => db.insert(SessionCoordinatorWorkTable).values(rows.map((item) => item.row)).run())
        out.push(...rows.map((item) => item.task))
      }
      if (!ws.some((item) => item.role === "primary")) {
        const rows = primary(plan)
        Database.use((db) => db.insert(SessionCoordinatorWorkTable).values(rows.map((item) => item.row)).run())
        out.push(...rows.map((item) => item.task))
      }
      const next = await works(plan.id)
      const primaryDone = next.filter((item) => item.role === "primary" && ["completed", "verified", "resolved"].includes(item.status)).length
      const primaryLive = next.filter((item) => item.role === "primary" && ["planned", "running", "completed", "verified", "resolved"].includes(item.status)).length
      if (primaryLive < plan.requirements.primary) {
        const missing = plan.requirements.primary - primaryLive
        const rows = Array.from({ length: missing }, (_, idx) => extra(plan, primaryLive + idx + 1))
        Database.use((db) => db.insert(SessionCoordinatorWorkTable).values(rows.map((item) => item.row)).run())
        out.push(...rows.map((item) => item.task))
      }
      const after = await works(plan.id)
      const verifierDone = after.filter((item) => item.role === "verifier" && ["completed", "verified", "resolved"].includes(item.status)).length
      const verifierLive = after.some((item) => item.role === "verifier" && ["planned", "running"].includes(item.status))
      if (!bad.length && primaryDone >= plan.requirements.primary && verifierDone < plan.requirements.verifier && !verifierLive) {
        const row = verifier(plan, after, cs)
        Database.use((db) => db.insert(SessionCoordinatorWorkTable).values(row.row).run())
        out.push(row.task)
      }
      if (bad.length && !after.some((item) => item.role === "reconciler" && ["planned", "running"].includes(item.status))) {
        const row = reconciler(plan, bad[0], cs)
        Database.use((db) => db.insert(SessionCoordinatorWorkTable).values(row.row).run())
        out.push(row.task)
      }
      await refresh({ session_id: input.session_id })
      return { plan: await active(input.session_id), tasks: out }
    },
  )

  export const reply = fn(z.object({ session_id: z.string() }), async (input) => {
    const snap = await refresh({ session_id: input.session_id })
    if (!snap.plan || !snap.ready) return
    const rows = accepted(snap.claims)
    const findingTokens = new Set(rows.flatMap((r) => r.key.split(" ")))
    const allRisks = [...new Set(snap.works.flatMap((item) => item.metadata?.risks ?? []))]
    const risks = allRisks.filter((risk) => {
      const tokens = normalize(risk).split(" ")
      return !tokens.some((t) => findingTokens.has(t))
    }).slice(0, 5)
    const findings = rows
      .slice(0, 10)
      .map((item) => `- **${item.topic}**: ${item.row.statement}`)
    const scopes = snap.works
      .filter((item) => ["completed", "verified", "resolved"].includes(item.status))
      .filter((item) => item.role !== "reconciler")
      .map((item) => {
        const text = item.metadata?.summary ?? item.goal
        return `- **${item.scope}**: ${text.replace(/\/home\/[^ ,]*/g, (m) => m.split("/").pop() ?? m)}`
      })
      .slice(0, 4)
    const head = snap.plan.query.trim() ? snap.plan.query : "Analysis complete"
    return [
      head,
      "",
      findings.length ? "**Findings**" : undefined,
      ...findings,
      risks.length ? "" : undefined,
      risks.length ? "**Risks**" : undefined,
      ...risks.map((item) => `- ${item}`),
      scopes.length ? "" : undefined,
      scopes.length ? "**Scopes analyzed**" : undefined,
      ...scopes,
    ]
      .filter(Boolean)
      .join("\n")
  })

  export const get = fn(z.string(), async (session_id) => {
    const plan = await active(session_id)
    if (!plan) {
      return Snapshot.parse({
        plan: undefined,
        works: [],
        claims: [],
        conflicts: [],
        counts: {
          primary: {
            required: DEFAULT_PRIMARY,
            completed: 0,
          },
          verifier: {
            required: DEFAULT_VERIFIER,
            completed: 0,
          },
        },
        ready: true,
        summary: "No coordinator plan",
      })
    }
    const ws = await works(plan.id)
    const cs = await claims(plan.id)
    const bad = conflicts({ works: ws, claims: cs })
    return Snapshot.parse({
      plan,
      works: ws,
      claims: cs,
      conflicts: bad,
      counts: {
        primary: {
          required: plan.requirements.primary,
          completed: ws.filter((item) => item.role === "primary" && ["completed", "verified", "resolved"].includes(item.status)).length,
        },
        verifier: {
          required: plan.requirements.verifier,
          completed: ws.filter((item) => item.role === "verifier" && ["completed", "verified", "resolved"].includes(item.status)).length,
        },
      },
      ready: plan.status === "ready_to_finalize" || plan.status === "finalized",
      summary: summary({
        plan,
        works: ws,
        conflicts: bad,
      }),
    })
  })

  export const finalize = fn(z.object({ session_id: z.string() }), async (input) => {
    const plan = await active(input.session_id)
    if (!plan) return
    Database.use((db) =>
      db
        .update(SessionCoordinatorPlanTable)
        .set({
          status: "finalized",
          time_updated: now(),
        })
        .where(eq(SessionCoordinatorPlanTable.id, plan.id))
        .run(),
    )
    return publish(input.session_id)
  })
}

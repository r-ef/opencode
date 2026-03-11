import { sqliteTable, text, integer, index, primaryKey, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import type { MessageV2 } from "./message-v2"
import type { Snapshot } from "@/snapshot"
import type { PermissionNext } from "@/permission/next"
import { Timestamps } from "@/storage/schema.sql"

type PartData = Omit<MessageV2.Part, "id" | "sessionID" | "messageID">
type InfoData = Omit<MessageV2.Info, "id" | "sessionID">
type ContextData = {
  kind: string
  title?: string
  body: string
  metadata?: Record<string, unknown>
}
type PlanRequirements = {
  primary: number
  verifier: number
}
type WorkMeta = {
  summary?: string
  context_id?: number
  risks?: string[]
  query?: string
  attempt?: number
  retry_of?: string
  timeout_at?: number
  error?: string
  verify_topics?: string[]
  invalid_claims?: string[]
  source_files?: string[]
}
type ClaimMeta = {
  verdict?: "report" | "confirm" | "contradict"
  normalized?: string
  score?: number
  issue?: string
  source_files?: string[]
}

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text(),
    kind: text().notNull().default("interactive"),
    root_id: text()
      .references((): AnySQLiteColumn => SessionTable.id, { onDelete: "cascade" }),
    parent_id: text(),
    branch_from_session_id: text(),
    branch_from_message_id: text(),
    slug: text().notNull(),
    directory: text().notNull(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),
    revert: text({ mode: "json" }).$type<{ messageID: string; partID?: string; snapshot?: string; diff?: string }>(),
    permission: text({ mode: "json" }).$type<PermissionNext.Ruleset>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_kind_idx").on(table.kind),
    index("session_root_idx").on(table.root_id),
    index("session_parent_idx").on(table.parent_id),
    index("session_branch_from_session_idx").on(table.branch_from_session_id),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<InfoData>(),
  },
  (table) => [index("message_session_idx").on(table.session_id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().primaryKey(),
    message_id: text()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<PartData>(),
  },
  (table) => [index("part_message_idx").on(table.message_id), index("part_session_idx").on(table.session_id)],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const PermissionTable = sqliteTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<PermissionNext.Ruleset>(),
})

export const SessionContextTable = sqliteTable(
  "session_context",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<ContextData>(),
  },
  (table) => [
    index("session_context_root_session_id_idx").on(table.root_session_id),
    index("session_context_session_id_idx").on(table.session_id),
    index("session_context_time_created_idx").on(table.time_created),
  ],
)

export const SessionContextStateTable = sqliteTable(
  "session_context_state",
  {
    session_id: text()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    cursor: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("session_context_state_root_session_id_idx").on(table.root_session_id),
    index("session_context_state_cursor_idx").on(table.cursor),
  ],
)

export const SessionCoordinationTable = sqliteTable(
  "session_coordination",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    from_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    to_session_id: text().references(() => SessionTable.id, { onDelete: "cascade" }),
    to_agent: text(),
    request_id: text(),
    kind: text().notNull(),
    status: text().notNull(),
    title: text(),
    body: text().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    index("session_coordination_root_session_id_idx").on(table.root_session_id),
    index("session_coordination_from_session_id_idx").on(table.from_session_id),
    index("session_coordination_to_session_id_idx").on(table.to_session_id),
    index("session_coordination_to_agent_idx").on(table.to_agent),
    index("session_coordination_request_id_idx").on(table.request_id),
    index("session_coordination_status_idx").on(table.status),
    index("session_coordination_time_created_idx").on(table.time_created),
  ],
)

export const SessionCoordinationStateTable = sqliteTable(
  "session_coordination_state",
  {
    session_id: text()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    cursor: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("session_coordination_state_root_session_id_idx").on(table.root_session_id),
    index("session_coordination_state_cursor_idx").on(table.cursor),
  ],
)

export const SessionCoordinatorPlanTable = sqliteTable(
  "session_coordinator_plan",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    mode: text().notNull(),
    status: text().notNull(),
    query: text().notNull(),
    requirements: text({ mode: "json" }).notNull().$type<PlanRequirements>(),
    summary: text(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    index("session_coordinator_plan_root_session_id_idx").on(table.root_session_id),
    index("session_coordinator_plan_status_idx").on(table.status),
  ],
)

export const SessionCoordinatorWorkTable = sqliteTable(
  "session_coordinator_work",
  {
    id: text().primaryKey(),
    plan_id: integer()
      .notNull()
      .references(() => SessionCoordinatorPlanTable.id, { onDelete: "cascade" }),
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    role: text().notNull(),
    agent: text().notNull(),
    scope: text().notNull(),
    goal: text().notNull(),
    status: text().notNull(),
    depends_on: text({ mode: "json" }).$type<string[]>(),
    verify_against: text(),
    metadata: text({ mode: "json" }).$type<WorkMeta>(),
    ...Timestamps,
  },
  (table) => [
    index("session_coordinator_work_plan_id_idx").on(table.plan_id),
    index("session_coordinator_work_root_session_id_idx").on(table.root_session_id),
    index("session_coordinator_work_session_id_idx").on(table.session_id),
    index("session_coordinator_work_status_idx").on(table.status),
  ],
)

export const SessionCoordinatorClaimTable = sqliteTable(
  "session_coordinator_claim",
  {
    id: text().primaryKey(),
    plan_id: integer()
      .notNull()
      .references(() => SessionCoordinatorPlanTable.id, { onDelete: "cascade" }),
    work_id: text()
      .notNull()
      .references(() => SessionCoordinatorWorkTable.id, { onDelete: "cascade" }),
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    topic: text().notNull(),
    statement: text().notNull(),
    evidence: text({ mode: "json" }).notNull().$type<string[]>(),
    confidence: text().notNull(),
    status: text().notNull(),
    metadata: text({ mode: "json" }).$type<ClaimMeta>(),
    ...Timestamps,
  },
  (table) => [
    index("session_coordinator_claim_plan_id_idx").on(table.plan_id),
    index("session_coordinator_claim_work_id_idx").on(table.work_id),
    index("session_coordinator_claim_root_session_id_idx").on(table.root_session_id),
    index("session_coordinator_claim_status_idx").on(table.status),
    index("session_coordinator_claim_topic_idx").on(table.topic),
  ],
)

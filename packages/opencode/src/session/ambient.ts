import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { TaskBranch } from "@/task/branch"
import { TaskRun } from "@/task/run"
import { Log } from "@/util/log"

export namespace SessionAmbient {
  const log = Log.create({ service: "session.ambient" })

  type Row = {
    kind: "task" | "branch"
    id: string
    parentID: string
    rootID: string
    title: string
    last?: string
  }

  const state = Instance.state(
    () => ({
      rows: new Map<string, Row>(),
      off: [] as (() => void)[],
    }),
    async (item) => {
      item.off.forEach((off) => off())
    },
  )

  function key(kind: Row["kind"], id: string) {
    return `${kind}:${id}`
  }

  async function ping(sessionID: string, text: string, metadata: Record<string, unknown>) {
    const { SessionPrompt } = await import("./prompt")
    await SessionPrompt.followup({
      sessionID,
      text: ["<system-reminder>", text, "</system-reminder>"].join("\n"),
      metadata,
    }).catch((error) => {
      log.warn("ambient followup failed", { sessionID, error })
    })
  }

  function init() {
    if (state().off.length) return
    state().off = [
      Bus.subscribe(TaskRun.Event.Entry, (event) => {
        void onTask(event.properties.taskID, event.properties.event)
      }),
      Bus.subscribe(TaskBranch.Event.Entry, (event) => {
        void onBranch(event.properties.branchID, event.properties.event)
      }),
      Bus.subscribe(Session.Event.Context, (event) => {
        void onContext(event.properties.info)
      }),
    ]
  }

  function note(item: Row, next: string) {
    if (item.last === next) return false
    item.last = next
    return true
  }

  async function onTask(id: string, event: TaskRun.Info["events"][number]) {
    const item = state().rows.get(key("task", id))
    if (!item) return

    if (event.type === "completed") {
      if (!note(item, `completed:${event.id}`)) return
      await ping(
        item.parentID,
        [
          `Background task complete: ${item.title}.`,
          "Review the latest shared session context updates and continue helping the user.",
          `task_id: ${id}`,
        ].join("\n"),
        { ambient: true, kind: "task", task_id: id, status: "completed" },
      )
      state().rows.delete(key("task", id))
      return
    }

    if (event.type === "error" || event.type === "cancelled" || event.type === "interrupted") {
      if (!note(item, `${event.type}:${event.id}`)) return
      await ping(
        item.parentID,
        [
          `Background task ${event.type}: ${item.title}.`,
          "Review the latest shared session context updates, explain the outcome if needed, and choose the next step yourself when possible.",
          `task_id: ${id}`,
        ].join("\n"),
        { ambient: true, kind: "task", task_id: id, status: event.type },
      )
      state().rows.delete(key("task", id))
    }
  }

  async function onBranch(id: string, event: TaskBranch.Info["events"][number]) {
    const item = state().rows.get(key("branch", id))
    if (!item) return

    if (event.type === "winner") {
      if (!note(item, `winner:${event.id}`)) return
      await ping(
        item.parentID,
        [
          `Background branch winner ready: ${item.title}.`,
          "Review the latest shared session context updates.",
          "If applying the winning branch is the natural next step, call task_branch_apply yourself instead of asking the user to do it manually.",
          `branch_id: ${id}`,
        ].join("\n"),
        { ambient: true, kind: "branch", branch_id: id, status: "winner" },
      )
      return
    }

    if (event.type === "applied" || event.type === "apply_error") {
      if (!note(item, `${event.type}:${event.id}`)) return
      await ping(
        item.parentID,
        [
          `Background branch ${event.type === "applied" ? "apply finished" : "apply failed"}: ${item.title}.`,
          "Review the latest shared session context updates and continue helping the user.",
          `branch_id: ${id}`,
        ].join("\n"),
        { ambient: true, kind: "branch", branch_id: id, status: event.type },
      )
      if (event.type === "applied") state().rows.delete(key("branch", id))
      return
    }

    if (event.type === "completed" || event.type === "error" || event.type === "cancelled" || event.type === "interrupted") {
      if (!note(item, `${event.type}:${event.id}`)) return
      await ping(
        item.parentID,
        [
          `Background branch run ${event.type}: ${item.title}.`,
          "Review the latest shared session context updates and continue helping the user.",
          `branch_id: ${id}`,
        ].join("\n"),
        { ambient: true, kind: "branch", branch_id: id, status: event.type },
      )
      if (event.type !== "completed") state().rows.delete(key("branch", id))
    }
  }

  async function onContext(info: Session.ContextInfo) {
    const meta = info.data.metadata
    const task = typeof meta?.["task_id"] === "string" ? state().rows.get(key("task", meta["task_id"])) : undefined
    if (task && note(task, `context:${info.id}`)) {
      await ping(
        task.parentID,
        [
          `Background task published a useful update: ${task.title}.`,
          "Review the latest shared session context and decide the next step yourself when possible.",
          `task_id: ${task.id}`,
        ].join("\n"),
        { ambient: true, kind: "task", task_id: task.id, context_id: info.id, context_kind: info.data.kind },
      )
    }

    const branch = typeof meta?.["branch_id"] === "string" ? state().rows.get(key("branch", meta["branch_id"])) : undefined
    if (branch && note(branch, `context:${info.id}`)) {
      await ping(
        branch.parentID,
        [
          `Background branch published a useful update: ${branch.title}.`,
          "Review the latest shared session context and continue helping the user.",
          `branch_id: ${branch.id}`,
        ].join("\n"),
        { ambient: true, kind: "branch", branch_id: branch.id, context_id: info.id, context_kind: info.data.kind },
      )
    }
  }

  export function track(input: { kind: Row["kind"]; id: string; parentID: string; rootID: string; title: string }) {
    init()
    state().rows.set(key(input.kind, input.id), {
      kind: input.kind,
      id: input.id,
      parentID: input.parentID,
      rootID: input.rootID,
      title: input.title,
    })
  }
}

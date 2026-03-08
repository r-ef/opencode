import { Scheduler } from "@/scheduler"
import { TaskApply } from "./apply"
import { TaskBranch } from "./branch"
import { TaskRun } from "./run"

export namespace TaskRecovery {
  const timeout = 15_000
  const interval = 15_000

  export function init() {
    Scheduler.register({
      id: "task.recovery",
      interval,
      scope: "instance",
      run: recover,
    })
  }

  export async function recover() {
    const cutoff = Date.now() - timeout
    const [tasks, active, apply, all] = await Promise.all([
      TaskRun.list({ status: "running", limit: 1000 }),
      TaskBranch.list({ status: "running", limit: 1000 }),
      TaskApply.list(),
      TaskBranch.list({ limit: 1000 }),
    ])

    const stale = apply.filter((item) => item.runtime.heartbeat < cutoff)
    const done = new Set(stale.map((item) => item.branchID))

    await Promise.all([
      ...tasks
        .filter((item) => (item.runtime?.heartbeat ?? 0) < cutoff)
        .map((item) => TaskRun.interrupt(item.id, "Task interrupted after runtime owner disappeared")),
      ...active
        .filter((item) => (item.runtime?.heartbeat ?? 0) < cutoff)
        .map((item) => TaskBranch.interrupt(item.id, "Branch interrupted after runtime owner disappeared")),
      ...stale.map(async (item) => {
        await TaskApply.rollback(item.branchID, item)
        await TaskBranch.setApply(item.branchID, {
          status: "error",
          name: item.apply.name,
          sessionId: item.apply.sessionId,
          files: item.apply.files,
          time: Date.now(),
          error: "Apply interrupted and rolled back after runtime owner disappeared",
        }).catch(() => undefined)
        await TaskApply.clear(item.branchID)
      }),
      ...all
        .filter((item) => item.applied?.status === "running")
        .filter((item) => !done.has(item.id))
        .filter((item) => (item.applied?.time ?? 0) < cutoff)
        .map((item) =>
          TaskBranch.setApply(item.id, {
            status: "completed",
            name: item.applied!.name,
            sessionId: item.applied!.sessionId,
            files: item.applied!.files,
            time: Date.now(),
          }),
        ),
    ])
  }
}

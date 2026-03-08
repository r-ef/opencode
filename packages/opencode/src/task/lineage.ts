import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { PermissionNext } from "@/permission/next"
import { Session } from "@/session"
import { TaskRun } from "./run"

export namespace TaskLineage {
  export async function validate(input: { taskID: string; parentID: string; agent: string }) {
    const [task, parent] = await Promise.all([Session.get(input.taskID), Session.get(input.parentID)])
    if (task.projectID !== Instance.project.id || parent.projectID !== Instance.project.id) {
      throw new Error(`Task not found in current project: ${input.taskID}`)
    }
    if (task.kind !== "subagent") {
      throw new Error(`Task is not a subagent session: ${input.taskID}`)
    }
    if (task.time.archived) {
      throw new Error(`Task is archived: ${input.taskID}`)
    }
    if (task.rootID !== parent.rootID) {
      throw new Error(`Task belongs to a different root session tree: ${input.taskID}`)
    }

    const agent = await TaskRun.get(input.taskID)
      .then((item) => item.agent)
      .catch(async () => {
        const msgs = await Session.messages({ sessionID: input.taskID })
        return msgs.find((item) => item.info.role === "user")?.info.agent
      })

    if (agent && agent !== input.agent) {
      throw new Error(`Task ${input.taskID} belongs to @${agent}, not @${input.agent}`)
    }

    return { task, parent, agent }
  }

  export async function permission(input: { parent: Session.Info; allow: boolean }) {
    const cfg = await Config.get()
    return PermissionNext.merge(
      input.parent.permission ?? [],
      [
        {
          permission: "todowrite",
          pattern: "*",
          action: "deny",
        },
        {
          permission: "todoread",
          pattern: "*",
          action: "deny",
        },
        ...(input.allow
          ? []
          : [
              {
                permission: "task" as const,
                pattern: "*" as const,
                action: "deny" as const,
              },
            ]),
        ...(cfg.experimental?.primary_tools?.map((item) => ({
          permission: item,
          pattern: "*",
          action: "deny" as const,
        })) ?? []),
      ],
    )
  }
}

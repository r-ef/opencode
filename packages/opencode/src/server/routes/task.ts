import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { TaskBranch } from "@/task/branch"
import { TaskRun } from "@/task/run"
import { branchApply, branchCancel, taskCancel } from "@/tool/task"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { TaskLineage } from "@/task/lineage"
import { Identifier } from "@/id/id"
import { Bus } from "@/bus"

function clip(text: string, max = 3000) {
  if (text.length <= max) return text
  return text.slice(0, max) + "\n…[truncated]"
}

function text(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

async function wait(input: {
  ms: number
  ready: () => Promise<boolean>
  done: (event: { id: number }) => boolean
  sub: (fn: (event: { id: number }) => void) => () => void
}) {
  if (input.ms <= 0) return
  if (await input.ready()) return
  await new Promise<void>((resolve) => {
    let end = false
    const finish = () => {
      if (end) return
      end = true
      clearTimeout(timer)
      off()
      resolve()
    }
    const off = input.sub((event) => {
      if (!input.done(event)) return
      finish()
    })
    const timer = setTimeout(() => {
      finish()
    }, input.ms)
    void input.ready().then((ok) => {
      if (!ok) return
      finish()
    })
  })
}

export const TaskRoutes = lazy(() => {
  const app = new Hono()

  app.get(
    "/branch",
    describeRoute({
      summary: "List task branch runs",
      description: "List persisted task-branch tournaments for the current project or directory.",
      operationId: "taskBranch.list",
      responses: {
        200: {
          description: "Task branch runs",
          content: {
            "application/json": {
              schema: resolver(TaskBranch.Info.array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        directory: z.string().optional(),
        session_id: z.string().optional(),
        status: TaskBranch.Status.optional(),
        limit: z.coerce.number().optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query")
      return c.json(
        await TaskBranch.list({
          directory: query.directory,
          sessionId: query.session_id,
          status: query.status,
          limit: query.limit,
        }),
      )
    },
  )

  app.get(
    "/branch/:branchID",
    describeRoute({
      summary: "Get task branch run",
      description: "Get a persisted task-branch tournament by id.",
      operationId: "taskBranch.get",
      responses: {
        200: {
          description: "Task branch run",
          content: {
            "application/json": {
              schema: resolver(TaskBranch.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        branchID: Identifier.schema("tool"),
      }),
    ),
    async (c) => {
      return c.json(await TaskBranch.get(c.req.valid("param").branchID))
    },
  )

  app.get(
    "/branch/:branchID/events",
    describeRoute({
      summary: "List task branch events",
      description: "List persisted lifecycle events for a task-branch tournament.",
      operationId: "taskBranch.events",
      responses: {
        200: {
          description: "Task branch events",
          content: {
            "application/json": {
              schema: resolver(TaskBranch.Info.shape.events),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        branchID: Identifier.schema("tool"),
      }),
    ),
    validator(
      "query",
      z.object({
        cursor: z.coerce.number().optional(),
        limit: z.coerce.number().optional(),
        wait_ms: z.coerce.number().optional(),
      }),
    ),
    async (c) => {
      const params = c.req.valid("param")
      const query = c.req.valid("query")
      let info = await TaskBranch.get(params.branchID)
      let rows = info.events.filter((item) => item.id > (query.cursor ?? 0)).slice(0, query.limit ?? 100)
      if (!rows.length && (query.wait_ms ?? 0) > 0) {
        await wait({
          ms: query.wait_ms ?? 0,
          ready: async () => {
            const info = await TaskBranch.get(params.branchID)
            return info.events.some((item) => item.id > (query.cursor ?? 0))
          },
          done: (event) => event.id > (query.cursor ?? 0),
          sub: (fn) =>
            Bus.subscribe(TaskBranch.Event.Entry, (event) => {
              if (event.properties.branchID !== params.branchID) return
              fn(event.properties.event)
            }),
        })
        info = await TaskBranch.get(params.branchID)
        rows = info.events.filter((item) => item.id > (query.cursor ?? 0)).slice(0, query.limit ?? 100)
      }
      return c.json(rows)
    },
  )

  app.post(
    "/branch/:branchID/cancel",
    describeRoute({
      summary: "Cancel task branch run",
      description: "Cancel a running task-branch tournament and all live child sessions.",
      operationId: "taskBranch.cancel",
      responses: {
        200: {
          description: "Cancelled task branch run",
          content: {
            "application/json": {
              schema: resolver(TaskBranch.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        branchID: Identifier.schema("tool"),
      }),
    ),
    async (c) => {
      return c.json(await branchCancel(c.req.valid("param").branchID))
    },
  )

  app.post(
    "/branch/:branchID/apply",
    describeRoute({
      summary: "Apply task branch winner",
      description: "Apply a completed task-branch winner or named branch back into the current workspace.",
      operationId: "taskBranch.apply",
      responses: {
        200: {
          description: "Applied task branch winner",
          content: {
            "application/json": {
              schema: resolver(TaskBranch.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        branchID: Identifier.schema("tool"),
      }),
    ),
    validator(
      "json",
      z.object({
        branch: z.string().optional(),
      }),
    ),
    async (c) => {
      const params = c.req.valid("param")
      const body = c.req.valid("json")
      await branchApply({ branch_id: params.branchID, branch: body.branch })
      return c.json(await TaskBranch.get(params.branchID))
    },
  )

  app.get(
    "/",
    describeRoute({
      summary: "List task runs",
      description: "List persisted task runs for the current project or directory.",
      operationId: "task.list",
      responses: {
        200: {
          description: "Task runs",
          content: {
            "application/json": {
              schema: resolver(TaskRun.Info.array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        directory: z.string().optional(),
        parent_session_id: z.string().optional(),
        root_session_id: z.string().optional(),
        status: TaskRun.Status.optional(),
        limit: z.coerce.number().optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query")
      return c.json(
        await TaskRun.list({
          directory: query.directory,
          parentSessionID: query.parent_session_id,
          rootSessionID: query.root_session_id,
          status: query.status,
          limit: query.limit,
        }),
      )
    },
  )

  app.get(
    "/:taskID",
    describeRoute({
      summary: "Get task run",
      description: "Get a persisted task run by subagent session id.",
      operationId: "task.get",
      responses: {
        200: {
          description: "Task run",
          content: {
            "application/json": {
              schema: resolver(TaskRun.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        taskID: Identifier.schema("session"),
      }),
    ),
    async (c) => {
      return c.json(await TaskRun.ensure(c.req.valid("param").taskID))
    },
  )

  app.get(
    "/:taskID/events",
    describeRoute({
      summary: "List task events",
      description: "List persisted lifecycle events for a task run.",
      operationId: "task.events",
      responses: {
        200: {
          description: "Task events",
          content: {
            "application/json": {
              schema: resolver(TaskRun.Info.shape.events),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        taskID: Identifier.schema("session"),
      }),
    ),
    validator(
      "query",
      z.object({
        cursor: z.coerce.number().optional(),
        limit: z.coerce.number().optional(),
        wait_ms: z.coerce.number().optional(),
      }),
    ),
    async (c) => {
      const params = c.req.valid("param")
      const query = c.req.valid("query")
      let info = await TaskRun.ensure(params.taskID)
      let rows = info.events.filter((item) => item.id > (query.cursor ?? 0)).slice(0, query.limit ?? 100)
      if (!rows.length && (query.wait_ms ?? 0) > 0) {
        await wait({
          ms: query.wait_ms ?? 0,
          ready: async () => {
            const info = await TaskRun.ensure(params.taskID)
            return info.events.some((item) => item.id > (query.cursor ?? 0))
          },
          done: (event) => event.id > (query.cursor ?? 0),
          sub: (fn) =>
            Bus.subscribe(TaskRun.Event.Entry, (event) => {
              if (event.properties.taskID !== params.taskID) return
              fn(event.properties.event)
            }),
        })
        info = await TaskRun.ensure(params.taskID)
        rows = info.events.filter((item) => item.id > (query.cursor ?? 0)).slice(0, query.limit ?? 100)
      }
      return c.json(rows)
    },
  )

  app.post(
    "/:taskID/cancel",
    describeRoute({
      summary: "Cancel task run",
      description: "Cancel a running task and mark it as cancelled.",
      operationId: "task.cancel",
      responses: {
        200: {
          description: "Cancelled task run",
          content: {
            "application/json": {
              schema: resolver(TaskRun.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        taskID: Identifier.schema("session"),
      }),
    ),
    async (c) => {
      return c.json(await taskCancel(c.req.valid("param").taskID))
    },
  )

  app.post(
    "/:taskID/resume",
    describeRoute({
      summary: "Resume task run",
      description: "Resume a persisted task session directly via the backend task domain.",
      operationId: "task.resume",
      responses: {
        200: {
          description: "Resumed task run",
          content: {
            "application/json": {
              schema: resolver(TaskRun.Info),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        taskID: Identifier.schema("session"),
      }),
    ),
    validator(
      "json",
      z.object({
        parent_session_id: Identifier.schema("session"),
        prompt: z.string().optional(),
        parts: SessionPrompt.PromptInput.shape.parts.optional(),
        background: z.boolean().optional(),
        model: z
          .object({
            providerID: z.string(),
            modelID: z.string(),
          })
          .optional(),
        variant: z.string().optional(),
      }),
    ),
    async (c) => {
      const params = c.req.valid("param")
      const body = c.req.valid("json")
      const run = await TaskRun.ensure(params.taskID)
      const parent = await Session.get(body.parent_session_id)
      const task = await TaskLineage.validate({
        taskID: params.taskID,
        parentID: body.parent_session_id,
        agent: run.agent,
      }).then((item) => item.task)
      const parts = body.parts?.length
        ? body.parts
        : body.prompt
          ? await SessionPrompt.resolvePromptParts(body.prompt)
          : [{ type: "text" as const, text: "Continue." }]
      const model = body.model ?? run.model
      const background = body.background === true

      await TaskRun.upsert({
        session: task,
        parent,
        description: run.description,
        prompt: body.prompt ?? run.prompt,
        agent: run.agent,
        background,
        model,
        resumed: true,
      })

      const exec = () =>
        TaskRun.watch(task.id, () =>
          SessionPrompt.prompt({
            sessionID: task.id,
            messageID: Identifier.ascending("message"),
            model,
            agent: run.agent,
            variant: body.variant,
            permission: task.permission,
            parts,
          }),
        )

      if (background) {
        void exec()
          .then(async (msg) => {
            const out = msg.parts.findLast((item) => item.type === "text")?.text ?? ""
            await TaskRun.finish(task.id, { status: "completed", output: clip(out || "Task completed.") })
          })
          .catch(async (err) => {
            await TaskRun.finish(task.id, { status: "error", error: text(err) })
          })
        return c.json(await TaskRun.ensure(task.id))
      }

      try {
        const msg = await exec()
        const out = msg.parts.findLast((item) => item.type === "text")?.text ?? ""
        await TaskRun.finish(task.id, { status: "completed", output: clip(out || "Task completed.") })
        return c.json(await TaskRun.ensure(task.id))
      } catch (err) {
        await TaskRun.finish(task.id, { status: "error", error: text(err) })
        throw err
      }
    },
  )

  return app
})

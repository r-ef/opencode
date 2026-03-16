import z from "zod"

export namespace TaskEvent {
  export const Type = z
    .enum([
      "created",
      "running",
      "resumed",
      "completed",
      "error",
      "cancelled",
      "interrupted",
      "winner",
      "applied",
      "apply_error",
      "progress",
    ])
    .meta({
      ref: "TaskEventType",
    })
  export type Type = z.infer<typeof Type>

  export const Progress = z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("tool_started"),
        tool: z.string(),
        title: z.string().optional(),
      }),
      z.object({
        kind: z.literal("tool_completed"),
        tool: z.string(),
        title: z.string().optional(),
      }),
      z.object({
        kind: z.literal("tool_error"),
        tool: z.string(),
        error: z.string(),
      }),
      z.object({
        kind: z.literal("reasoning"),
        text: z.string(),
      }),
      z.object({
        kind: z.literal("text"),
        text: z.string(),
      }),
      z.object({
        kind: z.literal("context_published"),
        id: z.number().int(),
        event: z.string(),
      }),
      z.object({
        kind: z.literal("branch_started"),
        name: z.string(),
        sessionId: z.string(),
      }),
      z.object({
        kind: z.literal("branch_completed"),
        name: z.string(),
        sessionId: z.string(),
      }),
      z.object({
        kind: z.literal("branch_error"),
        name: z.string(),
        sessionId: z.string(),
        error: z.string().optional(),
      }),
      z.object({
        kind: z.literal("branch_cancelled"),
        name: z.string(),
        sessionId: z.string(),
      }),
      z.object({
        kind: z.literal("branch_tool_started"),
        name: z.string(),
        sessionId: z.string(),
        tool: z.string(),
        title: z.string().optional(),
      }),
      z.object({
        kind: z.literal("branch_tool_completed"),
        name: z.string(),
        sessionId: z.string(),
        tool: z.string(),
        title: z.string().optional(),
      }),
      z.object({
        kind: z.literal("branch_tool_error"),
        name: z.string(),
        sessionId: z.string(),
        tool: z.string(),
        error: z.string(),
      }),
      z.object({
        kind: z.literal("branch_reasoning"),
        name: z.string(),
        sessionId: z.string(),
        text: z.string(),
      }),
      z.object({
        kind: z.literal("branch_text"),
        name: z.string(),
        sessionId: z.string(),
        text: z.string(),
      }),
      z.object({
        kind: z.literal("branch_context_published"),
        name: z.string(),
        sessionId: z.string(),
        id: z.number().int(),
        event: z.string(),
      }),
    ])
    .meta({
      ref: "TaskProgressEvent",
    })
  export type Progress = z.infer<typeof Progress>

  export const Info = z
    .object({
      id: z.number().int().positive(),
      time: z.number().int(),
      type: Type,
      title: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      progress: Progress.optional(),
    })
    .meta({
      ref: "TaskEvent",
    })
  export type Info = z.infer<typeof Info>

  export function push(list: Info[] | undefined, input: Omit<Info, "id" | "time"> & { time?: number }) {
    const rows = list ?? []
    return [
      ...rows,
      {
        id: (rows.at(-1)?.id ?? 0) + 1,
        time: input.time ?? Date.now(),
        type: input.type,
        title: input.title,
        data: input.data,
        progress: input.progress,
      },
    ]
  }
}

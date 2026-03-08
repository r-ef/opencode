import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ProviderTransform } from "@/provider/transform"
import { SessionMemory } from "./memory"
import { Auth } from "@/auth"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  const COMPACTION_BUFFER = 20_000

  function reserve(model: Provider.Model, config: Awaited<ReturnType<typeof Config.get>>) {
    return config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(model))
  }

  function usable(model: Provider.Model, config: Awaited<ReturnType<typeof Config.get>>) {
    const out = reserve(model, config)
    return model.limit.input ? model.limit.input - out : model.limit.context - ProviderTransform.maxOutputTokens(model)
  }

  function resumable(model: Provider.Model) {
    if (model.providerID !== "openai" && model.api.npm !== "@ai-sdk/openai") return false
    return !`${model.id} ${model.api.id}`.toLowerCase().includes("codex")
  }

  function endpoint(url: string) {
    const base = url.replace(/\/+$/, "")
    return `${base.endsWith("/v1") ? base : `${base}/v1`}/responses/compact`
  }

  function token(auth: Awaited<ReturnType<typeof Auth.get>>, cfg: Awaited<ReturnType<typeof Config.get>>) {
    if (auth?.type === "api") return auth.key
    if (auth?.type === "oauth") return auth.access
    if (auth?.type === "wellknown") return auth.token
    const key = cfg.provider?.["openai"]?.options?.["apiKey"]
    return typeof key === "string" && key ? key : undefined
  }

  export async function native(input: {
    model: Provider.Model
    provider?: SessionMemory.Checkpoint["provider"]
  }) {
    if (!resumable(input.model)) return input.provider
    const prev = input.provider?.openai?.response_id
    if (!prev) return input.provider
    const cfg = await Config.get()
    const auth = await Auth.get("openai")
    const key = token(auth, cfg)
    if (!key) return input.provider
    const base = cfg.provider?.["openai"]?.options?.["baseURL"]
    const url = endpoint(typeof base === "string" && base ? base : input.model.api.url ?? "https://api.openai.com")
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model.api.id || input.model.id.split("/").at(-1),
        previous_response_id: prev,
      }),
    }).catch((err) => {
      log.warn("native compact request failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    if (!res) return input.provider
    if (!res.ok) {
      log.warn("native compact rejected", {
        status: res.status,
      })
      return input.provider
    }
    const body = await res.json().catch(() => undefined)
    const parsed = z.object({ id: z.string() }).safeParse(body)
    if (!parsed.success) return input.provider
    return {
      openai: {
        response_id: parsed.data.id,
      },
    } satisfies SessionMemory.Checkpoint["provider"]
  }

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context
    if (context === 0) return false

    const count =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

    return count >= usable(input.model, config)
  }

  export async function needsCheckpoint(input: { messages: import("ai").ModelMessage[]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    if (input.model.limit.context === 0) return false
    return Token.estimate(JSON.stringify(input.messages)) >= usable(input.model, config)
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          await SessionMemory.capturePart({
            sessionID: input.sessionID,
            part,
          })
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
    overflow?: boolean
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User

    let messages = input.messages
    let replay: MessageV2.WithParts | undefined
    if (input.overflow) {
      const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
      for (let i = idx - 1; i >= 0; i--) {
        const msg = input.messages[i]
        if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
          replay = msg
          messages = input.messages.slice(0, i)
          break
        }
      }
      const hasContent =
        replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
      if (!hasContent) {
        replay = undefined
        messages = input.messages
      }
    }

    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userMessage.variant,
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting: {
      context: string[]
      prompt?: string
      memory?: Array<{ kind: string; text: string; source?: Record<string, unknown> }>
      retrieve?: { terms?: string[]; files?: string[] }
    } = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined, memory: [], retrieve: undefined },
    )
    const defaultPrompt = `Write a compact continuation checkpoint for the conversation above.
Preserve durable context so another agent can continue without losing task intent, constraints, style, active files, validations, and pending work.
Keep it concrete and avoid filler.

Use this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]

## Pending / next steps

[What should the next agent do first, what is blocked, and what still needs verification?]
---`

    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        ...MessageV2.toModelMessages(messages, model, { stripMedia: true }),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "compact") {
      processor.message.error = new MessageV2.ContextOverflowError({
        message: replay
          ? "Conversation history too large to compact - exceeds model context limit"
          : "Session too large to compact - context exceeds model limit even after stripping media",
      }).toObject()
      processor.message.finish = "error"
      await Session.updateMessage(processor.message)
      return "stop"
    }

    if (result === "continue" && input.auto) {
      if (replay) {
        const original = replay.info as MessageV2.User
        const replayMsg = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: original.agent,
          model: original.model,
          format: original.format,
          tools: original.tools,
          system: original.system,
          variant: original.variant,
        })
        for (const part of replay.parts) {
          if (part.type === "compaction") continue
          const replayPart =
            part.type === "file" && MessageV2.isMedia(part.mime)
              ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
              : part
          await Session.updatePart({
            ...replayPart,
            id: Identifier.ascending("part"),
            messageID: replayMsg.id,
            sessionID: input.sessionID,
          })
        }
      } else {
        const continueMsg = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: userMessage.agent,
          model: userMessage.model,
        })
        const text =
          (input.overflow
            ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
            : "") +
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: continueMsg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        })
      }
    }
    const parts = await MessageV2.parts(processor.message.id)
    const note = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
      .trim()
    const config = await Config.get()
    const strategy =
      config.compaction?.strategy && config.compaction.strategy !== "hybrid"
        ? config.compaction.strategy
        : SessionMemory.strategy(model)
    if (compacting.memory?.length) {
      await SessionMemory.remember({
        sessionID: input.sessionID,
        entries: compacting.memory.flatMap((item) => {
          const kind = SessionMemory.Kind.safeParse(item.kind)
          if (!kind.success) return []
          return [
            {
              kind: kind.data,
              text: item.text,
              source: item.source,
            },
          ]
        }),
      })
    }
    const replayState = replay
      ? (() => {
          const user = replay.info as MessageV2.User
          const parts: SessionMemory.Replay["parts"] = []
          for (const part of replay.parts) {
            if (part.type === "text") parts.push({ type: "text", text: part.text, synthetic: part.synthetic })
            if (part.type === "file") parts.push({ type: "file", mime: part.mime, filename: part.filename, url: part.url })
            if (part.type === "agent") parts.push({ type: "agent", name: part.name })
            if (part.type === "subtask") {
              parts.push({
                type: "subtask",
                agent: part.agent,
                prompt: part.prompt,
                description: part.description,
                command: part.command,
                model: part.model,
                parts: part.parts,
              })
            }
          }
          return {
            messageID: user.id,
            agent: user.agent,
            model: user.model,
            format: user.format,
            tools: user.tools,
            system: user.system,
            variant: user.variant,
            parts,
          }
        })()
      : undefined
    await SessionMemory.checkpoint({
      sessionID: input.sessionID,
      model,
      note: note || "Conversation compacted.",
      replay: replayState,
      hints: compacting.retrieve,
      strategy,
      provider: await native({
        model,
        provider: SessionMemory.provider({
          parts,
          model,
          strategy,
        }),
      }),
    })
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    },
  )
}

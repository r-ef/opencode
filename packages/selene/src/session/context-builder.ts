import { Identifier } from "@/id/id"
import { Config } from "@/config/config"
import { Token } from "@/util/token"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { SessionMemory } from "./memory"

export namespace SessionContextBuilder {
  type Input = {
    sessionID: string
    model: Provider.Model
    user: MessageV2.User
    messages: MessageV2.WithParts[]
  }

  type Output = {
    messages: import("ai").ModelMessage[]
    memory: SessionMemory.Entry[]
    checkpoint?: SessionMemory.Checkpoint
  }

  function text(msg: MessageV2.WithParts) {
    return msg.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
  }

  function files(msgs: MessageV2.WithParts[]) {
    const out = new Set<string>()
    for (const msg of msgs) {
      for (const part of msg.parts) {
        if (part.type === "file" && part.filename) out.add(part.filename)
        if (part.type === "patch") {
          for (const file of part.files) out.add(file)
        }
        if (part.type === "tool") {
          const input = part.state.input
          if (typeof input?.["filePath"] === "string") out.add(input["filePath"])
          if (typeof input?.["path"] === "string") out.add(input["path"])
        }
      }
    }
    return [...out]
  }

  function cost(msg: MessageV2.WithParts) {
    return Token.estimate(
      msg.parts
        .map((part) => {
          if (part.type === "text") return part.text
          if (part.type === "file") return part.filename ?? part.url
          if (part.type === "tool") {
            if (part.state.status === "completed") return part.state.output
            if (part.state.status === "error") return part.state.error
            return JSON.stringify(part.state.input)
          }
          if (part.type === "patch") return part.files.join("\n")
          return ""
        })
        .join("\n"),
    )
  }

  function strip(msgs: MessageV2.WithParts[]) {
    return msgs.filter((msg) => {
      if (msg.info.role === "assistant" && msg.info.summary) return false
      if (msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")) return false
      return true
    })
  }

  function hot(msgs: MessageV2.WithParts[], max: number) {
    const out: MessageV2.WithParts[] = []
    let total = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!msg) continue
      const next = cost(msg)
      if (out.length > 0 && total + next > max) break
      out.push(msg)
      total += next
    }
    return out.reverse()
  }

  function note(state: SessionMemory.State, rows: SessionMemory.Entry[], cp?: SessionMemory.Checkpoint) {
    const lines = ["<session-memory>"]
    if (cp) {
      lines.push(`strategy: ${cp.strategy}`)
      lines.push("")
      lines.push("Checkpoint:")
      lines.push(cp.note)
      lines.push("")
    }
    const add = (title: string, list: string[]) => {
      if (!list.length) return
      lines.push(title)
      for (const item of list) lines.push(`- ${item}`)
      lines.push("")
    }
    add("Goals:", state.goal.slice(0, 4))
    add("Instructions:", state.instruction.slice(0, 6))
    add("Preferences:", state.preference.slice(0, 6))
    add("Active files:", state.file.slice(0, 10))
    add("Pending:", state.pending.slice(0, 6))
    add("Validation:", state.validation.slice(0, 6))
    if (rows.length) {
      lines.push("Relevant memory:")
      for (const row of rows.slice(-10)) lines.push(`- [${row.kind}] ${row.text}`)
      lines.push("")
    }
    lines.push("</session-memory>")
    return lines.join("\n")
  }

  export async function build(input: Input): Promise<Output> {
    const cfg = await Config.get()
    const limit = cfg.compaction?.retrieve_limit ?? 12
    const max = cfg.compaction?.hot_window_tokens ?? 12_000
    const base = hot(strip(input.messages), max)
    const own = await SessionMemory.active(input.sessionID, base)
    const cp = await SessionMemory.latest(input.sessionID)
    const rows = await SessionMemory.retrieve({
      sessionID: input.sessionID,
      query: text({
        info: input.user,
        parts: input.messages.find((msg) => msg.info.id === input.user.id)?.parts ?? [],
      } as MessageV2.WithParts),
      files: [...own.file, ...files(base)],
      limit,
      hints: cp?.hints,
    })

    const state = {
      ...(cp?.state ?? SessionMemory.State.parse({
        goal: [],
        instruction: [],
        decision: [],
        artifact: [],
        file: [],
        validation: [],
        pending: [],
        preference: [],
        style: [],
      })),
      file: [...new Set([...(cp?.state.file ?? []), ...own.file])],
      pending: [...new Set([...(cp?.state.pending ?? []), ...own.pending])],
      validation: [...new Set([...(cp?.state.validation ?? []), ...own.validation])],
    }
    const prefix: MessageV2.WithParts[] = []
    if (
      rows.length ||
      cp ||
      state.goal.length ||
      state.instruction.length ||
      state.preference.length ||
      state.file.length ||
      state.pending.length ||
      state.validation.length
    ) {
      const msgID = Identifier.ascending("message")
      prefix.push({
        info: {
          id: msgID,
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: input.user.agent,
          model: input.user.model,
          system: input.user.system,
          tools: input.user.tools,
          variant: input.user.variant,
          format: input.user.format,
        },
        parts: [
          {
            id: Identifier.ascending("part"),
            sessionID: input.sessionID,
            messageID: msgID,
            type: "text",
            synthetic: true,
            text: note(state, rows, cp),
          },
        ],
      })
    }

    return {
      messages: MessageV2.toModelMessages([...prefix, ...base], input.model),
      memory: rows,
      checkpoint: cp,
    }
  }
}

import type { Provider } from "../../src/provider/provider"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionContextBuilder } from "../../src/session/context-builder"
import { SessionMemory } from "../../src/session/memory"

export type Part =
  | Omit<MessageV2.TextPart, "id" | "sessionID" | "messageID">
  | Omit<MessageV2.ToolPart, "id" | "sessionID" | "messageID">

export type Phase = {
  user: string
  parts: Part[]
  note: string
}

export function model(): Provider.Model {
  return {
    id: "gpt-5.2",
    providerID: "openai",
    name: "GPT-5.2",
    limit: {
      context: 200_000,
      input: 160_000,
      output: 32_000,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai" },
    options: {},
  } as Provider.Model
}

export async function user(sessionID: string, text: string) {
  const msg = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    model: {
      providerID: "openai",
      modelID: "gpt-5.2",
    },
    time: {
      created: Date.now(),
    },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg as MessageV2.User
}

export async function text(input: {
  sessionID: string
  messageID: string
  text: string
  synthetic?: boolean
  metadata?: Record<string, unknown>
}) {
  return Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: input.messageID,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
    synthetic: input.synthetic,
    metadata: input.metadata,
  })
}

export async function assistant(sessionID: string, parentID: string, parts: Part[], extra?: Partial<MessageV2.Assistant>) {
  const msg: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    parentID,
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
    modelID: "gpt-5.2",
    providerID: "openai",
    time: {
      created: Date.now(),
    },
    finish: "stop",
    ...extra,
  }
  await Session.updateMessage(msg)
  for (const part of parts) {
    await Session.updatePart({
      ...part,
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID,
    })
  }
  return msg
}

export async function compact(sessionID: string, note: string) {
  await SessionMemory.checkpoint({
    sessionID,
    model: model(),
    note,
  })
  const msg = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    model: {
      providerID: "openai",
      modelID: "gpt-5.2",
    },
    time: {
      created: Date.now(),
    },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID,
    type: "compaction",
    auto: true,
  })
  await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    mode: "compaction",
    agent: "compaction",
    parentID: msg.id,
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
    modelID: "gpt-5.2",
    providerID: "openai",
    time: {
      created: Date.now(),
    },
    summary: true,
    finish: "stop",
  })
}

export async function build(input: {
  sessionID: string
  phases: Phase[]
  query: string
}) {
  for (const phase of input.phases) {
    const turn = await user(input.sessionID, phase.user)
    await assistant(input.sessionID, turn.id, phase.parts)
    await SessionMemory.extract({
      sessionID: input.sessionID,
      messageID: turn.id,
    })
    await compact(input.sessionID, phase.note)
  }

  const current = await user(input.sessionID, input.query)
  const msgs = await MessageV2.filterCompacted(MessageV2.stream(input.sessionID))
  const built = await SessionContextBuilder.build({
    sessionID: input.sessionID,
    model: model(),
    user: current,
    messages: msgs,
  })
  return JSON.stringify(built.messages[0] ?? "")
}

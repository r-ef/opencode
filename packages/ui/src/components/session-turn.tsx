import { AssistantMessage, type FileDiff, Message as MessageType, Part as PartType } from "@opencode-ai/sdk/v2/client"
import type { SessionStatus } from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useFileComponent } from "../context/file"

import { Binary } from "@opencode-ai/util/binary"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import { createEffect, createMemo, createSignal, For, on, onCleanup, ParentProps, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { AssistantParts, Message, Part, PART_MAPPING } from "./message-part"
import { Card } from "./card"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { Collapsible } from "./collapsible"
import { DiffChanges } from "./diff-changes"
import { Icon } from "./icon"
import { TextShimmer } from "./text-shimmer"
import { SessionRetry } from "./session-retry"
import { TextReveal } from "./text-reveal"
import { createAutoScroll } from "../hooks"
import { useI18n } from "../context/i18n"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isMessage(value: unknown): value is MessageType {
  return record(value) && typeof value.id === "string" && typeof value.role === "string" && record(value.time)
}

function unwrap(message: string) {
  const text = message.replace(/^Error:\s*/, "").trim()

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }

  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)

  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) {
      json = read(text.slice(start, end + 1))
    }
  }

  if (!record(json)) return message

  const err = record(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const msg = typeof err.message === "string" ? err.message : undefined
    if (type && msg) return `${type}: ${msg}`
    if (msg) return msg
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }

  const msg = typeof json.message === "string" ? json.message : undefined
  if (msg) return msg

  const reason = typeof json.error === "string" ? json.error : undefined
  if (reason) return reason

  return message
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function cancel(frame?: number) {
  if (frame !== undefined) cancelAnimationFrame(frame)
}

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

const hidden = new Set(["todowrite", "todoread"])

function partState(part: PartType, showReasoningSummaries: boolean) {
  if (part.type === "tool") {
    if (hidden.has(part.tool)) return
    if (part.tool === "question" && (part.state.status === "pending" || part.state.status === "running")) return
    return "visible" as const
  }
  if (part.type === "text") return part.text?.trim() ? ("visible" as const) : undefined
  if (part.type === "reasoning") {
    if (showReasoningSummaries && part.text?.trim()) return "visible" as const
    return
  }
  if (PART_MAPPING[part.type]) return "visible" as const
  return
}

function clean(value: string) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .trim()
}

function heading(text: string) {
  const markdown = text.replace(/\r\n?/g, "\n")

  const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
  if (html?.[1]) {
    const value = clean(html[1].replace(/<[^>]+>/g, " "))
    if (value) return value
  }

  const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
  if (atx?.[1]) {
    const value = clean(atx[1])
    if (value) return value
  }

  const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
  if (setext?.[1]) {
    const value = clean(setext[1])
    if (value) return value
  }

  const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
  if (strong?.[1]) {
    const value = clean(strong[1])
    if (value) return value
  }
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    messageID: string
    showReasoningSummaries?: boolean
    shellToolDefaultOpen?: boolean
    editToolDefaultOpen?: boolean
    active?: boolean
    queued?: boolean
    status?: SessionStatus
    onUserInteracted?: () => void
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const data = useData()
  const i18n = useI18n()
  const fileComponent = useFileComponent()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyDiffs: FileDiff[] = []
  const idle = { type: "idle" as const }
  const emptyAssistantState = {
    interrupted: false,
    error: undefined as AssistantMessage["error"] | undefined,
    copy: undefined as string | undefined,
    end: undefined as number | undefined,
    visible: 0,
    tail: undefined as "text" | "other" | undefined,
    title: undefined as string | undefined,
  }

  const allMessages = createMemo(() => list(data.store.message?.[props.sessionID], emptyMessages).filter(isMessage))

  const turn = createMemo(() => {
    const list = allMessages()
    if (!Array.isArray(list) || list.length === 0) return
    const hit = Binary.search(list, props.messageID, (msg) => msg.id)
    if (!hit.found) return
    const msg = list[hit.index]
    if (!msg || msg.role !== "user") return
    return { index: hit.index, message: msg }
  })

  const message = createMemo(() => turn()?.message)

  const pendingState = createMemo(() => {
    if (typeof props.active === "boolean" && typeof props.queued === "boolean") return {}
    const list = allMessages()
    if (!Array.isArray(list) || list.length === 0) return {}
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      if (item.role !== "assistant" || typeof item.time.completed === "number") continue
      if (!item.parentID) return { pending: item }
      const hit = Binary.search(list, item.parentID, (msg) => msg.id)
      const msg = hit.found ? list[hit.index] : undefined
      if (!msg || msg.role !== "user") return { pending: item }
      return { pending: item, user: msg }
    }
    return {}
  })

  const active = createMemo(() => {
    if (typeof props.active === "boolean") return props.active
    const msg = message()
    const user = pendingState().user
    if (!msg || !user) return false
    return user.id === msg.id
  })

  const queued = createMemo(() => {
    if (typeof props.queued === "boolean") return props.queued
    const id = message()?.id
    const pending = pendingState().pending
    if (!id || !pending || !pendingState().user) return false
    return id > pending.id
  })

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return list(data.store.part?.[msg.id], emptyParts)
  })

  const compaction = createMemo(() => parts().find((part) => part.type === "compaction"))

  const diffs = createMemo(() => {
    const files = message()?.summary?.diffs
    if (!files?.length) return emptyDiffs

    const seen = new Set<string>()
    return files
      .reduceRight<FileDiff[]>((result, diff) => {
        if (seen.has(diff.file)) return result
        seen.add(diff.file)
        result.push(diff)
        return result
      }, [])
      .reverse()
  })
  const edited = createMemo(() => diffs().length)
  const [open, setOpen] = createSignal(false)
  const [expanded, setExpanded] = createSignal<string[]>([])
  const openSet = createMemo(() => new Set(expanded()))

  createEffect(
    on(
      open,
      (value, prev) => {
        if (!value && prev) setExpanded([])
      },
      { defer: true },
    ),
  )

  const assistantMessages = createMemo(
    () => {
      const row = turn()
      if (!row) return emptyAssistant

      const list = allMessages()
      const out: AssistantMessage[] = []
      for (let i = row.index + 1; i < list.length; i++) {
        const item = list[i]
        if (item.role === "user") break
        if (item.role === "assistant" && item.parentID === row.message.id) out.push(item as AssistantMessage)
      }
      return out
    },
    emptyAssistant,
    { equals: same },
  )

  const showReasoningSummaries = createMemo(() => props.showReasoningSummaries ?? true)

  const assistantState = createMemo(() => {
    let interrupted = false
    let err = undefined as AssistantMessage["error"] | undefined
    let copy = undefined as string | undefined
    let end = undefined as number | undefined
    let visible = 0
    let tail = undefined as "text" | "other" | undefined
    let title = undefined as string | undefined

    for (const msg of assistantMessages()) {
      if (msg.error?.name === "MessageAbortedError") interrupted = true
      if (!err && msg.error && msg.error.name !== "MessageAbortedError") err = msg.error
      const done = msg.time.completed
      if (typeof done === "number") end = end === undefined ? done : Math.max(end, done)

      const rows = list(data.store.part?.[msg.id], emptyParts)
      for (let i = rows.length - 1; i >= 0; i--) {
        const part = rows[i]
        if (!copy && part.type === "text" && part.text?.trim()) copy = part.id
      }
      for (const part of rows) {
        if (partState(part, showReasoningSummaries()) !== "visible") continue
        visible += 1
        tail = part.type === "text" ? "text" : "other"
        if (part.type !== "reasoning" || !part.text) continue
        const next = heading(part.text)
        if (next) title = next
      }
    }

    return {
      interrupted,
      error: err,
      copy,
      end,
      visible,
      tail,
      title,
    }
  }, emptyAssistantState)
  const assistant = createMemo(() => assistantState() ?? emptyAssistantState)
  const errorText = createMemo(() => {
    const err = assistant().error
    const msg = err?.data?.message
    if (typeof msg === "string") return unwrap(msg)
    if (msg === undefined || msg === null) return ""
    return unwrap(String(msg))
  })
  const assistantError = createMemo(() => assistant().error)

  const status = createMemo(() => {
    if (props.status !== undefined) return props.status
    if (typeof props.active === "boolean" && !props.active) return idle
    return data.store.session_status[props.sessionID] ?? idle
  })
  const working = createMemo(() => status().type !== "idle" && active())

  const assistantCopyPartID = createMemo(() => {
    if (working()) return null
    return assistant().copy ?? null
  })
  const turnDurationMs = createMemo(() => {
    const start = message()?.time.created
    const end = assistant().end
    if (typeof start !== "number" || typeof end !== "number") return undefined
    if (end < start) return undefined
    return end - start
  })
  const showThinking = createMemo(() => {
    if (!working() || !!assistantError()) return false
    if (queued()) return false
    if (status().type === "retry") return false
    if (showReasoningSummaries()) return assistant().visible === 0
    return true
  })

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
    overflowAnchor: "dynamic",
  })

  return (
    <div data-component="session-turn" class={props.classes?.root}>
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()}>
            {(msg) => (
              <div
                ref={autoScroll.contentRef}
                data-message={msg().id}
                data-slot="session-turn-message-container"
                class={props.classes?.container}
              >
                <div data-slot="session-turn-message-content" aria-live="off">
                  <Message message={msg()} parts={parts()} interrupted={assistant().interrupted} queued={queued()} />
                </div>
                <Show when={compaction()}>
                  {(part) => (
                    <div data-slot="session-turn-compaction">
                      <Part part={part()} message={msg()} hideDetails />
                    </div>
                  )}
                </Show>
                <Show when={assistantMessages().length > 0}>
                  <div data-slot="session-turn-assistant-content" aria-hidden={working()}>
                    <AssistantParts
                      messages={assistantMessages()}
                      showAssistantCopyPartID={assistantCopyPartID()}
                      turnDurationMs={turnDurationMs()}
                      working={working()}
                      showReasoningSummaries={showReasoningSummaries()}
                      shellToolDefaultOpen={props.shellToolDefaultOpen}
                      editToolDefaultOpen={props.editToolDefaultOpen}
                    />
                  </div>
                </Show>
                <Show when={showThinking()}>
                  <div data-slot="session-turn-thinking">
                    <TextShimmer text={i18n.t("ui.sessionTurn.status.thinking")} />
                    <Show when={!showReasoningSummaries()}>
                      <TextReveal
                        text={assistant().title}
                        class="session-turn-thinking-heading"
                        travel={25}
                        duration={700}
                      />
                    </Show>
                  </div>
                </Show>
                <SessionRetry status={status()} show={active()} />
                <Show when={edited() > 0 && !working()}>
                  <div data-slot="session-turn-diffs">
                    <Collapsible open={open()} onOpenChange={setOpen} variant="ghost">
                      <Collapsible.Trigger>
                        <div data-component="session-turn-diffs-trigger">
                          <div data-slot="session-turn-diffs-title">
                            <span data-slot="session-turn-diffs-label">
                              {i18n.t("ui.sessionReview.change.modified")}
                            </span>
                            <span data-slot="session-turn-diffs-count">
                              {edited()} {i18n.t(edited() === 1 ? "ui.common.file.one" : "ui.common.file.other")}
                            </span>
                            <div data-slot="session-turn-diffs-meta">
                              <DiffChanges changes={diffs()} variant="bars" />
                              <Collapsible.Arrow />
                            </div>
                          </div>
                        </div>
                      </Collapsible.Trigger>
                      <Collapsible.Content>
                        <Show when={open()}>
                          <div data-component="session-turn-diffs-content">
                            <Accordion
                              multiple
                              style={{ "--sticky-accordion-offset": "40px" }}
                              value={expanded()}
                              onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
                            >
                              <For each={diffs()}>
                                {(diff) => {
                                  const active = createMemo(() => openSet().has(diff.file))
                                  const [visible, setVisible] = createSignal(false)
                                  let frame: number | undefined

                                  createEffect(
                                    on(
                                      active,
                                      (value) => {
                                        cancel(frame)
                                        frame = undefined
                                        if (!value) {
                                          setVisible(false)
                                          return
                                        }

                                        frame = requestAnimationFrame(() => {
                                          frame = undefined
                                          if (!active()) return
                                          setVisible(true)
                                        })
                                      },
                                      { defer: true },
                                    ),
                                  )

                                  onCleanup(() => cancel(frame))

                                  return (
                                    <Accordion.Item value={diff.file}>
                                      <StickyAccordionHeader>
                                        <Accordion.Trigger>
                                          <div data-slot="session-turn-diff-trigger">
                                            <span data-slot="session-turn-diff-path">
                                              <Show when={diff.file.includes("/")}>
                                                <span data-slot="session-turn-diff-directory">
                                                  {`\u202A${getDirectory(diff.file)}\u202C`}
                                                </span>
                                              </Show>
                                              <span data-slot="session-turn-diff-filename">
                                                {getFilename(diff.file)}
                                              </span>
                                            </span>
                                            <div data-slot="session-turn-diff-meta">
                                              <span data-slot="session-turn-diff-changes">
                                                <DiffChanges changes={diff} />
                                              </span>
                                              <span data-slot="session-turn-diff-chevron">
                                                <Icon name="chevron-down" size="small" />
                                              </span>
                                            </div>
                                          </div>
                                        </Accordion.Trigger>
                                      </StickyAccordionHeader>
                                      <Accordion.Content>
                                        <Show when={visible()}>
                                          <div data-slot="session-turn-diff-view" data-scrollable>
                                            <Dynamic
                                              component={fileComponent}
                                              mode="diff"
                                              before={{ name: diff.file, contents: diff.before }}
                                              after={{ name: diff.file, contents: diff.after }}
                                            />
                                          </div>
                                        </Show>
                                      </Accordion.Content>
                                    </Accordion.Item>
                                  )
                                }}
                              </For>
                            </Accordion>
                          </div>
                        </Show>
                      </Collapsible.Content>
                    </Collapsible>
                  </div>
                </Show>
                <Show when={assistantError()}>
                  <Card variant="error" class="error-card">
                    {errorText()}
                  </Card>
                </Show>
              </div>
            )}
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}

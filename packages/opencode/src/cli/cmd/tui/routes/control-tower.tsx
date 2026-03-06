import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useDirectory } from "@tui/context/directory"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { useDialog } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { useExit } from "@tui/context/exit"
import type { Message, PermissionRequest, QuestionInfo, QuestionRequest, Session, SessionStatus, Todo, ToolPart } from "@opencode-ai/sdk/v2"
import { createStore } from "solid-js/store"
import { createEffect, createMemo, createResource, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"

type Row = {
  info: Session
  status: SessionStatus
  perms: number
  asks: number
}

type Fam = {
  id: string
  root: Row
  rows: Row[]
  all: Row[]
  busy: number
  wait: number
  kids: number
  time: number
}

type Node = {
  row: Row
  fam: Fam
  depth: number
}

type Wait =
  | {
      id: string
      kind: "permission"
      sessionID: string
      row?: Row
      req: PermissionRequest
    }
  | {
      id: string
      kind: "question"
      sessionID: string
      row?: Row
      req: QuestionRequest
    }

type Work = {
  dir: string
  rows: Row[]
  live: number
  wait: number
  kids: number
  time: number
}

type Run = {
  id: string
  root: Row
  title: string
  rows: {
    name: string
    sessionID: string
    status: SessionStatus
    row?: Row
  }[]
  win?: {
    name?: string
    sessionId?: string
  } | null
  background: boolean
  state: "running" | "done" | "error"
  time: number
}

type Pane = "family" | "wait" | "work" | "task"

const idle = { type: "idle" as const }

function tone(input: { status: SessionStatus; perms: number; asks: number }) {
  if (input.perms + input.asks > 0) return "wait" as const
  if (input.status.type === "busy") return "busy" as const
  if (input.status.type === "retry") return "retry" as const
  return "idle" as const
}

function ago(time: number) {
  const diff = Date.now() - time
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))}h ago`
  return `${Math.max(1, Math.round(diff / 86_400_000))}d ago`
}

function tail(input: string) {
  const parts = input.split("/").filter(Boolean)
  return parts.at(-1) ?? input
}

function cap(idx: number, len: number) {
  if (len <= 0) return 0
  if (idx < 0) return 0
  if (idx >= len) return len - 1
  return idx
}

function mark(todo: Todo["status"]) {
  if (todo === "completed") return "✓"
  if (todo === "in_progress") return "◐"
  if (todo === "cancelled") return "×"
  return "•"
}

function stat(input: SessionStatus) {
  if (input.type === "busy") return "running"
  if (input.type === "retry") return `retry ${input.attempt}`
  return "idle"
}

function note(req: PermissionRequest) {
  if (req.permission === "bash") {
    const cmd = typeof req.metadata.command === "string" ? req.metadata.command : undefined
    return cmd ? `$ ${cmd}` : "shell access"
  }
  if (req.permission === "edit") {
    const file = typeof req.metadata.filepath === "string" ? req.metadata.filepath : req.patterns[0]
    return file ? `edit ${tail(file)}` : "edit files"
  }
  if (req.permission === "read") {
    const file = typeof req.metadata.filepath === "string" ? req.metadata.filepath : req.patterns[0]
    return file ? `read ${tail(file)}` : "read files"
  }
  if (req.patterns.length > 0) return `${req.permission} ${req.patterns[0]}`
  return req.permission
}

function cut(input?: string, size = 220) {
  if (!input) return
  return input.length > size ? input.slice(0, size - 1) + "…" : input
}

function tool(part: ToolPart) {
  if (part.state.status === "running") return part.state.title ? `${part.tool} ${part.state.title}` : `${part.tool} running`
  if (part.state.status === "error") return `${part.tool} failed`
  if (part.state.status === "completed") return part.state.title ? `${part.tool} ${part.state.title}` : part.tool
  return `${part.tool} pending`
}

function tonebg(theme: ReturnType<typeof useTheme>["theme"], on: boolean) {
  return on ? theme.primary : theme.backgroundPanel
}

function seek(root: Renderable, id: string): Renderable | undefined {
  if (root.id === id) return root
  for (const child of root.getChildren()) {
    const found = seek(child, id)
    if (found) return found
  }
}

function Chip(props: { text: string; tone: "busy" | "retry" | "wait" | "idle" | "base" }) {
  const { theme } = useTheme()
  const fg = {
    busy: theme.success,
    retry: theme.warning,
    wait: theme.info,
    idle: theme.textMuted,
    base: theme.text,
  }[props.tone]
  return <text fg={fg}>[{props.text}]</text>
}

function Tab(props: { text: string; note?: string; on: boolean; onPick: () => void }) {
  const { theme } = useTheme()
  const bg = tonebg(theme, props.on)
  const fg = props.on ? selectedForeground(theme, bg) : theme.text
  return (
    <box backgroundColor={bg} paddingLeft={1} paddingRight={1} onMouseUp={props.onPick}>
      <text fg={fg}>
        <b>{props.text}</b>
        <Show when={props.note}>
          <span style={{ fg: props.on ? selectedForeground(theme, bg) : theme.textMuted }}>{` ${props.note}`}</span>
        </Show>
      </text>
    </box>
  )
}

function Stat(props: { label: string; value: string | number; note: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" width={18} paddingRight={2}>
      <text fg={theme.textMuted}>{props.label}</text>
      <text fg={theme.text}>
        <b>{String(props.value)}</b>
      </text>
      <text fg={theme.textMuted}>{props.note}</text>
    </box>
  )
}

function FamilyRow(props: {
  item: Node
  on: boolean
  root: string
  onPick: () => void
  onOpen: () => void
  onStop: () => void
}) {
  const { theme } = useTheme()
  const bg = theme.backgroundPanel
  const fg = props.on ? theme.primary : theme.text
  const muted = props.on ? theme.text : theme.textMuted
  const state = createMemo(() => tone(props.item.row))
  const head = createMemo(() => props.item.row.info.id === props.item.fam.id)
  const branch = createMemo(
    () => props.item.fam.rows.findIndex((item) => item.info.id === props.item.row.info.id && item.info.kind === "interactive") + 1,
  )

  return (
    <box id={`family:${props.item.row.info.id}`} backgroundColor={bg} paddingLeft={1} paddingRight={1} onMouseUp={props.onPick}>
      <box flexDirection="row" gap={1}>
        <text fg={fg}>{props.on ? "›" : " "}</text>
        <text fg={fg}>{" ".repeat(props.item.depth * 2)}</text>
        <text fg={state() === "busy" ? theme.success : state() === "retry" ? theme.warning : state() === "wait" ? theme.info : muted}>
          {props.item.row.info.kind === "subagent" ? "•" : head() ? "◆" : "◦"}
        </text>
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          <box flexDirection="row" gap={1}>
            <text fg={fg} wrapMode="word">
              <b>{props.item.row.info.title}</b>
            </text>
            <Show when={props.item.row.info.kind === "subagent"}>
              <Chip text="agent" tone="base" />
            </Show>
            <Show when={props.item.row.info.kind === "interactive" && head()}>
              <Chip text="root" tone="base" />
            </Show>
            <Show when={props.item.row.info.kind === "interactive" && !head()}>
              <Chip text={`branch ${branch()}/${props.item.fam.rows.length}`} tone="base" />
            </Show>
            <Show when={state() === "busy"}>
              <Chip text="running" tone="busy" />
            </Show>
            <Show when={state() === "retry"}>
              <Chip text={props.item.row.status.type === "retry" ? `retry ${props.item.row.status.attempt}` : "retry"} tone="retry" />
            </Show>
            <Show when={state() === "wait"}>
              <Chip text="needs input" tone="wait" />
            </Show>
          </box>
          <box flexDirection="row" gap={1} flexWrap="wrap">
            <text fg={muted} wrapMode="word">
              {props.item.row.info.directory === props.root ? "local" : tail(props.item.row.info.directory)} · {ago(props.item.row.info.time.updated)}
              <Show when={props.item.row.perms > 0 || props.item.row.asks > 0}>
                {` · ${props.item.row.perms > 0 ? `${props.item.row.perms} approvals` : ""}${props.item.row.perms > 0 && props.item.row.asks > 0 ? " / " : ""}${props.item.row.asks > 0 ? `${props.item.row.asks} questions` : ""}`}
              </Show>
            </text>
            <text fg={muted}>·</text>
            <text
              fg={props.on ? theme.primary : theme.text}
              onMouseUp={(evt) => {
                evt.stopPropagation()
                props.onOpen()
              }}
            >
              open
            </text>
            <Show when={props.item.row.status.type !== "idle"}>
              <>
                <text fg={muted}>·</text>
                <text
                  fg={theme.warning}
                  onMouseUp={(evt) => {
                    evt.stopPropagation()
                    props.onStop()
                  }}
                >
                  stop
                </text>
              </>
            </Show>
          </box>
        </box>
      </box>
    </box>
  )
}

export function ControlTower() {
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const command = useCommandDialog()
  const toast = useToast()
  const dialog = useDialog()
  const keybind = useKeybind()
  const exit = useExit()
  const directory = useDirectory()
  const { theme } = useTheme()
  const dims = useTerminalDimensions()

  let main: ScrollBoxRenderable | undefined

  const [store, setStore] = createStore({
    pane: "family" as Pane,
    family: 0,
    wait: 0,
    work: 0,
    task: 0,
    pick: 0,
    qtab: 0,
    ans: {} as Record<string, string[][]>,
    rid: undefined as string | undefined,
    fid: undefined as string | undefined,
    qid: undefined as string | undefined,
    wid: undefined as string | undefined,
    tid: undefined as string | undefined,
  })

  const rows = createMemo(() =>
    sync.data.session
      .filter((item) => item.time.archived === undefined)
      .map((info) => ({
        info,
        status: sync.data.session_status[info.id] ?? idle,
        perms: (sync.data.permission[info.id] ?? []).length,
        asks: (sync.data.question[info.id] ?? []).length,
      }))
      .toSorted((a, b) => b.info.time.updated - a.info.time.updated || b.info.id.localeCompare(a.info.id)),
  )

  const by = createMemo(() => new Map(rows().map((row) => [row.info.id, row] as const)))

  const kids = createMemo(() => {
    const map = new Map<string, Row[]>()
    for (const row of rows()) {
      const id = row.info.parentID
      if (!id) continue
      const list = map.get(id)
      if (list) list.push(row)
      if (!list) map.set(id, [row])
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
    }
    return map
  })

  const fams = createMemo(() => {
    const map = new Map<string, Row[]>()
    const all = rows()
    for (const row of all) {
      if (row.info.kind !== "interactive") continue
      const list = map.get(row.info.rootID)
      if (list) list.push(row)
      if (!list) map.set(row.info.rootID, [row])
    }

    const list: Fam[] = []
    for (const [id, rows] of map) {
      const tree = all.filter((row) => row.info.rootID === id)
      const sorted = rows.toSorted((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
      const root = sorted.find((row) => row.info.id === id) ?? sorted[0]
      if (!root) continue
      list.push({
        id,
        root,
        rows: sorted,
        all: tree,
        busy: tree.filter((row) => row.status.type !== "idle").length,
        wait: tree.filter((row) => row.perms + row.asks > 0).length,
        kids: tree.filter((row) => row.info.kind === "subagent").length,
        time: tree.reduce((max, row) => Math.max(max, row.info.time.updated), 0),
      })
    }
    return list.toSorted((a, b) => b.time - a.time || b.root.info.id.localeCompare(a.root.info.id))
  })

  const flat = createMemo(() => {
    const out: Node[] = []
    for (const fam of fams()) {
      const seen = new Set<string>()
      const walk = (row: Row, depth: number) => {
        if (seen.has(row.info.id)) return
        seen.add(row.info.id)
        out.push({ row, fam, depth })
        for (const child of kids().get(row.info.id) ?? []) walk(child, depth + 1)
      }
      for (const row of fam.rows) walk(row, row.info.id === fam.id ? 0 : 1)
    }
    return out
  })

  const wait = createMemo(() =>
    rows()
      .flatMap((row) => [
        ...(sync.data.permission[row.info.id] ?? []).map((req) => ({
          id: req.id,
          kind: "permission" as const,
          sessionID: row.info.id,
          row,
          req,
        })),
        ...(sync.data.question[row.info.id] ?? []).map((req) => ({
          id: req.id,
          kind: "question" as const,
          sessionID: row.info.id,
          row,
          req,
        })),
      ])
      .toSorted((a, b) => (b.row?.info.time.updated ?? 0) - (a.row?.info.time.updated ?? 0) || b.id.localeCompare(a.id)),
  )

  const [sand, { refetch: loadsand }] = createResource(async () => {
    const result = await sdk.client.worktree.list()
    return result.data ?? []
  })

  onMount(() => {
    const timer = setInterval(() => {
      void loadsand()
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })

  const work = createMemo(() => {
    const dirs = [...new Set([directory(), ...(sand() ?? []), ...rows().map((row) => row.info.directory)])]
    return dirs
      .map((dir) => {
        const list = rows().filter((row) => row.info.directory === dir)
        return {
          dir,
          rows: list,
          live: list.filter((row) => row.status.type !== "idle").length,
          wait: list.filter((row) => row.perms + row.asks > 0).length,
          kids: list.filter((row) => row.info.kind === "subagent").length,
          time: list.reduce((max, row) => Math.max(max, row.info.time.updated), 0),
        } satisfies Work
      })
      .toSorted((a, b) => {
        if (a.dir === directory()) return -1
        if (b.dir === directory()) return 1
        return b.time - a.time || a.dir.localeCompare(b.dir)
      })
  })

  createEffect(() => {
    const ids = [
      ...fams()
        .slice(0, 12)
        .map((fam) => fam.root.info.id),
      ...wait()
        .slice(0, 8)
        .map((item) => item.sessionID),
    ]
    const pick = current()
    if (pick) ids.push(pick.info.id)
    for (const id of [...new Set(ids)]) void sync.session.sync(id)
  })

  const task = createMemo(() => {
    const out: Run[] = []
    const seen = new Set<string>()

    for (const fam of fams()) {
      const root = fam.root
      const msgs = sync.data.message[root.info.id] ?? []
      for (const msg of msgs) {
        const parts = sync.data.part[msg.id] ?? []
        for (const part of parts) {
          if (part.type !== "tool" || part.tool !== "task_branch") continue
          if (part.state.status === "pending") continue
          const meta = (part.state.status === "running" || part.state.status === "completed" || part.state.status === "error"
            ? part.state.metadata
            : undefined) as
            | {
                branchId?: string
                background?: boolean
                branches?: { name?: string; sessionId?: string }[]
                winner?: { name?: string; sessionId?: string } | null
              }
            | undefined
          const id = meta?.branchId ?? part.id
          if (seen.has(id)) continue
          seen.add(id)
          const list = (meta?.branches ?? []).flatMap((item) => {
            if (!item.sessionId) return []
            return [
              {
                name: item.name ?? item.sessionId,
                sessionID: item.sessionId,
                status: sync.data.session_status[item.sessionId] ?? idle,
                row: by().get(item.sessionId),
              },
            ]
          })
          out.push({
            id,
            root,
            title:
              (("title" in part.state && typeof part.state.title === "string" && part.state.title) ||
                (typeof part.state.input.description === "string" && part.state.input.description) ||
                "Branch run"),
            rows: list,
            win: meta?.winner,
            background: meta?.background === true,
            state: part.state.status === "error" ? "error" : part.state.status === "completed" ? "done" : "running",
            time: Math.max(
              msg.time.created,
              ...list.map((item) => item.row?.info.time.updated ?? 0),
            ),
          })
        }
      }
    }

    return out.toSorted((a, b) => b.time - a.time || b.id.localeCompare(a.id))
  })

  createEffect(() => {
    for (const run of task().slice(0, 8)) {
      for (const item of run.rows) void sync.session.sync(item.sessionID)
    }
  })

  createEffect(() => {
    const rows = flat()
    const idx = store.fid ? rows.findIndex((item) => item.row.info.id === store.fid) : -1
    if (idx !== -1) {
      if (store.family !== idx) setStore("family", idx)
      return
    }
    const next = cap(store.family, rows.length)
    if (store.family !== next) setStore("family", next)
    if (rows[next]) setStore("fid", rows[next].row.info.id)
  })

  createEffect(() => {
    const rows = wait()
    const idx = store.qid ? rows.findIndex((item) => item.id === store.qid) : -1
    if (idx !== -1) {
      if (store.wait !== idx) setStore("wait", idx)
      return
    }
    const next = cap(store.wait, rows.length)
    if (store.wait !== next) setStore("wait", next)
    if (rows[next]) setStore("qid", rows[next].id)
  })

  createEffect(() => {
    const rows = work()
    const idx = store.wid ? rows.findIndex((item) => item.dir === store.wid) : -1
    if (idx !== -1) {
      if (store.work !== idx) setStore("work", idx)
      return
    }
    const next = cap(store.work, rows.length)
    if (store.work !== next) setStore("work", next)
    if (rows[next]) setStore("wid", rows[next].dir)
  })

  createEffect(() => {
    const rows = task()
    const idx = store.tid ? rows.findIndex((item) => item.id === store.tid) : -1
    if (idx !== -1) {
      if (store.task !== idx) setStore("task", idx)
      return
    }
    const next = cap(store.task, rows.length)
    if (store.task !== next) setStore("task", next)
    if (rows[next]) setStore("tid", rows[next].id)
  })

  createEffect(() => {
    const req = item()
    if (!req || req.kind !== "question") return
    if (store.rid !== req.req.id) {
      setStore("rid", req.req.id)
      setStore("pick", 0)
      setStore("qtab", 0)
    }
    if (store.ans[req.req.id] !== undefined) return
    setStore(
      "ans",
      req.req.id,
      req.req.questions.map(() => [] as string[]),
    )
  })

  const node = createMemo(() => flat()[store.family])
  const item = createMemo(() => wait()[store.wait])
  const lane = createMemo(() => work()[store.work])
  const run = createMemo(() => task()[store.task])

  const famcur = createMemo(() => {
    const item = node()
    if (!item) return
    const row =
      item.row.info.kind === "interactive"
        ? item.row
        : item.fam.rows.find((row) => row.info.id === item.row.info.parentID) ?? item.fam.root
    const idx = item.fam.rows.findIndex((entry) => entry.info.id === row.info.id)
    return {
      fam: item.fam,
      row,
      idx: idx === -1 ? 0 : idx,
    }
  })

  const qreq = createMemo(() => {
    const req = item()
    if (!req || req.kind !== "question") return
    return req.req
  })

  const qans = createMemo(() => {
    const req = qreq()
    if (!req) return [] as string[][]
    return store.ans[req.id] ?? req.questions.map(() => [] as string[])
  })

  const qtab = createMemo(() => {
    const req = qreq()
    if (!req) return 0
    return Math.min(store.qtab, Math.max(req.questions.length - 1, 0))
  })

  const qcur = createMemo(() => qreq()?.questions[qtab()])
  const qopts = createMemo(() => qcur()?.options ?? [])
  const qsel = createMemo(() => qans()[qtab()] ?? [])
  const qdone = createMemo(() => {
    const req = qreq()
    if (!req) return false
    return req.questions.every((_, idx) => (qans()[idx] ?? []).length > 0)
  })

  const selected = createMemo(() => {
    if (store.pane === "family") return node()?.row.info.id ? `family:${node()!.row.info.id}` : undefined
    if (store.pane === "wait") return item()?.id ? `wait:${item()!.id}` : undefined
    if (store.pane === "work") return lane()?.dir ? `work:${lane()!.dir}` : undefined
    return run()?.id ? `task:${run()!.id}` : undefined
  })

  createEffect(() => {
    const id = selected()
    if (!id || !main) return
    const target = main.content.getChildren().flatMap((child) => seek(child, id) ?? []).at(0)
    if (!target) return
    const y = target.y - main.viewport.y
    if (y >= main.viewport.height) {
      main.scrollBy(y - main.viewport.height + 1)
      return
    }
    if (y < 0) {
      main.scrollBy(y)
      const first =
        (store.pane === "family" && store.family === 0) ||
        (store.pane === "wait" && store.wait === 0) ||
        (store.pane === "work" && store.work === 0) ||
        (store.pane === "task" && store.task === 0)
      if (first) main.scrollTo(0)
    }
  })

  const current = createMemo(() => {
    if (store.pane === "family") return node()?.row
    if (store.pane === "wait") return item()?.row
    if (store.pane === "work") return lane()?.rows[0]
    const win = run()?.win?.sessionId
    if (win) return by().get(win) ?? run()?.rows.find((item) => item.sessionID === win)?.row ?? run()?.root
    return run()?.rows[0]?.row ?? run()?.root
  })

  const msgs = createMemo(() => {
    const id = current()?.info.id
    if (!id) return [] as Message[]
    return sync.data.message[id] ?? []
  })

  const todos = createMemo(() => {
    const id = current()?.info.id
    if (!id) return [] as Todo[]
    return sync.data.todo[id] ?? []
  })

  const diff = createMemo(() => {
    const id = current()?.info.id
    if (!id) return []
    return sync.data.session_diff[id] ?? []
  })

  const tools = createMemo(() =>
    msgs()
      .flatMap((msg) => sync.data.part[msg.id] ?? [])
      .filter((part): part is ToolPart => part.type === "tool")
      .slice(-6)
      .reverse(),
  )

  const last = createMemo(() => msgs().findLast((msg) => msg.role === "assistant"))

  const text = createMemo(() => {
    const msg = last()
    if (!msg) return
    const part = (sync.data.part[msg.id] ?? []).findLast((part) => part.type === "text")
    if (!part || part.type !== "text") return
    return cut(part.text, 320)
  })

  const ctx = createMemo(() => {
    const msg = last()
    if (!msg || msg.role !== "assistant") return
    const total =
      msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
    const model = sync.data.provider.find((item) => item.id === msg.providerID)?.models[msg.modelID]
    return `${total.toLocaleString()} tokens${model?.limit.context ? ` · ${Math.round((total / model.limit.context) * 100)}%` : ""}`
  })

  const stats = createMemo(() => ({
    live: rows().filter((row) => row.status.type !== "idle").length,
    wait: wait().length,
    agents: rows().filter((row) => row.info.kind === "subagent").length,
    branches: rows().filter((row) => row.info.kind === "interactive" && row.info.id !== row.info.rootID).length,
    workspaces: work().length,
  }))

  const wide = createMemo(() => dims().width >= 150)

  const fail = (error: unknown) => {
    toast.show({
      variant: "error",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const open = (row?: Row) => {
    if (!row) return
    route.navigate({ type: "session", sessionID: row.info.id })
  }

  const stop = async (row?: Row) => {
    if (!row || row.status.type === "idle") return
    await sdk.client.session.abort({ sessionID: row.info.id, directory: row.info.directory }).catch(fail)
  }

  const branch = async (row?: Row) => {
    if (!row || row.info.kind !== "interactive") return
    const result = await sdk.client.session.branch({ sessionID: row.info.id, directory: row.info.directory }).catch(fail)
    const id = result?.data?.id
    if (!id) return
    route.navigate({ type: "session", sessionID: id })
  }

  const fresh = async (dir?: string) => {
    if (!dir) return
    const result = await sdk.client.session.create({ directory: dir }).catch(fail)
    const id = result?.data?.id
    if (!id) return
    route.navigate({ type: "session", sessionID: id })
  }

  const once = async () => {
    const req = item()
    if (!req || req.kind !== "permission") return
    await sdk.client.permission.reply({ requestID: req.req.id, directory: req.row?.info.directory, reply: "once" }).catch(fail)
  }

  const always = async () => {
    const req = item()
    if (!req || req.kind !== "permission") return
    await sdk.client.permission.reply({ requestID: req.req.id, directory: req.row?.info.directory, reply: "always" }).catch(fail)
  }

  const deny = async () => {
    const req = item()
    if (!req) return
    if (req.kind === "permission") {
      await sdk.client.permission.reply({ requestID: req.req.id, directory: req.row?.info.directory, reply: "reject" }).catch(fail)
      return
    }
    await sdk.client.question.reject({ requestID: req.req.id, directory: req.row?.info.directory }).catch(fail)
  }

  const jump = () => {
    if (store.pane === "family") return open(famcur()?.row)
    if (store.pane === "wait") {
      const req = item()
      if (!req) return
      return open(req.row)
    }
    if (store.pane === "work") {
      const row = lane()?.rows[0]
      if (row) return open(row)
      return void fresh(lane()?.dir)
    }
    const win = run()?.win?.sessionId
    if (win) return open(by().get(win) ?? run()?.rows.find((item) => item.sessionID === win)?.row ?? run()?.root)
    return open(run()?.rows[0]?.row ?? run()?.root)
  }

  const qpick = (idx = store.pick) => {
    const req = qreq()
    const cur = qcur()
    const opt = qopts()[idx]
    if (!req || !cur || !opt) return
    const next = qans().map((item) => [...item])
    const row = next[qtab()] ?? []
    if (cur.multiple) {
      const pos = row.indexOf(opt.label)
      if (pos === -1) row.push(opt.label)
      if (pos !== -1) row.splice(pos, 1)
      next[qtab()] = row
      setStore("ans", req.id, next)
      return
    }
    next[qtab()] = [opt.label]
    setStore("ans", req.id, next)
    if (qtab() < req.questions.length - 1) {
      setStore("qtab", qtab() + 1)
      setStore("pick", 0)
    }
  }

  const qclear = () => {
    const req = qreq()
    if (!req) return
    const next = qans().map((item) => [...item])
    next[qtab()] = []
    setStore("ans", req.id, next)
  }

  const qsubmit = async () => {
    const req = qreq()
    if (!req || !qdone()) return
    await sdk.client
      .question.reply({
        requestID: req.id,
        directory: item()?.row?.info.directory,
        answers: qans(),
      })
      .then(() => {
        setStore("ans", req.id, [])
      })
      .catch(fail)
  }

  const froot = () => open(famcur()?.fam.root)

  const fmove = (step: number) => {
    const cur = famcur()
    if (!cur) return
    const next = (cur.idx + step + cur.fam.rows.length) % cur.fam.rows.length
    open(cur.fam.rows[next])
  }

  const fstop = async () => {
    const cur = famcur()
    if (!cur) return
    const rows = cur.fam.all.filter((row) => row.status.type !== "idle")
    if (rows.length === 0) return
    await Promise.all(
      rows.map((row) => sdk.client.session.abort({ sessionID: row.info.id, directory: row.info.directory }).catch(fail)),
    )
    toast.show({
      variant: "info",
      message: `Stopped ${rows.length} session${rows.length === 1 ? "" : "s"} in family`,
    })
  }

  const move = (step: number) => {
    if (store.pane === "family") {
      const idx = cap(store.family + step, flat().length)
      setStore("family", idx)
      setStore("fid", flat()[idx]?.row.info.id)
      return
    }
    if (store.pane === "wait") {
      const idx = cap(store.wait + step, wait().length)
      setStore("wait", idx)
      setStore("qid", wait()[idx]?.id)
      setStore("pick", 0)
      return
    }
    if (store.pane === "work") {
      const idx = cap(store.work + step, work().length)
      setStore("work", idx)
      setStore("wid", work()[idx]?.dir)
      return
    }
    const idx = cap(store.task + step, task().length)
    setStore("task", idx)
    setStore("tid", task()[idx]?.id)
  }

  const pane = (step: number) => {
    const list: Pane[] = ["family", "wait", "work", "task"]
    const idx = list.indexOf(store.pane)
    setStore("pane", list[(idx + step + list.length) % list.length])
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (keybind.match("app_exit", evt)) {
      evt.preventDefault()
      evt.stopPropagation()
      void exit()
      return
    }

    if (evt.name === "tab") {
      evt.preventDefault()
      evt.stopPropagation()
      pane(evt.shift ? -1 : 1)
      return
    }

    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      move(-1)
      return
    }

    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      move(1)
      return
    }

    if (store.pane === "family" && (evt.name === "left" || evt.name === "h")) {
      evt.preventDefault()
      evt.stopPropagation()
      fmove(-1)
      return
    }

    if (store.pane === "family" && (evt.name === "right" || evt.name === "l")) {
      evt.preventDefault()
      evt.stopPropagation()
      fmove(1)
      return
    }

    if (store.pane === "wait" && qreq() && evt.name === "left") {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("pick", cap(store.pick - 1, qopts().length))
      return
    }

    if (store.pane === "wait" && qreq() && evt.name === "right") {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("pick", cap(store.pick + 1, qopts().length))
      return
    }

    if (store.pane === "wait" && qreq() && evt.name === "[") {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("qtab", Math.max(0, qtab() - 1))
      setStore("pick", 0)
      return
    }

    if (store.pane === "wait" && qreq() && evt.name === "]") {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("qtab", Math.min((qreq()?.questions.length ?? 1) - 1, qtab() + 1))
      setStore("pick", 0)
      return
    }

    if (store.pane === "wait" && qreq() && evt.name && /^[1-9]$/.test(evt.name)) {
      evt.preventDefault()
      evt.stopPropagation()
      const idx = Number(evt.name) - 1
      if (idx < qopts().length) {
        setStore("pick", idx)
        qpick(idx)
      }
      return
    }

    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      jump()
      return
    }

    if (evt.name === "x") {
      evt.preventDefault()
      evt.stopPropagation()
      void stop(current())
      return
    }

    if (evt.name === "b") {
      evt.preventDefault()
      evt.stopPropagation()
      void branch(store.pane === "family" ? famcur()?.row : current())
      return
    }

    if (evt.name === "n") {
      evt.preventDefault()
      evt.stopPropagation()
      void fresh(store.pane === "work" ? lane()?.dir : current()?.info.directory)
      return
    }

    if (evt.name === "o") {
      evt.preventDefault()
      evt.stopPropagation()
      void once()
      return
    }

    if (evt.name === "a") {
      evt.preventDefault()
      evt.stopPropagation()
      if (item()?.kind === "permission") void once()
      if (item()?.kind === "question") qpick()
      return
    }

    if (evt.name === "y") {
      evt.preventDefault()
      evt.stopPropagation()
      void always()
      return
    }

    if (evt.name === "d") {
      evt.preventDefault()
      evt.stopPropagation()
      void deny()
      return
    }

    if (store.pane === "wait" && evt.name === "s") {
      evt.preventDefault()
      evt.stopPropagation()
      void qsubmit()
      return
    }

    if (store.pane === "wait" && evt.name === "c") {
      evt.preventDefault()
      evt.stopPropagation()
      qclear()
      return
    }

    if (store.pane === "family" && evt.name === "r") {
      evt.preventDefault()
      evt.stopPropagation()
      froot()
      return
    }

    if (store.pane === "family" && evt.name === "z") {
      evt.preventDefault()
      evt.stopPropagation()
      void fstop()
      return
    }

    if (evt.name === "w") {
      evt.preventDefault()
      evt.stopPropagation()
      const id = run()?.win?.sessionId
      if (!id) return
      open(by().get(id) ?? run()?.rows.find((item) => item.sessionID === id)?.row ?? run()?.root)
    }
  })

  return (
    <box flexDirection="column" height="100%" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <box flexDirection="column" flexShrink={0} gap={1}>
        <text fg={theme.textMuted}>Operations</text>
        <text fg={theme.text}>
          <b>Agent Control Tower</b>
        </text>
        <text fg={theme.textMuted}>{directory()}</text>
        <box flexDirection="row" flexWrap="wrap" gap={2}>
          <Stat label="Live" value={stats().live} note="running now" />
          <Stat label="Waiting" value={stats().wait} note="needs input" />
          <Stat label="Agents" value={stats().agents} note="subagents" />
          <Stat label="Branches" value={stats().branches} note="interactive" />
          <Stat label="Workspaces" value={stats().workspaces} note="directories" />
        </box>
        <box flexDirection="row" gap={1}>
          <Tab text="Families" note={String(flat().length)} on={store.pane === "family"} onPick={() => setStore("pane", "family")} />
          <Tab text="Attention" note={String(wait().length)} on={store.pane === "wait"} onPick={() => setStore("pane", "wait")} />
          <Tab text="Workspaces" note={String(work().length)} on={store.pane === "work"} onPick={() => setStore("pane", "work")} />
          <Tab text="Tasks" note={String(task().length)} on={store.pane === "task"} onPick={() => setStore("pane", "task")} />
        </box>
      </box>

      <box flexGrow={1} flexDirection={wide() ? "row" : "column"} gap={2} paddingTop={1} minHeight={0}>
        <scrollbox
          ref={(r: ScrollBoxRenderable) => (main = r)}
          flexGrow={1}
          minHeight={wide() ? 0 : 12}
          width={wide() ? "66%" : undefined}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexDirection="column" gap={1} paddingRight={1}>
            <Switch>
              <Match when={store.pane === "family"}>
                <Show when={fams().length > 0} fallback={<text fg={theme.textMuted}>No recent sessions.</text>}>
                  <For each={fams()}>
                    {(fam) => (
                      <box flexDirection="column" backgroundColor={theme.backgroundPanel} paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
                        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
                          <text fg={theme.text} wrapMode="word">
                            <b>{fam.root.info.title}</b>
                          </text>
                          <Show when={fam.busy > 0}>
                            <Chip text={`${fam.busy} live`} tone="busy" />
                          </Show>
                          <Show when={fam.wait > 0}>
                            <Chip text={`${fam.wait} waiting`} tone="wait" />
                          </Show>
                          <Show when={fam.kids > 0}>
                            <Chip text={`${fam.kids} agents`} tone="base" />
                          </Show>
                        </box>
                        <text fg={theme.textMuted}>
                          {fam.rows.length} branches · {fam.root.info.directory === directory() ? "local" : tail(fam.root.info.directory)} · {ago(fam.time)}
                        </text>
                        <box height={1} />
                        <For each={flat().filter((item) => item.fam.id === fam.id)}>
                          {(item) => (
                            <FamilyRow
                              item={item}
                              on={store.pane === "family" && node()?.row.info.id === item.row.info.id}
                              root={directory()}
                              onPick={() => {
                                setStore("pane", "family")
                                setStore(
                                  "family",
                                  flat().findIndex((row) => row.row.info.id === item.row.info.id),
                                )
                                setStore("fid", item.row.info.id)
                              }}
                              onOpen={() => open(item.row)}
                              onStop={() => void stop(item.row)}
                            />
                          )}
                        </For>
                      </box>
                    )}
                  </For>
                </Show>
              </Match>

              <Match when={store.pane === "wait"}>
                <Show when={wait().length > 0} fallback={<text fg={theme.textMuted}>Nothing needs attention right now.</text>}>
                  <box flexDirection="column" gap={1}>
                    <For each={wait()}>
                      {(entry, idx) => {
                        const on = () => idx() === store.wait
                        const bg = () => theme.backgroundPanel
                        return (
                          <box
                            id={`wait:${entry.id}`}
                            backgroundColor={bg()}
                            paddingLeft={1}
                            paddingRight={1}
                            onMouseUp={() => {
                              setStore("wait", idx())
                              setStore("qid", entry.id)
                            }}
                          >
                            <box flexDirection="row" gap={1}>
                              <text fg={on() ? theme.primary : theme.text}>{on() ? "›" : " "}</text>
                              <text fg={entry.kind === "permission" ? theme.warning : theme.info}>
                                {entry.kind === "permission" ? "△" : "?"}
                              </text>
                              <box flexDirection="column" flexGrow={1} minWidth={0}>
                                <text fg={on() ? theme.primary : theme.text} wrapMode="word">
                                  <b>{entry.row?.info.title ?? entry.sessionID}</b>
                                </text>
                                <text fg={on() ? theme.text : theme.textMuted} wrapMode="word">
                                  {entry.kind === "permission" ? note(entry.req) : entry.req.questions[0]?.header || "Question"} · {entry.row?.info.directory === directory() ? "local" : tail(entry.row?.info.directory ?? directory())}
                                </text>
                              </box>
                            </box>
                          </box>
                        )
                      }}
                    </For>

                    <Show when={item()}>
                      {(entry) => (
                        <box flexDirection="column" backgroundColor={theme.backgroundPanel} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
                          <Switch>
                            <Match when={entry().kind === "permission"}>
                              {(() => {
                                const req = entry().req as PermissionRequest
                                return (
                                  <>
                                    <text fg={theme.text}>
                                      <b>Selected permission</b>
                                    </text>
                                    <text fg={theme.textMuted} wrapMode="word">
                                      {`${req.permission} · ${note(req)}`}
                                    </text>
                                    <Show when={req.patterns.length > 0}>
                                      <text fg={theme.textMuted} wrapMode="word">{req.patterns.join(", ")}</text>
                                    </Show>
                                    <text fg={theme.textMuted}>enter open session · o allow once · y allow always · d reject</text>
                                  </>
                                )
                              })()}
                            </Match>
                            <Match when={true}>
                              {(() => {
                                const req = entry().req as QuestionRequest
                                const cur = qcur()
                                const total = qans().reduce((sum, item) => sum + (item.length > 0 ? 1 : 0), 0)
                                return (
                                  <>
                                    <text fg={theme.text}>
                                      <b>Selected question</b>
                                    </text>
                                    <text fg={theme.textMuted} wrapMode="word">
                                      {cur?.question ?? req.questions[0]?.question ?? "Question"}
                                    </text>
                                    <text fg={theme.textMuted}>
                                      {`question ${qtab() + 1}/${req.questions.length} · answered ${total}/${req.questions.length}`}
                                    </text>
                                    <text fg={theme.textMuted}>enter open session · a pick · s submit · d reject · c clear · [ ] question</text>
                                    <box flexDirection="row" gap={1} flexWrap="wrap" paddingTop={1}>
                                      <For each={req.questions}>
                                        {(q, idx) => (
                                          <text
                                            fg={idx() === qtab() ? theme.primary : (qans()[idx()]?.length ? theme.success : theme.textMuted)}
                                            onMouseUp={() => {
                                              setStore("qtab", idx())
                                              setStore("pick", 0)
                                            }}
                                          >
                                            {`${idx() + 1}:${q.header}`}
                                          </text>
                                        )}
                                      </For>
                                    </box>
                                    <Show when={qopts().length > 0} fallback={<text fg={theme.textMuted}>No inline options. Press enter to answer in the session.</text>}>
                                      <box flexDirection="column" gap={1} paddingTop={1}>
                                        <For each={qopts().slice(0, 9)}>
                                          {(opt, idx) => {
                                            const on = () => idx() === store.pick
                                            const chosen = () => qsel().includes(opt.label)
                                            return (
                                              <box
                                                backgroundColor={theme.backgroundPanel}
                                                paddingLeft={1}
                                                paddingRight={1}
                                                onMouseUp={() => {
                                                  setStore("pick", idx())
                                                  qpick(idx())
                                                }}
                                              >
                                                <text fg={chosen() ? theme.success : on() ? theme.primary : theme.text} wrapMode="word">
                                                  {on() ? "› " : "  "}
                                                  {idx() + 1}. <b>{opt.label}</b>{chosen() ? " ✓" : ""}{" "}
                                                  <span style={{ fg: chosen() ? theme.success : on() ? theme.primary : theme.textMuted }}>{opt.description}</span>
                                                </text>
                                              </box>
                                            )
                                          }}
                                        </For>
                                        <text fg={theme.textMuted}>← → move option · 1-9 quick pick · a pick/toggle · s submit</text>
                                      </box>
                                    </Show>
                                  </>
                                )
                              })()}
                            </Match>
                          </Switch>
                        </box>
                      )}
                    </Show>
                  </box>
                </Show>
              </Match>

              <Match when={store.pane === "work"}>
                <Show when={work().length > 0} fallback={<text fg={theme.textMuted}>No workspaces found.</text>}>
                  <For each={work()}>
                    {(entry, idx) => {
                      const on = () => idx() === store.work
                      const bg = () => theme.backgroundPanel
                      const fg = () => (on() ? theme.primary : theme.text)
                      const muted = () => (on() ? theme.text : theme.textMuted)
                      return (
                        <box
                          id={`work:${entry.dir}`}
                          backgroundColor={bg()}
                          paddingTop={1}
                          paddingBottom={1}
                          paddingLeft={2}
                          paddingRight={2}
                          onMouseUp={() => {
                            setStore("work", idx())
                            setStore("wid", entry.dir)
                          }}
                        >
                          <box flexDirection="row" gap={1}>
                            <text fg={fg()}>{on() ? "›" : " "}</text>
                            <text fg={fg()}>
                              <b>{entry.dir === directory() ? "main workspace" : tail(entry.dir)}</b>
                            </text>
                            <Show when={entry.live > 0}>
                              <Chip text={`${entry.live} live`} tone="busy" />
                            </Show>
                            <Show when={entry.wait > 0}>
                              <Chip text={`${entry.wait} waiting`} tone="wait" />
                            </Show>
                          </box>
                          <text fg={muted()} wrapMode="word">
                            {entry.dir} · {entry.rows.length} sessions · {entry.kids} agents
                          </text>
                          <Show when={entry.rows[0]}>
                            <text fg={muted()} wrapMode="word">
                              head: {entry.rows[0].info.title}
                            </text>
                          </Show>
                          <box flexDirection="row" gap={1} flexWrap="wrap">
                            <text
                              fg={on() ? theme.primary : theme.text}
                              onMouseUp={(evt) => {
                                evt.stopPropagation()
                                const row = entry.rows[0]
                                if (row) open(row)
                              }}
                            >
                              open
                            </text>
                            <text fg={muted()}>·</text>
                            <text
                              fg={on() ? theme.primary : theme.text}
                              onMouseUp={(evt) => {
                                evt.stopPropagation()
                                void fresh(entry.dir)
                              }}
                            >
                              new session
                            </text>
                            <text fg={muted()}>· enter open · n new session here</text>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </Match>

              <Match when={store.pane === "task"}>
                <Show when={task().length > 0} fallback={<text fg={theme.textMuted}>No task branch tournaments detected yet.</text>}>
                  <For each={task()}>
                    {(entry, idx) => {
                      const on = () => idx() === store.task
                      const bg = () => theme.backgroundPanel
                      const fg = () => (on() ? theme.primary : theme.text)
                      const muted = () => (on() ? theme.text : theme.textMuted)
                      const done = () => entry.rows.filter((item) => item.status.type === "idle").length
                      return (
                        <box
                          id={`task:${entry.id}`}
                          backgroundColor={bg()}
                          paddingTop={1}
                          paddingBottom={1}
                          paddingLeft={2}
                          paddingRight={2}
                          onMouseUp={() => {
                            setStore("task", idx())
                            setStore("tid", entry.id)
                          }}
                        >
                          <box flexDirection="row" gap={1}>
                            <text fg={fg()}>{on() ? "›" : " "}</text>
                            <text fg={fg()} wrapMode="word">
                              <b>{entry.title}</b>
                            </text>
                            <Chip text={entry.state} tone={entry.state === "running" ? "busy" : entry.state === "error" ? "retry" : "base"} />
                            <Show when={entry.background}>
                              <Chip text="background" tone="base" />
                            </Show>
                          </box>
                          <text fg={muted()} wrapMode="word">
                            root: {entry.root.info.title} · {done()}/{entry.rows.length} complete · {ago(entry.time)}
                          </text>
                          <For each={entry.rows}>
                            {(item) => (
                              <text fg={muted()} wrapMode="word">
                                • <span style={{ fg: fg() }}>{item.name}</span> · {stat(item.status)}
                                <Show when={entry.win?.sessionId === item.sessionID}> · winner</Show>
                              </text>
                            )}
                          </For>
                          <box flexDirection="row" gap={1} flexWrap="wrap">
                            <text
                              fg={on() ? theme.primary : theme.text}
                              onMouseUp={(evt) => {
                                evt.stopPropagation()
                                const id = entry.win?.sessionId
                                if (id) return open(by().get(id) ?? entry.rows.find((item) => item.sessionID === id)?.row ?? entry.root)
                                open(entry.rows[0]?.row ?? entry.root)
                              }}
                            >
                              open best
                            </text>
                            <Show when={entry.win?.sessionId}>
                              <>
                                <text fg={muted()}>·</text>
                                <text
                                  fg={on() ? theme.primary : theme.text}
                                  onMouseUp={(evt) => {
                                    evt.stopPropagation()
                                    const id = entry.win?.sessionId
                                    if (!id) return
                                    open(by().get(id) ?? entry.rows.find((item) => item.sessionID === id)?.row ?? entry.root)
                                  }}
                                >
                                  winner
                                </text>
                              </>
                            </Show>
                            <text fg={muted()}>· enter open best branch · w winner</text>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </Match>
            </Switch>
          </box>
        </scrollbox>

        <scrollbox
          width={wide() ? 46 : undefined}
          height={wide() ? undefined : 16}
          flexShrink={0}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexDirection="column" gap={1} backgroundColor={theme.backgroundPanel} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
            <text fg={theme.textMuted}>Evidence</text>
            <Show when={current()} fallback={<text fg={theme.textMuted}>Select a session, workspace, or task to inspect.</text>}>
              {(row) => (
                <>
                  <text fg={theme.text} wrapMode="word">
                    <b>{row().info.title}</b>
                  </text>
                  <text fg={theme.textMuted} wrapMode="word">
                    {row().info.directory} · {row().info.kind} · {stat(row().status)}
                  </text>
                  <text fg={theme.textMuted}>enter open · x stop · b branch · n new here</text>

                  <Show when={store.pane === "family" && famcur()}>
                    {(info) => (
                      <>
                        <box height={1} />
                        <text fg={theme.text}>
                          <b>Family controls</b>
                        </text>
                        <text fg={theme.textMuted} wrapMode="word">
                          {`${info().idx + 1}/${info().fam.rows.length} branches · ${info().fam.kids} agents · ${info().fam.wait} waiting`}
                        </text>
                        <box flexDirection="row" gap={1} flexWrap="wrap">
                          <text fg={theme.primary} onMouseUp={() => open(info().row)}>
                            open
                          </text>
                          <text fg={theme.textMuted}>·</text>
                          <text fg={theme.primary} onMouseUp={() => froot()}>
                            root
                          </text>
                          <text fg={theme.textMuted}>·</text>
                          <text fg={theme.primary} onMouseUp={() => fmove(-1)}>
                            prev
                          </text>
                          <text fg={theme.textMuted}>·</text>
                          <text fg={theme.primary} onMouseUp={() => fmove(1)}>
                            next
                          </text>
                          <text fg={theme.textMuted}>·</text>
                          <text fg={theme.primary} onMouseUp={() => void branch(info().row)}>
                            branch
                          </text>
                          <text fg={theme.textMuted}>·</text>
                          <text fg={theme.warning} onMouseUp={() => void fstop()}>
                            stop family
                          </text>
                        </box>
                        <text fg={theme.textMuted}>h/l cycle branches · r root · b branch · z stop family</text>
                      </>
                    )}
                  </Show>

                  <Show when={ctx() || last()}>
                    <box height={1} />
                    <text fg={theme.text}>
                      <b>Runtime</b>
                    </text>
                    <Show when={last()}>
                      {(msg) => (
                        <text fg={theme.textMuted} wrapMode="word">
                          {msg().role === "assistant" ? `${msg().providerID}/${msg().modelID} · ${msg().agent}` : "assistant unavailable"}
                        </text>
                      )}
                    </Show>
                    <Show when={ctx()}>
                      <text fg={theme.textMuted}>{ctx()}</text>
                    </Show>
                  </Show>

                  <Show when={todos().length > 0}>
                    <box height={1} />
                    <text fg={theme.text}>
                      <b>Todos</b>
                    </text>
                    <For each={todos().slice(0, 6)}>
                      {(todo) => (
                        <text fg={theme.textMuted} wrapMode="word">
                          {mark(todo.status)} <span style={{ fg: theme.text }}>{todo.content}</span>
                        </text>
                      )}
                    </For>
                  </Show>

                  <Show when={tools().length > 0}>
                    <box height={1} />
                    <text fg={theme.text}>
                      <b>Recent tools</b>
                    </text>
                    <For each={tools()}>
                      {(part) => (
                        <text fg={theme.textMuted} wrapMode="word">
                          • <span style={{ fg: theme.text }}>{tool(part)}</span>
                        </text>
                      )}
                    </For>
                  </Show>

                  <Show when={diff().length > 0}>
                    <box height={1} />
                    <text fg={theme.text}>
                      <b>Changed files</b>
                    </text>
                    <For each={diff().slice(0, 8)}>
                      {(file) => (
                        <text fg={theme.textMuted} wrapMode="word">
                          • <span style={{ fg: theme.text }}>{file.file}</span>
                          {` · +${file.additions} -${file.deletions}`}
                        </text>
                      )}
                    </For>
                  </Show>

                  <Show when={text()}>
                    <box height={1} />
                    <text fg={theme.text}>
                      <b>Last output</b>
                    </text>
                    <text fg={theme.textMuted} wrapMode="word">
                      {text()}
                    </text>
                  </Show>
                </>
              )}
            </Show>
          </box>
        </scrollbox>
      </box>

      <box flexShrink={0} paddingTop={1} flexDirection="row" gap={2}>
        <text fg={theme.textMuted}>tab pane</text>
        <text fg={theme.textMuted}>↑↓ move</text>
        <text fg={theme.textMuted}>enter open</text>
        <text fg={theme.textMuted}>x stop</text>
        <text fg={theme.textMuted}>b branch</text>
        <text fg={theme.textMuted}>n new</text>
        <text fg={theme.textMuted}>o/y allow</text>
        <text fg={theme.textMuted}>a pick</text>
        <text fg={theme.textMuted}>s submit</text>
        <text fg={theme.textMuted}>d reject</text>
        <box flexGrow={1} />
        <text fg={theme.textMuted} onMouseUp={() => command.show()}>
          command palette
        </text>
      </box>
    </box>
  )
}

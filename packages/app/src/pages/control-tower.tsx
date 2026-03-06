import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import type {
  FileDiff,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  ToolPart,
} from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { useNavigate, useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { DialogBranches } from "@/components/dialog-branches"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { decode64 } from "@/utils/base64"
import { applyState, famNote as familyNote, runNote as taskNote } from "./control-tower-state"

type Row = {
  info: Session
  dir: string
  branch?: string
  status: SessionStatus
  perms: number
  asks: number
}

type Fam = {
  id: string
  root: Row
  rows: Row[]
  busy: number
  wait: number
  kids: number
  time: number
}

type Box = {
  dir: string
  branch?: string
  local: boolean
  busy: number
  wait: number
  count: number
  err?: string
}

type Ask =
  | {
      id: string
      kind: "permission"
      row: Row
      req: PermissionRequest
    }
  | {
      id: string
      kind: "question"
      row: Row
      req: QuestionRequest
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

type Snap = {
  msg?: Message[]
  part?: Record<string, Part[]>
  diff?: FileDiff[]
  todo?: Todo[]
  loading?: boolean
  err?: string
}

const idle = { type: "idle" as const }
const days = 30 * 24 * 60 * 60 * 1000

const text = (err: unknown) => {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  return "Request failed"
}

const ago = (time: number) => {
  const diff = Date.now() - time
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))}h ago`
  return `${Math.max(1, Math.round(diff / 86_400_000))}d ago`
}

const rank = (status: SessionStatus) => {
  if (status.type === "busy") return 0
  if (status.type === "retry") return 1
  return 2
}

const tone = (row: Row) => {
  if (row.perms + row.asks > 0) return "wait" as const
  if (row.status.type === "busy") return "busy" as const
  if (row.status.type === "retry") return "retry" as const
  return "idle" as const
}

const dot = (row: Row) => {
  if (tone(row) === "busy") return "bg-emerald-500"
  if (tone(row) === "retry") return "bg-amber-500"
  if (tone(row) === "wait") return "bg-sky-500"
  return "bg-border-strong"
}

const cut = (input?: string, size = 280) => {
  if (!input) return
  return input.length > size ? input.slice(0, size - 1) + "…" : input
}

const tail = (input: string) => {
  const parts = input.split("/").filter(Boolean)
  return parts.at(-1) ?? input
}

const stat = (input: SessionStatus) => {
  if (input.type === "busy") return "running"
  if (input.type === "retry") return `retry ${input.attempt}`
  return "idle"
}

const note = (req: PermissionRequest) => {
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

const tool = (part: ToolPart) => {
  if (part.state.status === "running") return part.state.title ? `${part.tool} ${part.state.title}` : `${part.tool} running`
  if (part.state.status === "error") return `${part.tool} failed`
  if (part.state.status === "completed") return part.state.title ? `${part.tool} ${part.state.title}` : part.tool
  return `${part.tool} pending`
}

const lastAssistant = (msg: Message[]) => {
  for (let i = msg.length - 1; i >= 0; i--) {
    if (msg[i].role === "assistant") return msg[i]
  }
}

const askTone = (item: Ask) => (item.kind === "permission" ? "retry" : "wait")

const runTone = (run: Run) => (run.state === "running" ? "busy" : run.state === "error" ? "retry" : "base")

const done = (run: Run) => run.rows.filter((item) => item.status.type === "idle").length

function Pill(props: {
  tone: "busy" | "retry" | "wait" | "idle" | "base"
  children: JSX.Element
}) {
  const cls = {
    busy: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    retry: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    wait: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    idle: "border-border-weak-base bg-surface-panel text-text-weak",
    base: "border-border-weak-base bg-background-stronger text-text-base",
  }

  return (
    <span class={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls[props.tone]}`}>
      {props.children}
    </span>
  )
}

function Stat(props: { icon: string; label: string; value: number; note: string }) {
  return (
    <div class="rounded-2xl border border-border-weak-base bg-background-base p-4 shadow-xs-border-base">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">{props.label}</div>
          <div class="pt-3 text-[30px] leading-none font-semibold text-text-strong">{props.value}</div>
          <div class="pt-2 text-12-regular text-text-weak">{props.note}</div>
        </div>
        <div class="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-weak-base bg-background-stronger text-icon-base">
          <Icon name={props.icon as never} size="small" />
        </div>
      </div>
    </div>
  )
}

function Tab(props: { on: boolean; label: string; value: number; onClick: () => void }) {
  return (
    <button
      type="button"
      class="inline-flex items-center gap-2 rounded-full border px-3 py-2 text-12-medium transition-colors"
      classList={{
        "border-border-weak-base bg-background-base text-text-base hover:bg-surface-panel": !props.on,
        "border-border-strong bg-surface-panel text-text-strong shadow-xs-border-base": props.on,
      }}
      onClick={props.onClick}
    >
      <span>{props.label}</span>
      <span class="rounded-full bg-background-stronger px-1.5 py-0.5 text-[11px] text-text-weak">{props.value}</span>
    </button>
  )
}

function Section(props: { title: string; note: string; children: JSX.Element }) {
  return (
    <section class="overflow-hidden rounded-2xl border border-border-weak-base bg-background-base shadow-xs-border-base">
      <div class="border-b border-border-weak-base px-4 py-3">
        <div class="text-13-medium text-text-strong">{props.title}</div>
        <div class="pt-1 text-12-regular text-text-weak">{props.note}</div>
      </div>
      {props.children}
    </section>
  )
}

function Empty(props: { icon: string; title: string; note: string }) {
  return (
    <div class="rounded-2xl border border-dashed border-border-weak-base bg-background-base px-6 py-10 text-center shadow-xs-border-base">
      <div class="mx-auto flex size-12 items-center justify-center rounded-full border border-border-weak-base bg-background-stronger text-icon-base">
        <Icon name={props.icon as never} />
      </div>
      <div class="pt-4 text-14-medium text-text-strong">{props.title}</div>
      <div class="mx-auto max-w-[32rem] pt-2 text-14-regular text-text-weak">{props.note}</div>
    </div>
  )
}

export default function ControlTower() {
  const params = useParams()
  const navigate = useNavigate()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const local = useLocal()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const root = dir()
    return layout.projects.list().find((item) => item.worktree === root || item.sandboxes?.includes(root))
  })
  const name = createMemo(() => project()?.name || getFilename(project()?.worktree || dir()))
  const dirs = createMemo(() => {
    const root = project()?.worktree ?? dir()
    if (!root) return [] as string[]
    return [...new Set([root, ...(project()?.sandboxes ?? [])])]
  })
  const refs = createMemo(() =>
    dirs().map((dir) => ({
      dir,
      store: globalSync.child(dir, { bootstrap: true })[0],
    })),
  )
  const model = createMemo(() => {
    const cur = local.model.current()
    if (cur) {
      return {
        providerID: cur.provider.id,
        modelID: cur.id,
      }
    }
    const cfg = globalSync.data.config.model
    if (!cfg) return
    const [providerID, modelID] = cfg.split("/")
    if (!providerID || !modelID) return
    return { providerID, modelID }
  })
  const variant = createMemo(() => local.model.variant.current())

  const [data, setData] = createStore({
    list: {} as Record<string, Session[]>,
    err: {} as Record<string, string | undefined>,
    at: 0,
    loading: false,
  })
  const [tab, setTab] = createSignal<"all" | "live" | "wait" | "branch" | "agent">("all")
  const [pick, setPick] = createSignal<string>()
  const [stop, setStop] = createStore({} as Record<string, boolean>)
  const [act, setAct] = createStore({} as Record<string, boolean>)
  const [op, setOp] = createStore({} as Record<string, boolean>)
  const [snap, setSnap] = createStore({} as Record<string, Snap>)

  let job: Promise<void> | undefined
  const jobs = new Map<string, Promise<void>>()

  const load = async () => {
    if (job) return job
    const list = refs().map((item) => item.dir)
    if (list.length === 0) {
      setData("loading", false)
      return
    }

    setData("loading", true)
    job = Promise.all(
      list.map(async (dir) => {
        const result = await globalSDK.client.session
          .list({
            directory: dir,
            start: Date.now() - days,
            limit: 300,
          })
          .then((x) => x.data ?? [])
          .then((x) => x.filter((item) => !!item?.id).filter((item) => item.time.archived === undefined))
          .then((x) => x.toSorted((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id)))
          .catch((err) => {
            setData("err", dir, text(err))
            return undefined
          })

        if (!result) return
        setData("list", dir, result)
        setData("err", dir, undefined)
      }),
    )
      .then(() => {
        setData("at", Date.now())
      })
      .finally(() => {
        setData("loading", false)
        job = undefined
      })

    return job
  }

  createEffect(() => {
    refs().map((item) => item.dir).join("\n")
    void load()
    const timer = setInterval(() => {
      void load()
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })

  const rows = createMemo(() => {
    const list: Row[] = []
    for (const item of refs()) {
      const listByDir = data.list[item.dir] ?? []
      const branch = item.store.vcs?.branch
      for (const info of listByDir) {
        list.push({
          info,
          dir: item.dir,
          branch,
          status: item.store.session_status[info.id] ?? idle,
          perms: (item.store.permission[info.id] ?? []).length,
          asks: (item.store.question[info.id] ?? []).length,
        })
      }
    }
    return list
  })

  const by = createMemo(() => new Map(rows().map((row) => [row.info.id, row] as const)))

  const byParent = createMemo(() => {
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
    for (const [id, group] of map) {
      const sorted = group.toSorted((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
      const tree = all.filter((row) => row.info.rootID === id)
      const root = sorted.find((row) => row.info.id === id) ?? sorted[0]
      if (!root) continue
      list.push({
        id,
        root,
        rows: sorted,
        busy: tree.reduce((sum, row) => sum + (row.status.type === "idle" ? 0 : 1), 0),
        wait: tree.reduce((sum, row) => sum + (row.perms + row.asks > 0 ? 1 : 0), 0),
        kids: tree.filter((row) => row.info.kind === "subagent").length,
        time: tree.reduce((max, row) => Math.max(max, row.info.time.updated), 0),
      })
    }

    return list.toSorted((a, b) => b.time - a.time || b.root.info.id.localeCompare(a.root.info.id))
  })

  const live = createMemo(() =>
    rows()
      .filter((row) => row.status.type !== "idle")
      .toSorted((a, b) => rank(a.status) - rank(b.status) || b.info.time.updated - a.info.time.updated),
  )

  const waitRows = createMemo(() =>
    rows()
      .filter((row) => row.perms + row.asks > 0)
      .toSorted((a, b) => b.perms + b.asks - (a.perms + a.asks) || b.info.time.updated - a.info.time.updated),
  )

  const asks = createMemo(() =>
    rows()
      .flatMap((row) => [
        ...(refs()
          .find((item) => item.dir === row.dir)
          ?.store.permission[row.info.id] ?? [])
          .map((req) => ({
            id: req.id,
            kind: "permission" as const,
            row,
            req,
          })),
        ...(refs()
          .find((item) => item.dir === row.dir)
          ?.store.question[row.info.id] ?? [])
          .map((req) => ({
            id: req.id,
            kind: "question" as const,
            row,
            req,
          })),
      ])
      .toSorted((a, b) => b.row.info.time.updated - a.row.info.time.updated || b.id.localeCompare(a.id)),
  )

  const boxes = createMemo<Box[]>(() =>
    refs().map((item) => {
      const list = data.list[item.dir] ?? []
      return {
        dir: item.dir,
        branch: item.store.vcs?.branch,
        local: item.dir === (project()?.worktree ?? dir()),
        busy: list.filter((row) => (item.store.session_status[row.id] ?? idle).type !== "idle").length,
        wait: list.filter(
          (row) => ((item.store.permission[row.id] ?? []).length + (item.store.question[row.id] ?? []).length) > 0,
        ).length,
        count: list.length,
        err: data.err[item.dir],
      }
    }),
  )

  const stats = createMemo(() => {
    const list = rows()
    return {
      live: list.filter((row) => row.status.type !== "idle").length,
      wait: asks().length,
      agents: list.filter((row) => row.info.kind === "subagent").length,
      branches: list.filter((row) => row.info.kind === "interactive" && row.info.id !== row.info.rootID).length,
      boxes: dirs().length,
    }
  })

  const show = (fam: Fam) => {
    if (tab() === "all") return true
    if (tab() === "live") return fam.busy > 0
    if (tab() === "wait") return fam.wait > 0
    if (tab() === "branch") return fam.rows.length > 1
    return fam.kids > 0
  }

  const list = createMemo(() => fams().filter(show))

  const open = (row: Row) => navigate(`/${base64Encode(row.dir)}/session/${row.info.id}`)
  const fresh = (dir: string) => navigate(`/${base64Encode(dir)}/session`)

  const boxLabel = (row: Row) => {
    const kind = row.dir === (project()?.worktree ?? dir()) ? "Local" : "Sandbox"
    return row.branch ? `${kind} · ${row.branch}` : `${kind} · ${getFilename(row.dir)}`
  }

  const key = (row: Row) => `${row.dir}:${row.info.id}`

  const pickRun = (run: Run) => {
    const id = run.win?.sessionId
    if (id) return by().get(id) ?? run.rows.find((item) => item.sessionID === id)?.row ?? run.root
    return run.rows[0]?.row ?? run.root
  }

  const rootTools = (row: Row) =>
    Object.values(snap[key(row)]?.part ?? {})
      .flat()
      .filter((item): item is ToolPart => item.type === "tool")

  const apply = (run: Run) => applyState(rootTools(run.root), run.id)
  const famHint = (fam: Fam) => familyNote(fam.root.info, !!model())
  const runHint = (run: Run) => taskNote(run, { model: !!model(), apply: apply(run) })

  const stopRow = async (row: Row) => {
    if (row.status.type === "idle") return
    if (stop[row.info.id]) return
    setStop(row.info.id, true)
    await globalSDK
      .createClient({ directory: row.dir, throwOnError: true })
      .session.abort({ sessionID: row.info.id })
      .catch((err) => {
        showToast({
          variant: "error",
          title: "Failed to stop agent",
          description: text(err),
        })
      })
    setStop(row.info.id, false)
    void load()
  }

  const actOn = async (id: string, fn: () => Promise<void>) => {
    if (act[id]) return
    setAct(id, true)
    await fn()
      .catch((err) => {
        showToast({
          variant: "error",
          title: "Request failed",
          description: text(err),
        })
      })
      .finally(() => setAct(id, false))
    void load()
  }

  const opOn = async (id: string, fn: () => Promise<void>, ok?: string) => {
    if (op[id]) return
    setOp(id, true)
    await fn()
      .then(() => {
        if (!ok) return
        showToast({
          variant: "success",
          title: ok,
        })
      })
      .catch((err) => {
        showToast({
          variant: "error",
          title: "Request failed",
          description: text(err),
        })
      })
      .finally(() => setOp(id, false))
    void load()
  }

  const allow = (item: Extract<Ask, { kind: "permission" }>, response: "once" | "always" | "reject") =>
    actOn(item.id, () =>
      globalSDK
        .createClient({ directory: item.row.dir, throwOnError: true })
        .permission.respond({
          sessionID: item.req.sessionID,
          permissionID: item.req.id,
          response,
        })
        .then(() => undefined),
    )

  const reject = (item: Ask) => {
    if (item.kind === "permission") return allow(item, "reject")
    return actOn(item.id, () =>
      globalSDK
        .createClient({ directory: item.row.dir, throwOnError: true })
        .question.reject({ requestID: item.req.id })
        .then(() => undefined),
    )
  }

  const answer = (item: Extract<Ask, { kind: "question" }>, value: string) =>
    actOn(item.id, () =>
      globalSDK
        .createClient({ directory: item.row.dir, throwOnError: true })
        .question.reply({ requestID: item.req.id, answers: [[value]] })
        .then(() => undefined),
    )

  const quick = (item: Ask) => {
    if (item.kind !== "question") return [] as { label: string; description: string }[]
    const cur = item.req.questions[0]
    if (!cur) return []
    if (item.req.questions.length !== 1) return []
    if (cur.multiple) return []
    return cur.options.slice(0, 3)
  }

  const compare = (sessionID: string) => {
    dialog.show(() => <DialogBranches sessionID={sessionID} />)
  }

  const openWinner = (run: Run) => {
    const id = run.win?.sessionId
    if (!id) return
    const row = by().get(id) ?? run.rows.find((item) => item.sessionID === id)?.row ?? run.root
    setPick(row.info.id)
    open(row)
  }

  const applyRun = (run: Run) => {
    const cfg = model()
    if (!cfg) {
      showToast({
        variant: "error",
        title: "Connect a provider to apply the winner",
      })
      return
    }
    return opOn(
      `apply:${run.id}`,
      () =>
        globalSDK
          .createClient({ directory: run.root.dir, throwOnError: true })
          .session.promptAsync({
            sessionID: run.root.info.id,
            model: cfg,
            variant: variant(),
            parts: [
              {
                type: "text",
                text: `Use the task_branch_apply tool to apply the winning result from branch run ${run.id} back into this session workspace. If apply is blocked, explain the reason briefly.`,
              },
            ],
          })
          .then(() => undefined),
      "Applying winner in root session",
    )
  }

  const summarizeFam = (fam: Fam) => {
    const cfg = model()
    if (!cfg) {
      showToast({
        variant: "error",
        title: "Connect a provider to summarize this family",
      })
      return
    }
    return opOn(
      `summarize:${fam.id}`,
      () =>
        globalSDK
          .createClient({ directory: fam.root.dir, throwOnError: true })
          .session.summarize({
            sessionID: fam.root.info.id,
            providerID: cfg.providerID,
            modelID: cfg.modelID,
          })
          .then(() => undefined),
      "Family summary started",
    )
  }

  const need = async (row?: Row, full = false) => {
    if (!row) return
    const id = key(row)
    const cur = snap[id]
    const ready = cur?.msg !== undefined && cur?.part !== undefined && (!full || (cur.diff !== undefined && cur.todo !== undefined))
    if (ready) return

    const pending = jobs.get(id)
    if (pending) {
      await pending
      if (full) return need(row, true)
      return
    }

    setSnap(id, "loading", true)
    setSnap(id, "err", undefined)
    const sdk = globalSDK.createClient({ directory: row.dir, throwOnError: true })

    const next = Promise.all([
      cur?.msg !== undefined && cur?.part !== undefined ? Promise.resolve(undefined) : sdk.session.messages({ sessionID: row.info.id, limit: 120 }),
      !full || cur?.diff !== undefined ? Promise.resolve(undefined) : sdk.session.diff({ sessionID: row.info.id }),
      !full || cur?.todo !== undefined ? Promise.resolve(undefined) : sdk.session.todo({ sessionID: row.info.id }),
    ])
      .then(([msg, diff, todo]) => {
        batch(() => {
          if (msg?.data) {
            const list = (msg.data ?? []) as { info: Message; parts: Part[] }[]
            setSnap(
              id,
              "msg",
              list.map((item) => item.info).toSorted((a, b) => a.id.localeCompare(b.id)),
            )
            setSnap(
              id,
              "part",
              Object.fromEntries(list.map((item) => [item.info.id, item.parts])),
            )
          }
          if (diff?.data) setSnap(id, "diff", diff.data)
          if (todo?.data) setSnap(id, "todo", todo.data)
        })
      })
      .catch((err) => {
        setSnap(id, "err", text(err))
      })
      .finally(() => {
        setSnap(id, "loading", false)
        jobs.delete(id)
      })

    jobs.set(id, next)
    return next
  }

  createEffect(() => {
    const next = by().get(pick() ?? "")
    if (next) return
    const row = live()[0] ?? waitRows()[0] ?? list()[0]?.root
    if (row) setPick(row.info.id)
  })

  createEffect(() => {
    for (const fam of fams().slice(0, 12)) void need(fam.root)
  })

  const current = createMemo(() => by().get(pick() ?? "") ?? live()[0] ?? waitRows()[0] ?? list()[0]?.root)

  createEffect(() => {
    void need(current(), true)
  })

  const info = createMemo(() => {
    const row = current()
    if (!row) return
    return snap[key(row)]
  })

  const msg = createMemo(() => info()?.msg ?? [])
  const part = createMemo(() => info()?.part ?? {})
  const diff = createMemo(() => info()?.diff ?? [])
  const todo = createMemo(() => info()?.todo ?? [])
  const toolList = createMemo(() =>
    msg()
      .flatMap((entry) => part()[entry.id] ?? [])
      .filter((entry): entry is ToolPart => entry.type === "tool")
      .slice(-6)
      .reverse(),
  )
  const last = createMemo(() => lastAssistant(msg()))
  const lastText = createMemo(() => {
    const entry = last()
    if (!entry) return
    const list = part()[entry.id] ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      if (item.type === "text") return cut(item.text, 320)
    }
  })
  const ctx = createMemo(() => getSessionContextMetrics(msg(), globalSync.data.provider.all).context)

  const runs = createMemo(() => {
    const seen = new Set<string>()
    const out: Run[] = []

    for (const fam of fams().slice(0, 12)) {
      const ref = snap[key(fam.root)]
      const msg = ref?.msg ?? []
      const part = ref?.part ?? {}
      for (const entry of msg) {
        for (const item of part[entry.id] ?? []) {
          if (item.type !== "tool" || item.tool !== "task_branch") continue
          if (item.state.status === "pending") continue
          const meta = (item.state.status === "running" || item.state.status === "completed" || item.state.status === "error"
            ? item.state.metadata
            : undefined) as
            | {
                branchId?: string
                background?: boolean
                branches?: { name?: string; sessionId?: string }[]
                winner?: { name?: string; sessionId?: string } | null
              }
            | undefined
          const id = meta?.branchId ?? item.id
          if (seen.has(id)) continue
          seen.add(id)
          const rows = (meta?.branches ?? []).flatMap((entry) => {
            if (!entry.sessionId) return []
            return [
              {
                name: entry.name ?? entry.sessionId,
                sessionID: entry.sessionId,
                status: by().get(entry.sessionId)?.status ?? idle,
                row: by().get(entry.sessionId),
              },
            ]
          })
          out.push({
            id,
            root: fam.root,
            title:
              (("title" in item.state && typeof item.state.title === "string" && item.state.title) ||
                (typeof item.state.input.description === "string" && item.state.input.description) ||
                "Branch run"),
            rows,
            win: meta?.winner,
            background: meta?.background === true,
            state: item.state.status === "error" ? "error" : item.state.status === "completed" ? "done" : "running",
            time: Math.max(entry.time.created, ...rows.map((row) => row.row?.info.time.updated ?? 0)),
          })
        }
      }
    }

    return out.toSorted((a, b) => b.time - a.time || b.id.localeCompare(a.id))
  })

  const tabs = [
    { id: "all" as const, label: "All", value: () => fams().length },
    { id: "live" as const, label: "Live", value: () => live().length },
    { id: "wait" as const, label: "Attention", value: () => waitRows().length },
    { id: "branch" as const, label: "Branches", value: () => stats().branches },
    { id: "agent" as const, label: "Agents", value: () => stats().agents },
  ]

  function Line(props: { row: Row; fam: Fam; depth: number }) {
    const kids = createMemo(() => byParent().get(props.row.info.id) ?? [])
    const needs = createMemo(() => props.row.perms + props.row.asks)
    const pos = createMemo(() => props.fam.rows.findIndex((item) => item.info.id === props.row.info.id) + 1)
    const root = createMemo(() => props.row.info.id === props.row.info.rootID)
    const on = createMemo(() => current()?.info.id === props.row.info.id)

    return (
      <>
        <div class="px-3 py-3">
          <button
            type="button"
            class="block w-full min-w-0 text-left"
            style={{ "margin-left": `${props.depth * 20}px` }}
            onClick={() => setPick(props.row.info.id)}
          >
            <div
              class="flex items-start gap-3 rounded-2xl border p-3 transition-colors"
              classList={{
                "border-border-weak-base bg-background-stronger hover:bg-surface-panel": !on(),
                "border-border-strong bg-background-base shadow-xs-border-base": on(),
              }}
            >
              <div class="flex shrink-0 flex-col items-center pt-1">
                <div class={`size-2.5 rounded-full ${dot(props.row)}`} />
                <Show when={kids().length > 0}>
                  <div class="mt-2 h-full min-h-6 w-px bg-border-weak-base" />
                </Show>
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <div class="min-w-0 flex-1 truncate text-13-medium text-text-strong" title={props.row.info.title}>
                    {props.row.info.title}
                  </div>
                  <Pill tone="base">
                    {props.row.info.kind === "subagent" ? "Agent" : root() ? "Root" : `Branch ${pos()}/${props.fam.rows.length}`}
                  </Pill>
                  <Show when={tone(props.row) === "busy"}>
                    <Pill tone="busy">Running</Pill>
                  </Show>
                  <Show when={tone(props.row) === "retry"}>
                    <Pill tone="retry">
                      {props.row.status.type === "retry" ? `Retry ${props.row.status.attempt}` : "Retry"}
                    </Pill>
                  </Show>
                  <Show when={tone(props.row) === "wait"}>
                    <Pill tone="wait">Needs input</Pill>
                  </Show>
                </div>

                <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-12-regular text-text-weak">
                  <span class="max-w-full truncate" title={boxLabel(props.row)}>
                    {boxLabel(props.row)}
                  </span>
                  <Show when={needs() > 0}>
                    <span>
                      {props.row.perms > 0 ? `${props.row.perms} approvals` : ""}
                      {props.row.perms > 0 && props.row.asks > 0 ? " · " : ""}
                      {props.row.asks > 0 ? `${props.row.asks} questions` : ""}
                    </span>
                  </Show>
                  <Show when={kids().length > 0}>
                    <span>{kids().length} child agents</span>
                  </Show>
                  <span>{ago(props.row.info.time.updated)}</span>
                </div>
              </div>

              <div class="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="small"
                  class="h-8 px-3"
                  onClick={(evt: MouseEvent & { currentTarget: HTMLButtonElement; target: Element }) => {
                    evt.stopPropagation()
                    open(props.row)
                  }}
                >
                  Open
                </Button>
                <Show when={props.row.status.type !== "idle"}>
                  <Button
                    variant="ghost"
                    size="small"
                    class="h-8 px-3 text-red-600 hover:text-red-700 dark:text-red-300"
                    disabled={stop[props.row.info.id]}
                    onClick={(evt: MouseEvent & { currentTarget: HTMLButtonElement; target: Element }) => {
                      evt.stopPropagation()
                      void stopRow(props.row)
                    }}
                  >
                    <Show when={stop[props.row.info.id]} fallback={<>Stop</>}>
                      <Spinner class="size-3.5" />
                    </Show>
                  </Button>
                </Show>
              </div>
            </div>
          </button>
        </div>
        <For each={kids()}>{(row) => <Line row={row} fam={props.fam} depth={props.depth + 1} />}</For>
      </>
    )
  }

  return (
    <div class="size-full overflow-y-auto bg-background-stronger">
      <div class="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-4 py-5 md:px-6 md:py-6">
        <section class="overflow-hidden rounded-[28px] border border-border-weak-base bg-background-base shadow-xs-border-base">
          <div class="border-b border-border-weak-base px-4 py-5 md:px-6">
            <div class="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div class="min-w-0 max-w-3xl">
                <div class="inline-flex items-center gap-2 rounded-full border border-border-weak-base bg-background-stronger px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-text-weaker">
                  <span class="inline-block size-1.5 rounded-full bg-emerald-500" />
                  Operations deck
                </div>
                <div class="pt-4 flex flex-wrap items-end gap-x-3 gap-y-2">
                  <h1 class="text-3xl font-semibold leading-none tracking-[-0.03em] text-text-strong">Agent Control Tower</h1>
                  <div class="text-14-regular text-text-weak">{name()}</div>
                </div>
                <div class="pt-3 max-w-2xl text-14-regular leading-6 text-text-weak">
                  Track branch families, background agents, blockers, and active work without diving into each session
                  one by one.
                </div>
                <div class="pt-4 flex flex-wrap gap-2">
                  <Pill tone={stats().live > 0 ? "busy" : "idle"}>{stats().live > 0 ? `${stats().live} live now` : "No live runs"}</Pill>
                  <Pill tone={stats().wait > 0 ? "wait" : "idle"}>{stats().wait > 0 ? `${stats().wait} blockers` : "No blockers"}</Pill>
                  <Pill tone="base">{dirs().length} workspaces in scope</Pill>
                  <Pill tone="base">30 day window</Pill>
                </div>
              </div>

              <div class="grid gap-3 sm:grid-cols-2 xl:w-[360px] xl:grid-cols-1">
                <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-4">
                  <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Pulse</div>
                  <div class="pt-2 text-18-medium text-text-strong">{data.at ? `Updated ${ago(data.at)}` : "Booting…"}</div>
                  <div class="pt-1 text-12-regular text-text-weak">
                    {stats().branches} active branch lanes across {stats().boxes} workspaces.
                  </div>
                </div>
                <div class="flex flex-wrap items-center gap-2 xl:justify-end">
                  <Button variant="ghost" size="large" disabled={data.loading} onClick={() => void load()}>
                    <Show when={data.loading} fallback={<>Refresh</>}>
                      <span class="inline-flex items-center gap-2">
                        <Spinner class="size-3.5" />
                        Refreshing
                      </span>
                    </Show>
                  </Button>
                  <Show when={project()?.worktree ?? dir()} keyed>
                    {(root) => (
                      <Button variant="primary" size="large" onClick={() => fresh(root)}>
                        New session
                      </Button>
                    )}
                  </Show>
                </div>
              </div>
            </div>

            <div class="pt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <Stat icon="task" label="Live" value={stats().live} note="Running or retrying now" />
              <Stat icon="checklist" label="Waiting" value={stats().wait} note="Approvals and questions" />
              <Stat icon="task" label="Agents" value={stats().agents} note="Background subagent sessions" />
              <Stat icon="branch" label="Branches" value={stats().branches} note="Non-root interactive branches" />
              <Stat icon="folder" label="Workspaces" value={stats().boxes} note="Local plus sandbox worktrees" />
            </div>
          </div>

          <div class="flex flex-wrap gap-2 px-4 py-3 md:px-6">
            <For each={tabs}>{(item) => <Tab on={tab() === item.id} label={item.label} value={item.value()} onClick={() => setTab(item.id)} />}</For>
          </div>
        </section>

        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div class="flex min-w-0 flex-col gap-4">
            <Show
              when={list().length > 0}
              fallback={
                <Empty
                  icon="task"
                  title="Nothing in flight yet"
                  note="Start a session in this workspace family and it will appear here as soon as work begins."
                />
              }
            >
              <For each={list()}>
                {(fam) => (
                  <section class="overflow-hidden rounded-[26px] border border-border-weak-base bg-background-base shadow-xs-border-base">
                    <div class="border-b border-border-weak-base px-4 py-4 md:px-5">
                      <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <button type="button" class="min-w-0 flex-1 text-left" onClick={() => setPick(fam.root.info.id)}>
                          <div class="flex items-start gap-3">
                            <div class="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border-weak-base bg-background-stronger text-icon-base">
                              <Icon name="branch" size="small" />
                            </div>
                            <div class="min-w-0 flex-1">
                              <div class="flex flex-wrap items-center gap-2">
                                <div class="min-w-0 flex-1 truncate text-15-medium text-text-strong" title={fam.root.info.title}>
                                  {fam.root.info.title}
                                </div>
                                <Show when={fam.busy > 0}>
                                  <Pill tone="busy">{fam.busy} live</Pill>
                                </Show>
                                <Show when={fam.wait > 0}>
                                  <Pill tone="wait">{fam.wait} waiting</Pill>
                                </Show>
                                <Show when={fam.kids > 0}>
                                  <Pill tone="base">{fam.kids} agents</Pill>
                                </Show>
                                <Show when={fam.root.info.time.compacting}>
                                  <Pill tone="busy">summarizing</Pill>
                                </Show>
                              </div>
                              <div class="pt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-12-regular text-text-weak">
                                <span>{fam.rows.length} branches</span>
                                <span class="max-w-full truncate" title={boxLabel(fam.root)}>
                                  {boxLabel(fam.root)}
                                </span>
                                <span>{ago(fam.time)}</span>
                              </div>
                            </div>
                          </div>
                        </button>

                        <div class="flex shrink-0 flex-col items-start gap-2 xl:items-end">
                          <div class="flex flex-wrap items-center gap-2 xl:justify-end">
                            <Button variant="ghost" size="small" class="h-8 px-3" onClick={() => open(fam.root)}>
                              Open root
                            </Button>
                            <Button variant="ghost" size="small" class="h-8 px-3" onClick={() => compare(fam.root.info.id)}>
                              Compare
                            </Button>
                            <Button
                              variant="ghost"
                              size="small"
                              class="h-8 px-3"
                              title={famHint(fam)}
                              disabled={!!famHint(fam) || op[`summarize:${fam.id}`]}
                              onClick={() => void summarizeFam(fam)}
                            >
                              <Show when={op[`summarize:${fam.id}`]} fallback={<>Summarize family</>}>
                                <Spinner class="size-3.5" />
                              </Show>
                            </Button>
                            <Button variant="ghost" size="small" class="h-8 px-3" onClick={() => fresh(fam.root.dir)}>
                              New session
                            </Button>
                          </div>
                          <Show when={famHint(fam)}>
                            {(hint) => <div class="text-12-regular text-text-weak xl:text-right">{hint()}</div>}
                          </Show>
                        </div>
                      </div>

                      <div class="mt-4 grid gap-3 sm:grid-cols-3">
                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger px-3 py-3">
                          <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Branches</div>
                          <div class="pt-2 text-18-medium text-text-strong">{fam.rows.length}</div>
                        </div>
                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger px-3 py-3">
                          <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Agents</div>
                          <div class="pt-2 text-18-medium text-text-strong">{fam.kids}</div>
                        </div>
                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger px-3 py-3">
                          <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Last touch</div>
                          <div class="pt-2 text-18-medium text-text-strong">{ago(fam.time)}</div>
                        </div>
                      </div>
                    </div>

                    <div class="divide-y divide-border-weak-base px-1 py-1">
                      <For each={fam.rows}>{(row) => <Line row={row} fam={fam} depth={row.info.id === fam.id ? 0 : 1} />}</For>
                    </div>
                  </section>
                )}
              </For>
            </Show>
          </div>

          <div class="flex min-w-0 flex-col gap-4">
            <Section title="Evidence" note="Selected session telemetry, diffs, recent tools, and last output.">
              <div class="p-4">
                <Show when={current()} fallback={<div class="text-12-regular text-text-weak">Select a session to inspect it here.</div>}>
                  {(row) => (
                    <div class="flex flex-col gap-4">
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-14-medium text-text-strong" title={row().info.title}>
                            {row().info.title}
                          </div>
                          <div class="pt-1 flex flex-wrap gap-2 text-12-regular text-text-weak">
                            <span class="max-w-full truncate" title={boxLabel(row())}>
                              {boxLabel(row())}
                            </span>
                            <span>{stat(row().status)}</span>
                            <span>{ago(row().info.time.updated)}</span>
                          </div>
                          <div class="pt-2 flex flex-wrap gap-2">
                            <Pill tone={tone(row())}>{stat(row().status)}</Pill>
                            <Pill tone="base">{msg().length} messages</Pill>
                            <Pill tone="base">{toolList().length} recent tools</Pill>
                            <Pill tone="base">{diff().length} changed files</Pill>
                          </div>
                        </div>
                        <div class="flex items-center gap-2">
                          <Button variant="ghost" size="small" class="h-8 px-3" onClick={() => void need(row(), true)}>
                            Refresh
                          </Button>
                          <Button variant="ghost" size="small" class="h-8 px-3" onClick={() => open(row())}>
                            Open
                          </Button>
                          <Show when={row().status.type !== "idle"}>
                            <Button
                              variant="ghost"
                              size="small"
                              class="h-8 px-3 text-red-600 hover:text-red-700 dark:text-red-300"
                              disabled={stop[row().info.id]}
                              onClick={() => void stopRow(row())}
                            >
                              <Show when={stop[row().info.id]} fallback={<>Stop</>}>
                                <Spinner class="size-3.5" />
                              </Show>
                            </Button>
                          </Show>
                        </div>
                      </div>

                      <Show when={info()?.loading}>
                        <div class="flex items-center gap-2 rounded-2xl border border-border-weak-base bg-background-stronger px-3 py-3 text-12-regular text-text-weak">
                          <Spinner class="size-3.5" />
                          Loading evidence…
                        </div>
                      </Show>

                      <Show when={info()?.err}>
                        {(err) => <div class="text-12-regular text-red-600 dark:text-red-300">{err()}</div>}
                      </Show>

                      <div class="grid gap-3 sm:grid-cols-2">
                        <Show when={ctx()}>
                          {(ctx) => (
                            <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-3">
                              <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Runtime</div>
                              <div class="pt-2 text-13-medium text-text-strong">
                                {ctx().providerLabel} · {ctx().modelLabel}
                              </div>
                              <div class="pt-1 text-12-regular text-text-weak">
                                {ctx().total.toLocaleString()} tokens
                                <Show when={ctx().usage !== null}> · {ctx().usage}% of context</Show>
                              </div>
                            </div>
                          )}
                        </Show>

                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-3">
                          <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Snapshot</div>
                          <div class="pt-2 grid grid-cols-2 gap-2 text-12-regular">
                            <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-text-weak">
                              <div class="text-[11px] uppercase tracking-[0.16em] text-text-weaker">Todos</div>
                              <div class="pt-1 text-13-medium text-text-strong">{todo().length}</div>
                            </div>
                            <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-text-weak">
                              <div class="text-[11px] uppercase tracking-[0.16em] text-text-weaker">Files</div>
                              <div class="pt-1 text-13-medium text-text-strong">{diff().length}</div>
                            </div>
                            <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-text-weak">
                              <div class="text-[11px] uppercase tracking-[0.16em] text-text-weaker">Tools</div>
                              <div class="pt-1 text-13-medium text-text-strong">{toolList().length}</div>
                            </div>
                            <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-text-weak">
                              <div class="text-[11px] uppercase tracking-[0.16em] text-text-weaker">Assistant msgs</div>
                              <div class="pt-1 text-13-medium text-text-strong">{msg().filter((item) => item.role === "assistant").length}</div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <Show when={todo().length > 0}>
                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-3">
                          <div class="flex items-center justify-between gap-3">
                            <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Todos</div>
                            <div class="text-12-regular text-text-weak">{todo().filter((item) => item.status === "completed").length}/{todo().length} done</div>
                          </div>
                          <div class="mt-2 flex flex-col gap-2">
                            <For each={todo().slice(0, 6)}>
                              {(item) => (
                                <div class="flex gap-2 rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-12-regular text-text-weak">
                                  <span class="text-text-base">{item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : item.status === "cancelled" ? "×" : "•"}</span>
                                  <span>{item.content}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      <Show when={toolList().length > 0}>
                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-3">
                          <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Recent tools</div>
                          <div class="mt-2 flex flex-col gap-2">
                            <For each={toolList()}>
                              {(item) => (
                                <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-12-regular text-text-weak">
                                  <span class="text-text-base">{tool(item)}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      <Show when={diff().length > 0}>
                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-3">
                          <div class="flex items-center justify-between gap-3">
                            <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Changed files</div>
                            <div class="text-12-regular text-text-weak">
                              +{diff().reduce((sum, item) => sum + item.additions, 0)} · -{diff().reduce((sum, item) => sum + item.deletions, 0)}
                            </div>
                          </div>
                          <div class="mt-2 flex flex-col gap-2">
                            <For each={diff().slice(0, 8)}>
                              {(item) => (
                                <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-12-regular text-text-weak">
                                  <div class="truncate text-text-base" title={item.file}>{item.file}</div>
                                  <div class="pt-1">+{item.additions} · -{item.deletions}</div>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      <Show when={lastText() || last()}>
                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-3">
                          <div class="flex items-center justify-between gap-3">
                            <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-text-weaker">Last output</div>
                            <Show when={last()}>
                              {(item) => <div class="text-12-regular text-text-weak">{ago(item().time.created)}</div>}
                            </Show>
                          </div>
                          <div class="pt-2 rounded-xl border border-border-weak-base bg-background-base px-3 py-3 text-12-regular leading-6 text-text-weak">
                            {lastText() || "No assistant output captured yet."}
                          </div>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
            </Section>

            <Section title="Needs attention" note="Handle blockers inline without opening every session.">
              <div class="divide-y divide-border-weak-base">
                <Show when={asks().length > 0} fallback={<div class="px-4 py-5 text-12-regular text-text-weak">Nothing is blocked right now.</div>}>
                  <For each={asks().slice(0, 8)}>
                    {(item) => (
                      <div class="px-4 py-4">
                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-4">
                          <div class="flex items-start gap-3">
                            <div class="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-weak-base bg-background-base text-icon-base">
                              <Icon name={(item.kind === "question" ? "bubble-5" : "checklist") as never} size="small" />
                            </div>
                            <div class="min-w-0 flex-1">
                              <div class="flex flex-wrap items-center gap-2">
                                <div class="truncate text-13-medium text-text-strong" title={item.row.info.title}>
                                  {item.row.info.title}
                                </div>
                                <Pill tone={askTone(item)}>{item.kind === "permission" ? "Permission" : "Question"}</Pill>
                                {item.kind === "question" && item.req.questions.length > 1 ? (
                                  <Pill tone="base">{item.req.questions.length} prompts</Pill>
                                ) : null}
                              </div>
                              <div class="pt-1 text-12-regular text-text-weak">
                                {item.kind === "permission" ? note(item.req) : item.req.questions[0]?.header || "Question"}
                              </div>
                              <div class="pt-1 flex flex-wrap gap-x-3 gap-y-1 text-12-regular text-text-weak">
                                <span class="max-w-full truncate" title={boxLabel(item.row)}>
                                  {boxLabel(item.row)}
                                </span>
                                <span>{ago(item.row.info.time.updated)}</span>
                              </div>

                              {item.kind === "permission" ? (
                                <>
                                  <Show when={item.req.patterns.length > 0}>
                                    <div class="pt-3 flex flex-wrap gap-2">
                                      <For each={item.req.patterns.slice(0, 3)}>
                                        {(pattern) => <Pill tone="base">{cut(pattern, 36) ?? pattern}</Pill>}
                                      </For>
                                    </div>
                                  </Show>
                                  <div class="pt-3 text-12-regular text-text-weak">
                                    {typeof item.req.metadata.command === "string"
                                      ? cut(item.req.metadata.command, 140)
                                      : "Review the requested capability and respond inline."}
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div class="pt-3 text-12-regular leading-6 text-text-weak">{item.req.questions[0]?.question}</div>
                                  <Show when={quick(item).length > 0}>
                                    <div class="pt-3 grid gap-2">
                                      <For each={quick(item)}>
                                        {(opt) => (
                                          <button
                                            type="button"
                                            class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-left transition-colors hover:bg-surface-panel"
                                            disabled={act[item.id]}
                                            onClick={() => answer(item, opt.label)}
                                          >
                                            <div class="text-12-medium text-text-strong">{opt.label}</div>
                                            <div class="pt-1 text-12-regular text-text-weak">{opt.description}</div>
                                          </button>
                                        )}
                                      </For>
                                    </div>
                                  </Show>
                                  <Show when={item.req.questions.length > 1}>
                                    <div class="pt-3 rounded-xl border border-border-weak-base bg-background-base px-3 py-3 text-12-regular text-text-weak">
                                      <div class="text-12-medium text-text-strong">Additional prompts</div>
                                      <div class="pt-2 flex flex-wrap gap-2">
                                        <For each={item.req.questions.slice(1, 4)}>{(q) => <Pill tone="base">{q.header}</Pill>}</For>
                                      </div>
                                      <div class="pt-2">Open the session to answer the full questionnaire.</div>
                                    </div>
                                  </Show>
                                </>
                              )}

                              <div class="pt-3 flex flex-wrap gap-2">
                                <Button
                                  variant="ghost"
                                  size="small"
                                  class="h-8 px-3"
                                  onClick={() => {
                                    setPick(item.row.info.id)
                                    open(item.row)
                                  }}
                                >
                                  Open
                                </Button>

                                {item.kind === "permission" ? (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="small"
                                      class="h-8 px-3"
                                      disabled={act[item.id]}
                                      onClick={() => allow(item, "once")}
                                    >
                                      <Show when={act[item.id]} fallback={<>Allow once</>}>
                                        <Spinner class="size-3.5" />
                                      </Show>
                                    </Button>
                                    <Button variant="ghost" size="small" class="h-8 px-3" disabled={act[item.id]} onClick={() => allow(item, "always")}>
                                      Always
                                    </Button>
                                  </>
                                ) : null}

                                <Button
                                  variant="ghost"
                                  size="small"
                                  class="h-8 px-3 text-red-600 hover:text-red-700 dark:text-red-300"
                                  disabled={act[item.id]}
                                  onClick={() => void reject(item)}
                                >
                                  Reject
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Section>

            <Section title="Tasks" note="Branch tournaments spawned by task runs.">
              <div class="divide-y divide-border-weak-base">
                <Show
                  when={runs().length > 0}
                  fallback={<div class="px-4 py-5 text-12-regular text-text-weak">No task branch tournaments detected yet.</div>}
                >
                  <For each={runs().slice(0, 8)}>
                    {(run) => (
                      <div class="px-4 py-4">
                        <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-4">
                          <div class="flex flex-wrap items-center gap-2">
                            <div class="min-w-0 flex-1 truncate text-13-medium text-text-strong" title={run.title}>
                              {run.title}
                            </div>
                            <Pill tone={runTone(run)}>{run.state}</Pill>
                            <Show when={run.background}>
                              <Pill tone="base">background</Pill>
                            </Show>
                            <Show when={run.win?.sessionId}>
                              <Pill tone="busy">winner picked</Pill>
                            </Show>
                            <Show when={apply(run) === "running"}>
                              <Pill tone="busy">applying</Pill>
                            </Show>
                            <Show when={apply(run) === "done"}>
                              <Pill tone="base">applied</Pill>
                            </Show>
                            <Show when={apply(run) === "error"}>
                              <Pill tone="retry">apply blocked</Pill>
                            </Show>
                          </div>

                          <div class="pt-1 flex flex-wrap gap-x-3 gap-y-1 text-12-regular text-text-weak">
                            <span class="truncate" title={run.root.info.title}>root: {run.root.info.title}</span>
                            <span>{run.rows.length} branches</span>
                            <span>{done(run)}/{run.rows.length} done</span>
                            <span>{ago(run.time)}</span>
                          </div>

                          <div class="mt-3 grid gap-2 sm:grid-cols-3">
                            <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2">
                              <div class="text-[11px] uppercase tracking-[0.16em] text-text-weaker">Branches</div>
                              <div class="pt-1 text-13-medium text-text-strong">{run.rows.length}</div>
                            </div>
                            <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2">
                              <div class="text-[11px] uppercase tracking-[0.16em] text-text-weaker">Complete</div>
                              <div class="pt-1 text-13-medium text-text-strong">{done(run)}</div>
                            </div>
                            <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2">
                              <div class="text-[11px] uppercase tracking-[0.16em] text-text-weaker">Winner</div>
                              <div class="pt-1 truncate text-13-medium text-text-strong" title={run.win?.name ?? "Pending"}>{run.win?.name ?? "Pending"}</div>
                            </div>
                          </div>

                          <div class="mt-3 flex flex-col gap-2">
                            <For each={run.rows.slice(0, 5)}>
                              {(item) => (
                                <button
                                  type="button"
                                  class="rounded-xl border border-border-weak-base bg-background-base px-3 py-3 text-left transition-colors hover:bg-surface-panel"
                                  onClick={() => {
                                    if (!item.row) return
                                    setPick(item.row.info.id)
                                  }}
                                >
                                  <div class="flex flex-wrap items-center gap-2">
                                    <div class="min-w-0 flex-1 truncate text-12-medium text-text-strong" title={item.name}>
                                      {item.name}
                                    </div>
                                    <Pill tone={item.status.type === "busy" ? "busy" : item.status.type === "retry" ? "retry" : "base"}>{stat(item.status)}</Pill>
                                    <Show when={run.win?.sessionId === item.sessionID}>
                                      <Pill tone="busy">winner</Pill>
                                    </Show>
                                  </div>
                                  <Show when={item.row}>
                                    {(row) => (
                                      <div class="pt-1 text-12-regular text-text-weak" title={boxLabel(row())}>
                                        {boxLabel(row())}
                                      </div>
                                    )}
                                  </Show>
                                </button>
                              )}
                            </For>
                          </div>

                          <div class="pt-3 flex flex-col gap-2">
                            <div class="flex flex-wrap gap-2">
                              <Button variant="ghost" size="small" class="h-8 px-3" onClick={() => open(run.root)}>
                                Open root
                              </Button>
                              <Button variant="ghost" size="small" class="h-8 px-3" onClick={() => compare(run.root.info.id)}>
                                Compare
                              </Button>
                              <Button
                                variant="ghost"
                                size="small"
                                class="h-8 px-3"
                                onClick={() => {
                                  const row = pickRun(run)
                                  setPick(row.info.id)
                                  open(row)
                                }}
                              >
                                Open best
                              </Button>
                              <Button
                                variant="ghost"
                                size="small"
                                class="h-8 px-3"
                                title={runHint(run)}
                                disabled={!run.win?.sessionId}
                                onClick={() => openWinner(run)}
                              >
                                Open winner
                              </Button>
                              <Button
                                variant="ghost"
                                size="small"
                                class="h-8 px-3"
                                title={runHint(run)}
                                disabled={!run.win?.sessionId}
                                onClick={() => {
                                  const id = run.win?.sessionId
                                  if (!id) return
                                  const row = by().get(id) ?? run.rows.find((item) => item.sessionID === id)?.row ?? run.root
                                  setPick(row.info.id)
                                }}
                              >
                                Select winner
                              </Button>
                              <Button
                                variant="ghost"
                                size="small"
                                class="h-8 px-3"
                                title={runHint(run)}
                                disabled={!run.win?.sessionId || !model() || apply(run) === "running" || op[`apply:${run.id}`]}
                                onClick={() => void applyRun(run)}
                              >
                                <Show when={op[`apply:${run.id}`]} fallback={<>Apply winner</>}>
                                  <Spinner class="size-3.5" />
                                </Show>
                              </Button>
                            </div>
                            <Show when={runHint(run)}>
                              {(hint) => <div class="text-12-regular text-text-weak">{hint()}</div>}
                            </Show>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Section>

            <Section title="Workspaces" note="Local plus sandbox activity for this project.">
              <div class="grid gap-3 p-4">
                <For each={boxes()}>
                  {(box) => (
                    <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-4">
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-13-medium text-text-strong" title={box.local ? "Local workspace" : box.branch || getFilename(box.dir)}>
                            {box.local ? "Local workspace" : box.branch || getFilename(box.dir)}
                          </div>
                          <div class="pt-1 flex flex-wrap gap-2">
                            <Pill tone={box.busy > 0 ? "busy" : "idle"}>{box.busy > 0 ? `${box.busy} live` : "quiet"}</Pill>
                            <Show when={box.wait > 0}>
                              <Pill tone="wait">{box.wait} waiting</Pill>
                            </Show>
                            <Pill tone="base">{box.count} sessions</Pill>
                          </div>
                          <div class="pt-3 text-12-regular text-text-weak" title={box.local ? "Primary worktree" : box.dir}>
                            <Show when={box.local} fallback={<span class="break-all">{box.dir}</span>}>
                              <span>Primary worktree</span>
                            </Show>
                          </div>
                          <Show when={box.err}>
                            {(err) => <div class="pt-2 text-12-regular text-red-600 dark:text-red-300">{err()}</div>}
                          </Show>
                        </div>
                        <Button variant="ghost" size="small" class="h-8 px-3" onClick={() => fresh(box.dir)}>
                          Open
                        </Button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </div>
  )
}

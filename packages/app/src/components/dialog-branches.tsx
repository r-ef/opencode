import { Dialog } from "@selene-ai/ui/dialog"
import { List } from "@selene-ai/ui/list"
import type { Session } from "@selene-ai/sdk/v2/client"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, onCleanup, type Component } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { base64Encode } from "@selene-ai/util/encode"
import { build, type Row } from "@/utils/branch-tree"

function tag(input: { current: boolean; root: boolean }) {
  const list = [] as string[]
  if (input.current) list.push("current")
  if (input.root) list.push("root")
  if (!list.length) return ""
  return `[${list.join(" ")}] `
}

function time(value: number) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

export const DialogBranches: Component<{ sessionID: string }> = (props) => {
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()

  const [rows, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const result = await sdk.client.session.branches({ sessionID })
      return result.data ?? []
    },
  )

  createEffect(() => {
    if (!props.sessionID) return
    void refetch()
    const timer = setInterval(() => {
      void refetch()
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    for (const item of rows() ?? []) {
      void sync.session.sync(item.id)
    }
  })

  const current = createMemo(() => params.id)
  const list = createMemo(() => rows() ?? [])
  const src = (id?: string) => {
    if (!id) return
    return list().find((item) => item.id === id) ?? sync.session.get(id)
  }

  const items = createMemo(() => {
    return build({ items: list() as Row[] }).map((row) => {
      const item = row.item as Session
      const from = src(item.branchFromSessionID)
      const description = !item.branchFromSessionID
        ? "family root"
        : item.branchFromMessageID
          ? `from ${from?.title ?? item.branchFromSessionID} (message branch)`
          : `from ${from?.title ?? item.branchFromSessionID}`

      return {
        id: item.id,
        directory: item.directory,
        title:
          row.prefix +
          tag({
            current: item.id === current(),
            root: item.id === item.rootID,
          }) +
          item.title,
        description,
        time: time(item.time.updated),
      }
    })
  })

  return (
    <Dialog title="Branches">
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: "Search branches", autofocus: true }}
        emptyMessage="No branches yet"
        key={(item) => item.id}
        items={items}
        filterKeys={["title", "description"]}
        onSelect={(item) => {
          if (!item) return
          navigate(`/${base64Encode(item.directory)}/session/${item.id}`)
        }}
      >
        {(item) => (
          <div class="w-full min-w-0 flex items-start gap-3">
            <div class="min-w-0 flex-1 flex flex-col gap-0.5">
              <div class="text-14-medium text-text-strong truncate">{item.title}</div>
              <div class="text-12-regular text-text-weak truncate">{item.description}</div>
            </div>
            <div class="shrink-0 text-12-regular text-text-weak">{item.time}</div>
          </div>
        )}
      </List>
    </Dialog>
  )
}

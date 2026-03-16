import { createMemo, createResource, onMount } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { Locale } from "@/util/locale"
import { build } from "./branch-tree"

function mark(input: { current: boolean; root: boolean }) {
  const tags = [] as string[]
  if (input.current) tags.push("current")
  if (input.root) tags.push("root")
  if (!tags.length) return ""
  return `[${tags.join(" ")}] `
}

export function DialogBranches(props: { sessionID: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const sync = useSync()

  onMount(() => {
    dialog.setSize("large")
  })

  const [rows] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const result = await sdk.client.session.branches({
        sessionID,
      })
      return result.data ?? []
    },
  )

  const current = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const items = createMemo(() => rows() ?? [])
  const source = (id?: string) => {
    if (!id) return
    return items().find((item) => item.id === id) ?? sync.session.get(id)
  }

  const options = createMemo((): DialogSelectOption<string>[] => {
    return build({ items: items() }).map((row) => {
      const item = row.item
      const from = source(item.branchFromSessionID)
      const text = !item.branchFromSessionID
        ? "family root"
        : item.branchFromMessageID
          ? `from ${from?.title ?? item.branchFromSessionID} (message branch)`
          : `from ${from?.title ?? item.branchFromSessionID}`
      return {
        title:
          row.prefix +
          mark({
            current: item.id === current(),
            root: item.id === item.rootID,
          }) +
          item.title,
        description: text,
        value: item.id,
        footer: Locale.time(item.time.updated),
        onSelect: (dialog) => {
          route.navigate({
            type: "session",
            sessionID: item.id,
          })
          dialog.clear()
        },
      }
    })
  })

  return <DialogSelect title="Branches" current={current()} options={options()} />
}

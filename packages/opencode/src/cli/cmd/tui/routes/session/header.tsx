import { type Accessor, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { pipe, sumBy } from "remeda"
import { useTheme } from "@tui/context/theme"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { useTerminalDimensions } from "@opentui/solid"

const Title = (props: { session: Accessor<Session> }) => {
  const { theme } = useTheme()
  return (
    <text fg={theme.text}>
      <span style={{ bold: true }}>{props.session().title}</span>
    </text>
  )
}

const ContextInfo = (props: { context: Accessor<string | undefined>; cost: Accessor<string> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.context()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {props.context()} · {props.cost()}
      </text>
    </Show>
  )
}

export function Header() {
  const route = useRouteData("session")
  const sync = useSync()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const branches = createMemo(() =>
    sync.data.session
      .filter((item) => item.kind === "interactive" && item.rootID === session()?.rootID)
      .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id)),
  )
  const branch = createMemo(() => branches().findIndex((item) => item.id === session()?.id) + 1)
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])

  const cost = createMemo(() => {
    const total = pipe(
      messages(),
      sumBy((x) => (x.role === "assistant" ? x.cost : 0)),
    )
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    let result = total.toLocaleString()
    if (model?.limit.context) {
      result += "  " + Math.round((total / model.limit.context) * 100) + "%"
    }
    return result
  })

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<
    "parent" | "prev" | "next" | "root" | "branch-list" | "branch-prev" | "branch-next" | null
  >(null)
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={0}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        border={["bottom"]}
        borderColor={theme.borderSubtle}
        flexShrink={0}
      >
        <Switch>
          <Match when={session()?.kind === "subagent"}>
            <box flexDirection="column" gap={1}>
              <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={narrow() ? 1 : 0}>
                <text fg={theme.text}>
                  <b>Subagent session</b>
                </text>
                <ContextInfo context={context} cost={cost} />
              </box>
              <box flexDirection="row" gap={2}>
                <box
                  onMouseOver={() => setHover("parent")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => command.trigger("session.parent")}
                  backgroundColor={hover() === "parent" ? theme.backgroundElement : undefined}
                >
                  <text fg={theme.textMuted}>
                    Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
                  </text>
                </box>
                <box
                  onMouseOver={() => setHover("prev")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => command.trigger("session.child.previous")}
                  backgroundColor={hover() === "prev" ? theme.backgroundElement : undefined}
                >
                  <text fg={theme.textMuted}>
                    Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
                  </text>
                </box>
                <box
                  onMouseOver={() => setHover("next")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => command.trigger("session.child.next")}
                  backgroundColor={hover() === "next" ? theme.backgroundElement : undefined}
                >
                  <text fg={theme.textMuted}>
                    Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
                  </text>
                </box>
              </box>
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection="column" gap={1}>
              <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={1}>
                <Title session={session} />
                <ContextInfo context={context} cost={cost} />
              </box>
              <Show when={branches().length > 1}>
                <box flexDirection="row" gap={2}>
                  <box
                    onMouseOver={() => setHover("branch-list")}
                    onMouseOut={() => setHover(null)}
                    onMouseUp={() => command.trigger("session.branches")}
                    backgroundColor={hover() === "branch-list" ? theme.backgroundElement : undefined}
                  >
                    <text fg={theme.textMuted}>
                      Branch {branch()}/{branches().length}
                    </text>
                  </box>
                  <Show when={session()?.rootID !== session()?.id}>
                    <box
                      onMouseOver={() => setHover("root")}
                      onMouseOut={() => setHover(null)}
                      onMouseUp={() => command.trigger("session.branch.root")}
                      backgroundColor={hover() === "root" ? theme.backgroundElement : undefined}
                    >
                      <text fg={theme.textMuted}>
                        Root
                      </text>
                    </box>
                  </Show>
                  <box
                    onMouseOver={() => setHover("branch-prev")}
                    onMouseOut={() => setHover(null)}
                    onMouseUp={() => command.trigger("session.branch.previous")}
                    backgroundColor={hover() === "branch-prev" ? theme.backgroundElement : undefined}
                  >
                    <text fg={theme.textMuted}>
                      Prev
                    </text>
                  </box>
                  <box
                    onMouseOver={() => setHover("branch-next")}
                    onMouseOut={() => setHover(null)}
                    onMouseUp={() => command.trigger("session.branch.next")}
                    backgroundColor={hover() === "branch-next" ? theme.backgroundElement : undefined}
                  >
                    <text fg={theme.textMuted}>
                      Next
                    </text>
                  </box>
                </box>
              </Show>
            </box>
          </Match>
        </Switch>
      </box>
    </box>
  )
}

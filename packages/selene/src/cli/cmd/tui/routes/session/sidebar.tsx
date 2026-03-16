import { useSync } from "@tui/context/sync"
import { createMemo, createResource, For, Show, Switch, Match, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import type { AssistantMessage } from "@selene-ai/sdk/v2"
import { Installation } from "@/installation"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { useSDK } from "../../context/sdk"
import { TodoItem } from "../../component/todo-item"
import * as coordfmt from "@tui/util/coordination"
import * as workfmt from "@tui/util/background"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: true,
    todo: true,
    lsp: true,
  })

  // Sort MCP servers alphabetically for consistent display order
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))

  // Count connected and error MCP servers for collapsed header display
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, item]) => item.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, item]) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
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
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const directory = useDirectory()
  const kv = useKV()
  const [coord, { refetch: refetchCoord }] = createResource(
    () => props.sessionID,
    async (id) => (id ? (await sdk.client.session.coordination({ sessionID: id, limit: 8 })).data ?? [] : []),
  )
  const [plan, { refetch: refetchPlan }] = createResource(
    () => session()?.rootID,
    async (id) => (id ? (await sdk.client.session.coordinator({ sessionID: id })).data : undefined),
  )
  const [task, { refetch: refetchTask }] = createResource(
    () => session()?.rootID,
    async (id) =>
      id
        ? (await sdk.client.task.list({ root_session_id: id, limit: 24 })).data ?? []
        : [],
  )
  const [run, { refetch: refetchRun }] = createResource(
    () => session()?.rootID,
    async (id) =>
      id
        ? ((await sdk.client.taskBranch.list({ limit: 48 })).data ?? []).filter((item) => item.rootSessionId === id)
        : [],
  )

  const collab = createMemo(() =>
    coordfmt.merge(coord() ?? [], [
      ...(task() ?? []).map((item) => ({
        kind: "task" as const,
        title: item.description,
        status: item.status,
        time: item.time.updated,
      })),
      ...(run() ?? []).map((item) => ({
        kind: "branch" as const,
        title: item.description,
        status: item.status,
        time: item.updated,
      })),
    ]),
  )
  const openCoord = createMemo(() => coordfmt.open(collab()))
  const recentCoord = createMemo(() => coordfmt.recent(collab()))
  const work = createMemo(() => [
    ...(task() ?? [])
      .filter((item) => item.background)
      .map((item) => ({
        kind: "task" as const,
        title: item.description,
        status: item.status,
        time: item.time.updated,
      })),
    ...(run() ?? [])
      .filter((item) => item.background)
      .map((item) => ({
        kind: "branch" as const,
        title: item.description,
        status: item.status,
        time: item.updated,
      })),
  ])

  const stop = sdk.event.on("session.coordination", (evt) => {
    if (evt.properties.info.root_session_id !== session()?.rootID) return
    void refetchCoord()
    void refetchPlan()
  })
  const stopPlan = sdk.event.on("session.coordinator", (evt) => {
    if (evt.properties.root_session_id !== session()?.rootID) return
    void refetchPlan()
  })
  const stopTask = sdk.event.on("task.updated", (evt) => {
    if (evt.properties.info.rootSessionID !== session()?.rootID) return
    void refetchTask()
    void refetchPlan()
  })
  const stopRun = sdk.event.on("task.branch.updated", (evt) => {
    if (evt.properties.info.rootSessionId !== session()?.rootID) return
    void refetchRun()
    void refetchPlan()
  })
  onCleanup(stop)
  onCleanup(stopPlan)
  onCleanup(stopTask)
  onCleanup(stopRun)

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "selene" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const gettingStartedDismissed = createMemo(() => kv.get("dismissed_getting_started", false))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.background}
        width={42}
        height="100%"
        paddingTop={0}
        paddingBottom={0}
        paddingLeft={2}
        paddingRight={1}
        border={["left"]}
        borderColor={theme.borderSubtle}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={0} paddingRight={1} paddingTop={1}>
            <box paddingBottom={1}>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>
            <text fg={theme.textMuted}>context</text>
            <text fg={theme.textMuted}>
              {context()?.tokens ?? 0} tokens · {context()?.percentage ?? 0}% · {cost()}
            </text>
            <box height={1} />
            <text fg={theme.textMuted}>background</text>
            <Show when={workfmt.active(work()).length > 0 || workfmt.recent(work()).length > 0} fallback={<text fg={theme.textMuted}>none</text>}>
              <text fg={theme.textMuted}>{workfmt.active(work()).length} active · {workfmt.summary(work())}</text>
              <For each={workfmt.recent(work())}>
                {(item) => (
                  <text fg={theme.textMuted} wrapMode="word">
                    {workfmt.line(item)}
                  </text>
                )}
              </For>
            </Show>
            <box height={1} />
            <text fg={theme.textMuted}>coordination</text>
            <Show when={plan()?.plan}>
              <text fg={theme.textMuted} wrapMode="word">{plan()?.summary}</text>
            </Show>
            <Show when={recentCoord().length > 0} fallback={<text fg={theme.textMuted}>{openCoord().length} open · {coordfmt.summary(collab())}</text>}>
              <text fg={theme.textMuted}>{openCoord().length} open · {coordfmt.summary(collab())}</text>
              <For each={recentCoord()}>
                {(item) => (
                  <box flexDirection="column">
                    <text fg={theme.textMuted} wrapMode="word">
                      {coordfmt.line(item)}
                    </text>
                    <text fg={theme.textMuted} wrapMode="word">
                      {item.body}
                    </text>
                  </box>
                )}
              </For>
            </Show>
            <Show when={mcpEntries().length > 0}>
              <box height={1} />
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
              >
                <text fg={theme.textMuted}>
                  mcp
                  <Show when={!expanded.mcp && mcpEntries().length > 2}>
                    <span style={{ fg: theme.textMuted }}> {connectedMcpCount()} active{errorMcpCount() > 0 ? `, ${errorMcpCount()} err` : ""}</span>
                  </Show>
                </text>
                <Show when={mcpEntries().length > 2}>
                  <text fg={theme.textMuted}>{expanded.mcp ? "▾" : "▸"}</text>
                </Show>
              </box>
              <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                <For each={mcpEntries()}>
                  {([key, item]) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: (
                            {
                              connected: theme.success,
                              failed: theme.error,
                              disabled: theme.textMuted,
                              needs_auth: theme.warning,
                              needs_client_registration: theme.error,
                            } as Record<string, typeof theme.success>
                          )[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.textMuted} wrapMode="word">
                        {key}{" "}
                        <Switch fallback={<span style={{ fg: theme.textMuted }}>{item.status}</span>}>
                          <Match when={item.status === "connected"}><span style={{ fg: theme.textMuted }}>ok</span></Match>
                          <Match when={item.status === "failed" && item}>{(val) => <span style={{ fg: theme.textMuted }}><i>{val().error}</i></span>}</Match>
                          <Match when={item.status === "disabled"}><span style={{ fg: theme.textMuted }}>off</span></Match>
                          <Match when={(item.status as string) === "needs_auth"}><span style={{ fg: theme.textMuted }}>auth</span></Match>
                          <Match when={(item.status as string) === "needs_client_registration"}><span style={{ fg: theme.textMuted }}>needs client</span></Match>
                        </Switch>
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </Show>
            <box height={1} />
            <box
              flexDirection="row"
              gap={1}
              onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
            >
              <text fg={theme.textMuted}>
                lsp
                <Show when={!expanded.lsp && sync.data.lsp.length > 2}>
                  <span style={{ fg: theme.textMuted }}> {sync.data.lsp.length} servers</span>
                </Show>
              </text>
              <Show when={sync.data.lsp.length > 2}>
                <text fg={theme.textMuted}>{expanded.lsp ? "▾" : "▸"}</text>
              </Show>
            </box>
            <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
              <Show when={sync.data.lsp.length === 0}>
                <text fg={theme.textMuted}>
                  {sync.data.config.lsp === false
                    ? "disabled in settings"
                    : "activates as files are read"}
                </text>
              </Show>
              <For each={sync.data.lsp}>
                {(item) => (
                  <box flexDirection="row" gap={1}>
                    <text
                      flexShrink={0}
                      style={{
                        fg: {
                          connected: theme.success,
                          error: theme.error,
                        }[item.status],
                      }}
                    >
                      •
                    </text>
                    <text fg={theme.textMuted}>
                      {item.id} {item.root}
                    </text>
                  </box>
                )}
              </For>
            </Show>
            <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
              <box height={1} />
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
              >
                <text fg={theme.textMuted}>todo</text>
                <Show when={todo().length > 2}>
                  <text fg={theme.textMuted}>{expanded.todo ? "▾" : "▸"}</text>
                </Show>
              </box>
              <Show when={todo().length <= 2 || expanded.todo}>
                <For each={todo()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
              </Show>
            </Show>
            <Show when={diff().length > 0}>
              <box height={1} />
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
              >
                <text fg={theme.textMuted}>changes</text>
                <Show when={diff().length > 2}>
                  <text fg={theme.textMuted}>{expanded.diff ? "▾" : "▸"}</text>
                </Show>
              </box>
              <Show when={diff().length <= 2 || expanded.diff}>
                <For each={diff() || []}>
                  {(item) => {
                    return (
                      <box flexDirection="row" gap={1} justifyContent="space-between">
                        <text fg={theme.textMuted} wrapMode="none">
                          {item.file}
                        </text>
                        <box flexDirection="row" gap={1} flexShrink={0}>
                          <Show when={item.additions}>
                            <text fg={theme.diffAdded}>+{item.additions}</text>
                          </Show>
                          <Show when={item.deletions}>
                            <text fg={theme.diffRemoved}>-{item.deletions}</text>
                          </Show>
                        </box>
                      </box>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} paddingTop={1} paddingBottom={1}>
          <Show when={!hasProviders() && !gettingStartedDismissed()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} fg={theme.text}>
                ⬖
              </text>
              <box flexGrow={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Getting started</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                    ✕
                  </text>
                </box>
                <text fg={theme.textMuted}>Selene includes free models so you can start immediately.</text>
                <text fg={theme.textMuted}>
                  Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
                </text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme.text}>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <text fg={theme.textMuted}>{directory()}</text>
          <text fg={theme.textMuted}>{Installation.VERSION}</text>
        </box>
      </box>
    </Show>
  )
}

import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"

const bin = Bun.which("agent-tui")
const live = bin && process.env.OPENCODE_TUI_E2E === "1" ? test : test.skip
const cwd = "/Users/ref/dev/opencode"

function run(cmd: string[], env?: Record<string, string>) {
  const out = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
    },
  })
  const text = new TextDecoder().decode(out.stdout)
  const err = new TextDecoder().decode(out.stderr)
  if (out.exitCode === 0) return text
  throw new Error(err || text || `${cmd[0]} failed: ${out.exitCode}`)
}

function agent(args: string[]) {
  return run(["agent-tui", ...args])
}

async function shot(id: string) {
  return agent(["screenshot", "--strip-ansi", "--session", id])
}

async function wait(id: string, checks: string[]) {
  let last = ""
  for (let i = 0; i < 80; i++) {
    const text = await shot(id)
    last = text
    if (checks.every((item) => text.includes(item))) return text
    await Bun.sleep(250)
  }
  throw new Error(`timed out waiting for ${checks.join(", ")}\n\n${last}`)
}

async function start(dir: string) {
  const out = agent([
    "run",
    "--json",
    "--cols",
    "160",
    "--cwd",
    cwd,
    "bun",
    "run",
    "--cwd",
    "packages/opencode",
    "--conditions=browser",
    "./src/index.ts",
    dir,
  ])
  const row = JSON.parse(out) as { session_id: string }
  await Bun.sleep(2000)
  agent(["wait", "--session", row.session_id, "--stable"])
  return row.session_id
}

async function stop(id: string) {
  agent(["kill", "--session", id])
}

async function tower(id: string) {
  agent(["type", "--session", id, "/tower"])
  await Bun.sleep(300)
  agent(["press", "--session", id, "Enter"])
  await Bun.sleep(700)
  await wait(id, ["Agent Control Tower"])
}

function setup(dir: string, mode: "empty" | "seeded") {
  const code = `
    import { Instance } from "./packages/opencode/src/project/instance"
    import { Session } from "./packages/opencode/src/session"
    import { TaskRun } from "./packages/opencode/src/task/run"
    import { TaskBranch } from "./packages/opencode/src/task/branch"
    import { Identifier } from "./packages/opencode/src/id/id"
    import { Auth } from "./packages/opencode/src/auth"
    import { Database } from "./packages/opencode/src/storage/db"

    const dir = process.env.SELENE_TUI_DIR
    const mode = process.env.SELENE_TUI_MODE
    if (!dir || !mode) throw new Error("missing setup env")

    await Instance.provide({
      directory: dir,
      fn: async () => {
        await Auth.set("openai", { type: "api", key: "test-openai-key" })
        const root = await Session.create({ title: "ambient root" })
        if (mode === "empty") return
        const task = await Session.create({ parentID: root.id, title: "task child" })
        const lane = await Session.create({ parentID: root.id, title: "branch child" })
        await TaskRun.upsert({
          session: task,
          parent: root,
          description: "inspect parser",
          prompt: "inspect parser",
          agent: "build",
          background: true,
          model: { providerID: "openai", modelID: "gpt-5.2" },
        })
        await TaskBranch.create({
          id: Identifier.ascending("tool"),
          sessionId: root.id,
          rootSessionId: root.id,
          projectID: root.projectID,
          directory: dir,
          messageId: Identifier.ascending("message"),
          description: "compare fixes",
          prompt: "compare fixes",
          subagent: "build",
          background: true,
          created: Date.now(),
          status: "running",
          base: { dir, root: dir },
          model: { providerID: "openai", modelID: "gpt-5.2" },
          branches: [{ name: "left", prompt: "left", sessionId: lane.id, status: "running" }],
          winner: null,
          applied: null,
        })
        await Session.coordinationWrite({
          session_id: task.id,
          kind: "request",
          title: "Need review",
          body: "Check parser edge cases.",
        })
      },
    })
    Database.close()
  `
  run(["bun", "--eval", code], {
    SELENE_TUI_DIR: dir,
    SELENE_TUI_MODE: mode,
  })
}

describe("tui ambient", () => {
  live("shows empty coordination state in a real TUI session", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    setup(tmp.path, "empty")

    let tui = ""
    try {
      tui = await start(tmp.path)
      await tower(tui)
      agent(["press", "--session", tui, "Enter"])
      const text = await wait(tui, ["Background work", "Coordination", "0 open", "No coordination yet"])
      expect(text).toContain("Coordination")
      expect(text).toContain("No coordination yet")
    } finally {
      if (tui) await stop(tui)
    }
  })

  live("shows seeded background work and coordination on startup", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    setup(tmp.path, "seeded")

    let tui = ""
    try {
      tui = await start(tmp.path)
      await tower(tui)
      agent(["press", "--session", tui, "Enter"])
      const text = await wait(tui, [
        "Background work",
        "2 active",
        "1 task running · 1 branch run active",
        "inspect parser",
        "compare fixes",
        "Coordination",
        "1 open",
        "1 open coordination item",
        "Need review",
      ])
      expect(text).toContain("Check parser edge cases.")
    } finally {
      if (tui) await stop(tui)
    }
  })
})

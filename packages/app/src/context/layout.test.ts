import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { autoWorkspaces, createSessionKeyReader, ensureSessionKey, pruneSessionKeys, showWorkspaces } from "./layout"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

describe("showWorkspaces", () => {
  test("shows workspaces when enabled", () => {
    expect(
      showWorkspaces({
        project: { worktree: "/root", vcs: "git", sandboxes: ["/root/.wt/a"] },
        directory: "/root",
        enabled: true,
      }),
    ).toBe(true)
  })

  test("shows workspaces for an active sandbox", () => {
    expect(
      showWorkspaces({
        project: { worktree: "/root", vcs: "git", sandboxes: ["/root/.wt/a"] },
        directory: "/root/.wt/a",
        enabled: false,
      }),
    ).toBe(true)
  })

  test("shows workspaces on the root when sandboxes exist", () => {
    expect(
      showWorkspaces({
        project: { worktree: "/root", vcs: "git", sandboxes: ["/root/.wt/a"] },
        directory: "/root",
        enabled: false,
      }),
    ).toBe(true)
  })

  test("keeps workspaces hidden on the root when there are no sandboxes", () => {
    expect(
      showWorkspaces({
        project: { worktree: "/root", vcs: "git", sandboxes: [] },
        directory: "/root",
        enabled: false,
      }),
    ).toBe(false)
  })
})

describe("autoWorkspaces", () => {
  test("enables workspaces for git projects with sandboxes when unset", () => {
    expect(autoWorkspaces({ project: { vcs: "git", sandboxes: ["/root/.wt/a"] } })).toBe(true)
  })

  test("does not override an explicit setting", () => {
    expect(autoWorkspaces({ project: { vcs: "git", sandboxes: ["/root/.wt/a"] }, value: false })).toBe(false)
  })

  test("stays off for projects without sandboxes", () => {
    expect(autoWorkspaces({ project: { vcs: "git", sandboxes: [] } })).toBe(false)
  })
})

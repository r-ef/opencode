import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

describe("session.branch", () => {
  test("creates interactive branches in the same shared family", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const left = await Session.branch({ sessionID: root.id })
        const right = await Session.branch({ sessionID: root.id })
        const child = await Session.create({ parentID: left.id, title: "task" })
        const rows = await Session.branches(left.id)

        expect(root.kind).toBe("interactive")
        expect(root.rootID).toBe(root.id)
        expect(left.kind).toBe("interactive")
        expect(left.parentID).toBeUndefined()
        expect(left.rootID).toBe(root.id)
        expect(left.branchFromSessionID).toBe(root.id)
        expect(right.rootID).toBe(root.id)
        expect(child.kind).toBe("subagent")
        expect(child.parentID).toBe(left.id)
        expect(child.rootID).toBe(root.id)
        expect(new Set(rows.map((item) => item.id))).toEqual(new Set([root.id, left.id, right.id]))
      },
    })
  })

  test("reroots the family when the original branch root is removed", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const branch = await Session.branch({ sessionID: root.id })
        await Session.contextWrite({
          session_id: root.id,
          kind: "task_result",
          title: "root",
          body: "from root",
        })
        const b = await Session.contextWrite({
          session_id: branch.id,
          kind: "task_result",
          title: "branch",
          body: "from branch",
        })

        await Session.remove(root.id)

        const next = await Session.get(branch.id)
        const rows = await Session.contextList({
          session_id: branch.id,
          after: 0,
          limit: 10,
          include_self: true,
        })

        expect(next.rootID).toBe(branch.id)
        expect(rows.map((item) => item.id)).toEqual([b.id])
      },
    })
  })

  test("creates isolated worktrees for interactive branches", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        await Bun.write(path.join(root.directory, "root.txt"), "root\n")

        const branch = await Session.branch({ sessionID: root.id })

        expect(branch.directory).not.toBe(root.directory)
        expect(await Bun.file(path.join(branch.directory, "root.txt")).text()).toBe("root\n")

        await Bun.write(path.join(branch.directory, "branch.txt"), "branch\n")

        expect(await Bun.file(path.join(root.directory, "branch.txt")).exists()).toBe(false)

        await Session.remove(branch.id)
        expect(await Bun.file(branch.directory).exists()).toBe(false)
      },
    })
  })

  test("provides branch-local execution context", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "root" })
        const branch = await Session.branch({ sessionID: root.id })

        const result = await Session.provide({
          sessionID: branch.id,
          fn: async () => {
            await Bun.write(path.join(Instance.directory, "context.txt"), "branch\n")
            return {
              cwd: Instance.directory,
              root: Instance.worktree,
            }
          },
        })

        expect(await fs.realpath(result.cwd)).toBe(await fs.realpath(branch.directory))
        expect(await fs.realpath(result.root)).toBe(await fs.realpath(branch.directory))
        expect(await Bun.file(path.join(branch.directory, "context.txt")).text()).toBe("branch\n")
        expect(await Bun.file(path.join(root.directory, "context.txt")).exists()).toBe(false)
      },
    })
  })
})

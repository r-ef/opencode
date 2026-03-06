import { describe, expect, test } from "bun:test"
import path from "path"
import { ListTool } from "../../src/tool/ls"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.list", () => {
  test("renders nested tree without ripgrep", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "a")
        await Bun.write(path.join(dir, "src", "b.ts"), "b")
        await Bun.write(path.join(dir, "src", "deep", "c.ts"), "c")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const list = await ListTool.init()
        const result = await list.execute({ path: tmp.path }, ctx)
        expect(result.output).toContain(`${tmp.path}/`)
        expect(result.output).toContain("  a.ts")
        expect(result.output).toContain("  src/")
        expect(result.output).toContain("    b.ts")
        expect(result.output).toContain("    deep/")
        expect(result.output).toContain("      c.ts")
      },
    })
  })

  test("respects ignore patterns", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "keep.ts"), "a")
        await Bun.write(path.join(dir, "dist", "skip.js"), "b")
        await Bun.write(path.join(dir, "tmp", "skip.txt"), "c")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const list = await ListTool.init()
        const result = await list.execute({ path: tmp.path }, ctx)
        expect(result.output).toContain("keep.ts")
        expect(result.output).not.toContain("dist/")
        expect(result.output).not.toContain("skip.js")
        expect(result.output).not.toContain("tmp/")
      },
    })
  })
})

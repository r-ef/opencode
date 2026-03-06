import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { GlobTool } from "../../src/tool/glob"
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

describe("tool.glob", () => {
  test("returns newest files first", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const a = path.join(dir, "a.ts")
        const b = path.join(dir, "b.ts")
        await Bun.write(a, "a")
        await Bun.write(b, "b")
        await fs.utimes(a, 1, 1)
        await fs.utimes(b, 2, 2)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "*.ts", path: tmp.path }, ctx)
        const rows = result.output.split("\n").filter(Boolean)
        expect(rows[0]).toBe(path.join(tmp.path, "b.ts"))
        expect(rows[1]).toBe(path.join(tmp.path, "a.ts"))
      },
    })
  })
})

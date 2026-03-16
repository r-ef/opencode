import z from "zod"
import { Tool } from "./tool"
import * as fs from "fs/promises"
import * as path from "path"
import DESCRIPTION from "./ls.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Glob } from "../util/glob"

export const IGNORE_PATTERNS = [
  "node_modules/",
  "__pycache__/",
  ".git/",
  "dist/",
  "build/",
  "target/",
  "vendor/",
  "bin/",
  "obj/",
  ".idea/",
  ".vscode/",
  ".zig-cache/",
  "zig-out",
  ".coverage",
  "coverage/",
  "vendor/",
  "tmp/",
  "temp/",
  ".cache/",
  "cache/",
  "logs/",
  ".venv/",
  "venv/",
  "env/",
]

const LIMIT = 100

type Node = {
  dir: Set<string>
  file: string[]
}

const norm = (input: string) => input.replaceAll("\\", "/")

function skip(patterns: string[], input: string, dir: boolean) {
  const item = dir ? `${input}/` : input
  return patterns.some((pattern) => Glob.match(pattern, item) || (dir && pattern.endsWith("/") && Glob.match(pattern + "*", item)))
}

function node(map: Map<string, Node>, key: string) {
  const hit = map.get(key)
  if (hit) return hit
  const next = { dir: new Set<string>(), file: [] }
  map.set(key, next)
  return next
}

export const ListTool = Tool.define("list", {
  description: DESCRIPTION,
  parameters: z.object({
    path: z.string().describe("The absolute path to the directory to list (must be absolute, not relative)").optional(),
    ignore: z.array(z.string()).describe("List of glob patterns to ignore").optional(),
  }),
  async execute(params, ctx) {
    const search = path.resolve(Instance.directory, params.path || ".")
    await assertExternalDirectory(ctx, search, { kind: "directory" })

    await ctx.ask({
      permission: "list",
      patterns: [search],
      always: ["*"],
      metadata: {
        path: search,
      },
    })

    const patterns = IGNORE_PATTERNS.concat(params.ignore ?? [])
    const tree = new Map<string, Node>()
    let count = 0
    let truncated = false

    const walk = async (dir: string) => {
      if (truncated) return
      const full = dir === "." ? search : path.join(search, dir)
      const rows = await fs.readdir(full, { withFileTypes: true })
      rows.sort((a, b) => a.name.localeCompare(b.name))
      node(tree, dir)

      for (const row of rows) {
        if (truncated) return
        const rel = norm(dir === "." ? row.name : path.join(dir, row.name))

        if (row.isDirectory()) {
          if (skip(patterns, rel, true)) continue
          node(tree, dir).dir.add(row.name)
          await walk(rel)
          continue
        }

        if (row.isSymbolicLink()) {
          const stat = await fs.stat(path.join(full, row.name)).catch(() => undefined)
          if (stat?.isDirectory()) continue
        }

        if (skip(patterns, rel, false)) continue
        count += 1
        if (count > LIMIT) {
          truncated = true
          return
        }
        node(tree, dir).file.push(row.name)
      }
    }

    await walk(".")

    const render = (dir: string, depth: number) => {
      const cur = tree.get(dir)
      if (!cur) return ""
      const pad = "  ".repeat(depth)
      const child = "  ".repeat(depth + 1)
      let out = ""

      if (depth > 0) out += `${pad}${path.basename(dir)}/\n`

      for (const name of [...cur.dir].sort()) {
        out += render(dir === "." ? name : `${dir}/${name}`, depth + 1)
      }

      for (const name of [...cur.file].sort()) {
        out += `${child}${name}\n`
      }

      return out
    }

    const output = `${search}/\n` + render(".", 0)

    return {
      title: path.relative(Instance.worktree, search),
      metadata: {
        count: Math.min(count, LIMIT),
        truncated,
      },
      output,
    }
  },
})

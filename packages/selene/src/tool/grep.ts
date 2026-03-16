import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"
import { Process } from "../util/process"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    let search = params.path ?? Instance.directory
    search = path.isAbsolute(search) ? search : path.resolve(Instance.directory, search)
    await assertExternalDirectory(ctx, search, { kind: "directory" })

    const rg = await Ripgrep.filepath()
    const args = [
      rg,
      "-nH",
      "--hidden",
      "--no-messages",
      "--color=never",
      "--field-match-separator=|",
      "--sortr=modified",
      "--regexp",
      params.pattern,
    ]
    if (params.include) args.push("--glob", params.include)
    args.push(search)

    const proc = Process.spawn(args, {
      stdout: "pipe",
      stderr: "ignore",
      abort: ctx.abort,
    })

    if (!proc.stdout) {
      throw new Error("Process output not available")
    }

    const limit = 100
    let total = 0
    const keep = [] as { path: string; line: number; text: string }[]
    let buf = ""

    for await (const chunk of proc.stdout as AsyncIterable<Buffer | string>) {
      buf += typeof chunk === "string" ? chunk : chunk.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ""

      for (const row of lines) {
        if (!row) continue
        const fileEnd = row.indexOf("|")
        const lineEnd = row.indexOf("|", fileEnd + 1)
        if (fileEnd === -1 || lineEnd === -1) continue

        total += 1
        if (keep.length >= limit) continue

        keep.push({
          path: row.slice(0, fileEnd),
          line: Number.parseInt(row.slice(fileEnd + 1, lineEnd), 10),
          text: row.slice(lineEnd + 1),
        })
      }
    }

    if (buf) {
      const fileEnd = buf.indexOf("|")
      const lineEnd = buf.indexOf("|", fileEnd + 1)
      if (fileEnd !== -1 && lineEnd !== -1) {
        total += 1
        if (keep.length < limit) {
          keep.push({
            path: buf.slice(0, fileEnd),
            line: Number.parseInt(buf.slice(fileEnd + 1, lineEnd), 10),
            text: buf.slice(lineEnd + 1),
          })
        }
      }
    }

    const code = await proc.exited
    if (code === 1 || (code === 2 && total === 0)) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    if (code !== 0 && code !== 2) {
      throw new Error(`ripgrep failed with code ${code}`)
    }

    if (keep.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    const truncated = total > limit
    const out = [`Found ${total} matches${truncated ? ` (showing first ${limit})` : ""}`]

    let file = ""
    for (const item of keep) {
      if (file !== item.path) {
        if (file) out.push("")
        file = item.path
        out.push(`${item.path}:`)
      }
      const text = item.text.length > MAX_LINE_LENGTH ? item.text.substring(0, MAX_LINE_LENGTH) + "..." : item.text
      out.push(`  Line ${item.line}: ${text}`)
    }

    if (truncated) {
      out.push("")
      out.push(
        `(Results truncated: showing ${limit} of ${total} matches (${total - limit} hidden). Consider using a more specific path or pattern.)`,
      )
    }

    if (code === 2) {
      out.push("")
      out.push("(Some paths were inaccessible and skipped)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: total,
        truncated,
      },
      output: out.join("\n"),
    }
  },
})

import { $ } from "bun"
import { platform, release } from "os"
import clipboardy from "clipboardy"
import { lazy } from "../../../../util/lazy.js"
import { tmpdir } from "os"
import path from "path"
import { Filesystem } from "../../../../util/filesystem"
import { Process } from "../../../../util/process"

const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]
const PLAIN_MIME = ["text/plain;charset=utf-8", "text/plain"]

function base64(text: string) {
  return Buffer.from(text).toString("base64")
}

function decode(text?: string) {
  if (!text) return
  return Buffer.from(text, "base64").toString("utf8")
}

function wrap(seq: string) {
  if (!process.env["TMUX"] && !process.env["STY"]) return seq
  return `\x1bPtmux;\x1b${seq}\x1b\\`
}

function write(seq: string): void {
  if (!process.stdout.isTTY) return
  process.stdout.write(wrap(seq))
}

function choose(list: string[]) {
  for (const mime of IMAGE_MIME) {
    if (list.includes(mime)) return mime
  }
  const image = list.find((mime) => mime.startsWith("image/"))
  if (image) return image
  for (const mime of PLAIN_MIME) {
    const found = list.find((item) => item.startsWith(mime))
    if (found) return found
  }
}

function query(
  opts: { mime: string; auth?: string; key?: "pw" | "password"; name?: string },
  send: (seq: string) => void = write,
) {
  const meta = [`type=read`]
  if (opts.auth) meta.push(`${opts.key ?? "pw"}=${opts.auth}`)
  if (opts.name) meta.push(`name=${base64(opts.name)}`)
  send(`\x1b]5522;${meta.join(":")};${base64(opts.mime)}\x1b\\`)
}

function parse(seq: string) {
  const end = seq.endsWith("\x1b\\") ? -2 : seq.endsWith("\x07") ? -1 : 0
  if (!seq.startsWith("\x1b]5522;") || !end) return
  const body = seq.slice(7, end)
  const cut = body.indexOf(";")
  const head = cut === -1 ? body : body.slice(0, cut)
  const data = cut === -1 ? "" : body.slice(cut + 1)
  const meta = new Map(
    head.split(":").map((item) => {
      const cut = item.indexOf("=")
      if (cut === -1) return [item, ""]
      return [item.slice(0, cut), item.slice(cut + 1)]
    }),
  )
  const type = meta.get("type")
  if (!type) return
  return {
    type,
    status: meta.get("status"),
    mime: decode(meta.get("mime")),
    auth: meta.get("pw") ?? meta.get("password"),
    key: meta.has("pw") ? ("pw" as const) : meta.has("password") ? ("password" as const) : undefined,
    data: data || undefined,
  }
}

/**
 * Writes text to clipboard via OSC 52 escape sequence.
 * This allows clipboard operations to work over SSH by having
 * the terminal emulator handle the clipboard locally.
 */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  write(`\x1b]52;c;${base64(text)}\x07`)
}

export namespace Clipboard {
  export interface Content {
    data: string
    mime: string
  }

  export function imageWarning() {
    const remote = !!(process.env["SSH_CONNECTION"] || process.env["SSH_CLIENT"] || process.env["SSH_TTY"])
    if (!remote) return

    const term = process.env["TERM_PROGRAM"]?.toLowerCase()
    const tmux = !!(process.env["TMUX"] || process.env["STY"] || process.env["TERM"]?.includes("tmux"))

    if (term === "ghostty") {
      if (tmux) {
        return "Remote image paste is not available in this Ghostty SSH/tmux session. tmux must allow passthrough and the outer terminal must support MIME clipboard paste. Use an image file path or the web UI instead."
      }
      return "Remote image paste is not available in this Ghostty SSH session. Use an image file path or the web UI instead."
    }

    if (tmux) {
      return "No image data reached the remote TUI. Remote image paste needs terminal MIME clipboard support and tmux passthrough (`set -g allow-passthrough on`). Use an image file path or the web UI instead."
    }

    return "No image data reached the remote TUI. Remote image paste depends on terminal clipboard MIME support. Use an image file path or the web UI instead."
  }

  export function mode(on: boolean) {
    write(`\x1b[?5522${on ? "h" : "l"}`)
  }

  export function handler(opts: { paste: (content: Content) => void; write?: (seq: string) => void }) {
    let state:
      | {
          mode: "list"
          auth?: string
          key?: "pw" | "password"
          list: string[]
        }
      | {
          mode: "data"
          mime: string
          data: string[]
        }
      | undefined

    const send = opts.write ?? write

    return (seq: string) => {
      const pkt = parse(seq)
      if (!pkt || pkt.type !== "read") return false

      if (!state && pkt.status === "OK" && pkt.auth) {
        state = {
          mode: "list",
          auth: pkt.auth,
          key: pkt.key,
          list: [],
        }
        return true
      }

      if (!state) return true

      if (state.mode === "list") {
        if (pkt.status === "DATA" && pkt.mime) {
          state.list.push(pkt.mime)
          return true
        }
        if (pkt.status !== "DONE") {
          if (pkt.status === "ERROR") state = undefined
          return true
        }
        const mime = choose(state.list)
        const auth = state.auth
        const key = state.key
        state = undefined
        if (!mime) return true
        query({ mime, auth, key, name: "Paste event" }, send)
        state = {
          mode: "data",
          mime,
          data: [],
        }
        return true
      }

      if (pkt.status === "DATA" && pkt.data) {
        state.data.push(pkt.data)
        return true
      }
      if (pkt.status === "DONE") {
        opts.paste({
          mime: state.mime,
          data: state.data.join(""),
        })
        state = undefined
        return true
      }
      if (pkt.status === "ERROR") {
        state = undefined
        return true
      }
      return true
    }
  }

  export async function read(): Promise<Content | undefined> {
    const os = platform()

    if (os === "darwin") {
      const tmpfile = path.join(tmpdir(), "opencode-clipboard.png")
      try {
        await $`osascript -e 'set imageData to the clipboard as "PNGf"' -e 'set fileRef to open for access POSIX file "${tmpfile}" with write permission' -e 'set eof fileRef to 0' -e 'write imageData to fileRef' -e 'close access fileRef'`
          .nothrow()
          .quiet()
        const buffer = await Filesystem.readBytes(tmpfile)
        return { data: buffer.toString("base64"), mime: "image/png" }
      } catch {
      } finally {
        await $`rm -f "${tmpfile}"`.nothrow().quiet()
      }
    }

    if (os === "win32" || release().includes("WSL")) {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
      const base64 = await $`powershell.exe -NonInteractive -NoProfile -command "${script}"`.nothrow().text()
      if (base64) {
        const imageBuffer = Buffer.from(base64.trim(), "base64")
        if (imageBuffer.length > 0) {
          return { data: imageBuffer.toString("base64"), mime: "image/png" }
        }
      }
    }

    if (os === "linux") {
      const wayland = await $`wl-paste -t image/png`.nothrow().arrayBuffer()
      if (wayland && wayland.byteLength > 0) {
        return { data: Buffer.from(wayland).toString("base64"), mime: "image/png" }
      }
      const x11 = await $`xclip -selection clipboard -t image/png -o`.nothrow().arrayBuffer()
      if (x11 && x11.byteLength > 0) {
        return { data: Buffer.from(x11).toString("base64"), mime: "image/png" }
      }
    }

    const text = await clipboardy.read().catch(() => {})
    if (text) {
      return { data: text, mime: "text/plain" }
    }
  }

  const getCopyMethod = lazy(() => {
    const os = platform()

    if (os === "darwin" && Bun.which("osascript")) {
      console.log("clipboard: using osascript")
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        await $`osascript -e 'set the clipboard to "${escaped}"'`.nothrow().quiet()
      }
    }

    if (os === "linux") {
      if (process.env["WAYLAND_DISPLAY"] && Bun.which("wl-copy")) {
        console.log("clipboard: using wl-copy")
        return async (text: string) => {
          const proc = Process.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
          if (!proc.stdin) return
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
      if (Bun.which("xclip")) {
        console.log("clipboard: using xclip")
        return async (text: string) => {
          const proc = Process.spawn(["xclip", "-selection", "clipboard"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          if (!proc.stdin) return
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
      if (Bun.which("xsel")) {
        console.log("clipboard: using xsel")
        return async (text: string) => {
          const proc = Process.spawn(["xsel", "--clipboard", "--input"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          if (!proc.stdin) return
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
    }

    if (os === "win32") {
      console.log("clipboard: using powershell")
      return async (text: string) => {
        // Pipe via stdin to avoid PowerShell string interpolation ($env:FOO, $(), etc.)
        const proc = Process.spawn(
          [
            "powershell.exe",
            "-NonInteractive",
            "-NoProfile",
            "-Command",
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
          ],
          {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          },
        )

        if (!proc.stdin) return
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }

    console.log("clipboard: no native support")
    return async (text: string) => {
      await clipboardy.write(text).catch(() => {})
    }
  })

  export async function copy(text: string): Promise<void> {
    writeOsc52(text)
    await getCopyMethod()(text)
  }
}

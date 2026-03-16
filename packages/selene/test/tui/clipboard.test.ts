import { describe, expect, test } from "bun:test"
import { Clipboard } from "../../src/cli/cmd/tui/util/clipboard"

function base64(text: string) {
  return Buffer.from(text).toString("base64")
}

function pkt(meta: string, data?: string) {
  return `\x1b]5522;${meta}${data ? `;${data}` : ""}\x1b\\`
}

describe("tui clipboard", () => {
  test("warns for ghostty remote image paste", () => {
    const env = {
      TERM_PROGRAM: process.env["TERM_PROGRAM"],
      SSH_CONNECTION: process.env["SSH_CONNECTION"],
      TMUX: process.env["TMUX"],
    }
    try {
      process.env["TERM_PROGRAM"] = "ghostty"
      process.env["SSH_CONNECTION"] = "1"
      process.env["TMUX"] = "1"

      expect(Clipboard.imageWarning()).toContain("Ghostty SSH/tmux session")
    } finally {
      if (env.TERM_PROGRAM === undefined) delete process.env["TERM_PROGRAM"]
      else process.env["TERM_PROGRAM"] = env.TERM_PROGRAM
      if (env.SSH_CONNECTION === undefined) delete process.env["SSH_CONNECTION"]
      else process.env["SSH_CONNECTION"] = env.SSH_CONNECTION
      if (env.TMUX === undefined) delete process.env["TMUX"]
      else process.env["TMUX"] = env.TMUX
    }
  })

  test("requests the preferred image mime from a paste notice", () => {
    const sent: string[] = []
    const got: Clipboard.Content[] = []
    const handle = Clipboard.handler({
      write(seq) {
        sent.push(seq)
      },
      paste(content) {
        got.push(content)
      },
    })

    handle(pkt("type=read:status=OK:pw=secret"))
    handle(pkt(`type=read:status=DATA:mime=${base64("text/plain;charset=utf-8")}`))
    handle(pkt(`type=read:status=DATA:mime=${base64("image/png")}`))
    handle(pkt("type=read:status=DONE"))

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("type=read:pw=secret")
    expect(sent[0]).toContain(base64("image/png"))
    expect(got).toEqual([])
  })

  test("echoes password auth when the terminal uses that key", () => {
    const sent: string[] = []
    const handle = Clipboard.handler({
      write(seq) {
        sent.push(seq)
      },
      paste() {},
    })

    handle(pkt("type=read:status=OK:password=secret"))
    handle(pkt(`type=read:status=DATA:mime=${base64("image/png")}`))
    handle(pkt("type=read:status=DONE"))

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("type=read:password=secret")
    expect(sent[0]).toContain(base64("image/png"))
  })

  test("emits image data after the follow-up read completes", () => {
    const sent: string[] = []
    const got: Clipboard.Content[] = []
    const handle = Clipboard.handler({
      write(seq) {
        sent.push(seq)
      },
      paste(content) {
        got.push(content)
      },
    })

    handle(pkt("type=read:status=OK:pw=secret"))
    handle(pkt(`type=read:status=DATA:mime=${base64("image/png")}`))
    handle(pkt("type=read:status=DONE"))
    handle(pkt("type=read:status=OK"))
    handle(pkt(`type=read:status=DATA:mime=${base64("image/png")}`, "YWJj"))
    handle(pkt("type=read:status=DATA", "MTIz"))
    handle(pkt("type=read:status=DONE"))

    expect(sent).toHaveLength(1)
    expect(got).toEqual([
      {
        mime: "image/png",
        data: "YWJjMTIz",
      },
    ])
  })

  test("falls back to plain text when no image mime is offered", () => {
    const got: Clipboard.Content[] = []
    const handle = Clipboard.handler({
      write() {},
      paste(content) {
        got.push(content)
      },
    })

    handle(pkt("type=read:status=OK:pw=secret"))
    handle(pkt(`type=read:status=DATA:mime=${base64("text/plain;charset=utf-8")}`))
    handle(pkt("type=read:status=DONE"))
    handle(pkt("type=read:status=OK"))
    handle(pkt(`type=read:status=DATA:mime=${base64("text/plain;charset=utf-8")}`, base64("hello")))
    handle(pkt("type=read:status=DONE"))

    expect(got).toEqual([
      {
        mime: "text/plain;charset=utf-8",
        data: base64("hello"),
      },
    ])
  })
})

import { describe, expect, test } from "bun:test"
import { allowed, basic, remember, unauthorized } from "../../src/server/auth"

describe("server auth", () => {
  test("accepts a basic auth header", () => {
    const req = new Request("http://localhost:4096/session", {
      headers: {
        Authorization: basic("opencode", "secret"),
      },
    })

    expect(allowed(req, "opencode", "secret")).toBe(basic("opencode", "secret"))
  })

  test("accepts websocket auth from the query string", () => {
    const req = new Request(`http://localhost:4096/pty/pty_123/connect?authorization=${encodeURIComponent(basic("opencode", "secret"))}`, {
      headers: {
        Upgrade: "websocket",
      },
    })

    expect(allowed(req, "opencode", "secret")).toBe(basic("opencode", "secret"))
  })

  test("rejects websocket auth without the query token", () => {
    const req = new Request("http://localhost:4096/pty/pty_123/connect", {
      headers: {
        Upgrade: "websocket",
      },
    })

    expect(allowed(req, "opencode", "secret")).toBeUndefined()
  })

  test("accepts auth from the cookie", () => {
    const req = new Request("http://localhost:4096/pty", {
      headers: {
        Cookie: remember(new Request("http://localhost:4096"), basic("opencode", "secret")),
      },
    })

    expect(allowed(req, "opencode", "secret")).toBe(basic("opencode", "secret"))
  })

  test("returns a basic auth challenge", () => {
    const res = unauthorized()

    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic")
  })

  test("does not challenge websocket requests", () => {
    const res = unauthorized(
      new Request("http://localhost:4096/pty/pty_123/connect", {
        headers: {
          Upgrade: "websocket",
        },
      }),
    )

    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toBeNull()
  })

  test("writes a secure cookie on https", () => {
    const cookie = remember(new Request("https://example.com"), basic("opencode", "secret"))

    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Secure")
  })
})

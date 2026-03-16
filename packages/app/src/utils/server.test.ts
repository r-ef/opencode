import { describe, expect, test } from "bun:test"
import { getBasicAuth, sanitizeServer, setSocketAuth } from "./server"

describe("getBasicAuth", () => {
  test("builds a default basic auth header", () => {
    expect(
      getBasicAuth({
        url: "http://localhost:4096",
        password: "secret",
      }),
    ).toBe("Basic b3BlbmNvZGU6c2VjcmV0")
  })

  test("returns undefined without a password", () => {
    expect(
      getBasicAuth({
        url: "http://localhost:4096",
      }),
    ).toBeUndefined()
  })
})

describe("setSocketAuth", () => {
  test("adds websocket auth to the query string", () => {
    const url = new URL("ws://selene@localhost:4096/pty/pty_123/connect")
    setSocketAuth(url, {
      url: "http://localhost:4096",
      username: "sam",
      password: "secret",
    })

    expect(url.username).toBe("")
    expect(url.password).toBe("")
    expect(url.searchParams.get("authorization")).toBe("Basic c2FtOnNlY3JldA==")
  })
})

describe("sanitizeServer", () => {
  test("extracts embedded credentials from the url", () => {
    expect(
      sanitizeServer({
        url: "http://selene:secret@100.72.18.21:5000",
      }),
    ).toEqual({
      url: "http://100.72.18.21:5000",
      username: "selene",
      password: "secret",
    })
  })
})

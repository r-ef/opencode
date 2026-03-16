const COOKIE = "selene-auth"

export function basic(user: string, pass: string) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`
}

function cookie(req: Request, name: string) {
  const raw = req.headers.get("cookie")
  if (!raw) return
  for (const item of raw.split(/;\s*/)) {
    const index = item.indexOf("=")
    if (index === -1) continue
    if (item.slice(0, index) !== name) continue
    return decodeURIComponent(item.slice(index + 1))
  }
}

export function allowed(req: Request, user: string, pass: string) {
  const auth = basic(user, pass)
  if (req.headers.get("authorization") === auth) return auth
  if (cookie(req, COOKIE) === auth) return auth
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return
  if (new URL(req.url).searchParams.get("authorization") === auth) return auth
}

export function remember(req: Request, auth: string) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(auth)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ]
  if (new URL(req.url).protocol === "https:") {
    parts.push("Secure")
  }
  return parts.join("; ")
}

export function unauthorized(req?: Request) {
  const headers = new Headers()
  if (req?.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    headers.set("WWW-Authenticate", 'Basic realm="Secure Area"')
  }
  return new Response("Unauthorized", {
    status: 401,
    headers,
  })
}

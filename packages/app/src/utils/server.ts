import { createSeleneClient } from "@selene-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { normalizeServerUrl } from "@/context/server"

export function sanitizeServer(server: ServerConnection.HttpBase): ServerConnection.HttpBase {
  const url = URL.canParse(server.url) ? new URL(server.url) : undefined
  const next = normalizeServerUrl(server.url) ?? server.url
  const user = server.username || url?.username || undefined
  const pass = server.password || url?.password || undefined
  return {
    url: next,
    username: user,
    password: pass,
  }
}

export function getBasicAuth(server: ServerConnection.HttpBase) {
  const next = sanitizeServer(server)
  if (!next.password) return
  return `Basic ${btoa(`${next.username ?? "selene"}:${next.password}`)}`
}

export function setSocketAuth(url: URL, server?: ServerConnection.HttpBase) {
  url.username = ""
  url.password = ""
  if (!server) return url
  const auth = getBasicAuth(server)
  if (!auth) return url
  url.searchParams.set("authorization", auth)
  return url
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createSeleneClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const next = sanitizeServer(server)
  const auth = getBasicAuth(next)

  return createSeleneClient({
    ...config,
    headers: { ...config.headers, ...(auth ? { Authorization: auth } : {}) },
    baseUrl: next.url,
  })
}

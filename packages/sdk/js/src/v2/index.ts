export * from "./client.js"
export * from "./server.js"

import { createSeleneClient } from "./client.js"
import { createSeleneServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createSelene(options?: ServerOptions) {
  const server = await createSeleneServer({
    ...options,
  })

  const client = createSeleneClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}

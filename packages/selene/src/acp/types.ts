import type { McpServer } from "@agentclientprotocol/sdk"
import type { SeleneClient } from "@selene-ai/sdk/v2"

export interface ACPSessionState {
  id: string
  cwd: string
  mcpServers: McpServer[]
  createdAt: Date
  model?: {
    providerID: string
    modelID: string
  }
  variant?: string
  modeId?: string
}

export interface ACPConfig {
  sdk: SeleneClient
  defaultModel?: {
    providerID: string
    modelID: string
  }
}

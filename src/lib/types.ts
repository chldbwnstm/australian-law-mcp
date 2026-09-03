/**
 * MCP tool type definitions.
 *
 * Source-specific response shapes (legislation records, judgments, …) belong
 * with the client that produces them. Only the tool contract lives here.
 */

import { z } from "zod"

/**
 * MCP tool response
 */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/** Loose shape a tool handler may return (allows `{ type: string }`). */
export interface LooseToolResponse {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * MCP tool definition.
 *
 * `TClient` is the upstream API client handed to every handler. The core
 * library is source-agnostic, so the concrete client type is supplied by the
 * layer that registers the tool (`McpTool<AustralianLawApiClient>`).
 */
export interface McpTool<TClient = any> {
  /** Tool name (snake_case) */
  name: string
  /** Tool description */
  description: string
  /** Zod input schema */
  schema: z.ZodSchema
  /** Handler (input is guaranteed by Zod at runtime; each tool narrows it internally) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (apiClient: TClient, input: any) => Promise<LooseToolResponse>
}

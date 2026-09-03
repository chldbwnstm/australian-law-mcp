/**
 * Unified error handling.
 */

import type { ToolResponse } from "./types.js"
import { maskSensitiveUrl } from "./fetch-with-retry.js"
import { UpstreamRecordMissingError } from "./upstream-miss.js"

/**
 * Error codes
 */
export const ErrorCodes = {
  NOT_FOUND: "LAW_NOT_FOUND",
  /**
   * An **observation** that the upstream did not hand over the record. It is
   * not a claim of absence. Keep it strictly apart from the `NOT_FOUND`
   * family — for a machine reader the bracket label beats any hedging prose,
   * and if this path's label reads as "absent" it becomes a false negative
   * that advises a real case out of existence.
   */
  UPSTREAM_NO_DATA: "UPSTREAM_NO_DATA",
  /**
   * A schedule/annex was located but no text could be extracted because the
   * body is not inline in the record. Bracket labels are a contract with
   * machine readers, so they are never built ad hoc — a label created outside
   * this constant leaves consumers unable to tell which set it belongs to.
   */
  ANNEX_BODY_UNAVAILABLE: "ANNEX_BODY_UNAVAILABLE",
  INVALID_PARAM: "INVALID_PARAMETER",
  API_ERROR: "EXTERNAL_API_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "REQUEST_TIMEOUT",
  PARSE_ERROR: "PARSE_ERROR",
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

/**
 * Upstream law API error
 */
export class LawApiError extends Error {
  code: ErrorCode
  suggestions: string[]

  constructor(message: string, code: ErrorCode, suggestions: string[] = []) {
    super(message)
    this.name = "LawApiError"
    this.code = code
    this.suggestions = suggestions
  }

  format(): string {
    let result = `[ERROR] ${this.message}`
    if (this.suggestions.length > 0) {
      result += "\nSuggestions:"
      this.suggestions.forEach((s, i) => {
        result += `\n  ${i + 1}. ${s}`
      })
    }
    return result
  }
}

/**
 * Hint for an empty search result.
 * Upstream search APIs commonly treat whitespace-separated keywords as an AND
 * condition, so more keywords easily drives the result count to zero.
 *
 * The `[NOT_FOUND]` prefix lets an LLM detect the failure mechanically instead
 * of hallucinating a plausible answer.
 */
export function noResultHint(query: string, label?: string): ToolResponse {
  const prefix = label ? `${label} ` : ""
  const keywords = query.trim().split(/\s+/)
  const lines = [`[NOT_FOUND] ${prefix}No search results for '${query}'.`]
  lines.push("")
  lines.push("⚠️ This tool found no actual data. Do not guess or invent results. Report the search failure to the user and try the suggestions below first.")

  if (keywords.length >= 2) {
    lines.push("")
    lines.push("Hint: the upstream search API treats whitespace-separated keywords as an AND condition, so more keywords means fewer results.")
    lines.push(`Retry suggestion: "${keywords[0]}" or "${keywords.slice(0, 2).join(" ")}"`)
  } else {
    lines.push("Retry with a different keyword.")
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  }
}

/**
 * Explicit "no data" response.
 * `noResultHint` is for failed searches; use this when a specific resource
 * (a section, a schedule, a file) is missing.
 */
export function notFoundResponse(message: string, suggestions?: string[]): ToolResponse {
  const lines = [`[NOT_FOUND] ${message}`]
  lines.push("")
  lines.push("⚠️ This tool could not find the requested data. Do not generate an answer of your own. Tell the user explicitly that the data was not available.")
  if (suggestions && suggestions.length > 0) {
    lines.push("")
    lines.push("Retry suggestions:")
    suggestions.forEach((s) => lines.push(`  - ${s}`))
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  }
}

/**
 * Build a structured tool error response.
 *
 * Output format:
 *   [ERROR_CODE] message
 *   Tool: <toolName>
 *   Suggestions: ...
 */
export function formatToolError(error: unknown, context?: string): ToolResponse {
  let code: string
  let msg: string
  let suggestions: string[]

  if (error instanceof LawApiError) {
    code = error.code || ErrorCodes.API_ERROR
    msg = error.message
    suggestions = error.suggestions || []
  } else if (error instanceof UpstreamRecordMissingError) {
    // The label carries only the observed fact. Both directions of accident —
    // inventing what is absent and declaring absent what exists — are banned
    // side by side, and two indistinguishable causes are not ranked.
    code = ErrorCodes.UPSTREAM_NO_DATA
    msg = error.message
    suggestions = [
      "⚠️ This response does not prove the record is absent. Report it to the user as a lookup failure; do not state that no such legislation or case law is on record.",
      "⚠️ No data was received. Do not guess or invent the contents.",
      // A notice page (kind === "html") has one extra cause that retrying never
      // fixes — the API for that key was never registered or approved. The
      // module knows three values; flattening to two at the surface leaves only
      // "retry shortly", and that case never gets better.
      error.kind === "html"
        ? "The cause is one of three and this response alone does not distinguish them — (a) there genuinely is no record for this ID, (b) upstream maintenance or overload, (c) this API key is not registered/approved for this endpoint."
        : "The cause is one of two and this response alone does not distinguish them — (a) there genuinely is no record for this ID, (b) upstream maintenance or overload returned an empty body.",
      error.kind === "html"
        ? "If a retry shortly gives the same result, check this key's registration and approval status with the upstream provider — (c) will not be fixed by retrying. Re-confirm the ID from search_* results (never invent one)."
        : "Retry shortly, and if the result is unchanged re-confirm the ID from search_* results (never invent one).",
    ]
  } else if (error instanceof Error) {
    // Detect Zod validation errors
    if (error.name === "ZodError" && Array.isArray((error as any).issues)) {
      code = ErrorCodes.INVALID_PARAM
      msg = (error as any).issues
        .map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
      suggestions = ["Check the parameter formats and required values."]
    } else {
      code = ErrorCodes.API_ERROR
      msg = error.message
      suggestions = []
    }
  } else {
    code = ErrorCodes.API_ERROR
    msg = String(error)
    suggestions = []
  }

  const lines: string[] = []
  // Last line of defence — even if tool code builds an error containing a URL
  // itself, no API key reaches the client.
  lines.push(`[${code}] ${maskSensitiveUrl(msg)}`)

  if (context) {
    lines.push(`Tool: ${context}`)
  }

  if (suggestions.length > 0) {
    lines.push("Suggestions:")
    suggestions.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s}`)
    })
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  }
}

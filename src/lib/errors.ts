/**
 * Unified error handling.
 */

import type { ToolResponse } from "./types.js"
import { maskSensitiveUrl } from "./fetch-with-retry.js"
import { UpstreamRecordMissingError } from "./upstream-miss.js"
import { followupEnvelope, makeGap, type ResearchGap } from "./research-followup.js"

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
   * The source exists and is known, but this server refuses to fetch it —
   * AustLII, LawCite, judgments.fedcourt.gov.au, the NSW/SA legislation
   * registers, ACCC and the Competition Tribunal all sit behind anti-bot
   * gates or ask not to be crawled.
   *
   * Kept strictly apart from `NOT_FOUND` *and* from `UPSTREAM_NO_DATA`: the
   * first would claim absence, the second would suggest retrying. Neither is
   * true here. The honest answer is "we did not look, here is the link" — so
   * this label always travels with deep links from `external-links-map.ts`.
   */
  UPSTREAM_BLOCKED: "UPSTREAM_BLOCKED",
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
 * A host on the blocked list was requested.
 *
 * Thrown *before* any network call, so it can never be confused with a
 * failed one. The message never says the record is absent — it says this
 * server did not look, and points at where a human can.
 */
export class UpstreamBlockedError extends Error {
  /** The `HostKey` that was refused (kept as a string so `errors.ts` stays host-table-agnostic). */
  readonly host: string
  /** Human-usable deep links for the same material. */
  readonly links: string[]

  constructor(host: string, reason: string, links: string[] = []) {
    super(
      `${host} is not fetched by this server (${reason}). ` +
      `This is a refusal to request, not an observation about the record — ` +
      `nothing here says the material is absent.`
    )
    this.name = "UpstreamBlockedError"
    this.host = host
    this.links = links
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
  } else if (error instanceof UpstreamBlockedError) {
    code = ErrorCodes.UPSTREAM_BLOCKED
    msg = error.message
    suggestions = [
      "⚠️ Do not report this as 'no such case/legislation'. The source was never queried, so this response carries no evidence either way.",
      ...error.links.map((link) => `Open directly: ${link}`),
    ]
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

  const gap = gapForError(error, context ?? "unknown_tool", code, msg)
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
    ...(gap ? { structuredContent: { followup: followupEnvelope([gap], { pending: true }) } } : {}),
  }
}

/** Build gaps from typed failure branches, never by scraping rendered error prose. */
function gapForError(error: unknown, originTool: string, code: string, reason: string): ResearchGap | undefined {
  let kind: ResearchGap["kind"] | undefined
  let sourceUrls: string[] = []
  let sourceAccess: ResearchGap["sourceAccess"] = "unknown"
  let target: ResearchGap["target"] = {}

  if (error instanceof UpstreamBlockedError) {
    kind = "source_access"
    sourceUrls = error.links.filter((link) => /^https?:\/\//i.test(link)).slice(0, 20)
    sourceAccess = "requires_access"
    target = { documentId: error.host }
  } else if (error instanceof UpstreamRecordMissingError) {
    kind = "document_body"
  } else if (error instanceof LawApiError) {
    if (error.code === ErrorCodes.ANNEX_BODY_UNAVAILABLE) kind = "document_body"
    else if (error.code === ErrorCodes.TIMEOUT || error.code === ErrorCodes.RATE_LIMITED) kind = "budget"
    else if (error.code === ErrorCodes.UPSTREAM_NO_DATA || error.code === ErrorCodes.API_ERROR || error.code === ErrorCodes.PARSE_ERROR) kind = "source_access"
  }
  if (!kind) return undefined
  return makeGap({
    kind,
    originTool,
    originalErrorCode: code,
    target,
    reason,
    sourceUrls,
    sourceAccess,
    evidenceNeeded: kind === "document_body"
      ? ["The original document body", "An exact relevant passage with paragraph or page locator"]
      : ["The requested original source record", "Observed identity and relevant passage"],
  })
}

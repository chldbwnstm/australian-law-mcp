/**
 * Turning `SourceSearchResult` / `SourceDocument` into the text an LLM caller
 * reads. One renderer for every decision domain, because the alternative — each
 * tool printing its own layout — is how a caller ends up unable to tell which
 * field is the identifier it must pass to the `get_` tool.
 *
 * Two conventions the whole domain set relies on:
 *
 *  - **Every hit prints the exact identifier the matching `get_` call takes**,
 *    labelled `id:`. Nothing else in the block is an identifier.
 *  - **A count is never printed bare when the upstream's count is unreliable.**
 *    Three of these sources report facet-wide or capped totals; printing
 *    "186,201 results" for a query that returned 25 rows teaches the caller a
 *    false fact about the corpus.
 */

import { compactBody } from "../decision-compact.js"
import { truncateResponse } from "../schemas.js"
import type { SourceDocument, SourceHit, SourceSearchResult } from "./types.js"

export interface RenderSearchOptions {
  /** Domain/tool heading, e.g. `Fair Work Commission decisions`. */
  heading: string
  /** The query as the user typed it, for the heading and the empty-result hint. */
  query?: string
  /** How to fetch one of these, e.g. `get_decision_text(domain="workplace", id="…")`. */
  followUp?: string
  /** Extra lines printed under the heading (limitations, blocked companions). */
  notes?: string[]
  /** Print the source label on each hit (used when several sources are merged). */
  showSource?: boolean
}

function formatCount(result: SourceSearchResult): string {
  const shown = result.hits.length
  if (result.total === undefined) return `${shown} result${shown === 1 ? "" : "s"} returned`
  if (result.totalIsUnreliable) {
    return `${shown} result${shown === 1 ? "" : "s"} returned (upstream reports ${result.total.toLocaleString()} — see the note below)`
  }
  return `${shown} of ${result.total.toLocaleString()} result${result.total === 1 ? "" : "s"}`
}

export function renderHit(hit: SourceHit, index: number, showSource: boolean): string {
  const lines: string[] = []
  const citation = hit.citation ? ` ${hit.citation}` : ""
  lines.push(`${index}. ${hit.title}${citation}`)
  lines.push(`   id: ${hit.id}${showSource ? `  ·  source: ${hit.source}` : ""}`)
  if (hit.court) lines.push(`   court: ${hit.court}`)
  if (hit.date) lines.push(`   date: ${hit.date}`)
  if (hit.catchwords) lines.push(`   catchwords: ${clip(hit.catchwords, 400)}`)
  if (hit.snippet) lines.push(`   summary: ${clip(hit.snippet, 400)}`)
  for (const [label, value] of hit.extra ?? []) lines.push(`   ${label}: ${clip(value, 300)}`)
  lines.push(`   url: ${hit.url}`)
  return lines.join("\n")
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

export function renderSearch(result: SourceSearchResult, options: RenderSearchOptions): string {
  const lines: string[] = []
  const query = options.query ? ` — "${options.query}"` : ""
  lines.push(`${options.heading}${query}`)
  lines.push(formatCount(result))
  if (result.page !== undefined) lines.push(`page: ${result.page}`)
  if (result.totalNote) lines.push(`note: ${result.totalNote}`)
  for (const note of options.notes ?? []) lines.push(`note: ${note}`)
  lines.push("")

  if (result.hits.length === 0) {
    lines.push(
      "No rows came back from this source for that query. That is a search result, not proof of " +
      "absence — do not tell the user the decision does not exist. Try fewer or broader keywords, " +
      "or widen the date/court filters.",
    )
    lines.push(`Browse the source directly: ${result.sourceUrl}`)
    return truncateResponse(lines.join("\n"))
  }

  result.hits.forEach((hit, index) => {
    lines.push(renderHit(hit, index + 1, options.showSource ?? false))
    lines.push("")
  })
  if (options.followUp) lines.push(`Full text: ${options.followUp}`)
  lines.push(`Source listing: ${result.sourceUrl}`)
  return truncateResponse(lines.join("\n"))
}

export interface RenderDocumentOptions {
  /** Section header used for the body — must be one `compactLongSections` knows. */
  bodyHeading?: string
  notes?: string[]
  /**
   * `false` (or omitted) shortens a long body from the middle with the gap
   * marked; `true` returns it verbatim. Shortening happens here rather than in
   * each tool so a judgment fetched directly and the same judgment fetched
   * through `get_decision_text` come back identical.
   */
  full?: boolean
}

export function renderDocument(document: SourceDocument, options: RenderDocumentOptions = {}): string {
  const lines: string[] = []
  lines.push(`=== ${document.title} ===`)
  if (document.citation) lines.push(`Citation: ${document.citation}`)
  lines.push(`Source: ${document.url}`)
  lines.push("")

  if (document.metadata.length > 0) {
    for (const [label, value] of document.metadata) lines.push(`${label}: ${value}`)
    lines.push("")
  }

  if (document.documents && document.documents.length > 0) {
    lines.push("Documents:")
    for (const entry of document.documents) lines.push(`  - ${entry.label}: ${entry.url}`)
    lines.push("")
  }

  for (const note of [...(options.notes ?? []), ...(document.note ? [document.note] : [])]) {
    lines.push(`Note: ${note}`)
  }
  if (options.notes?.length || document.note) lines.push("")

  if (document.text.trim()) {
    lines.push(`${options.bodyHeading ?? "Full text"}:`)
    lines.push(compactBody(document.text, { full: options.full === true }))
  }
  return truncateResponse(lines.join("\n"))
}

/**
 * Merge several sources' hits into one numbered list, keeping each source's own
 * ordering interleaved rather than concatenated — a caller that reads only the
 * first five hits should see more than one source's view of the question.
 */
export function interleave(results: SourceSearchResult[]): SourceHit[] {
  const merged: SourceHit[] = []
  const maxLength = Math.max(0, ...results.map((result) => result.hits.length))
  for (let index = 0; index < maxLength; index++) {
    for (const result of results) {
      const hit = result.hits[index]
      if (hit) merged.push(hit)
    }
  }
  return merged
}

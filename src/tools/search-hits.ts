/**
 * Reading a rendered search result back into hits.
 *
 * The reference server's `search-hits.ts` adapts *upstream XML* into display
 * strings, because there the API answers in one shape and the tool prints
 * another. Here the direction is reversed: every Australian search tool already
 * renders through `lib/sources/render.ts` (or `statute-helpers/format.ts`), and
 * the pieces that want to chain off a search — `search-detail-chain`, the
 * chains, the CLI — have the rendered text and need the identifiers back.
 *
 * So this module owns the one convention those renderers guarantee, in one
 * place: **the identifier a follow-up call takes is the value on the `id:` line,
 * and nothing else in the block is an identifier.** Two renderers put different
 * things after it —
 *
 *     id: C2004A00109 | Act | InForce | principal | No 51 of 1974   (statutes)
 *     id: nsw:5f2c…  ·  source: nswCaselaw                          (decisions)
 *     id: [2026] AICmr 40                                           (privacy)
 *
 * — and an id may itself contain spaces (`TR 2024/1`, `[2026] AICmr 40`), so
 * splitting on whitespace is wrong. The separators are what terminate the id.
 */

/**
 * The `id:` line, with the two known trailing decorations as terminators:
 * ` | ` (statute facts) and the two-space `·` (source label). Everything else
 * runs to end of line, spaces included.
 */
export const ID_LINE = /^[ \t]*id:[ \t]*(.+?)(?:[ \t]+\|[ \t]|[ \t]{2}·|[ \t]*$)/

/** Compilation lines print `registerId:` instead — `formatVersionLine`. */
export const REGISTER_ID_LINE = /^[ \t]*[•\d.]*[ \t]*.*?registerId:[ \t]*([A-Za-z0-9]+)/

export interface RenderedHit {
  /** The identifier to pass to the matching `get_*` tool. */
  id: string
  /** The numbered title line above it, when there was one. */
  title?: string
}

/** Add the `g` flag without mutating the caller's regex (`lastIndex` is shared state). */
export function globalise(regex: RegExp): RegExp {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`
  return new RegExp(regex.source, flags)
}

/**
 * Every id in a rendered result, in order, de-duplicated.
 *
 * `limit` is applied after de-duplication so a source that repeats its top hit
 * across pages cannot consume the caller's whole allowance with one record.
 */
export function extractHitIds(text: string, pattern: RegExp = ID_LINE, limit?: number): string[] {
  if (!text.trim()) return []
  const regex = globalise(new RegExp(pattern.source, pattern.flags.includes("m") ? pattern.flags : `${pattern.flags}m`))
  const seen = new Set<string>()
  const ids: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const id = match[1]?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (limit !== undefined && ids.length >= limit) break
    // A zero-length match would spin forever; `.+?` cannot produce one, but the
    // pattern is caller-supplied.
    if (match[0].length === 0) regex.lastIndex += 1
  }
  return ids
}

/**
 * Ids with the numbered heading that introduced them.
 *
 * The heading is what makes a chain's summary readable — "1. Smith v Jones
 * [2020] HCA 41" says far more than `hca:smith-v-jones`. It is optional
 * because not every renderer numbers its blocks.
 */
export function extractHits(text: string, pattern: RegExp = ID_LINE, limit?: number): RenderedHit[] {
  const lines = text.split("\n")
  const single = new RegExp(pattern.source, pattern.flags.replace("g", ""))
  const seen = new Set<string>()
  const hits: RenderedHit[] = []

  for (let index = 0; index < lines.length; index++) {
    const match = single.exec(lines[index])
    const id = match?.[1]?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const heading = findHeading(lines, index)
    hits.push(heading ? { id, title: heading } : { id })
    if (limit !== undefined && hits.length >= limit) break
  }
  return hits
}

/** The nearest `N. Title` line above `from`, within a couple of lines. */
function findHeading(lines: string[], from: number): string | undefined {
  for (let index = from - 1; index >= 0 && index >= from - 3; index--) {
    const heading = /^\s*\d+\.\s+(.*\S)\s*$/.exec(lines[index])
    if (heading) return heading[1]
  }
  return undefined
}

/**
 * Did a rendered result actually contain hits?
 *
 * Deliberately *not* "is the text non-empty": `renderSearch` prints a full
 * paragraph when a source returns nothing, and that paragraph says in so many
 * words that it is not proof of absence. Treating it as content is how a chain
 * ends up presenting "no rows came back" as a finding.
 */
export function hasHits(text: string): boolean {
  return extractHitIds(text, ID_LINE, 1).length > 0
}

/**
 * Table-of-contents helpers: one cached NCX fetch per (title, date), plus the
 * subtree/tree operations every structural tool needs.
 *
 * The caching matters more than it looks. A compiled Act's NCX is 800 KB for
 * the CCA and every provision fetch needs it, so `get_batch_provisions` over
 * 30 sections of one Act must not pull it 30 times. Keyed by title **and**
 * date because a point-in-time TOC is a different document.
 */

import type { AuApiClient } from "../../lib/api-client.js"
import { ARTICLE_CACHE_TTL, lawCache } from "../../lib/cache.js"
import { ErrorCodes, LawApiError } from "../../lib/errors.js"
import { ancestorsOf, volumeNumberOf } from "../../lib/ncx-parser.js"
import { findNavPoint, htmlToText, withDuplicateNumberNote } from "../../lib/provision-slicer.js"
import { parseSectionRef, type SectionRef } from "../../lib/section-ref.js"
import type { NcxEntry } from "../../lib/types.js"

/** Cached `getToc`. Same contract as the client method, including its errors. */
export async function cachedToc(client: AuApiClient, titleId: string, date?: string): Promise<NcxEntry[]> {
  const key = `toc:${titleId}:${date ?? "latest"}`
  const hit = lawCache.get<NcxEntry[]>(key)
  if (hit) return hit
  const entries = await client.getToc(titleId, date)
  lawCache.set(key, entries, ARTICLE_CACHE_TTL)
  return entries
}

/** Every descendant of `root` in document order (the root itself excluded). */
export function descendantsOf(entries: readonly NcxEntry[], root: NcxEntry): NcxEntry[] {
  const start = entries.indexOf(root)
  if (start === -1) return []
  const out: NcxEntry[] = []
  for (let i = start + 1; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.depth <= root.depth) break
    out.push(entry)
  }
  return out
}

/** True when `entry` is `root` or sits under it. */
export function isUnder(entry: NcxEntry, root: NcxEntry): boolean {
  return entry === root || ancestorsOf(entry).includes(root)
}

/** The volume roots (depth 1) of a TOC — `["Volume 1", …]`, or `[]` for single-volume acts. */
export function volumeRoots(entries: readonly NcxEntry[]): NcxEntry[] {
  return entries.filter((entry) => entry.depth === 1)
}

/** Distinct volume documents referenced by a TOC. */
export function volumeDocs(entries: readonly NcxEntry[]): string[] {
  const seen = new Set<string>()
  for (const entry of entries) if (entry.volumeDoc) seen.add(entry.volumeDoc)
  return [...seen]
}

/** `Schedule N—…` roots, outermost only (a schedule inside a schedule is not a root). */
export function scheduleRoots(entries: readonly NcxEntry[]): NcxEntry[] {
  return entries.filter(
    (entry) =>
      /^schedules?[\s ]/i.test(entry.label) &&
      !ancestorsOf(entry).some((ancestor) => /^schedules?[\s ]/i.test(ancestor.label)),
  )
}

/** Leaf-ish provision nodes (numbered sections) under a root — used for item counts. */
export function provisionLeaves(entries: readonly NcxEntry[], root: NcxEntry): NcxEntry[] {
  return descendantsOf(entries, root).filter((entry) => /^\d/.test(entry.label))
}

/**
 * Render an NCX subtree as an indented outline.
 *
 * `maxDepth` counts from the root (1 = the root's own children). `limit`
 * caps the number of rendered lines; the caller is told how many were cut,
 * never left thinking the outline is complete.
 */
export function renderTree(
  entries: readonly NcxEntry[],
  root: NcxEntry | undefined,
  opts: { maxDepth: number; limit: number },
): { text: string; shown: number; total: number } {
  const scope = root ? descendantsOf(entries, root) : [...entries]
  const baseDepth = root ? root.depth : 0
  const eligible = scope.filter((entry) => entry.depth - baseDepth <= opts.maxDepth)
  const lines: string[] = []
  for (const entry of eligible.slice(0, opts.limit)) {
    lines.push(`${"  ".repeat(Math.max(0, entry.depth - baseDepth - 1))}${entry.label}`)
  }
  return { text: lines.join("\n"), shown: Math.min(eligible.length, opts.limit), total: eligible.length }
}

/** A one-line "what is in this act" summary: volumes, chapters/parts, schedules. */
export function tocSummary(entries: readonly NcxEntry[]): string[] {
  const volumes = volumeRoots(entries)
  const schedules = scheduleRoots(entries)
  const sections = entries.filter((entry) => /^\d/.test(entry.label))
  const lines: string[] = []
  lines.push(
    `Structure: ${entries.length} table-of-contents entries` +
      (volumes.length > 1 ? ` across ${volumes.length} volumes` : "") +
      `, ${sections.length} numbered provisions, ${schedules.length} schedule(s).`,
  )
  if (volumes.length > 1) {
    lines.push(
      `Volumes: ${volumes
        .map((volume) => `${volume.label}${volumeNumberOf(volume.volumeDoc) ? "" : ""}`)
        .join(", ")}`,
    )
  }
  return lines
}

/**
 * Text of a whole structural node (a Part, Division, Chapter or Schedule).
 *
 * `sliceProvision` in the lib stops at the *next navPoint*, which for a Part
 * is its own first child — so it would return the heading alone. A subtree
 * runs to the next entry at the same or a shallower depth instead.
 *
 * Returns `null` when the anchor is missing from the HTML (a real TOC/volume
 * mismatch, which the caller must surface rather than widen).
 *
 * Shares `withDuplicateNumberNote` with `sliceProvision`: these two are the
 * only functions that turn a navPoint into served text, and an Act that
 * numbers a provision twice must be as visible through one as the other.
 * (A Part/Chapter/Schedule/endnote root has a worded label, so the note never
 * fires on the structural work this function normally does.)
 */
export function sliceSubtree(html: string, entries: readonly NcxEntry[], root: NcxEntry): string | null {
  if (!root.anchor) return withDuplicateNumberNote(htmlToText(html), root, entries)
  const at = html.indexOf(`id="${root.anchor}"`)
  if (at === -1) return null
  const start = Math.max(0, lastParagraphStart(html, at))

  let end = -1
  const rootIndex = entries.indexOf(root)
  for (let i = rootIndex + 1; i < entries.length; i++) {
    const next = entries[i]
    if (next.depth > root.depth) continue // still inside the subtree
    if (next.volumeDoc !== root.volumeDoc || !next.anchor) break
    const nextAt = html.indexOf(`id="${next.anchor}"`, at + 1)
    if (nextAt !== -1) end = lastParagraphStart(html, nextAt)
    break
  }
  if (end === -1) {
    const bodyEnd = html.indexOf("</body>", at)
    end = bodyEnd === -1 ? html.length : bodyEnd
  }
  return withDuplicateNumberNote(htmlToText(html.slice(start, end)), root, entries)
}

function lastParagraphStart(html: string, position: number): number {
  const start = html.lastIndexOf("<p", position)
  return start === -1 ? position : start
}

/** True for nodes that own a subtree of provisions rather than being one. */
export function isStructuralKind(kind: SectionRef["kind"]): boolean {
  return kind === "part" || kind === "division" || kind === "subdivision" || kind === "chapter" || kind === "schedule"
}

/**
 * Parse a provision string, or throw the same error shape the client uses.
 *
 * The shape is the load-bearing part. An unparseable `provision` is a local
 * parameter problem: nothing was requested upstream, so labelling it
 * `[EXTERNAL_API_ERROR]` — which is what `formatToolError` does with a plain
 * `Error` — reports a failure of the Federal Register that never happened, and
 * tells the caller to retry something that can never succeed. Inside a chain it
 * came out as "[NOT RETRIEVED] … Reason: [EXTERNAL_API_ERROR]". Every sibling
 * path already gets this right (`AuApiClient.getProvision`, `impact_map`,
 * `parse_section_ref`), and the message/suggestion here is deliberately the
 * same text as `getProvision`'s so the two cannot drift.
 */
export function requireRef(provision: string): SectionRef {
  const ref = parseSectionRef(provision)
  if (!ref) {
    throw new LawApiError(
      `Not a recognisable provision reference: ${JSON.stringify(provision)}`,
      ErrorCodes.INVALID_PARAM,
      [
        'Use forms like "s 18", "sch 2 s 18", "pt IV", "div 2", "reg 2.01", "cl 7", "s 5(2)(a)".',
        "This is the `provision` parameter, not the upstream register — nothing was fetched, so retrying " +
          "the same string will fail the same way.",
        "Call the tool without `provision` (or get_law_tree) to see the labels this compilation actually uses.",
      ],
    )
  }
  return ref
}

/** Locate a reference in a TOC (the disambiguating `sch 2 s 18` logic lives in the lib). */
export function locate(ref: SectionRef, entries: readonly NcxEntry[]): NcxEntry | undefined {
  return findNavPoint(ref, entries as NcxEntry[])
}

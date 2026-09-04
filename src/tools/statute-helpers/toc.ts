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

/**
 * Containment rank of the unit an FRL navLabel names — outermost first.
 *
 * Only used to answer one question: does this sibling belong *inside* the
 * container above it, or does it end it? Anything not on this list (a group
 * heading like "Guide to Subdivision 20-A" or "Maximum net asset value test",
 * a numbered section) is unranked and therefore belongs inside.
 */
const CONTAINER_RANK: ReadonlyArray<[RegExp, number]> = [
  [/^schedules?\b/i, 1],
  [/^chapter\b/i, 2],
  [/^part\b/i, 3],
  [/^division\b/i, 4],
  [/^subdivision\b/i, 5],
]

/** An endnote block ends every container, whatever its own depth says. */
const ENDNOTE_LABEL = /^(?:endnotes?|notes? to the\b)/i

function containerRank(label: string): number | undefined {
  for (const [pattern, rank] of CONTAINER_RANK) if (pattern.test(label)) return rank
  return undefined
}

/**
 * The entries a container node owns — descendants where the NCX nests, and the
 * sibling run where it does not.
 *
 * FRL's NCX is not consistently nested. Under *Subdivision 20-A* of the ITAA
 * 1997 the sections do not hang off the subdivision at all: the subdivision, its
 * "Guide to Subdivision 20-A" and its "What is an assessable recoupment?" group
 * heading are all siblings at one depth, and only the sections hang off the
 * *group headings*. `descendantsOf` therefore returns `[]`, `sliceSubtree`
 * stopped at the first sibling, and `get_law_text {provision:"Subdiv 20-A"}`
 * came back as the heading line and nothing else. Measured live 2026-09-05:
 * **373 of the 941** Part/Division/Subdivision entries in the ITAA 1997 are
 * shaped that way, and 7 in the CCA — including the ACL's *Division 1 —
 * Consumer guarantees*.
 *
 * So when a container has no descendants, its members are the following
 * siblings up to the next unit that ends it: a container of the **same or
 * higher rank** (a Subdivision does not end a Division; another Division does),
 * an endnote block, or anything shallower. Deeper entries under those siblings
 * come with them. Nesting that already works is untouched — a root with
 * descendants returns exactly `descendantsOf`.
 */
export function subtreeMembers(entries: readonly NcxEntry[], root: NcxEntry): NcxEntry[] {
  const nested = descendantsOf(entries, root)
  if (nested.length > 0) return nested
  const rank = containerRank(root.label)
  if (rank === undefined) return nested

  const start = entries.indexOf(root)
  if (start === -1) return nested
  const out: NcxEntry[] = []
  for (let i = start + 1; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.depth > root.depth) {
      out.push(entry)
      continue
    }
    if (entry.depth < root.depth) break
    if (ENDNOTE_LABEL.test(entry.label)) break
    const otherRank = containerRank(entry.label)
    if (otherRank !== undefined && otherRank <= rank) break
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

  // The first entry that is *not* a member of this node — where its text stops.
  // `subtreeMembers` is `descendantsOf` wherever the NCX nests, so this is the
  // same "first entry at the root's depth or shallower" it always was; where the
  // NCX does not nest it is the end of the sibling run instead.
  const rootIndex = entries.indexOf(root)
  const members = rootIndex === -1 ? [] : subtreeMembers(entries, root)
  const next = rootIndex === -1 ? undefined : entries[rootIndex + 1 + members.length]

  let end = -1
  if (next && next.volumeDoc === root.volumeDoc && next.anchor) {
    const nextAt = html.indexOf(`id="${next.anchor}"`, at + 1)
    if (nextAt !== -1) end = lastParagraphStart(html, nextAt)
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

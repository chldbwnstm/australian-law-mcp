/**
 * Locate a provision in an FRL epub and slice its text out of the volume HTML
 * (docs/research/frl-api-reference.md §3: there is no per-section endpoint —
 * the NCX anchor grammar is the only section-level address the Register has).
 *
 * Exported separately so each is testable against the recorded CCA fixtures on
 * its own:
 *
 *  - `resolveNavPoint` / `findNavPoint` — provision reference → the right NCX
 *    entry, plus the same-numbered entries it did *not* serve. The load-bearing
 *    cases are `sch 2 s 18` vs `s 18` (the CCA has both, with different
 *    content) and the Constitution's two sets of ss 1–9; returning the wrong
 *    one is a confidently wrong legal answer.
 *  - `duplicateNumberNote` / `withDuplicateNumberNote` — the one ambiguity the
 *    reference grammar cannot express (covering clauses against the Act's own
 *    numbering), named in the text that is served. A silently resolved
 *    ambiguity is indistinguishable from a wrong answer; a warning printed over
 *    an answer that was never ambiguous is its own kind of wrong.
 *  - `sliceProvision` — NCX entry + volume HTML → readable text between this
 *    anchor and the next one.
 */

import { ancestorsOf } from "./ncx-parser.js"
import { decodeXmlEntities } from "./ncx-parser.js"
import { refToNcxLabelPattern, type SectionRef } from "./section-ref.js"
import type { NcxEntry } from "./types.js"

/** Pattern for the `Schedule N—…` navLabel that owns a `sch N s x` reference. */
function schedulePattern(scheduleNumber: string): RegExp {
  return refToNcxLabelPattern({
    kind: "schedule",
    number: scheduleNumber,
    subsections: [],
    plural: false,
    raw: `sch ${scheduleNumber}`,
  })
}

function isInsideSchedule(entry: NcxEntry, pattern?: RegExp): boolean {
  return ancestorsOf(entry).some((ancestor) =>
    pattern ? pattern.test(ancestor.label) : /^schedules?\b/i.test(ancestor.label),
  )
}

/**
 * Container navLabels that make a numbered provision part of an Act's own
 * structure rather than material hanging off the document root.
 *
 * Volume roots are deliberately absent: `"Volume 1"` is a delivery artefact of
 * the epub, not a division of the Act, and counting it would make every
 * section of a multi-volume compilation "contained" and the test below useless.
 */
const STRUCTURAL_LABEL =
  /^(?:chapters?|parts?|divisions?|sub-?divisions?|schedules?|appendix|appendices|orders?)[\s ]/i

function structuralAncestors(entry: NcxEntry): NcxEntry[] {
  return ancestorsOf(entry).filter((ancestor) => STRUCTURAL_LABEL.test(ancestor.label))
}

/** The innermost Chapter/Part/Division an entry sits in, if any. */
function nearestStructural(entry: NcxEntry): string | undefined {
  const chain = structuralAncestors(entry)
  return chain.length > 0 ? chain[chain.length - 1].label : undefined
}

/** One navPoint choice, with the same-numbered entries the rules did not serve. */
export interface NavPointMatch {
  /** The entry to serve, or `undefined` when the TOC has no such provision. */
  entry: NcxEntry | undefined
  /**
   * Entries that matched just as well and were not served. Non-empty only for
   * a genuine ambiguity the reference grammar cannot express — the schedule
   * rule below is a *decision*, so a rejected schedule twin is not listed here.
   */
  alternatives: NcxEntry[]
}

/**
 * Resolve a parsed reference against a TOC, and say what else it could have
 * meant. `findNavPoint` is the thin wrapper; this is the single place any
 * navPoint choice is made, so a new caller cannot re-derive its own rule.
 *
 * Resolution rules, in order:
 *  - `sch N …` must match **inside** the `Schedule N` subtree; a body section
 *    with the same number is not a fallback (that is the exact confusion the
 *    schedule prefix exists to prevent).
 *  - A bare `sch N` (with or without an item) resolves to the schedule node
 *    itself; NCX granularity stops at navPoints, so items are not addressed here.
 *  - An unqualified reference prefers a **body** match. Only when the whole
 *    act lives in schedules (some consolidations do) does a schedule-subtree
 *    match get returned.
 *  - When two body matches survive, the Act's own numbering wins over material
 *    hanging off the document root. That case is the *Commonwealth of Australia
 *    Constitution Act 1900* (C2004Q00685, NCX read live 2026-09-04): its ss 1–9
 *    are the Imperial Act's **covering clauses** (`1. Short title.`,
 *    `7. Repeal of Federal Council Act.`) sitting directly under the document
 *    root, while the Constitution's own ss 1–9 (`7. The Senate.`) sit under
 *    `Chapter I.—The Parliament.`. "Constitution s 7" in a court, a textbook or
 *    AGLC r 3.6 means the latter; taking the first match served the covering
 *    clause for every one of ss 1–9 and said nothing about it. The covering
 *    clauses keep their own address — the profession calls them clauses, so
 *    `cl 7` asks for one — and `duplicateNumberNote` names the choice in the
 *    text that is served.
 */
export function resolveNavPoint(ref: SectionRef, entries: readonly NcxEntry[]): NavPointMatch {
  if (ref.kind === "schedule") {
    const pattern = schedulePattern(ref.number + (ref.letterSuffix ?? ""))
    return { entry: entries.find((entry) => pattern.test(entry.label)), alternatives: [] }
  }

  const pattern = refToNcxLabelPattern(ref)
  const matches = entries.filter((entry) => pattern.test(entry.label))
  if (matches.length === 0) return { entry: undefined, alternatives: [] }

  if (ref.schedule) {
    const owner = schedulePattern(ref.schedule)
    const inside = matches.filter((entry) => isInsideSchedule(entry, owner))
    return { entry: inside[0], alternatives: inside.slice(1) }
  }

  const body = matches.filter((entry) => !isInsideSchedule(entry))
  const pool = body.length > 0 ? body : matches
  if (pool.length === 1) return { entry: pool[0], alternatives: [] }

  const rooted = pool.filter((entry) => structuralAncestors(entry).length === 0)
  const contained = pool.filter((entry) => structuralAncestors(entry).length > 0)
  const chosen =
    rooted.length > 0 && contained.length > 0
      ? // `cl` is how covering clauses are cited; every other designation means
        // the Act's own numbering.
        (ref.kind === "clause" ? rooted[0] : contained[0])
      : pool[0]
  return { entry: chosen, alternatives: pool.filter((entry) => entry !== chosen) }
}

/**
 * Find the navPoint a parsed reference points at, or `undefined` — never a
 * guess — when the TOC has no such provision. See `resolveNavPoint` for the
 * rules; this wrapper exists because most callers only need the entry.
 */
export function findNavPoint(ref: SectionRef, entries: NcxEntry[]): NcxEntry | undefined {
  return resolveNavPoint(ref, entries).entry
}

/**
 * The number a navLabel leads with: `"7. The Senate."` → `7`,
 * `"18 Meetings of Commission"` → `18`, `"105A. Agreements…"` → `105A`,
 * `"86."` → `86`. `undefined` for worded labels (`"Part IV—…"`, `"Endnotes"`).
 */
export function leadingNumber(label: string): string | undefined {
  const match = /^(\d[0-9A-Za-z.‐‑-]*?)\.?(?=[\s ]|$)/.exec(label)
  return match ? match[1].replace(/[‐‑]/g, "-") : undefined
}

function placeOf(entry: NcxEntry): string {
  const where = nearestStructural(entry)
  return where
    ? `in ${where}`
    : "directly under the Act itself, in no Chapter or Part (where an enacting Act's covering clauses sit)"
}

/**
 * Name an unresolvable ambiguity in the served text, or `undefined` when there
 * is none.
 *
 * The ambiguity this exists for is **one shape**: an enacting Act's covering
 * clauses, which hang directly off the document root, colliding with the Act's
 * own numbering inside its Chapters and Parts. That is the *Commonwealth of
 * Australia Constitution Act 1900* (C2004Q00685), where ss 1–9 name two
 * different provisions apiece; `resolveNavPoint` decides it by designation
 * (`cl 7` is the covering clause, `s 7` the Constitution's own), and this says
 * which was picked, where the other is, and how to ask for it — the choice is
 * named rather than made in silence.
 *
 * Two collisions are deliberately **not** named, because in neither case is a
 * reader being handed a provision they could have meant instead:
 *
 *  - **Schedule twins.** `sch 2 s 18` already addresses the ACL's s 18, the
 *    schedule rule in `resolveNavPoint` already decides it, and every tool that
 *    can serve one prints the schedule in its breadcrumb.
 *  - **Numbering that restarts inside a Part.** Non-operative reader's aids
 *    renumber from 1: the *Corporations Act 2001* (C2004A00818, NCX read live
 *    2026-09-05, 5,569 entries) numbers its "Part 1.5—Small business guide"
 *    paragraphs 1–12, colliding with ss 1–7, 9–12 of Parts 1.1 and 1.2 — 22
 *    entries across 11 numbers, on the second-most-cited Australian Act.
 *    "Corporations Act s 9" is not ambiguous: only one of the two is a section,
 *    and warning that it might be the guide's paragraph 9 is a false alarm
 *    printed above a correct answer. Both sit inside the Act's own structure,
 *    so requiring the two to differ in *rootedness* excludes them — and that is
 *    also the only case `resolveNavPoint` resolves by a rule, hence the only
 *    one for which there is a second designation to offer.
 */
export function duplicateNumberNote(entry: NcxEntry, entries: readonly NcxEntry[]): string | undefined {
  const number = leadingNumber(entry.label)
  if (number === undefined || isInsideSchedule(entry)) return undefined

  const servedIsRooted = nearestStructural(entry) === undefined
  // Cheapest test first: most labels are worded and fail `leadingNumber`
  // outright, so the ancestor walk runs only for the handful of numbered ones.
  const peers = entries.filter(
    (other) =>
      other !== entry &&
      leadingNumber(other.label) === number &&
      !isInsideSchedule(other) &&
      // One of the two must be a covering clause and the other part of the
      // Act's own structure. Two entries on the same side of that line are a
      // renumbering, not a reference the caller could have meant.
      (nearestStructural(other) === undefined) !== servedIsRooted,
  )
  if (peers.length === 0) return undefined

  const lines = [
    `Note: this compilation numbers "${number}" more than once, so a bare reference cannot tell them apart.`,
    `  served: ${entry.label} — ${placeOf(entry)}`,
  ]
  for (const peer of peers) {
    // The peer is on the other side of the rooted/contained line by
    // construction, so there is always a designation that reaches it.
    lines.push(
      `  also numbered ${number}: ${peer.label} — ${placeOf(peer)}. ` +
        `Ask for it as "${servedIsRooted ? "s" : "cl"} ${number}".`,
    )
  }
  return lines.join("\n")
}

/** Prefix served text with the ambiguity note, when there is one to make. */
export function withDuplicateNumberNote(
  text: string,
  entry: NcxEntry,
  entries: readonly NcxEntry[],
): string {
  const note = duplicateNumberNote(entry, entries)
  return note ? `${note}\n\n${text}` : text
}

/** Where `id="…"` occurs in the HTML, or -1. Anchor ids never need escaping checks — they are `_Toc` + digits. */
function anchorIndex(html: string, anchor: string, from = 0): number {
  return html.indexOf(`id="${anchor}"`, from)
}

/** Walk back from an in-element position to the `<p` that opens its paragraph. */
function paragraphStart(html: string, position: number): number {
  const start = html.lastIndexOf("<p", position)
  return start === -1 ? position : start
}

/**
 * Slice one provision's HTML out of its volume and convert it to readable
 * text. Returns `null` when the entry's anchor is not present in the HTML —
 * a real mismatch the caller must surface, not silently widen.
 *
 * The end of the slice is the next NCX anchor of the same volume that
 * actually occurs after the start (the NCX is the authority on order). When
 * none is found — a trimmed TOC, or the last provision of a volume — the next
 * `_Toc` anchor in the HTML itself is used, and failing that the end of the
 * body. Both fallbacks keep the slice to one heading's worth of text instead
 * of everything to EOF.
 *
 * When the Act numbers this provision twice (`duplicateNumberNote`), the text
 * is served with the ambiguity named above it — this is the only channel the
 * served *text* has, and every tool that prints provision text goes through it.
 */
export function sliceProvision(html: string, entry: NcxEntry, entries: NcxEntry[]): string | null {
  if (!entry.anchor) {
    // A volume root: the whole body is the "provision".
    return withDuplicateNumberNote(htmlToText(html), entry, entries)
  }

  const anchorAt = anchorIndex(html, entry.anchor)
  if (anchorAt === -1) return null
  const start = paragraphStart(html, anchorAt)

  let end = -1
  const startIndex = entries.indexOf(entry)
  for (let i = startIndex + 1; i < entries.length; i++) {
    const next = entries[i]
    if (next.volumeDoc !== entry.volumeDoc || !next.anchor) continue
    const at = anchorIndex(html, next.anchor, anchorAt + 1)
    if (at !== -1) {
      end = paragraphStart(html, at)
      break
    }
  }

  if (end === -1) {
    // NCX gave no reachable end anchor — fall back to the next heading anchor
    // in the HTML itself, then to the end of the body.
    const headingEnd = html.indexOf("</p>", anchorAt)
    const nextToc = /<a id="_Toc/g
    nextToc.lastIndex = headingEnd === -1 ? anchorAt + 1 : headingEnd
    const found = nextToc.exec(html)
    if (found) {
      end = paragraphStart(html, found.index)
    } else {
      const bodyEnd = html.indexOf("</body>", anchorAt)
      end = bodyEnd === -1 ? html.length : bodyEnd
    }
  }

  return withDuplicateNumberNote(htmlToText(html.slice(start, end)), entry, entries)
}

/**
 * Indentation per FRL paragraph class. The epub carries its indentation as
 * inline span widths, which do not survive tag stripping; the class names do.
 * Headings sit flush left; each structural level steps in, so `(1)` and `(a)`
 * keep their visual nesting in plain text.
 */
const CLASS_INDENT: ReadonlyArray<[RegExp, string]> = [
  [/^ActHead/i, ""],
  [/^subsection2$/i, "    "],
  [/^subsection$/i, "    "],
  [/^paragraph/i, "        "],
  [/^subparagraph/i, "            "],
  [/^note/i, "    "],
  [/^definition/i, "    "],
]

function indentFor(className: string | undefined): string {
  if (!className) return ""
  for (const [pattern, indent] of CLASS_INDENT) {
    if (pattern.test(className)) return indent
  }
  return ""
}

/**
 * XHTML fragment → readable text, one line per paragraph. Tags are stripped,
 * entities decoded, NBSPs (the epub's spacing device) collapsed to single
 * spaces, and the non-breaking hyphen of forms like `Part 2‑1` mapped to an
 * ordinary hyphen so downstream reference parsing sees `2-1`.
 */
export function htmlToText(fragment: string): string {
  const lines: string[] = []
  for (const match of fragment.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const classAttr = /\bclass="([^"]*)"/.exec(match[1])?.[1]
    const text = decodeXmlEntities(match[2].replace(/<[^>]+>/g, ""))
      .replace(/[\u00a0\u2007\u202f]/g, " ")
      .replace(/\u2011/g, "-")
      .replace(/[ \t]+/g, " ")
      .trim()
    if (!text) continue
    lines.push(`${indentFor(classAttr)}${text}`)
  }
  return lines.join("\n")
}

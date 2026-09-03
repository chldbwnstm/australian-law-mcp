/**
 * Locate a provision in an FRL epub and slice its text out of the volume HTML
 * (docs/research/frl-api-reference.md §3: there is no per-section endpoint —
 * the NCX anchor grammar is the only section-level address the Register has).
 *
 * Two functions, exported separately so each is testable against the recorded
 * CCA fixtures on its own:
 *
 *  - `findNavPoint` — provision reference → the right NCX entry. The load-bearing
 *    case is `sch 2 s 18` vs `s 18`: the CCA has both, with different content,
 *    and returning the wrong one is a confidently wrong legal answer.
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
 * Find the navPoint a parsed reference points at, or `undefined` — never a
 * guess — when the TOC has no such provision.
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
 */
export function findNavPoint(ref: SectionRef, entries: NcxEntry[]): NcxEntry | undefined {
  if (ref.kind === "schedule") {
    const pattern = schedulePattern(ref.number + (ref.letterSuffix ?? ""))
    return entries.find((entry) => pattern.test(entry.label))
  }

  const pattern = refToNcxLabelPattern(ref)
  const matches = entries.filter((entry) => pattern.test(entry.label))
  if (matches.length === 0) return undefined

  if (ref.schedule) {
    const owner = schedulePattern(ref.schedule)
    return matches.find((entry) => isInsideSchedule(entry, owner))
  }

  return matches.find((entry) => !isInsideSchedule(entry)) ?? matches[0]
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
 */
export function sliceProvision(html: string, entry: NcxEntry, entries: NcxEntry[]): string | null {
  if (!entry.anchor) {
    // A volume root: the whole body is the "provision".
    return htmlToText(html)
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

  return htmlToText(html.slice(start, end))
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

/**
 * Reading an epub table of contents as an index of provision *headings*.
 *
 * The NCX already carries the answer to "what is s 18 called" — the navLabel is
 * `"18  Meetings of Commission"`. That matters for cost as much as for
 * correctness: a content check that read the provision text would need a volume
 * fetch (megabytes) per citation, while the TOC is fetched once per Act and
 * answers existence, heading and the whole-Act neighbourhood together.
 *
 * The other job here is the one that makes a CONTENT_MISMATCH worth printing.
 * A claim that fails against the cited heading is ambiguous on its own — the
 * writer may be describing the section's body. A claim that fails against the
 * cited heading *and matches a different provision's heading in the same Act*
 * is not ambiguous: that is the provision they meant. `bestHeadingMatch` is
 * what turns "CCA s 18 prohibits misleading or deceptive conduct" into "you
 * mean sch 2 s 18".
 */

import { headingTitle, matchCitationContent } from "../../lib/citation-content-matcher.js"
import { ancestorsOf } from "../../lib/ncx-parser.js"
import type { SectionRef } from "../../lib/section-ref.js"
import type { NcxEntry } from "../../lib/types.js"

/** A navLabel that starts with a provision number: `"18  Meetings of Commission"`. */
const NUMBERED_LABEL = /^(\d{1,4}(?:[.\-]\d{1,4}){0,3}[A-Za-z]{0,4})[\s ]/
/** `"Schedule 2—The Australian Consumer Law"`. */
const SCHEDULE_LABEL = /^schedules?[\s ]+([0-9]+[A-Za-z]*|[IVXLCDM]+)\b\s*[—–-]?\s*(.*)$/i

/** The provision number a numbered navLabel begins with. */
export function numberOfLabel(label: string): string | undefined {
  return NUMBERED_LABEL.exec(label)?.[1]
}

/** The schedule an entry sits inside, as `{ number, name }`. */
export function scheduleOf(entry: NcxEntry): { number: string; name?: string } | undefined {
  for (const ancestor of [entry, ...ancestorsOf(entry)]) {
    const match = SCHEDULE_LABEL.exec(ancestor.label)
    if (!match) continue
    const name = match[2] ? headingTitle(ancestor.label) : undefined
    return { number: match[1], ...(name ? { name } : {}) }
  }
  return undefined
}

/** AGLC pinpoint for a TOC entry: `"sch 2 s 18"` or `"s 18"`. */
export function refStringForEntry(entry: NcxEntry): string | undefined {
  const number = numberOfLabel(entry.label)
  if (!number) return undefined
  const schedule = scheduleOf(entry)
  return schedule ? `sch ${schedule.number} s ${number}` : `s ${number}`
}

export interface HeadingMatch {
  entry: NcxEntry
  /** AGLC pinpoint of the matched provision. */
  ref: string
  /** Heading with the leading number removed. */
  heading: string
  /** Name of the schedule it sits in, when it sits in one. */
  scheduleName?: string
  score: number
}

/**
 * The provision in this Act whose heading best matches `claim`, excluding the
 * one already cited. Returns nothing unless a match actually clears the
 * matcher's threshold — a "closest" answer below it is noise.
 */
export function bestHeadingMatch(
  entries: readonly NcxEntry[],
  claim: string,
  exclude?: NcxEntry,
): HeadingMatch | undefined {
  let best: HeadingMatch | undefined
  for (const entry of entries) {
    if (entry === exclude) continue
    if (!NUMBERED_LABEL.test(entry.label)) continue
    const heading = headingTitle(entry.label)
    if (!heading) continue
    const result = matchCitationContent(claim, heading)
    if (!result.matched) continue
    if (best && result.score <= best.score) continue
    const ref = refStringForEntry(entry)
    if (!ref) continue
    const schedule = scheduleOf(entry)
    best = {
      entry,
      ref,
      heading,
      ...(schedule?.name ? { scheduleName: schedule.name } : {}),
      score: result.score,
    }
  }
  return best
}

/**
 * What the Act actually contains around a reference that is not there.
 *
 * "s 4242 does not exist" is a true statement that helps nobody; "the body runs
 * s 1 – s 179 and the nearest entries are s 17A, s 18, s 19" tells the reader
 * whether they mistyped, cited a schedule provision without its prefix, or
 * quoted a repealed section.
 */
export function provisionRangeHint(entries: readonly NcxEntry[], ref: SectionRef): string {
  const inScope = entries.filter((entry) => {
    if (!NUMBERED_LABEL.test(entry.label)) return false
    const schedule = scheduleOf(entry)
    return ref.schedule ? schedule?.number === ref.schedule : schedule === undefined
  })
  const scope = ref.schedule ? `schedule ${ref.schedule}` : "the body of the Act"
  if (inScope.length === 0) {
    return `The table of contents lists no numbered provisions in ${scope}.`
  }

  const numbers = inScope
    .map((entry) => ({ entry, value: Number.parseFloat(numberOfLabel(entry.label) ?? "") }))
    .filter((row) => Number.isFinite(row.value))
  const target = Number.parseFloat(`${ref.number}`)
  const nearest = Number.isFinite(target)
    ? [...numbers].sort((a, b) => Math.abs(a.value - target) - Math.abs(b.value - target)).slice(0, 3)
    : numbers.slice(0, 3)

  const first = numberOfLabel(inScope[0].label)
  const last = numberOfLabel(inScope[inScope.length - 1].label)
  const neighbours = nearest.map((row) => row.entry.label.replace(/\s+/g, " ").trim()).join(" | ")
  return (
    `${scope} runs from s ${first} to s ${last} in this compilation (${inScope.length} numbered entries). ` +
    `Nearest entries: ${neighbours}`
  )
}

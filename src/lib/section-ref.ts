/**
 * Provision references — parse, normalise, format, and turn into an NCX
 * lookup pattern. This module is the single source of that grammar (it
 * replaces the reference implementation's Korean article codes).
 *
 * Three decisions carry most of the weight:
 *
 *  - **`sch 2 s 18` is one reference, not two.** *Competition and Consumer
 *    Act 2010* (Cth) s 18 is "Meetings of Commission"; sch 2 s 18 — the
 *    Australian Consumer Law — is "Misleading or deceptive conduct". Dropping
 *    the schedule turns a correct citation into a confidently wrong one, so
 *    the schedule lives inside the ref rather than beside it.
 *  - **A hyphen means different things either side of a plural.** `ss 5-6` is
 *    a range; `s 355-25` is one ITAA-style section number. The plural
 *    abbreviation is the only signal present in the text, so that is what
 *    decides it — an en dash overrides, because it only ever means "to", while
 *    U+2010/U+2011 do not (they are how FRL prints a plain hyphen). Whatever
 *    the signal, a pair that runs backwards is never a range.
 *  - **`s18` is tolerated on input and never produced on output.** AGLC r
 *    3.1.4 requires the space. Being strict on input would reject most real
 *    user typing; being loose on output would emit non-compliant citations.
 */

import {
  PLURAL_SPELLINGS,
  ROMAN_NUMBER,
  SPELLING_ALTERNATION,
  SUBDIVISION_TOKEN,
  isRomanNumber,
  kindForSpelling,
  vocabFor,
  type RefKind,
} from "./section-ref-vocab.js"

export type { RefKind }

export interface SectionRef {
  kind: RefKind
  /** The number as written, minus any trailing letters: `18`, `355-25`, `2.01`, `IVA`. */
  number: string
  /** Trailing letters of a lettered section: `AA` of `s 10AA`. Never set for roman numbers. */
  letterSuffix?: string
  /** Bracketed subdivisions in order: `s 5(2)(a)` -> `["2", "a"]`. */
  subsections: string[]
  /** Schedule this reference sits inside: `sch 2 s 18` -> `"2"`. */
  schedule?: string
  /** Item within a schedule: `sch 1 item 4` -> `"4"`. */
  item?: string
  /** End of a range: `ss 5-6` -> `"6"`. */
  rangeEnd?: string
  /** True when the source used a plural designation. */
  plural: boolean
  /** The input text this ref was parsed from, whitespace-normalised. */
  raw: string
}

/**
 * Every dash-like character that becomes a plain `-` before parsing: U+2010
 * HYPHEN, U+2011 NON-BREAKING HYPHEN, figure dash, en dash, em dash,
 * horizontal bar and minus.
 */
const DASH_REPLACE = new RegExp("[‐‑‒–—―−]", "g")

/**
 * The subset that only ever means "to" in a pinpoint range — unlike a plain
 * hyphen, which can be part of an ITAA-style section number.
 *
 * U+2010 HYPHEN and U+2011 NON-BREAKING HYPHEN are deliberately **not** here.
 * They are typographic spellings of the plain hyphen, and the Federal Register
 * emits U+2011 *inside* section numbers — `provision-slicer.ts` folds the same
 * character back to `-` for exactly that reason. Counting them as range dashes
 * read the real `s 355‑25` as the impossible range 355–25 and reported a
 * correctly cited provision as one the Act does not contain.
 *
 * Deliberately not a `/g/` regex: `RegExp.prototype.test` on a global pattern
 * advances `lastIndex`, so the same call would alternate true and false.
 */
const RANGE_DASH_TEST = new RegExp("[‒–—―−]")
/** Non-breaking and thin spaces: FRL text and pasted citations are full of them. */
const ODD_SPACES = /[     ]/g

function normaliseInput(input: string): { text: string; hadRangeDash: boolean } {
  const collapsed = input.replace(ODD_SPACES, " ").replace(/\s+/g, " ").trim()
  return {
    text: collapsed.replace(DASH_REPLACE, "-"),
    hadRangeDash: RANGE_DASH_TEST.test(collapsed),
  }
}

/**
 * A provision number: an ITAA/ACL dotted-or-dashed form (`355-25`, `2.01`,
 * `42.02.2`, `2-1`), a plain or lettered arabic number (`18`, `10AA`), or a
 * roman part number (`IVA`).
 *
 * Every quantifier is bounded. An unbounded group nested inside another is
 * what turns a citation scanner into a hang on adversarial input, and this
 * pattern is compiled into the extraction regex that runs over whole
 * documents.
 */
const NUMBER_PATTERN = `(?:${ROMAN_NUMBER}|\\d{1,4}(?:[.\\-]\\d{1,4}){0,3}[A-Za-z]{0,4})`

/** `(2)(a)(ii)` — at most six levels, each one `SUBDIVISION_TOKEN`. */
const SUBSECTION_PATTERN = `(?:\\s?\\(${SUBDIVISION_TOKEN}\\)){0,6}`

const DESIGNATOR = `(?:${SPELLING_ALTERNATION})`
const SCHEDULE_WORD = `(?:schedules|schedule|schs|sch)`

/**
 * One provision expression, optionally prefixed by a schedule and optionally
 * carrying an `item`.
 */
const REF_BODY =
  `(?:${SCHEDULE_WORD}\\s*(${NUMBER_PATTERN})\\s*[,\\-]?\\s*)?` + // schedule prefix
  `(${DESIGNATOR})\\s*` +                                        // designation
  `(${NUMBER_PATTERN})` +                                        // number
  `(?:\\s*-\\s*(${NUMBER_PATTERN}))?` +                          // spaced range end
  `(${SUBSECTION_PATTERN})` +                                    // (2)(a)
  `(?:\\s+items?\\s+(${NUMBER_PATTERN}))?`                       // sch 1 item 4

const ANCHORED_REF = new RegExp(`^${REF_BODY}$`, "i")

/** Bare `sub-s (2)` / `para (a)` — a designation whose number is bracketed. */
const BRACKETED_ONLY = new RegExp(`^(${DESIGNATOR})\\s*\\((${SUBDIVISION_TOKEN})\\)$`, "i")

/**
 * `sub-div B`, `div A` — structural units are sometimes lettered rather than
 * numbered.
 *
 * Two restrictions keep this out of ordinary prose, and both are load-bearing:
 * the letter must be **uppercase** (otherwise "part of" parses as part "of"),
 * and the kind must be structural (a section is never a bare letter).
 */
const LETTERED_STRUCTURAL_KINDS: ReadonlySet<RefKind> = new Set<RefKind>([
  "part", "division", "subdivision", "chapter", "schedule", "appendix",
])
const LETTERED_STRUCTURAL = new RegExp(`^(${DESIGNATOR})\\s*([A-Z]{1,3})$`, "i")

/** `sch 2` on its own, or `sch 1 item 4`. */
const SCHEDULE_ONLY = new RegExp(
  `^${SCHEDULE_WORD}\\s*(${NUMBER_PATTERN})(?:\\s*[,\\-]?\\s*items?\\s*(${NUMBER_PATTERN}))?$`,
  "i",
)

/** Split `10AA` into `["10", "AA"]`; leave roman and dotted numbers whole. */
function splitLetterSuffix(value: string): { number: string; letterSuffix?: string } {
  if (isRomanNumber(value)) return { number: value.toUpperCase() }
  const match = /^(\d{1,4}(?:[.\-]\d{1,4}){0,3})([A-Za-z]{1,4})$/.exec(value)
  if (!match) return { number: value }
  return { number: match[1], letterSuffix: match[2].toUpperCase() }
}

function parseSubsections(raw: string): string[] {
  if (!raw) return []
  return [...raw.matchAll(new RegExp(`\\((${SUBDIVISION_TOKEN})\\)`, "g"))].map((m) => m[1])
}

/**
 * Is this pair arithmetically impossible as a range?
 *
 * `ss 355-25, 355-30` is how the ITAA 1997 is cited in a list — the plural
 * designation belongs to the list, not to a range — and reading the first item
 * as "sections 355 to 25" produces a lookup that cannot succeed, which the
 * caller then reports as the provision not existing. A backwards pair is
 * therefore always read as one dashed section number instead.
 *
 * The same reading is applied to a genuine backwards typo ("ss 20-15"),
 * deliberately: `s 20-15` either exists upstream, in which case the answer is
 * right, or comes back honestly as not in the table of contents, whereas the
 * range reading is guaranteed nonsense and is reported as an absence. A
 * non-numeric side (`pt IV-V`) is never treated as backwards.
 */
function runsBackwards(from: string, to: string): boolean {
  const start = Number.parseInt(from, 10)
  const end = Number.parseInt(to, 10)
  return Number.isFinite(start) && Number.isFinite(end) && end < start
}

/**
 * Parse one provision reference. Returns `null` — never a guess — when the
 * input is not a provision reference: a caller handed a ref for arbitrary
 * prose will go and "verify" it, and report the result as fact.
 */
export function parseSectionRef(input: string): SectionRef | null {
  if (!input) return null
  const { text, hadRangeDash } = normaliseInput(input)
  if (!text) return null

  const scheduleOnly = SCHEDULE_ONLY.exec(text)
  if (scheduleOnly) {
    const { number, letterSuffix } = splitLetterSuffix(scheduleOnly[1])
    return {
      kind: "schedule",
      number,
      ...(letterSuffix ? { letterSuffix } : {}),
      subsections: [],
      ...(scheduleOnly[2] ? { item: scheduleOnly[2] } : {}),
      plural: /^(?:schs|schedules)\b/i.test(text),
      raw: text,
    }
  }

  const bracketed = BRACKETED_ONLY.exec(text)
  if (bracketed) {
    const vocab = kindForSpelling(bracketed[1])
    if (!vocab) return null
    return { kind: vocab.kind, number: bracketed[2], subsections: [], plural: false, raw: text }
  }

  const lettered = LETTERED_STRUCTURAL.exec(text)
  if (lettered) {
    const vocab = kindForSpelling(lettered[1])
    // The uppercase test lives here rather than in the pattern because the
    // designation half has to stay case-insensitive ("Sub-div B").
    if (vocab && LETTERED_STRUCTURAL_KINDS.has(vocab.kind) && lettered[2] === lettered[2].toUpperCase()) {
      return { kind: vocab.kind, number: lettered[2], subsections: [], plural: false, raw: text }
    }
  }

  const match = ANCHORED_REF.exec(text)
  if (!match) return null
  const [, schedule, spelling, rawNumber, spacedRangeEnd, rawSubsections, item] = match

  const vocab = kindForSpelling(spelling)
  if (!vocab) return null
  const plural = PLURAL_SPELLINGS.has(spelling.toLowerCase())

  // The hyphen decision. `NUMBER_PATTERN` is greedy, so `ss 5-6` arrives here
  // as the single number "5-6" and has to be split back out; `s 355-25` must
  // not be. A range dash always means "to"; a hyphen only does after a plural.
  let numberText = rawNumber
  let rangeEnd = spacedRangeEnd as string | undefined
  if (!rangeEnd && (plural || hadRangeDash)) {
    const split = /^(\d{1,4}[A-Za-z]{0,4})-(\d{1,4}[A-Za-z]{0,4})$/.exec(rawNumber)
    if (split && !runsBackwards(split[1], split[2])) {
      numberText = split[1]
      rangeEnd = split[2]
    }
  }
  if (rangeEnd && ((!plural && !hadRangeDash) || runsBackwards(numberText, rangeEnd))) {
    // A spaced hyphen after a singular designation is still part of the number,
    // and so is a pair that runs backwards — see `runsBackwards`.
    numberText = `${numberText}-${rangeEnd}`
    rangeEnd = undefined
  }

  const { number, letterSuffix } = splitLetterSuffix(numberText)

  return {
    kind: vocab.kind,
    number,
    ...(letterSuffix ? { letterSuffix } : {}),
    subsections: parseSubsections(rawSubsections),
    ...(schedule ? { schedule: splitLetterSuffix(schedule).number } : {}),
    ...(item ? { item } : {}),
    ...(rangeEnd ? { rangeEnd } : {}),
    plural,
    raw: text,
  }
}

/** Designations AGLC writes with the number in brackets (r 3.1.4). */
const BRACKETED_KINDS: ReadonlySet<RefKind> = new Set<RefKind>([
  "subsection", "subclause", "subregulation", "subrule", "paragraph", "subparagraph",
])

/**
 * Canonical AGLC4 pinpoint. Always spaced (`s 18`, never `s18`), plural only
 * when a range is present, en dash for the range (r 3.1.4).
 */
export function formatRef(ref: SectionRef): string {
  const vocab = vocabFor(ref.kind)
  const usePlural = Boolean(ref.rangeEnd) || (ref.plural && !ref.item)
  const abbrev = usePlural ? vocab.plural : vocab.singular
  const number = `${ref.number}${ref.letterSuffix ?? ""}`

  if (ref.kind === "schedule") {
    const head = `${abbrev} ${number}`
    return ref.item ? `${head} item ${ref.item}` : head
  }

  const subsections = ref.subsections.map((part) => `(${part})`).join("")
  const core = BRACKETED_KINDS.has(ref.kind)
    ? `${abbrev} (${number})`
    : `${abbrev} ${number}${subsections}`
  const range = ref.rangeEnd ? `–${ref.rangeEnd}` : ""

  const parts: string[] = []
  if (ref.schedule) parts.push(`sch ${ref.schedule}`)
  parts.push(`${core}${range}`)
  if (ref.item) parts.push(`item ${ref.item}`)
  return parts.join(" ")
}

/** Convenience: parse and re-emit in canonical form, or `null` if unparsable. */
export function normaliseRef(input: string): string | null {
  const ref = parseSectionRef(input)
  return ref ? formatRef(ref) : null
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * A regex matching the FRL epub NCX navLabel for this reference.
 *
 * Two label shapes exist and the vocabulary table says which applies:
 * `"18  Meetings of Commission"` (number first) and
 * `"Part IVA—News media…"` (English word first). Structural labels
 * separate the word from the number with a **non-breaking** space, so both
 * space kinds are accepted; the negative lookahead is what stops `div 2`
 * matching `Division 2AA` or `Division 20`.
 */
export function refToNcxLabelPattern(ref: SectionRef): RegExp {
  const vocab = vocabFor(ref.kind)
  const number = escapeForPattern(`${ref.number}${ref.letterSuffix ?? ""}`)
  const gap = "[\\s\\u00a0]"

  if (vocab.ncxLabel === "worded") {
    return new RegExp(`^${vocab.ncxWord}${gap}*${number}(?![0-9A-Za-z])`, "i")
  }
  // A number-led label is always followed by whitespace and then the heading.
  // The lookahead, not the anchor, is what keeps `s 1` away from `18`.
  return new RegExp(`^${number}(?=${gap})`)
}

/**
 * Every provision reference in a block of prose, in order of appearance.
 *
 * A designation word is required, so bare numbers and years are not
 * harvested, and the lookbehind stops the `s` inside a word ("Acts 2010")
 * from starting a match. Quantifiers are bounded throughout, so this is safe
 * to run across a whole document.
 */
export function extractSectionRefs(text: string): SectionRef[] {
  if (!text) return []
  const scanner = new RegExp(`(?<![A-Za-z])${REF_BODY}`, "gi")
  const out: SectionRef[] = []
  for (const match of text.matchAll(scanner)) {
    const ref = parseSectionRef(match[0].trim())
    if (ref) out.push(ref)
  }
  return out
}

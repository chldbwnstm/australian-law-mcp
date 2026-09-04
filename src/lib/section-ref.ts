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
 *    a range; `s 355-25` is one ITAA-style section number, and `Subdiv 152-A`
 *    is one subdivision's whole name (there is no Subdivision 152). The plural
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
const DASH_LIKE = "‐‑‒–—―−"
const DASH_REPLACE = new RegExp(`[${DASH_LIKE}]`, "g")

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
 * A dash inside a number, and the same class with the dotted separator added.
 *
 * `parseSectionRef` folds every dash to a plain `-` before it matches, so the
 * width only matters to the document scanner, which sees the typography the
 * author actually wrote. Without it the scanner stopped at the dash and
 * `s 355‑25` came back as `s 355` and `ss 5–6` as `ss 5` — a different
 * provision, reported without a word about the tail it dropped.
 */
const NUMBER_DASH = `[\\-${DASH_LIKE}]`
const NUMBER_SEP = `[.\\-${DASH_LIKE}]`

/**
 * How far a number's trailing letters may run.
 *
 * Six, because the Commonwealth really does go that far: the *Taxation
 * Administration Act 1953* has s 8AAZLGA, sitting among ss 8AAZLA–8AAZLH. A
 * four-letter cap did not merely reject those — the unanchored scanner
 * truncated `s 8AAZLGA` to `s 8AAZL`, which is itself a real section, and a
 * citation checker then ticked the citation off against *that* section's
 * heading. A tail this module cannot read must drop out whole; a shorter
 * valid-looking reference left behind is the dangerous outcome.
 */
const LETTER_RUN_MAX = 6

/**
 * A provision number: an ITAA/ACL dotted-or-dashed form (`355-25`, `2.01`,
 * `42.02.2`, `2-1`), an ITAA structural form whose dash is followed by a
 * letter (`152-A`, `815-B`), a plain or lettered arabic number (`18`, `10AA`,
 * `8AAZLGA`), or a roman part number (`IVA`).
 *
 * The lettered-dash tail is bounded tight and has to end the number: three
 * letters covers every real structural suffix (`152-A`, `815-B`, `38-BA`),
 * while a longer run after a dash is ordinary hyphenated prose — "the s
 * 18-based claim", "Part IVA-style arrangements" — where the reference the
 * author wrote is the part before the dash.
 *
 * Every quantifier is bounded. An unbounded group nested inside another is
 * what turns a citation scanner into a hang on adversarial input, and this
 * pattern is compiled into the extraction regex that runs over whole
 * documents.
 */
const NUMBER_PATTERN =
  `(?:${ROMAN_NUMBER}` +
  `|\\d{1,4}(?:${NUMBER_SEP}\\d{1,4}){0,3}` +
  `(?:${NUMBER_DASH}[A-Za-z]{1,3}(?![A-Za-z0-9])|[A-Za-z]{0,${LETTER_RUN_MAX}}))`

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
  `(?:\\s*${NUMBER_DASH}\\s*(${NUMBER_PATTERN}))?` +             // spaced range end
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

/**
 * Split `10AA` into `["10", "AA"]`; leave roman, dotted and dash-lettered
 * numbers whole (`152-A` is the ITAA's name for one subdivision, not a
 * number with a suffix).
 */
const LETTER_SUFFIX_SPLIT = new RegExp(
  `^(\\d{1,4}(?:[.\\-]\\d{1,4}){0,3})([A-Za-z]{1,${LETTER_RUN_MAX}})$`,
)
function splitLetterSuffix(value: string): { number: string; letterSuffix?: string } {
  if (isRomanNumber(value)) return { number: value.toUpperCase() }
  const match = LETTER_SUFFIX_SPLIT.exec(value)
  if (!match) return { number: value }
  return { number: match[1], letterSuffix: match[2].toUpperCase() }
}

function parseSubsections(raw: string): string[] {
  if (!raw) return []
  return [...raw.matchAll(new RegExp(`\\((${SUBDIVISION_TOKEN})\\)`, "g"))].map((m) => m[1])
}

/**
 * The two halves of a hyphenated pair that could be a range. Both sides start
 * with digits on purpose: the ITAA's `152-A` is one subdivision's name, never
 * "152 to A", so it can never reach `runsBackwards`.
 */
const RANGE_SPLIT = new RegExp(
  `^(\\d{1,4}[A-Za-z]{0,${LETTER_RUN_MAX}})-(\\d{1,4}[A-Za-z]{0,${LETTER_RUN_MAX}})$`,
)

/**
 * Letters that follow a dash inside a number — `152-A`, `815-B`, `IV-V`.
 *
 * They must be uppercase, for the same reason a bare lettered unit must be
 * (see `LETTERED_STRUCTURAL`): lowercase would make "a s 3-in-1 test" and
 * "the s 18-based claim" provision numbers, and the caller would go on to
 * report them as provisions the Act does not contain.
 */
const DASHED_LETTERS = new RegExp(`-([A-Za-z]{1,${LETTER_RUN_MAX + 2}})(?![A-Za-z])`, "g")

function hasLowercaseDashedLetters(number: string): boolean {
  return [...number.matchAll(DASHED_LETTERS)].some((m) => m[1] !== m[1].toUpperCase())
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
    const split = RANGE_SPLIT.exec(rawNumber)
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

  if (hasLowercaseDashedLetters(numberText)) return null

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
 * The hyphen inside a number, as an NCX label may print it.
 *
 * The Federal Register sets `Part 2‑1` and `Subdivision 152‑A` with U+2011
 * NON-BREAKING HYPHEN — `htmlToText` folds it back for the body text, but
 * navLabels arrive as written, so a pattern built from the parsed (plain
 * hyphen) form has to accept both. Range dashes stay out: they never occur
 * inside a number, and admitting them would let `pt 2-1` match a label that
 * says something else.
 */
const LABEL_HYPHEN = "[-‐‑]"

function numberForLabel(ref: SectionRef): string {
  return escapeForPattern(`${ref.number}${ref.letterSuffix ?? ""}`).replace(/-/g, LABEL_HYPHEN)
}

/**
 * What may follow a worded label's number: anything but more of the number.
 *
 * The hyphen half is the ITAA/ACL structural form. `Subdivision 152` does not
 * exist — the Act has 152-A, 152-B, 152-C and 152-D — so letting `sub-div 152`
 * match the first of them answers a request for one subdivision with another
 * one's text. The title separator is an em dash, never a hyphen, so this
 * refuses nothing a real navLabel offers.
 */
const LABEL_TAIL = `(?![0-9A-Za-z]|${LABEL_HYPHEN}[0-9A-Za-z])`

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
  const number = numberForLabel(ref)
  const gap = "[\\s\\u00a0]"

  if (vocab.ncxLabel === "worded") {
    return new RegExp(`^${vocab.ncxWord}${gap}*${number}${LABEL_TAIL}`, "i")
  }
  // A number-led label is always followed by whitespace and then the heading,
  // optionally with a full stop between the two. The lookahead, not the anchor,
  // is what keeps `s 1` away from `18`.
  //
  // The optional stop is for the pre-Federation continued laws, which keep
  // their original typography: the *Commonwealth of Australia Constitution
  // Act* lists `"51. Legislative powers of the Parliament."`, so without it no
  // section of the Constitution could be fetched at all — while the alias
  // table's own note advertises `Australian Constitution s 51(xx)` as the way
  // to cite it. It is escaped and optional, so `s 51` still cannot reach `51A`
  // (no gap after the number) or `51.2` (no gap after the stop).
  return new RegExp(`^${number}\\.?(?=${gap})`)
}

/**
 * Every provision reference in a block of prose, in order of appearance.
 *
 * A designation word is required, so bare numbers and years are not
 * harvested, and the lookbehind stops the `s` inside a word ("Acts 2010")
 * from starting a match. Quantifiers are bounded throughout, so this is safe
 * to run across a whole document.
 *
 * The trailing lookahead is the other edge of the same rule, and it is the
 * load-bearing half: without it a number this grammar cannot read whole was
 * matched as far as it went, so `s 8AAZLGA` was harvested as `s 8AAZL` — a
 * different section that really exists, and whose heading a citation checker
 * will happily tick the citation off against. A reference that does not end
 * where the match ends is not a reference this scanner reports.
 */
export function extractSectionRefs(text: string): SectionRef[] {
  if (!text) return []
  const scanner = new RegExp(`(?<![A-Za-z])${REF_BODY}(?![0-9A-Za-z])`, "gi")
  const out: SectionRef[] = []
  for (const match of text.matchAll(scanner)) {
    const ref = parseSectionRef(match[0].trim())
    if (ref) out.push(ref)
  }
  return out
}

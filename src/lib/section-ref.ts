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
 *
 * Exported so the tests can enumerate the three roles below and fail if a
 * character is ever added to this string without being given one.
 */
export const DASH_LIKE = "‐‑‒–—―−"
const DASH_REPLACE = new RegExp(`[${DASH_LIKE}]`, "g")

/**
 * The three roles a dash plays in scanned text. Every character of
 * `DASH_LIKE` has exactly one of them, and the plain ASCII hyphen has two (it
 * is both the hyphen inside a number and the range dash a keyboard produces),
 * so `HYPHEN_SPELLINGS ∪ RANGE_DASHES ∪ HEADING_DASHES` is the whole class —
 * which is what the test enumerating them checks. `parseSectionRef` never
 * sees them: it folds every dash to a plain `-` first, so these widths only
 * ever change what the *unanchored* scanner harvests out of a document.
 *
 *  - `HYPHEN_SPELLINGS` — typographic spellings of the plain hyphen, which is
 *    a character *inside* a number. The Federal Register sets `s 355‑25`,
 *    `Part 2‑1` and `Subdivision 152‑A` with U+2011, and `provision-slicer.ts`
 *    folds the same character for the same reason.
 *  - `RANGE_DASHES` — a dash that means "to" between two numbers: `ss 5–6`.
 *  - `HEADING_DASHES` — the separator the Federal Register prints between a
 *    heading's number and its title: `Schedule 1—2019 measures`,
 *    `Part IVA—News media…`. It is an EM DASH in all 284 navLabels of
 *    `__fixtures__/cca-document.ncx` and in FRL body text; the register never
 *    writes a range with one.
 *
 * Treating an em dash as a range dash is how "Schedule 1—2019 measures" came
 * back as the schedule range `sch 1-2019`, "Part 1—2015 transitional
 * provisions" as `pts 1–2015` and "s 45 — 1 January 2011" as the fabricated
 * ITAA-style `s 45-1` — the heading swallowed, and a provision nobody cited
 * reported in its place. The trade is deliberate and one-sided: prose that
 * writes a range with an em dash (AGLC r 1.9 says en dash) now scans as its
 * first half, which is a reference the author did write, while the anchored
 * `parseSectionRef("s 5—6")` still reads the range, because there the caller
 * has said the whole string is one reference.
 */
const HYPHEN_SPELLINGS = "‐‑"
const RANGE_DASHES = "‒–−"
const HEADING_DASHES = "—―"

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
 * A heading dash *is* here, unlike in the scanner's `RANGE_DASH`: this test
 * runs on input a caller has already said is one reference, where there is no
 * heading for an em dash to separate, so `parseSectionRef("s 5—6")` still
 * reads the range the writer meant.
 *
 * Deliberately not a `/g/` regex: `RegExp.prototype.test` on a global pattern
 * advances `lastIndex`, so the same call would alternate true and false.
 */
const RANGE_DASH_TEST = new RegExp(`[${RANGE_DASHES}${HEADING_DASHES}]`)
/** Non-breaking and thin spaces: FRL text and pasted citations are full of them. */
const ODD_SPACES = /[     ]/g

/**
 * U+2010/U+2011 are how the Federal Register prints the hyphen *inside* a
 * number (`s 355‑25`), and FRL never writes a range with them — ranges are
 * worded ("sections 5 to 6"). So text still carrying one arrived by copy and
 * paste from the Register, and its hyphen pair is one ITAA-style number, not
 * a range, whatever the designation's plurality says. Only the anchored
 * parser can honour this: both the epub pipeline (`htmlToText`) and the NCX
 * label normaliser fold these characters before the scanner runs.
 */
const NUMBER_HYPHEN_TEST = new RegExp(`[${HYPHEN_SPELLINGS}]`)

function normaliseInput(input: string): {
  text: string
  hadRangeDash: boolean
  hadNumberHyphen: boolean
} {
  const collapsed = input.replace(ODD_SPACES, " ").replace(/\s+/g, " ").trim()
  return {
    text: collapsed.replace(DASH_REPLACE, "-"),
    hadRangeDash: RANGE_DASH_TEST.test(collapsed),
    hadNumberHyphen: NUMBER_HYPHEN_TEST.test(collapsed),
  }
}

/**
 * The dash a number may contain, the dash that may join the two ends of a
 * range, and the same class with the dotted separator added.
 *
 * `parseSectionRef` folds every dash to a plain `-` before it matches, so
 * these widths only matter to the document scanner, which sees the typography
 * the author actually wrote. Too narrow and the scanner stops at the dash, so
 * `s 355‑25` comes back as `s 355` and `ss 5–6` as `ss 5` — a different
 * provision, reported without a word about the tail it dropped. Too wide and
 * it swallows the heading separator: see `HEADING_DASHES`.
 *
 * `NUMBER_HYPHEN` is the tighter of the two on purpose. It is the dash that
 * appears *within* a number, so it also decides what may precede the lettered
 * structural tail (`152-A`), and a heading dash there read
 * "Schedule 2—The Australian Consumer Law" — an FRL navLabel — as schedule
 * `2-The`.
 */
const NUMBER_HYPHEN = `[\\-${HYPHEN_SPELLINGS}]`
const RANGE_DASH = `[\\-${HYPHEN_SPELLINGS}${RANGE_DASHES}]`
const NUMBER_SEP = `[.\\-${HYPHEN_SPELLINGS}${RANGE_DASHES}]`

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
 * letter (`152-A`, `815-B`, `83A-C`), a plain or lettered arabic number
 * (`18`, `10AA`, `8AAZLGA`), or a roman part number (`IVA`).
 *
 * **Every component may carry letters, not just the last.** The Corporations
 * Act numbers 125 of its Parts `2A.1` … `2N.5` (and `2F.1A`), and the ITAA
 * 1997 names Subdivisions `83A-A` … `83A-E`; a digits-only rule for the front
 * of a compound did not merely reject them — the scanner truncated
 * `Part 2D.1` to the nonexistent `pt 2D`, and a citation checker then accused
 * a correct citation of being invented. The letters of a *compound* number
 * must be uppercase as every Act prints them (see
 * `hasLowercaseCompoundLetters`), so scanning prose case-insensitively does
 * not turn "5e-10" into a section.
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
const NUMBER_COMPONENT = `\\d{1,4}[A-Za-z]{0,${LETTER_RUN_MAX}}`
const NUMBER_PATTERN =
  `(?:${ROMAN_NUMBER}` +
  `|${NUMBER_COMPONENT}(?:${NUMBER_SEP}${NUMBER_COMPONENT}){0,3}` +
  `(?:${NUMBER_HYPHEN}[A-Za-z]{1,3}(?![A-Za-z0-9]))?)`

/** `(2)(a)(ii)` — at most six levels, each one `SUBDIVISION_TOKEN`. */
const SUBSECTION_PATTERN = `(?:\\s?\\(${SUBDIVISION_TOKEN}\\)){0,6}`

const DESIGNATOR = `(?:${SPELLING_ALTERNATION})`
const SCHEDULE_WORD = `(?:schedules|schedule|schs|sch)`

/**
 * What may sit between a designation and its number: whitespace, or nothing at
 * all when the number begins with a digit.
 *
 * `s18` is tolerated on input (see the module header) — but only when the
 * number is arabic. Glued to *letters*, a designation spelling is not a
 * designation at all: it is the front of an ordinary all-capitals word, and
 * every one of them was harvested as a pinpoint. `SIS` (the Superannuation
 * Industry (Supervision) Act's own everyday abbreviation) read as `s IS`,
 * `SIX` as `s IX`, `ARTIX` as `art IX`, `SCHIV` as `sch IV`, and once the
 * roman tail grew to three letters `PARTIES` — a word that appears verbatim in
 * the party block of every judgment — read as `pt IES`. Each phantom then
 * routes to a lookup that answers `[NOT_FOUND]` for a provision the document
 * never cited.
 *
 * The rule is one line rather than a list of blocked words on purpose: the
 * gap, not the vocabulary, is what tells a citation from a word, and a
 * spelling added to `KIND_VOCAB` tomorrow is covered the day it lands. Nobody
 * writes `sIV`; AGLC r 3.1.4 spaces every pinpoint, and the no-space
 * tolerance only ever existed for what a keyboard produces (`s18`).
 */
const NUMBER_GAP = `(?:\\s+|(?=\\d))`

/**
 * One provision expression, optionally prefixed by a schedule and optionally
 * carrying an `item`.
 */
const REF_BODY =
  `(?:${SCHEDULE_WORD}${NUMBER_GAP}(${NUMBER_PATTERN})\\s*[,\\-]?\\s*)?` + // schedule prefix
  `(${DESIGNATOR})${NUMBER_GAP}` +                               // designation
  `(${NUMBER_PATTERN})` +                                        // number
  `(?:\\s*${RANGE_DASH}\\s*(${NUMBER_PATTERN}))?` +              // spaced range end
  `(${SUBSECTION_PATTERN})` +                                    // (2)(a)
  `(?:\\s+items?\\s+(${NUMBER_PATTERN}))?`                       // sch 1 item 4

const ANCHORED_REF = new RegExp(`^${REF_BODY}$`, "i")

/** Bare `sub-s (2)` / `para (a)` — a designation whose number is bracketed. */
const BRACKETED_ONLY = new RegExp(`^(${DESIGNATOR})\\s*\\((${SUBDIVISION_TOKEN})\\)$`, "i")

/**
 * `sub-div B`, `div A` — structural units are sometimes lettered rather than
 * numbered.
 *
 * Three restrictions keep this out of ordinary prose, and all are
 * load-bearing: the letter must be **uppercase** (otherwise "part of" parses
 * as part "of"), the kind must be structural (a section is never a bare
 * letter), and the letter must be separated from the designation — glued, as
 * `NUMBER_GAP` explains, `PARTIES` is a word and not part "IES".
 */
const LETTERED_STRUCTURAL_KINDS: ReadonlySet<RefKind> = new Set<RefKind>([
  "part", "division", "subdivision", "chapter", "schedule", "appendix",
])
const LETTERED_STRUCTURAL = new RegExp(`^(${DESIGNATOR})\\s+([A-Z]{1,3})$`, "i")

/** `sch 2` on its own, or `sch 1 item 4`. */
const SCHEDULE_ONLY = new RegExp(
  `^${SCHEDULE_WORD}${NUMBER_GAP}(${NUMBER_PATTERN})` +
    `(?:\\s*[,\\-]?\\s*items?${NUMBER_GAP}(${NUMBER_PATTERN}))?$`,
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
 * Letters inside a *compound* number — `152-A`, `2D.1`, `83A-C`, `IV-V` —
 * must be uppercase, as every real Act prints them.
 *
 * The reason is the same one `LETTERED_STRUCTURAL` has: lowercase would make
 * "a s 3-in-1 test", "the s 18-based claim" and the scientific "5e-10"
 * provision numbers, and the caller would go on to report them as provisions
 * the Act does not contain. A number with no separator keeps the lowercase
 * tolerance (`s 10aa` is what a keyboard produces, and `splitLetterSuffix`
 * uppercases it), because a bare `10aa` has no prose reading to defend
 * against.
 */
function hasLowercaseCompoundLetters(number: string): boolean {
  if (!/[.\-]/.test(number)) return false
  const letters = number.match(/[A-Za-z]+/g) ?? []
  return letters.some((run) => run !== run.toUpperCase())
}

/**
 * Reject a roman number the writer did not capitalise.
 *
 * The grammar has to stay case-insensitive — designations are written
 * "Part IVA", "part IVA" and "PART IVA" — but that same insensitivity turns
 * every English word built from numeral letters into a provision number:
 * "the item is", "which sections mix", "div id attribute" parsed as items,
 * sections and divisions nobody cited, and each one routes to a lookup that
 * answers `[NOT_FOUND]` for a reference the document never contained.
 * AGLC r 3.1.4 writes roman pinpoints in capitals, so case is the signal —
 * the same rule `LETTERED_STRUCTURAL` applies to a bare lettered unit and the
 * same one `query-extract.ts` and `statute-citations.ts` settled on for their
 * own copies of this grammar. It belongs here, at the one choke point both
 * `parseSectionRef` and `extractSectionRefs` pass through, rather than in each
 * caller: `ROMAN_NUMBER`'s three-letter tail is only safe with it in place.
 *
 * Lower-case *subsections* (`s 51(xx)`) are untouched — a subsection is not
 * the number — and a lettered arabic number is uppercased by
 * `splitLetterSuffix`, so `s 10aa` still reads as `s 10AA`.
 */
function romanNumbersAreCapitalised(...parts: Array<string | undefined>): boolean {
  for (const part of parts) {
    if (!part || part === part.toUpperCase()) continue
    if (isRomanNumber(part.toUpperCase())) return false
  }
  return true
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
  const { text, hadRangeDash, hadNumberHyphen } = normaliseInput(input)
  if (!text) return null

  const scheduleOnly = SCHEDULE_ONLY.exec(text)
  if (scheduleOnly) {
    if (!romanNumbersAreCapitalised(scheduleOnly[1], scheduleOnly[2])) return null
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
  if (!romanNumbersAreCapitalised(rawNumber, schedule, spacedRangeEnd, item)) return null
  const plural = PLURAL_SPELLINGS.has(spelling.toLowerCase())

  // The hyphen decision. `NUMBER_PATTERN` is greedy, so `ss 5-6` arrives here
  // as the single number "5-6" and has to be split back out; `s 355-25` must
  // not be. A range dash always means "to"; a hyphen only does after a plural
  // — and a U+2010/U+2011 hyphen never does, whatever the plurality: it is
  // FRL typography, and FRL only ever sets it inside a number (see
  // `NUMBER_HYPHEN_TEST`). Without that veto, pasting the Register's own
  // "sections 165‑210 and 165‑211" read the real ITAA s 165-210 as the range
  // 165–210 and reported a correct citation as a provision the Act lacks.
  let numberText = rawNumber
  let rangeEnd = spacedRangeEnd as string | undefined
  if (!rangeEnd && (plural || hadRangeDash) && !(hadNumberHyphen && !hadRangeDash)) {
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

  if (hasLowercaseCompoundLetters(numberText)) return null

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
  // A bracketed kind wraps its number only when the number IS the bracketed
  // token (`sub-s (2)`, from the numberless "subsection (2)"). The
  // drafting-standard `subsection 5(2)` carries the section number too, and
  // wrapping *that* — `sub-s (5)` — renamed section 5's subsection (2) to
  // subsection (5) and dropped the (2) entirely: a different provision,
  // printed as the canonical form of a correct citation.
  const core =
    BRACKETED_KINDS.has(ref.kind) && ref.subsections.length === 0
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
 * hyphen) form has to accept both. It is the same class the number grammar
 * calls `NUMBER_HYPHEN`, and for the same reason: range and heading dashes
 * never occur inside a number, and admitting them would let `pt 2-1` match a
 * label that says something else.
 */
const LABEL_HYPHEN = NUMBER_HYPHEN

function labelNumber(value: string): string {
  return escapeForPattern(value).replace(/-/g, LABEL_HYPHEN)
}

/**
 * The number half of a label pattern — as an alternation when the reference
 * carries a range.
 *
 * A hyphen pair after a plural parses as a range, but by the time text
 * reaches the scanner nothing distinguishes a true range from an ITAA-style
 * section *name*: the Register writes "sections 165‑210 and 165‑211" for two
 * real sections whose serials exceed their division, `htmlToText` folds the
 * U+2011 that would have said so, and `runsBackwards` cannot help a forward
 * pair. The TOC is the only authority left, so the pattern asks it both
 * questions, most specific first: an Act with a section literally named
 * `165-210` answers with that section, an Act without one answers with the
 * range's start — and a lookup that used to answer "no such provision" for a
 * correctly cited ITAA section now cannot.
 */
function numberForLabel(ref: SectionRef): string {
  const number = `${ref.number}${ref.letterSuffix ?? ""}`
  if (!ref.rangeEnd) return labelNumber(number)
  return `(?:${labelNumber(`${number}-${ref.rangeEnd}`)}|${labelNumber(number)})`
}

/**
 * What may follow a worded label's number: anything but more of the number.
 *
 * A structural number continues past its first component in two ways, and
 * both have to be refused. `Subdivision 152` does not exist — the ITAA has
 * 152-A, 152-B, 152-C and 152-D — so letting `sub-div 152` match the first of
 * them answers a request for one subdivision with another one's text. The
 * *Corporations Act 2001* numbers the same shape with a stop: Chapter 5 has
 * Parts 5.1 to 5.9 and no bare Part 5, so a dot-blind guard answered
 * `pt 5` with Part 5.1's subtree.
 *
 * The separator between a label's number and its title is a heading dash,
 * never a hyphen or a stop-with-more-number after it, so this refuses nothing
 * a real navLabel offers — including the 1900 typography of
 * `"Schedule 1. Amendments"`, where the stop is followed by a space.
 */
const LABEL_CONTINUATION = `[.\\-${HYPHEN_SPELLINGS}]`
const LABEL_TAIL = `(?![0-9A-Za-z]|${LABEL_CONTINUATION}[0-9A-Za-z])`

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
  // A number-led label is followed by whitespace and then the heading,
  // optionally with a full stop between the two — or by nothing at all. The
  // lookahead, not the anchor, is what keeps `s 1` away from `18`.
  //
  // The optional stop is for the pre-Federation continued laws, which keep
  // their original typography: the *Commonwealth of Australia Constitution
  // Act* lists `"51. Legislative powers of the Parliament."`, so without it no
  // section of the Constitution could be fetched at all — while the alias
  // table's own note advertises `Australian Constitution s 51(xx)` as the way
  // to cite it. It is escaped and optional, so `s 51` still cannot reach `51A`
  // (no gap after the number) or `51.2` (no gap after the stop).
  //
  // The end-of-string arm is for the same Act's untitled sections: its real
  // NCX labels ss 86 and 87 as the bare `"86."` and `"87."`, and a pattern
  // that insisted on a heading answered "[NOT_FOUND] s 86 is not in the
  // latest table of contents" about a section that is in it.
  return new RegExp(`^${number}\\.?(?=${gap}|$)`)
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
 * where the match ends is not a reference this scanner reports. The
 * separator post-check below is the same rule for the *middle* of a number:
 * a match followed by `.4` or `-B` stopped short of the number the author
 * wrote (`Part 2D.1` once harvested as `pt 2D`), so it drops out whole.
 * Lowercase after the separator stays harvestable — "the s 18-based claim"
 * really does cite s 18, and no Act writes a number's letters in lowercase.
 *
 * The second pass is for the units the number grammar deliberately cannot
 * say: bare lettered structural units (`Subdivision C`, `Division DA`).
 * `ROMAN_NUMBER` refuses C/D/L/M so that scanned prose ("can", "did") cannot
 * become a number, which means the main scanner cannot see the Crimes Act's
 * real `Subdivision C` at all — it was dropped from scanned documents in
 * silence. `parseSectionRef` applies the real rules (structural kind only,
 * uppercase only), so this pass invents nothing the anchored grammar would
 * refuse; overlaps (e.g. `Part IVA`, which both passes read) are settled by
 * position, first and longest match wins.
 */
export function extractSectionRefs(text: string): SectionRef[] {
  if (!text) return []
  const scanner = new RegExp(`(?<![A-Za-z])${REF_BODY}(?![0-9A-Za-z])`, "gi")
  // The separator check lives outside the scanner because the scanner is
  // case-insensitive and this rule is not: `.4` or `-B` after a match is more
  // number (drop the match whole rather than serve its front half), while
  // `-based` is hyphenated prose and the match stands. As a post-check it
  // also cannot make the engine backtrack into a shorter phantom the way an
  // in-pattern lookahead would.
  const continuesNumber = new RegExp(`^${NUMBER_SEP}[0-9A-Z]`)
  const letteredScanner = new RegExp(
    `(?<![A-Za-z])(${DESIGNATOR})\\s+([A-Za-z]{1,3})(?![0-9A-Za-z])`,
    "gi",
  )

  const spans: Array<{ start: number; end: number; ref: SectionRef }> = []
  for (const match of text.matchAll(scanner)) {
    const end = match.index + match[0].length
    if (continuesNumber.test(text.slice(end, end + 2))) continue
    const ref = parseSectionRef(match[0].trim())
    if (ref) spans.push({ start: match.index, end, ref })
  }
  for (const match of text.matchAll(letteredScanner)) {
    // `parseSectionRef` enforces most of what makes this safe in prose: only
    // structural kinds are lettered, and only in uppercase ("part of" is not
    // part "OF", "PARTIES" has no gap). ALL-CAPS prose is the one context
    // where a short word slips past the uppercase gate — a judgment heading
    // reading "PART WAS" is not part "WAS" — so a multi-letter unit must show
    // the mixed-case typography every real citation uses ("Subdivision CA",
    // "sub-div CA"). A single letter stays harvestable from any case:
    // "SCHEDULE A" and "PART C" are how lettered schedules and parts are
    // actually set in the documents that carry them.
    const [, spelling, letters] = match
    if (letters.length > 1 && spelling === spelling.toUpperCase()) continue
    const ref = parseSectionRef(match[0].trim())
    if (ref) spans.push({ start: match.index, end: match.index + match[0].length, ref })
  }

  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: SectionRef[] = []
  let coveredTo = -1
  for (const span of spans) {
    if (span.start < coveredTo) continue
    out.push(span.ref)
    coveredTo = span.end
  }
  return out
}

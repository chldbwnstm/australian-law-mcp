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
  KIND_VOCAB,
  PLURAL_SPELLINGS,
  ROMAN_NUMBER,
  SERIES_UNIT_LETTER,
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

function normaliseInput(input: string): { text: string; hadRangeDash: boolean } {
  const collapsed = input.replace(ODD_SPACES, " ").replace(/\s+/g, " ").trim()
  return {
    text: collapsed.replace(DASH_REPLACE, "-"),
    hadRangeDash: RANGE_DASH_TEST.test(collapsed),
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
 * One component of a compound number: digits, then the letters that may
 * follow them.
 *
 * **The letters belong to the component, not to the end of the number.** A
 * compound number's *first* component carries them just as often as its last:
 * `__fixtures__/corporations-act-toc-slice.ncx` has 125 Part labels whose
 * number carries a letter (`2A.1` … `2N.5`, plus `2F.1A` and `5C.10`), the
 * ITAA 1997 has Subdivisions `83A-A` … `83A-E`, and sch 1 to the *Taxation
 * Administration Act 1953* has `12A-A` … `12A-C`.
 * Requiring digits on both sides of the separator did not merely reject those:
 * because the scanner's right-edge guard does not fire on a `.` or a `-`,
 * `Part 2D.1` was harvested as `pt 2D` and `Subdivision 83A-C` as
 * `sub-div 83A` — a *different* provision, handed to a citation checker that
 * answered `NOT_FOUND … has no pt 2D` about a correct citation.
 */
const NUMBER_COMPONENT = `\\d{1,4}[A-Za-z]{0,${LETTER_RUN_MAX}}`

/**
 * A provision number: an ITAA/ACL dotted-or-dashed form (`355-25`, `2.01`,
 * `42.02.2`, `2-1`, `2D.1`), an ITAA structural form whose dash is followed by
 * a letter (`152-A`, `815-B`, `83A-C`), a plain or lettered arabic number
 * (`18`, `10AA`, `8AAZLGA`), or a roman part number (`IVA`).
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

/**
 * The same units, as they have to be found in a document rather than handed
 * over as a whole reference.
 *
 * `REF_BODY` cannot carry this: it requires a `NUMBER_PATTERN`, and a bare
 * letter is not one — which is why `extractSectionRefs` returned nothing at
 * all for `Subdivision C—Common provisions`, `Division D` and `Subdivision
 * CA`/`DA`. There are 390 of them in the *Corporations Act 2001*'s recorded
 * table of contents alone. They did not come back as unreadable either: they
 * simply were not there, so `verify_citations` counted a document's citations
 * without them.
 *
 * Two things make a second pass safe where widening `ROMAN_NUMBER` was not:
 *
 *  - **The letters are matched case-sensitively.** The numbered scanner runs
 *    `/i` because "Part", "part" and "PART" all occur, and that is exactly
 *    what turned "the rules can be amended" into `rr CAN`. Here the
 *    designation spelling is spelled out case-insensitively by hand and the
 *    letters are not, so `part of` and `division and` cannot match at all.
 *  - **The letters are `SERIES_UNIT_LETTER`, not `[A-Z]`.** A structural
 *    series is lettered from the front of the alphabet — A to H across all
 *    13,861 navLabels of the five Acts measured — so `SCHEDULE OF FEES` and
 *    `PART TO BE REPEALED` cannot read as `sch OF` or `pt TO`.
 *
 * The anchored `LETTERED_STRUCTURAL` stays wider on purpose: there the caller
 * has already said the whole string is one reference, and there is no prose
 * for a letter run to be a word in.
 */
const LETTERED_STRUCTURAL_SPELLINGS = KIND_VOCAB
  .filter((entry) => LETTERED_STRUCTURAL_KINDS.has(entry.kind))
  .flatMap((entry) => entry.spellings)
  .sort((a, b) => b.length - a.length)

function eitherCase(word: string): string {
  return [...word]
    .map((char) => (/[a-z]/.test(char) ? `[${char}${char.toUpperCase()}]` : escapeForPattern(char)))
    .join("")
}

const LETTERED_STRUCTURAL_SCANNER = new RegExp(
  `(?<![A-Za-z])(?:${LETTERED_STRUCTURAL_SPELLINGS.map(eitherCase).join("|")})` +
    `[\\s\\u00a0]+${SERIES_UNIT_LETTER}{1,2}(?![0-9A-Za-z])`,
  "g",
)

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
 * How far apart the two ends of a *plain-hyphen* range may be.
 *
 * `runsBackwards` is only half the rule, and it is the half that happens to be
 * free. `ss 355-25` is rescued because 25 < 355; `ss 165-210` is not, and it
 * is one real ITAA 1997 section — the Act's own navLabel reads
 * "165-212E  Entry history rule does not apply for the purposes of sections
 * 165-210 and 165-211". Read as "sections 165 to 210" it becomes a lookup for
 * 46 provisions the ITAA does not have, reported back as an absence.
 *
 * Measured over all 4,621 dashed section numbers the ITAA 1997 (C2004A05138)
 * served on 2026-09-05: 3,374 already run backwards, and of the 1,247 that run
 * forward only 182 span 20 or less. So a 20-section ceiling reads 96% of the
 * Act's own section numbers correctly while still reading every range anyone
 * writes by hand — `ss 5-6`, `ss 20-22`, `ss 51-53` — as the range it is. The
 * residue (`s 4-15`, `s 20-25`) is genuinely undecidable from the text: those
 * strings are a range *and* a section number, and no grammar can tell.
 *
 * The ceiling applies only to the plain hyphen. An en dash, or any of the
 * other `RANGE_DASHES`, only ever means "to" (AGLC r 1.9), so `ss 165–210`
 * with a real dash is still the range the writer asked for, however wide.
 */
const HYPHEN_RANGE_SPAN_MAX = 20

function spansTooFarForAHyphen(from: string, to: string): boolean {
  const start = Number.parseInt(from, 10)
  const end = Number.parseInt(to, 10)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  return end - start > HYPHEN_RANGE_SPAN_MAX
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
  // not be. A range dash always means "to"; a hyphen only does after a plural,
  // and then only for a pair that reads as a range — see `isNotARange`.
  const subsections = parseSubsections(rawSubsections)
  const isNotARange = (from: string, to: string): boolean =>
    runsBackwards(from, to) ||
    // A range end never carries a bracketed subdivision: `paragraphs
    // 230-395(2)(c)` is paragraph (c) of subsection (2) of one ITAA section,
    // not "paragraphs 230 to 395" with a stray (2)(c) hanging off the end.
    subsections.length > 0 ||
    (!hadRangeDash && spansTooFarForAHyphen(from, to))
  let numberText = rawNumber
  let rangeEnd = spacedRangeEnd as string | undefined
  if (!rangeEnd && (plural || hadRangeDash)) {
    const split = RANGE_SPLIT.exec(rawNumber)
    if (split && !isNotARange(split[1], split[2])) {
      numberText = split[1]
      rangeEnd = split[2]
    }
  }
  if (rangeEnd && ((!plural && !hadRangeDash) || isNotARange(numberText, rangeEnd))) {
    // A spaced hyphen after a singular designation is still part of the number,
    // and so is a pair that is not a range — see `isNotARange`.
    numberText = `${numberText}-${rangeEnd}`
    rangeEnd = undefined
  }

  if (hasLowercaseDashedLetters(numberText)) return null

  const { number, letterSuffix } = splitLetterSuffix(numberText)

  return {
    kind: vocab.kind,
    number,
    ...(letterSuffix ? { letterSuffix } : {}),
    subsections,
    ...(schedule ? { schedule: splitLetterSuffix(schedule).number } : {}),
    ...(item ? { item } : {}),
    ...(rangeEnd ? { rangeEnd } : {}),
    plural,
    raw: text,
  }
}

/**
 * Designations AGLC writes with the number in brackets (r 3.1.4) — but only
 * when the bracketed token is the *whole* reference.
 *
 * `sub-s (2)` has no section number to hang the (2) off, so the bracket is all
 * there is. `subsection 5(2)` — the phrase Commonwealth drafting uses in
 * nearly every Act — does have one, and it is section 5's subsection (2).
 * Printing that as `sub-s (5)` moved the reference to a different provision
 * *and* dropped the (2), so a document saying "for the purposes of subsection
 * 5(2) of the Act" was routed to a lookup for a provision nobody cited. Which
 * form applies is decided by `ref.subsections`, not by the kind.
 */
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
  const core = BRACKETED_KINDS.has(ref.kind) && ref.subsections.length === 0
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

function numberForLabel(ref: SectionRef): string {
  return escapeForPattern(`${ref.number}${ref.letterSuffix ?? ""}`).replace(/-/g, LABEL_HYPHEN)
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
  // A number-led label is the number, then the heading — or nothing at all.
  // The lookahead, not the anchor, is what keeps `s 1` away from `18`.
  //
  // The optional stop is for the pre-Federation continued laws, which keep
  // their original typography: the *Commonwealth of Australia Constitution
  // Act* lists `"51. Legislative powers of the Parliament."`, so without it no
  // section of the Constitution could be fetched at all — while the alias
  // table's own note advertises `Australian Constitution s 51(xx)` as the way
  // to cite it. It is escaped and optional, so `s 51` still cannot reach `51A`
  // (no gap after the number) or `51.2` (no gap after the stop).
  //
  // `$` is there for the same document. Two of the Constitution's navLabels
  // are byte-exactly `"86."` and `"87."` — the number and its stop, no heading
  // text — and a lookahead that insisted on whitespace could not be satisfied
  // at the end of a string, so `get_law_text` answered `[LAW_NOT_FOUND] s 86
  // is not in the latest table of contents` about a section that is in it.
  // An absence this module reports has to be an absence it established.
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
 * where the match ends is not a reference this scanner reports.
 *
 * The second pass is `LETTERED_STRUCTURAL_SCANNER`, whose matches are dropped
 * wherever the first pass already found something: the two grammars overlap on
 * `Part I` and only the number-carrying one may win.
 */
export function extractSectionRefs(text: string): SectionRef[] {
  if (!text) return []
  const scanner = new RegExp(`(?<![A-Za-z])${REF_BODY}(?![0-9A-Za-z])`, "gi")
  const numbered = [...text.matchAll(scanner)].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }))

  // Both lists arrive sorted and internally non-overlapping, so one forward
  // pointer is enough to test each lettered hit against the numbered ones.
  const hits = [...numbered]
  let cursor = 0
  for (const match of text.matchAll(LETTERED_STRUCTURAL_SCANNER)) {
    const index = match.index
    const end = index + match[0].length
    while (cursor < numbered.length && numbered[cursor].end <= index) cursor++
    if (cursor < numbered.length && numbered[cursor].index < end) continue
    hits.push({ index, end, text: match[0] })
  }
  hits.sort((a, b) => a.index - b.index)

  const out: SectionRef[] = []
  for (const hit of hits) {
    const ref = parseSectionRef(hit.text.trim())
    if (ref) out.push(ref)
  }
  return out
}

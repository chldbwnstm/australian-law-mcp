/**
 * Pulling AGLC statute citations out of prose.
 *
 * The grammar is AGLC4 r 3.1 (docs/research §4.1): italicised short title
 * including the year, a bracketed jurisdiction, then a spaced pinpoint —
 * *Competition and Consumer Act 2010* (Cth) s 18. Real writing departs from it
 * constantly, and each departure below is one this module has to survive
 * because failing to extract a citation is worse than mis-extracting one: a
 * citation that is never extracted is never checked, and the report still says
 * everything was verified.
 *
 *  - **Markdown emphasis.** Models emit `*Fair Work Act 2009* (Cth)`.
 *  - **Pinpoint first.** "s 18 of the Competition and Consumer Act 2010 (Cth)".
 *  - **Abbreviations.** "CCA s 18", "ACL s 18" — and ACL s 18 is *sch 2* s 18,
 *    so an alias carrying a schedule rewrites the pinpoint.
 *  - **Anaphora.** "the Act", "that Act" inherit the last full citation, and
 *    only **within the same paragraph** — the reference implementation learned
 *    that inheriting across a blank line attributes a section to an Act the
 *    paragraph is not about, which is a worse answer than admitting ignorance.
 *  - **Locally defined short forms.** `Fair Work Act 2009 (Cth) ('FW Act')`
 *    binds `the FW Act` for the whole document; a definition is not paragraph
 *    scoped, because that is not how legal drafting reads it.
 *  - **Missing jurisdiction.** "Crimes Act s 61" names different law in New
 *    South Wales and Victoria. It is returned with no jurisdiction so the
 *    caller can report the ambiguity, never resolved by guessing.
 *
 *  - **More than one provision in one pinpoint.** "ss 45 and 46", "ss 45 to
 *    46", "ss 45, 46, 47" name two and three sections. Reading only the first
 *    is the same failure as not reading any of them, and worse, because the
 *    count then says one was found and one was checked.
 *
 * Parsing of the pinpoint itself is delegated to `lib/section-ref.ts`, which
 * owns that grammar. Only *locating* a pinpoint in prose lives here.
 *
 * ## Nothing located may be dropped in silence
 *
 * The scanner is deliberately more generous than the parser: it locates a
 * pinpoint-shaped run of text and `parseSectionRef` decides what it means. That
 * split leaves one failure mode, and it is the worst one this module has —
 * text that *is* a citation, that the scanner cannot read, and that therefore
 * never reaches the report at all, so `verify_citations` prints `[VERIFIED]`
 * over a document it only partly read.
 *
 * Two mechanisms, both structural, keep that from happening:
 *
 *  - **A right edge on every number.** A pinpoint that does not end where the
 *    match ends is not a match. Without it the scanner read `s 8AAZLGA` — a
 *    real *Taxation Administration Act 1953* section — as `s 8AAZL`, which is
 *    *also* a real section, and the checker ticked the citation off against
 *    that one's heading. `section-ref.ts` learned the same lesson in
 *    `extractSectionRefs`; this is the other half of it.
 *  - **`PINPOINT_SHAPE`, a wider net cast after the fact.** Every fragment it
 *    finds must be accounted for: consumed by the reader, or refused by the
 *    reader for a named reason. Anything else is returned as an unread
 *    citation (`attachedBy: "unread"`) and reported. A new gap in the reader —
 *    a number shape nobody anticipated, a designation the parser rejects —
 *    surfaces there by itself, rather than waiting for someone to notice a
 *    missing line.
 *  - **A list that stops names what is left.** `PINPOINT_SHAPE` cannot be that
 *    net for the members of a multi-provision pinpoint: past the first, a
 *    member is a bare number carrying no designation, so nothing after the
 *    point where the reader stops is findable again. Every place the list scan
 *    stops therefore walks the rest of the list itself and reports it as one
 *    unread span **with the count of members it covers** — see
 *    `remainderMembers`. Stopping at "ss 51AC, 52 and 53" and mentioning
 *    neither 52 nor 53, or reporting the thirteenth of twenty and nothing
 *    about the other seven, is the same `[VERIFIED]`-over-an-unread-document
 *    failure wearing a smaller number.
 *
 * The right edge only pays if the number grammar in front of it is the *same*
 * grammar `section-ref.ts` parses. Every place this file was narrower than the
 * parser was a way to truncate a real citation into a different real
 * provision: a four-letter tail cut `s 8AAZLGA` down to `s 8AAZL`; an
 * ASCII-only separator cut the Federal Register's own `s 355‑25` (U+2011) down
 * to `s 355`; no dash-letter form at all cut `Subdiv 152-A` down to
 * `sub-div 152`, which does not exist. All three were silent, and the checker
 * reported on the truncation as though it were the citation. The test file
 * enumerates the shapes and fails if scanner and parser ever disagree again.
 */

import { MONTH_ALTERNATION } from "../../lib/au-date-patterns.js"
import { ErrorCodes } from "../../lib/errors.js"
import { normaliseAliasKey, resolveLawAlias, type AliasJurisdiction } from "../../lib/law-alias.js"
import { formatRef, parseSectionRef, type SectionRef } from "../../lib/section-ref.js"
import {
  PLURAL_SPELLINGS,
  ROMAN_NUMBER,
  SPELLING_ALTERNATION,
  SUBDIVISION_TOKEN,
  isRomanNumber,
  kindForSpelling,
} from "../../lib/section-ref-vocab.js"
import { extractContentClaim, type ClaimSource } from "./content-claims.js"

export type { ClaimSource }

/** How the statute became attached to the pinpoint — printed, because it is evidence. */
export type Attachment =
  | "trailing-cite"
  | "leading-cite"
  | "abbreviation"
  | "short-form"
  | "anaphora"
  | "bare-name"
  | "none"
  /**
   * Not a citation at all: a pinpoint this scanner located and could **not**
   * read. It carries no `lawName` on purpose — see `unreadCitation`.
   */
  | "unread"

export interface StatuteCitation {
  /** The citation as the text writes it: `"CCA s 18"`. */
  raw: string
  /** Statute name exactly as written, before any alias resolution. */
  lawName?: string
  /** Jurisdiction written in the citation. Absent means the writer omitted it. */
  jurisdiction?: AliasJurisdiction
  /** Year written in the citation. */
  year?: number
  ref: SectionRef
  /** Canonical AGLC pinpoint, e.g. `"sch 2 s 18"`. */
  pinpoint: string
  attachedBy: Attachment
  /** The full citation an anaphora or short form resolved to. */
  antecedent?: string
  /** What the prose asserts this provision says. */
  claim?: string
  claimSource?: ClaimSource
  index: number
}

const JURISDICTION_TOKENS = "Cth|NSW|Vic|Qld|SA|WA|Tas|ACT|NT"

/**
 * The word a short title ends in. `Law` is here for the *Australian Consumer
 * Law*, the *Corporations Law* and the uniform state laws, which are bodies of
 * law rather than Acts and are cited by name; without it the one trap this
 * module exists for — ACL s 18 is CCA sch 2 s 18 — was never even attributed.
 *
 * It is guarded by the two properties every pattern below already has — the
 * match is **case sensitive**, so "the law s 5 says" is ordinary prose and
 * stays prose, and a preceding title body is **mandatory**, so a bare `Law`
 * cannot be a statute name on its own — and by `isTitleReading`, because a
 * mandatory title body still admits "this Law" and "Australian Law".
 */
const STATUTE_SUFFIX = "Acts?|Code|Constitution|Regulations|Regulation|Rules|Rule|Ordinance|Instrument|Determination|Bill|Law"

/**
 * The one short title that *is* its suffix word. AGLC r 3.6 cites the
 * Australian Constitution as "the Constitution", so the mandatory title body
 * in front of the suffix would otherwise make it — and only it — impossible to
 * attach to a pinpoint. `Act`, `Code` and `Law` are deliberately not here:
 * standing alone they are English words.
 */
const STANDALONE_TITLE = "Constitution"
const STANDALONE_TITLE_ONLY = new RegExp(`^${STANDALONE_TITLE}$`)

/**
 * Bounded number and subsection patterns. They mirror `section-ref.ts` because
 * the same grammar has to be *found* here and *parsed* there; `parseSectionRef`
 * stays the authority on meaning, and anything this scanner matches that it
 * rejects is reported as unread rather than dropped.
 *
 * The three dash classes are `section-ref.ts`'s, for its reasons: U+2010 and
 * U+2011 are typographic spellings of the plain hyphen and the Register sets
 * `s 355‑25` with one, the en/figure/minus dashes only ever mean "to", and the
 * em dash and horizontal bar are heading separators (`Part IVA—News media…`)
 * that must never join two numbers. Six letters of tail is that module's
 * `LETTER_RUN_MAX`, sized on `s 8AAZLGA`.
 *
 * The dash-letter tail is `[A-Z]` where the parser writes `[A-Za-z]`: the
 * parser scans case-insensitively and rejects a lowercase tail afterwards
 * (`hasLowercaseDashedLetters`), while this file is case sensitive throughout,
 * so requiring the capital here reads "the s 18-based claim" as `s 18` instead
 * of manufacturing an unreadable `s 18-based`.
 */
const LETTER_RUN_MAX = 6
const HYPHEN_SPELLINGS = "‐‑"
const RANGE_DASHES = "‒–−"
const NUMBER_SEP = `[.\\-${HYPHEN_SPELLINGS}${RANGE_DASHES}]`
const NUMBER_HYPHEN = `[\\-${HYPHEN_SPELLINGS}]`
const RANGE_DASH = `[\\-${HYPHEN_SPELLINGS}${RANGE_DASHES}]`
const ARABIC_NUMBER =
  `\\d{1,4}(?:${NUMBER_SEP}\\d{1,4}){0,3}` +
  `(?:${NUMBER_HYPHEN}[A-Z]{1,3}(?![A-Za-z0-9])|[A-Za-z]{0,${LETTER_RUN_MAX}})`
const NUMBER = `(?:${ROMAN_NUMBER}|${ARABIC_NUMBER})`
const SUBSECTIONS = `(?:\\s?\\(${SUBDIVISION_TOKEN}\\)){0,6}`
const SCHEDULE_WORD = `(?:[Ss]chedules|[Ss]chedule|[Ss]chs|[Ss]ch)`
/** A four-digit year: what a titled instrument carries where a pinpoint carries a number. */
const YEAR_ONLY = /^(?:1[89]|20)\d{2}$/

/**
 * The number as it may follow a designation — the roman branch guarded on
 * **both** edges.
 *
 * `ROMAN_NUMBER` (the vocabulary module owns it) is a numeral with up to three
 * letters of tail — `IVA`, `IIIAA`, `IABA`, all real Commonwealth Parts — and
 * that is also the tail of a great many all-caps Australian abbreviations, with
 * a designation spelling for its first letter: `SIS` reads as `s IS`, `SDA` as
 * `s DA`, `RDA` as `r DA`, `SIX` as `s IX`, `SCHEDULE` as `s CH`. Each inherits
 * whatever Act the sentence already cited and is reported as a provision that
 * Act does not have — `verify_citations` accusing correct prose of inventing a
 * section, which is the one answer this server must never give. They also
 * spend the `maxCitations` budget, pushing the real citations out.
 *
 * So a roman pinpoint must be **separated** from its designation (AGLC r 3.1.4
 * writes a space: `pt IVA`, `s IV`, never `sIV`) and must not run on into a
 * word (`SCH` inside `SCHEDULE`). `lib/query-extract.ts` guards the same
 * grammar the same way — `romanNumbersAreCapitalised` plus `isWholeWordRef` —
 * for queries; this is the document-scanner half of it.
 *
 * Arabic numbers keep both liberties on purpose: `s18` is written that way,
 * and `s 10AA` legitimately ends in letters.
 */
const PINPOINT_NUMBER = `(?:(?<=\\s)${ROMAN_NUMBER}(?![A-Za-z])|${ARABIC_NUMBER})`

/**
 * Designation spellings accepting either case of the first letter, and **only**
 * the first letter.
 *
 * A case-insensitive flag over the whole pattern would make `ROMAN_NUMBER`
 * case-insensitive too, and then ordinary English becomes pinpoints: "See
 * Smith v Jones" parses as `s mit` (the `s` designation plus a lowercase roman
 * "mit"), and "s 18 applies" parses a second citation `app lie`. Both were
 * observed. Roman numerals in AGLC pinpoints are uppercase, so the flag goes
 * and the designations carry their own alternation instead.
 */
const SPELLINGS = SPELLING_ALTERNATION.split("|")
  .map((spelling) => `[${spelling[0].toUpperCase()}${spelling[0]}]${spelling.slice(1)}`)
  .join("|")

/**
 * A pinpoint anywhere in prose. The lookbehind keeps the `s` of "Acts" out,
 * and `PINPOINT_NUMBER` keeps an all-caps acronym from becoming a roman one.
 * The second branch is the bracketed form (`sub-s (2)`, `para (a)`), which has
 * no number of its own — without it those references are never extracted, and
 * an unextracted citation is one the report silently claims to have checked.
 *
 * The trailing `(?![0-9A-Za-z])` is the right edge described at the top of the
 * file: a number this grammar can only read *part* of is not read at all, and
 * `PINPOINT_SHAPE` then reports the whole fragment as unread. Truncating is the
 * one outcome that must not happen, because the truncation is usually a real
 * provision of the same Act and the checker ticks the citation off against it.
 *
 * Groups: 1 schedule prefix as written, 2 designation, 3 number, 4 designation
 * of the bracketed branch, 5 its token. The schedule prefix, the designation
 * and the token are captured because a multi-provision pinpoint ("sch 2 ss 18
 * and 29", "sub-ss (2) and (3)") has to rebuild each member of the list.
 */
const PINPOINT = new RegExp(
  `(?<![A-Za-z])(?:` +
    `(${SCHEDULE_WORD}\\s*${NUMBER}\\s*[,\\-]?\\s*)?` +
    `(${SPELLINGS})\\s*(${PINPOINT_NUMBER})` +
    `(?:\\s*${RANGE_DASH}\\s*${NUMBER})?` +
    SUBSECTIONS +
    `(?![0-9A-Za-z])` +
    `|(${SPELLINGS})\\s?\\((${SUBDIVISION_TOKEN})\\)` +
    `)`,
  "g",
)

/**
 * The wider net: a designation followed by *something number-shaped*, with the
 * same guards against acronyms and none of the guards about what a number may
 * contain.
 *
 * It exists to be compared against what the reader actually did. A fragment
 * this finds that no reading consumed and no named refusal covers is a hole in
 * the reader, and `extractStatuteCitations` returns it as an unread citation
 * rather than letting the document go out one citation shorter than it came in.
 *
 * The roman branch keeps the two guards that make roman numerals safe here —
 * a space in front (so `SIS` is not `s IS`) and a word edge behind — and it is
 * **`ROMAN_NUMBER` plus a near miss**, never a second spelling of it.
 *
 * Written out here the branch was `[IVX][A-Z]{0,9}`. It agreed with the
 * vocabulary on all 1,344 structural tokens in `src/lib/__fixtures__` and
 * disagreed at the top of the range, because a ceiling written down beside a
 * grammar cannot follow it: `ROMAN_NUMBER` reaches eleven characters
 * (`XXXVIII` and a four-letter series tail) and the literal stopped at ten, so
 * `pt XXXVIIIAABZ` — a tail one letter outside the series class, which the
 * reader therefore refuses — matched neither the reader nor the net and left
 * the report altogether. `ROMAN_NUMBER` was widened in round 6 from all
 * 126,207 navLabels of the statute book; a literal standing beside it is a
 * hole waiting for the next measurement.
 *
 * The `[A-Z]{0,4}` is the near miss, and it is what makes this a net rather
 * than a copy of the reader: the vocabulary's own tail runs to four letters, so
 * a pinpoint written with a longer one, or with a tail outside the series
 * class, is exactly what has to be caught and reported. The slack is bounded
 * for the same reason the vocabulary's is — every fragment this finds prints a
 * `[PARSE_ERROR]` line, and an unbounded tail would read ordinary capitalised
 * prose as a pinpoint the document never contained. Starting from
 * `ROMAN_NUMBER` also inherits its refusal of the `L`/`C`/`D`/`M` readings for
 * free, which is what kept `s CIVIL` and `r MILD` out.
 */
const PINPOINT_SHAPE = new RegExp(
  `(?<![A-Za-z])(?:${SPELLINGS})\\s*` +
    `(?:(?<=\\s)${ROMAN_NUMBER}[A-Z]{0,4}|\\d[0-9A-Za-z]{0,12}(?:${NUMBER_SEP}[0-9A-Za-z]{1,8}){0,4})` +
    `(?![0-9A-Za-z])`,
  "g",
)

/**
 * Characters a short title may contain between its first capital and the
 * `Act`/`Code`/… word.
 *
 * **Digits are excluded on purpose.** The capture is lazy and unanchored, so
 * with digits allowed a second citation on the same line makes the pattern
 * swallow the first one whole ("… Act 2010 (Cth) s 18 and again Competition and
 * Consumer Act"). Almost no Australian short title carries a digit before its
 * year; the handful that do (`Statute Law Revision Act (No 1) 2015`) lose their
 * bracketed number here and are still resolved by the shortened readings that
 * `statuteNameCandidates` produces.
 */
const TITLE_BODY = "[^;*_\\n0-9]"

/** A short title: capitalised body then a suffix word, or a standalone title. */
const STATUTE_NAME = `(?:[A-Z]${TITLE_BODY}{2,110}?(?:${STATUTE_SUFFIX})|${STANDALONE_TITLE})`

/** A complete citation: title, year, jurisdiction. Markdown emphasis tolerated. */
const FULL_CITE = new RegExp(
  `[*_]{0,2}(${STATUTE_NAME})\\s+((?:1[89]|20)\\d{2})[*_]{0,2}\\s*\\(\\s*(${JURISDICTION_TOKENS})\\s*\\)`,
  "g",
)

/** The same shape anchored to the end of the lookback window. */
const FULL_CITE_TAIL = new RegExp(
  `[*_]{0,2}(${STATUTE_NAME})\\s+((?:1[89]|20)\\d{2})[*_]{0,2}\\s*\\(\\s*(${JURISDICTION_TOKENS})\\s*\\)[\\s,]{0,4}$`,
)

/** `the Act`, `that Act`, `the same Act` — the pronoun forms. */
const ANAPHORA_TAIL = /(?:^|[^A-Za-z])(?:the|that|this|said)\s+(?:same\s+|said\s+)?(Act|Code|Regulations|Rules)[\s,]{0,4}$/i

/** A named statute with no jurisdiction: `Crimes Act 1900`, `FW Act`. */
const BARE_NAME_TAIL = new RegExp(
  `[*_]{0,2}(${STATUTE_NAME})[*_]{0,2}(?:\\s+((?:1[89]|20)\\d{2}))?[\\s,]{0,4}$`,
)

/**
 * A bare abbreviation immediately before a pinpoint: `CCA s 18`.
 *
 * The optional digits and year are how the tax Acts are abbreviated — `ITAA97`
 * and `ITAA 1997` are both alias-table entries, and a letters-only token could
 * reach neither, so the two most-cited Commonwealth Acts in the country were
 * never attached to their pinpoints. Only tokens `isKnownAlias` recognises are
 * accepted, so widening the shape cannot invent a statute.
 */
const ABBREVIATION_TAIL = /(?:^|[^A-Za-z])([A-Z][A-Za-z]{1,7}\d{0,4}(?:\s+(?:1[89]|20)\d{2})?)[\s,]{0,3}$/

/** `s 18 of the Competition and Consumer Act 2010 (Cth)` / `s 18 of the CCA`. */
const OF_THE_LEAD = new RegExp(
  `^[\\s,]{0,4}of\\s+(?:the\\s+)?(?:[*_]{0,2}(${STATUTE_NAME})[*_]{0,2}` +
    `(?:\\s+((?:1[89]|20)\\d{2}))?(?:\\s*\\(\\s*(${JURISDICTION_TOKENS})\\s*\\))?` +
    `|([A-Z]{2,7})\\b)`,
)

/** `Fair Work Act 2009 (Cth) ('FW Act')` — a short form defined in the text. */
const SHORT_FORM_DEFINITION = /^\s*\(\s*["'‘“]?(?:the\s+)?([A-Z][A-Za-z ]{1,30}?)["'’”]?\s*\)/

/** Designations spelled as full words. A four-digit year after one is a title, not a pinpoint. */
const WORD_SPELLING = /^(?:sections?|regulations?|rules?|schedules?|parts?|divisions?|chapters?|clauses?|articles?|items?|orders?|appendix|appendices|subdivisions?|paragraphs?|subsections?)$/i

/**
 * Prose words that can precede a short title. `a` and `an` are deliberately
 * absent: *A New Tax System (Goods and Services Tax) Act 1999* begins with one,
 * and trimming it would corrupt a real title.
 */
const LEADING_FILLER = new Set([
  "under", "the", "in", "into", "see", "per", "of", "by", "to", "and", "or", "but", "however",
  "also", "note", "this", "that", "these", "those", "pursuant", "according", "at", "from", "for",
  "with", "within", "both", "cf", "eg", "ie", "its", "their", "our", "his", "her", "whether",
  "when", "where", "while", "since", "because", "although", "though", "then", "thus", "therefore",
  "hence", "so", "as", "is", "was", "are", "were", "be", "been", "being", "said", "such",
  "relevant", "current", "applicable", "contrary", "namely", "eg.", "ie.",
])

/** Maximum leading words dropped when shortening a capture. */
const MAX_NAME_DROPS = 8

/**
 * Progressively shorter readings of a captured title, longest first.
 *
 * The capture starts at the leftmost capital letter that can reach an `Act`, so
 * "The accused was charged under the Crimes Act" is a normal capture. The full
 * reading comes first — some short titles really do begin with an article — and
 * the caller takes the first candidate that resolves rather than trusting a cut.
 */
export function statuteNameCandidates(name: string): string[] {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let start = 0; start < words.length && start <= MAX_NAME_DROPS; start++) {
    const candidate = words.slice(start).join(" ")
    if (candidate.length >= 4 && /\s/.test(candidate)) out.push(candidate)
  }
  return out.length > 0 ? out : [name.trim()]
}

/**
 * Drop leading prose words. Never touches `A`/`An`.
 *
 * It trims down to a single word and lets `isTitleReading` judge the result. A
 * floor cannot do that judging: stopping two words early leaves the filler word
 * standing *inside* the name, so "Under this Law s 5" became a statute called
 * `this Law` — blocking the bare word `Law` while admitting every prose phrase
 * that ends in it.
 */
function trimLeadingFiller(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  let start = 0
  while (start < words.length - 1 && LEADING_FILLER.has(words[start].toLowerCase().replace(/[^a-z.]/g, ""))) start++
  return words.slice(start).join(" ")
}

/**
 * Is this reading a short title, or prose that happens to end in a suffix word?
 *
 * Two readings are refused:
 *
 *  - **One word**, unless it is the title that stands alone (r 3.6, "the
 *    Constitution"). `Act`, `Code` and `Law` on their own are English.
 *  - **Two words ending in `Law`**, unless `law-alias.ts` vouches for them.
 *    `Law` is the only suffix in `STATUTE_SUFFIX` that announces no enactment
 *    of its own, so "Australian Law" and "this Law" are exactly as good a
 *    match for it as a real body of law is. The *Australian Consumer Law* —
 *    the reason `Law` is a suffix at all, because its s 18 is CCA sch 2 s 18 —
 *    is three words and passes on its own, and any shorter body of law passes
 *    by being in the alias table. That is the right place to teach this module
 *    a new one; widening a regex here brings the prose back with it.
 *
 * A refused reading is not an error: the caller falls through to the other
 * attachments and, failing those, reports that no statute was named.
 */
function isTitleReading(name: string): boolean {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 0) return false
  if (words.length === 1) return STANDALONE_TITLE_ONLY.test(words[0])
  if (words.length === 2 && words[1] === "Law") return isKnownAlias(name)
  return true
}

/**
 * The reading of a captured title to work with: the longest candidate the alias
 * table recognises, or — when none is recognised — the capture with leading
 * prose trimmed off. Resolution upstream still gets a shortened list to try.
 */
export function preferredStatuteName(name: string): string {
  for (const candidate of statuteNameCandidates(name)) {
    if (resolveLawAlias(candidate).candidates.length > 0) return candidate
  }
  return trimLeadingFiller(name)
}

interface FullCite {
  name: string
  year: number
  jurisdiction: AliasJurisdiction
  start: number
  end: number
  raw: string
}

function toJurisdiction(token: string): AliasJurisdiction {
  const upper = token.toUpperCase()
  if (upper === "CTH") return "Cth"
  if (upper === "NSW") return "NSW"
  if (upper === "VIC") return "Vic"
  if (upper === "QLD") return "Qld"
  if (upper === "SA") return "SA"
  if (upper === "WA") return "WA"
  if (upper === "TAS") return "Tas"
  if (upper === "ACT") return "ACT"
  return "NT"
}

/** Every complete citation in the text, with its position. */
export function findFullCites(text: string): FullCite[] {
  const out: FullCite[] = []
  FULL_CITE.lastIndex = 0
  for (const match of text.matchAll(FULL_CITE)) {
    const index = match.index ?? 0
    const name = preferredStatuteName(match[1].trim())
    const jurisdiction = toJurisdiction(match[3])
    out.push({
      name,
      year: Number(match[2]),
      jurisdiction,
      start: index,
      end: index + match[0].length,
      raw: `${name} ${match[2]} (${jurisdiction})`,
    })
  }
  return out
}

/** Short forms the text defines for itself, e.g. `('FW Act')` after a full cite. */
export function findShortForms(text: string, cites: readonly FullCite[]): Map<string, FullCite> {
  const out = new Map<string, FullCite>()
  for (const cite of cites) {
    const match = SHORT_FORM_DEFINITION.exec(text.slice(cite.end, cite.end + 48))
    if (!match) continue
    const key = normaliseAliasKey(match[1])
    if (key.length >= 2 && !out.has(key)) out.set(key, cite)
  }
  return out
}

/** True when a blank line separates the two offsets — the anaphora boundary. */
function paragraphBroke(text: string, from: number, to: number): boolean {
  return /\n[ \t]*\n/.test(text.slice(from, to))
}

interface Attribution {
  lawName?: string
  jurisdiction?: AliasJurisdiction
  year?: number
  attachedBy: Attachment
  antecedent?: string
  /** Where in the source the citation begins, for building `raw`. */
  citeStart: number
  /** Schedule the resolved alias forces onto the pinpoint (the ACL is CCA sch 2). */
  schedule?: string
}

/** Does this token resolve in the alias table? Used to accept a bare abbreviation. */
function isKnownAlias(token: string): boolean {
  return resolveLawAlias(token).candidates.length > 0
}

/** The schedule an unambiguous alias pins the reference to (ACL → sch 2). */
function aliasSchedule(name: string): string | undefined {
  const resolution = resolveLawAlias(name)
  if (resolution.needsJurisdiction || resolution.candidates.length === 0) return undefined
  return resolution.candidates[0].sch
}

const LOOKBACK = 150
const LOOKAHEAD = 200

function attribute(
  text: string,
  pinpointStart: number,
  pinpointEnd: number,
  cites: readonly FullCite[],
  shortForms: ReadonlyMap<string, FullCite>,
): Attribution {
  const lookback = text.slice(Math.max(0, pinpointStart - LOOKBACK), pinpointStart)
  const lookbackStart = Math.max(0, pinpointStart - LOOKBACK)

  const trailing = FULL_CITE_TAIL.exec(lookback)
  if (trailing) {
    const captured = trailing[1].trim()
    const name = preferredStatuteName(captured)
    return {
      lawName: name,
      year: Number(trailing[2]),
      jurisdiction: toJurisdiction(trailing[3]),
      attachedBy: "trailing-cite",
      citeStart: lookbackStart + lookback.indexOf(captured, trailing.index ?? 0) + (captured.length - name.length),
    }
  }

  const leading = OF_THE_LEAD.exec(text.slice(pinpointEnd, pinpointEnd + LOOKAHEAD))
  if (leading) {
    const abbreviation = leading[4]
    if (abbreviation && isKnownAlias(abbreviation)) {
      return {
        lawName: abbreviation,
        attachedBy: "leading-cite",
        citeStart: pinpointStart,
        ...(aliasSchedule(abbreviation) ? { schedule: aliasSchedule(abbreviation) } : {}),
      }
    }
    if (leading[1]) {
      const name = preferredStatuteName(leading[1].trim())
      if (!isTitleReading(name)) return { attachedBy: "none", citeStart: pinpointStart }
      return {
        lawName: name,
        ...(leading[2] ? { year: Number(leading[2]) } : {}),
        ...(leading[3] ? { jurisdiction: toJurisdiction(leading[3]) } : {}),
        attachedBy: "leading-cite",
        citeStart: pinpointStart,
        ...(aliasSchedule(name) ? { schedule: aliasSchedule(name) } : {}),
      }
    }
  }

  // Pronoun anaphora, before the bare-name reading: "That Act" would otherwise
  // be captured as a statute called "That Act".
  if (ANAPHORA_TAIL.test(lookback)) {
    const antecedent = lastCiteBefore(cites, pinpointStart)
    if (antecedent && !paragraphBroke(text, antecedent.end, pinpointStart)) {
      return {
        lawName: antecedent.name,
        year: antecedent.year,
        jurisdiction: antecedent.jurisdiction,
        attachedBy: "anaphora",
        antecedent: antecedent.raw,
        citeStart: pinpointStart,
      }
    }
    return { attachedBy: "anaphora", citeStart: pinpointStart }
  }

  const bare = BARE_NAME_TAIL.exec(lookback)
  if (bare) {
    const captured = bare[1].trim()
    const capturedAt = lookback.indexOf(captured, bare.index ?? 0)
    // Shortest-first here, unlike resolution: a locally defined short form is a
    // suffix of the capture ("… paragraph the FW Act" defines "FW Act"), and the
    // longer readings are prose that was swallowed on the way to it.
    for (const candidate of [...statuteNameCandidates(captured)].reverse()) {
      const defined = shortForms.get(normaliseAliasKey(candidate))
      if (!defined) continue
      return {
        lawName: defined.name,
        year: defined.year,
        jurisdiction: defined.jurisdiction,
        attachedBy: "short-form",
        antecedent: defined.raw,
        citeStart: lookbackStart + capturedAt + (captured.length - candidate.length),
      }
    }
    const name = preferredStatuteName(captured)
    // A refused reading falls through rather than returning: "Under this Law"
    // is prose, but the abbreviation below may still name a statute.
    if (isTitleReading(name)) {
      return {
        lawName: name,
        ...(bare[2] ? { year: Number(bare[2]) } : {}),
        attachedBy: "bare-name",
        citeStart: lookbackStart + capturedAt + (captured.length - name.length),
        ...(aliasSchedule(name) ? { schedule: aliasSchedule(name) } : {}),
      }
    }
  }

  const abbreviation = ABBREVIATION_TAIL.exec(lookback)
  if (abbreviation) {
    const token = abbreviation[1]
    const defined = shortForms.get(normaliseAliasKey(token))
    if (defined) {
      return {
        lawName: defined.name,
        year: defined.year,
        jurisdiction: defined.jurisdiction,
        attachedBy: "short-form",
        antecedent: defined.raw,
        citeStart: lookbackStart + lookback.lastIndexOf(token),
      }
    }
    if (isKnownAlias(token)) {
      return {
        lawName: token,
        attachedBy: "abbreviation",
        citeStart: lookbackStart + lookback.lastIndexOf(token),
        ...(aliasSchedule(token) ? { schedule: aliasSchedule(token) } : {}),
      }
    }
  }

  return { attachedBy: "none", citeStart: pinpointStart }
}

function lastCiteBefore(cites: readonly FullCite[], index: number): FullCite | undefined {
  let found: FullCite | undefined
  for (const cite of cites) {
    if (cite.end <= index) found = cite
    else break
  }
  return found
}

/** A half-open span of the source text. */
interface Span {
  start: number
  end: number
}

/**
 * Do any of `spans` overlap `span`, given both sequences are read in order?
 *
 * A linear sweep rather than a scan of the whole list per fragment: the caller
 * runs this over every pinpoint-shaped fragment of a whole document against
 * every span the reader accounted for, and the quadratic form took 450 ms on a
 * 160 KB brief. `cursor` and `coveredTo` carry between calls, which is why this
 * is a closure and not a predicate.
 */
function overlapSweep(spans: readonly Span[]): (span: Span) => boolean {
  const sorted = [...spans].sort((left, right) => left.start - right.start)
  let cursor = 0
  let coveredTo = -1
  return (span) => {
    while (cursor < sorted.length && sorted[cursor].start < span.end) {
      coveredTo = Math.max(coveredTo, sorted[cursor].end)
      cursor++
    }
    return coveredTo > span.start
  }
}

/**
 * The shape of a provision number, which is the signal a list continuation is
 * judged against.
 *
 * A list continues only while its items keep the shape of the first, because
 * the alternative — accepting whatever number follows a comma — harvests
 * ordinary prose: "under s 18, 3 March 2020" would yield a citation to `s 3`,
 * and a fabricated citation reported as one the reader wrote is worse than a
 * missed one. Same-shape is the narrow rule; anything else is either stopped
 * (a bare number, which is what prose looks like) or reported unread (a number
 * carrying letters or separators, which prose does not look like).
 */
type NumberShape = "roman" | "compound" | "lettered" | "plain" | "other"

function numberShape(value: string): NumberShape {
  if (value === value.toUpperCase() && isRomanNumber(value)) return "roman"
  if (/^\d{1,4}$/.test(value)) return "plain"
  if (new RegExp(`^\\d{1,4}[A-Za-z]{1,${LETTER_RUN_MAX}}$`).test(value)) return "lettered"
  if (new RegExp(`^\\d{1,4}(?:${NUMBER_SEP}[0-9A-Za-z]{1,4}){1,3}$`).test(value)) return "compound"
  return "other"
}

/**
 * May a member of this shape continue a list whose head had `headShape`?
 *
 * "Only an identical shape" was the earlier answer, and it refused two things
 * at once when only one of them deserved it:
 *
 *  - **A bare number after a differently-shaped head is still refused.** A bare
 *    number is exactly what prose looks like, which is the whole reason the
 *    shape rule exists ("ss 18, 3 March 2020"), and nothing about the head
 *    makes the number after the comma any less ambiguous.
 *  - **A lettered, dotted or dashed number is not refused any more.** `46A`,
 *    `45D`, `355-30` are unambiguously provision numbers — no English sentence
 *    puts one after a comma or an "and" — and `parseSectionRef` reads every one
 *    of them. "ss 45 and 46A" names two sections of the same Act, and refusing
 *    the second cost the report a citation it had already located.
 *
 * Roman and arabic stay apart in both directions: they are different numbering
 * series, so a roman member of an arabic list is not another member of the same
 * list, and `other` is a shape no reading here can use.
 *
 * A refusal is never the end of the story — see `remainderMembers`. What this
 * function declines to read is reported, not dropped.
 */
function continuesList(headShape: NumberShape, shape: NumberShape): boolean {
  if (shape === "other" || headShape === "other") return false
  if (shape === headShape) return true
  if (shape === "roman" || headShape === "roman") return false
  return shape !== "plain"
}

/** At most this many continuations of one pinpoint. A list is a citation, not a corpus. */
const MAX_LIST_ITEMS = 12

/**
 * The dash a `to` join is re-rendered with when its two ends are merged back
 * into one reference for `parseSectionRef`.
 *
 * `section-ref.ts` gives the plain hyphen two roles at once — the character
 * *inside* an ITAA-style number (`s 355-25`) and the range dash a keyboard
 * produces — so a hyphenated pair is genuinely ambiguous and that module
 * resolves it conservatively, by arithmetic and by width. A member of
 * `RANGE_DASHES` has only the one role: between two numbers it always means
 * "to" (AGLC r 1.9), whatever the two numbers are.
 *
 * Which is exactly the writer's own evidence here. Someone who typed "ss 100
 * to 140" left nothing to disambiguate, so handing the parser a hyphen threw
 * that evidence away and put the sentence through a rule written for a
 * different problem: `ss 5 to 8` merged and `ss 100 to 140` came back as two
 * citations, `ss 100` and `s 140`, neither of them text the document contains
 * and neither of them saying a word about ss 101–139 — the reading changing
 * silently at a width the writer never wrote.
 */
const RANGE_JOIN = "–"

/**
 * How the next member of a multi-provision pinpoint may be joined to the last:
 * `ss 45 and 46`, `ss 45 & 46`, `ss 45, 46, 47`, `ss 45, 46 and 47`,
 * `ss 45 to 46`. Group 1 is the join, 2 the number, 3 any subsections.
 *
 * Sticky, not global: a continuation is only a continuation when it sits
 * immediately after the item before it, and the lookbehind inside
 * `PINPOINT_NUMBER` still sees the real text to its left.
 */
const LIST_ITEM = new RegExp(
  `(\\s*,\\s*(?:and\\s+|&\\s*)?|\\s+and\\s+|\\s*&\\s*|\\s+to\\s+)(${PINPOINT_NUMBER})(${SUBSECTIONS})(?![0-9A-Za-z])`,
  "y",
)

/**
 * A date immediately after a candidate list item: "ss 18, 3 March 2020".
 *
 * This is the harvest the comma form risks, and the month word is the thing
 * that gives it away. `au-date-patterns.ts` owns the month vocabulary.
 */
const DATE_TAIL = new RegExp(`^\\s{1,3}(?:${MONTH_ALTERNATION})\\b`, "i")

/** `3rd`, `13th` — an English ordinal is prose (usually the rest of a date), never a provision. */
const ORDINAL = /^\d{1,4}(?:st|nd|rd|th)$/i

interface ListItem extends Span {
  number: string
  subsections: string
  /** `ss 45 to 46` — this item is the far end of a range, not a second citation. */
  joinsAsRange: boolean
  /** `sub-ss (2) and (3)` — the member is a bracketed token, not a number. */
  bracketed?: boolean
}

interface ListScan {
  items: ListItem[]
  /** Located, provision-shaped, and deliberately not read — reported, never dropped. */
  unread?: Span
  /** How many members `unread` covers, so the report can name the count rather than imply one. */
  unreadCount?: number
}

/**
 * Where the reader stopped is not where the list ended.
 *
 * Stopping used to mean returning the one member that caused the stop, and
 * every member after it was never looked at and never mentioned:
 * "ss 51AC, 52 and 53" reported `ss 51AC` alone, and a twenty-section list
 * reported thirteen sections plus a single unread `353` while 354–359
 * disappeared. Both read to `verify_citations` as a complete count of a text it
 * had only partly read, which is the one thing this module exists to prevent.
 *
 * So the members past the stop are walked — with the same joins and the same
 * refusals, and reading nothing — and returned as one span with the true count.
 * The refusals are repeated deliberately: a date or a year that ends a list is
 * prose the reader correctly declined, and renaming it an unread provision
 * would put a `[PARSE_ERROR]` on ordinary writing.
 */
function remainderMembers(text: string, from: number, headNumber: string): Span[] {
  const members: Span[] = []
  let cursor = from
  for (;;) {
    LIST_ITEM.lastIndex = cursor
    const match = LIST_ITEM.exec(text)
    if (!match) break
    const end = LIST_ITEM.lastIndex
    const start = end - (match[2].length + match[3].length)
    const number = match[2]
    if (DATE_TAIL.test(text.slice(end, end + 12)) || ORDINAL.test(number)) break
    if (YEAR_ONLY.test(number) && !YEAR_ONLY.test(headNumber)) break
    members.push({ start, end })
    cursor = end
  }
  return members
}

/** A run of located-but-unread members as the one span and count a report shows. */
function unreadRun(members: readonly Span[]): Pick<ListScan, "unread" | "unreadCount"> {
  if (members.length === 0) return {}
  return {
    unread: { start: members[0].start, end: members[members.length - 1].end },
    unreadCount: members.length,
  }
}

/**
 * The rest of a multi-provision pinpoint, read left to right from `from`.
 *
 * Only ever called after a **plural** designation (`ss`, `sections`, `pts`):
 * the plural is the writer's own signal that more than one provision is named,
 * and without it "s 18, 3 March 2020" is a section and a date.
 */
function scanProvisionList(text: string, from: number, headShape: NumberShape, headNumber: string): ListScan {
  const items: ListItem[] = []
  let cursor = from
  for (;;) {
    LIST_ITEM.lastIndex = cursor
    const match = LIST_ITEM.exec(text)
    if (!match) break
    const end = LIST_ITEM.lastIndex
    const start = end - (match[2].length + match[3].length)
    const number = match[2]

    // The two named refusals, tested before anything else so that neither can
    // be reported as unread: a date and a year are prose, and the list ended.
    if (DATE_TAIL.test(text.slice(end, end + 12)) || ORDINAL.test(number)) break
    if (YEAR_ONLY.test(number) && !YEAR_ONLY.test(headNumber)) break

    // A shape this list cannot take. Everything from here on is still
    // list-shaped, so the whole remainder is reported — not just the member
    // that stopped the reader, which is how the rest used to vanish.
    if (!continuesList(headShape, numberShape(number))) {
      return { items, ...unreadRun(remainderMembers(text, cursor, headNumber)) }
    }
    // The ceiling is on the work, never on what the reader admits to: a list
    // that runs past it stops here and says how much it left, because a
    // citation dropped for being the thirteenth is exactly as unchecked as one
    // nobody could parse — and so is the twentieth behind it.
    if (items.length >= MAX_LIST_ITEMS) {
      return { items, ...unreadRun(remainderMembers(text, cursor, headNumber)) }
    }

    items.push({ number, subsections: match[3], joinsAsRange: /\bto\b/.test(match[1]), start, end })
    cursor = end
  }
  return { items }
}

/**
 * The bracketed form of the same list: `sub-ss (2) and (3)`, `paras (a), (b)
 * and (c)`.
 *
 * The same two rules as the numbered form — a plural designation in front, and
 * items that keep the shape of the first — because the same harvest is
 * available here: `(2020)` is a `SUBDIVISION_TOKEN`, so "see ss 18, (2020) 15
 * ALJ 3" would otherwise put a subsection (2020) into the report. Shape plus
 * the year test refuse it.
 *
 * A `to` join is read as naming its two ends rather than as a range: a
 * bracketed range has no representation in `SectionRef`, and inventing the
 * members between them would be inventing citations the writer did not make.
 */
const BRACKET_ITEM = new RegExp(
  `(\\s*,\\s*(?:and\\s+|&\\s*)?|\\s+and\\s+|\\s*&\\s*|\\s+to\\s+)\\((${SUBDIVISION_TOKEN})\\)`,
  "y",
)

function tokenShape(token: string): "digits" | "letters" | "other" {
  if (/^\d{1,4}$/.test(token)) return "digits"
  if (/^[A-Za-z]{1,8}$/.test(token)) return "letters"
  return "other"
}

/**
 * The bracketed members past the ceiling, for the same reason as
 * `remainderMembers`: reporting the thirteenth alone says nothing about the
 * fourteenth.
 *
 * A token whose shape changed is **not** walked into the remainder, unlike the
 * numbered form. A bracketed token has no "more specific" shape to change into
 * — `(a)`, `(2)` and `(Cth)` are the same three characters of grammar — and the
 * things that follow a citation in brackets are overwhelmingly prose: a
 * reported year, a jurisdiction, an *ibid*. Marking those unread would print a
 * `[PARSE_ERROR]` over ordinary writing, and a warning that fires on everything
 * is read as firing on nothing.
 */
function bracketRemainderMembers(text: string, from: number): Span[] {
  const members: Span[] = []
  let cursor = from
  for (;;) {
    BRACKET_ITEM.lastIndex = cursor
    const match = BRACKET_ITEM.exec(text)
    if (!match) break
    const end = BRACKET_ITEM.lastIndex
    const token = match[2]
    if (YEAR_ONLY.test(token)) break
    members.push({ start: end - token.length - 2, end })
    cursor = end
  }
  return members
}

function scanBracketList(text: string, from: number, headToken: string): ListScan {
  const items: ListItem[] = []
  const headShape = tokenShape(headToken)
  if (headShape === "other") return { items }
  let cursor = from
  for (;;) {
    BRACKET_ITEM.lastIndex = cursor
    const match = BRACKET_ITEM.exec(text)
    if (!match) break
    const end = BRACKET_ITEM.lastIndex
    const token = match[2]
    if (tokenShape(token) !== headShape || YEAR_ONLY.test(token)) break
    if (items.length >= MAX_LIST_ITEMS) return { items, ...unreadRun(bracketRemainderMembers(text, cursor)) }
    items.push({
      number: token,
      subsections: "",
      joinsAsRange: false,
      bracketed: true,
      start: end - token.length - 2,
      end,
    })
    cursor = end
  }
  return { items }
}

/**
 * A pinpoint this scanner located and could not read.
 *
 * It deliberately carries **no `lawName`**: every consumer of a citation
 * without one already knows it cannot be checked (`statute-check.ts` answers ⚠
 * before it ever looks at `ref`, and `cite-check.ts` skips it), so an unread
 * fragment can never be turned into a lookup against a provision nobody cited.
 * `ref` is an inert placeholder for the same reason — the shape of this record
 * is "something is here and it was NOT checked", not a reference.
 *
 * `count` is how many provisions the fragment covers. One unread line standing
 * for seven has to say seven, or the reader downstream counts one and the
 * summary is wrong about a text it did not read — the same failure in a
 * smaller font.
 *
 * The bracket label comes from `ErrorCodes` like every other label in this
 * server: a machine reader has to be able to tell which set it belongs to, and
 * this one is a parse failure on our side, never a statement about the law.
 */
function unreadCitation(fragment: string, index: number, count = 1): StatuteCitation {
  const shown = fragment.replace(/\s+/g, " ").trim()
  const said =
    count > 1
      ? `${count} provisions this scanner located but did not read, ` +
        `so NONE of them was checked and nothing here says whether they are right`
      : "a pinpoint this scanner located but could not read, " +
        "so it was NOT checked and nothing here says whether it is right"
  return {
    raw: shown,
    ref: { kind: "section", number: "", subsections: [], plural: false, raw: shown },
    pinpoint: `[${ErrorCodes.PARSE_ERROR}] "${shown}" — ${said}`,
    attachedBy: "unread",
    index,
  }
}

/**
 * Every pinpoint-shaped fragment the reader neither used nor refused.
 *
 * This is the audit, and it is why a new gap in the grammar cannot go quiet:
 * the reader records a span for every path it takes — a citation it built, a
 * reading it refused for a named reason, a duplicate it dropped — and whatever
 * `PINPOINT_SHAPE` finds outside those spans is reported.
 */
function unreadShapes(text: string, accounted: readonly Span[]): Span[] {
  const found: Span[] = []
  const accountedFor = overlapSweep(accounted)
  PINPOINT_SHAPE.lastIndex = 0
  for (const match of text.matchAll(PINPOINT_SHAPE)) {
    const start = match.index ?? 0
    const span = { start, end: start + match[0].length }
    if (!accountedFor(span)) found.push(span)
  }
  return found
}

/** One provision of a pinpoint, with the text it was read from. */
interface Located extends Span {
  source: string
  ref: SectionRef
}

/**
 * Every statute citation in the text, in order, de-duplicated by (law,
 * pinpoint) and capped at `maxCitations`.
 *
 * A multi-provision pinpoint becomes one citation per provision: "ss 45 and
 * 46" is two, "ss 45, 46, 47" is three. Reading only the first is the failure
 * this whole module is against — the report then says one was found and one
 * was checked, over a text naming two.
 */
export function extractStatuteCitations(text: string, maxCitations: number): StatuteCitation[] {
  if (!text) return []
  const cites = findFullCites(text)
  const shortForms = findShortForms(text, cites)

  const out: StatuteCitation[] = []
  const seen = new Set<string>()
  /** Spans the reader accounted for: read, refused for a named reason, or reported unread. */
  const accounted: Span[] = []
  const unread: Array<{ fragment: string; index: number; count?: number }> = []
  let cappedEarly = false

  PINPOINT.lastIndex = 0
  for (const match of text.matchAll(PINPOINT)) {
    if (out.length >= maxCitations) {
      cappedEarly = true
      break
    }
    const raw = match[0]
    const start = match.index ?? 0
    const end = start + raw.length
    const schedulePrefix = match[1] ?? ""
    const spelling = match[2] ?? match[4] ?? ""
    const numberText = match[3]

    // "Migration Regulations 1994 (Cth)" is a title, not `regs 1994`.
    if (WORD_SPELLING.test(spelling) && numberText && YEAR_ONLY.test(numberText)) {
      accounted.push({ start, end })
      continue
    }
    if (new RegExp(`^\\s*\\(\\s*(?:${JURISDICTION_TOKENS})\\s*\\)`, "i").test(text.slice(end, end + 12))) {
      accounted.push({ start, end })
      continue
    }

    const headRef = parseSectionRef(raw)
    if (!headRef) {
      unread.push({ fragment: raw, index: start })
      accounted.push({ start, end })
      continue
    }

    // The list, and then the provisions it names. `located[0]` is the head; a
    // "to" join folds into whatever precedes it instead of standing alone.
    const headNumber = `${headRef.number}${headRef.letterSuffix ?? ""}`
    const headShape = numberShape(headNumber)
    const plural = PLURAL_SPELLINGS.has(spelling.toLowerCase())
    const bracketToken = match[5]
    let scan: ListScan = { items: [] }
    if (plural && numberText && headShape !== "other") scan = scanProvisionList(text, end, headShape, headNumber)
    else if (plural && bracketToken) scan = scanBracketList(text, end, bracketToken)
    // An unread continuation is reported with the head of its pinpoint in
    // front, so the report shows `ss 51AC … 52 and 53` rather than a bare "52"
    // that names no designation and cannot be found in the text again. The span
    // covers every member the reader left behind, and the count says how many.
    if (scan.unread) {
      unread.push({
        fragment: `${raw} … ${text.slice(scan.unread.start, scan.unread.end)}`,
        index: scan.unread.start,
        ...(scan.unreadCount ? { count: scan.unreadCount } : {}),
      })
      accounted.push(scan.unread)
    }

    const singular = kindForSpelling(spelling)?.singular ?? spelling
    const located: Located[] = [{ source: raw, ref: headRef, start, end }]
    for (const item of scan.items) {
      const last = located[located.length - 1]
      if (item.joinsAsRange) {
        // `RANGE_JOIN`, never a hyphen: the writer wrote "to", and the merge
        // has to carry that signal to the parser rather than re-creating the
        // ambiguity the word settled.
        const merged = `${last.source} ${RANGE_JOIN} ${item.number}${item.subsections}`
        const mergedRef = parseSectionRef(merged)
        if (mergedRef?.rangeEnd) {
          last.source = merged
          last.ref = mergedRef
          last.end = item.end
          continue
        }
        // A "to" the reader cannot fold into a range is not two citations.
        // Splitting it reports both ends as provisions the writer cited singly
        // — "ss 140 to 100" as `ss 140` and `s 100` — and says nothing at all
        // about the span between them, which is the `[VERIFIED]`-over-unread
        // failure this module exists to prevent. So the far end is located,
        // counted and reported unread; the head keeps the words the document
        // actually contains.
        unread.push({ fragment: `${raw} … ${text.slice(last.end, item.end)}`, index: item.start })
        accounted.push({ start: last.end, end: item.end })
        continue
      }
      const source = item.bracketed
        ? `${singular} (${item.number})`
        : `${schedulePrefix}${singular} ${item.number}${item.subsections}`
      const ref = parseSectionRef(source)
      if (!ref) {
        unread.push({ fragment: `${raw} … ${text.slice(item.start, item.end)}`, index: item.start })
        accounted.push({ start: item.start, end: item.end })
        continue
      }
      located.push({ source, ref, start: item.start, end: item.end })
    }

    // Attribution and the content claim are read from the end of the *whole*
    // pinpoint, so "ss 45 and 46 of the CCA" attaches the Act to both.
    const listEnd = located[located.length - 1].end
    const attribution = attribute(text, start, listEnd, cites, shortForms)
    // A claim describing a list ("ss 45 and 46 prohibit anti-competitive
    // conduct") is about the list, not about either member. Testing it against
    // one member's heading is how correct prose gets reported as a content
    // mismatch, which is the one verdict this server must never invent, so a
    // multi-provision pinpoint is checked for existence only.
    const claim =
      located.length === 1
        ? extractContentClaim(
            text.slice(Math.max(0, attribution.citeStart - 160), attribution.citeStart),
            text.slice(listEnd, listEnd + 200),
          )
        : undefined
    const prefix = text.slice(Math.min(attribution.citeStart, start), start)

    for (const entry of located) {
      if (out.length >= maxCitations) {
        cappedEarly = true
        break
      }
      const effectiveRef: SectionRef =
        attribution.schedule && !entry.ref.schedule ? { ...entry.ref, schedule: attribution.schedule } : entry.ref
      const pinpoint = formatRef(effectiveRef)

      const key = `${normaliseAliasKey(attribution.lawName ?? "")}|${attribution.jurisdiction ?? ""}|${pinpoint}`
      if (seen.has(key)) {
        accounted.push({ start: entry.start, end: entry.end })
        continue
      }
      seen.add(key)

      // The head keeps the writer's own words; a continuation has none of its
      // own ("46" alone is not a citation), so it is rebuilt from the
      // designation and schedule the writer put in front of the list.
      const written =
        entry === located[0] ? text.slice(Math.min(attribution.citeStart, start), entry.end) : `${prefix}${entry.source}`

      out.push({
        raw: written.replace(/[*_]/g, "").replace(/\s+/g, " ").trim(),
        ...(attribution.lawName ? { lawName: attribution.lawName } : {}),
        ...(attribution.jurisdiction ? { jurisdiction: attribution.jurisdiction } : {}),
        ...(attribution.year ? { year: attribution.year } : {}),
        ref: effectiveRef,
        pinpoint,
        attachedBy: attribution.attachedBy,
        ...(attribution.antecedent ? { antecedent: attribution.antecedent } : {}),
        ...(claim ? { claim: claim.text, claimSource: claim.source } : {}),
        index: entry.start,
      })
      accounted.push({ start: entry.start, end: entry.end })
    }
  }

  // The audit only runs over text the reader actually reached: past the cap
  // nothing was read, so "not accounted for" would say nothing about the
  // grammar. The cap is reported by the caller in its own words.
  const missed = cappedEarly
    ? unread
    : [
        ...unread,
        ...unreadShapes(text, accounted).map((span) => ({
          fragment: text.slice(span.start, span.end),
          index: span.start,
          count: 1,
        })),
      ]
  for (const item of missed) out.push(unreadCitation(item.fragment, item.index, item.count ?? 1))
  out.sort((left, right) => left.index - right.index)
  return out.slice(0, maxCitations)
}

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
 * Parsing of the pinpoint itself is delegated to `lib/section-ref.ts`, which
 * owns that grammar. Only *locating* a pinpoint in prose lives here.
 */

import { normaliseAliasKey, resolveLawAlias, type AliasJurisdiction } from "../../lib/law-alias.js"
import { formatRef, parseSectionRef, type SectionRef } from "../../lib/section-ref.js"
import { ROMAN_NUMBER, SPELLING_ALTERNATION, SUBDIVISION_TOKEN } from "../../lib/section-ref-vocab.js"
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
 * It is guarded by the two properties every pattern below already has: the
 * match is **case sensitive**, so "the law s 5 says" is ordinary prose and
 * stays prose, and a preceding title body is **mandatory**, so a bare `Law`
 * cannot be a statute name on its own.
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
 * rejects is simply dropped.
 */
const NUMBER = `(?:${ROMAN_NUMBER}|\\d{1,4}(?:[.\\-]\\d{1,4}){0,3}[A-Za-z]{0,4})`
const SUBSECTIONS = `(?:\\s?\\(${SUBDIVISION_TOKEN}\\)){0,6}`
const SCHEDULE_WORD = `(?:[Ss]chedules|[Ss]chedule|[Ss]chs|[Ss]ch)`

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
 * A pinpoint anywhere in prose. The lookbehind keeps the `s` of "Acts" out.
 * The second branch is the bracketed form (`sub-s (2)`, `para (a)`), which has
 * no number of its own — without it those references are never extracted, and
 * an unextracted citation is one the report silently claims to have checked.
 */
const PINPOINT = new RegExp(
  `(?<![A-Za-z])(?:` +
    `(?:${SCHEDULE_WORD}\\s*${NUMBER}\\s*[,\\-]?\\s*)?` +
    `(${SPELLINGS})\\s*(${NUMBER})` +
    `(?:\\s*[-–]\\s*${NUMBER})?` +
    SUBSECTIONS +
    `|(${SPELLINGS})\\s?\\(${SUBDIVISION_TOKEN}\\)` +
    `)`,
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
 * How far it may trim depends on the last word. A one-word result is allowed
 * only for a title that stands alone — "under the Constitution" is exactly
 * that, and stopping a word early left "the Constitution", which resolves to
 * nothing. Everything else keeps two words, so "Under this Law s 5" cannot be
 * trimmed down to a statute called `Law`.
 */
function trimLeadingFiller(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const floor = STANDALONE_TITLE_ONLY.test(words[words.length - 1] ?? "") ? 1 : 2
  let start = 0
  while (start < words.length - floor && LEADING_FILLER.has(words[start].toLowerCase().replace(/[^a-z.]/g, ""))) start++
  return words.slice(start).join(" ")
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
    return {
      lawName: name,
      ...(bare[2] ? { year: Number(bare[2]) } : {}),
      attachedBy: "bare-name",
      citeStart: lookbackStart + capturedAt + (captured.length - name.length),
      ...(aliasSchedule(name) ? { schedule: aliasSchedule(name) } : {}),
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

/**
 * Every statute citation in the text, in order, de-duplicated by (law,
 * pinpoint) and capped at `maxCitations`.
 */
export function extractStatuteCitations(text: string, maxCitations: number): StatuteCitation[] {
  if (!text) return []
  const cites = findFullCites(text)
  const shortForms = findShortForms(text, cites)

  const out: StatuteCitation[] = []
  const seen = new Set<string>()

  PINPOINT.lastIndex = 0
  for (const match of text.matchAll(PINPOINT)) {
    if (out.length >= maxCitations) break
    const raw = match[0]
    const start = match.index ?? 0
    const end = start + raw.length

    // "Migration Regulations 1994 (Cth)" is a title, not `regs 1994`.
    if (match[1] && WORD_SPELLING.test(match[1]) && /^(?:1[89]|20)\d{2}$/.test(match[2])) continue
    if (new RegExp(`^\\s*\\(\\s*(?:${JURISDICTION_TOKENS})\\s*\\)`, "i").test(text.slice(end, end + 12))) continue

    const ref = parseSectionRef(raw)
    if (!ref) continue

    const attribution = attribute(text, start, end, cites, shortForms)
    const effectiveRef: SectionRef =
      attribution.schedule && !ref.schedule ? { ...ref, schedule: attribution.schedule } : ref
    const pinpoint = formatRef(effectiveRef)

    const key = `${normaliseAliasKey(attribution.lawName ?? "")}|${attribution.jurisdiction ?? ""}|${pinpoint}`
    if (seen.has(key)) continue
    seen.add(key)

    const claim = extractContentClaim(text.slice(Math.max(0, attribution.citeStart - 160), attribution.citeStart), text.slice(end, end + 200))

    out.push({
      raw: text.slice(Math.min(attribution.citeStart, start), end).replace(/[*_]/g, "").replace(/\s+/g, " ").trim(),
      ...(attribution.lawName ? { lawName: attribution.lawName } : {}),
      ...(attribution.jurisdiction ? { jurisdiction: attribution.jurisdiction } : {}),
      ...(attribution.year ? { year: attribution.year } : {}),
      ref: effectiveRef,
      pinpoint,
      attachedBy: attribution.attachedBy,
      ...(attribution.antecedent ? { antecedent: attribution.antecedent } : {}),
      ...(claim ? { claim: claim.text, claimSource: claim.source } : {}),
      index: start,
    })
  }
  return out
}

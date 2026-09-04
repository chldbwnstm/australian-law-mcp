/**
 * Parameter extractors for the natural-language router.
 *
 * This file answers "what values are in this sentence" — Act name, provision,
 * citation, date, jurisdiction, domain. It never answers "which tool"; that is
 * `route-patterns.ts` (the declaration) and `query-router.ts` (the engine).
 *
 * Everything here delegates the actual grammar to the module that owns it:
 * provisions to `section-ref`, citations to `case-citation`, dates to
 * `au-dates`, statute names to `law-alias`. A second copy of any of those
 * grammars would drift, and the drift shows up as a router that recognises a
 * citation the verifier then cannot parse.
 *
 * Regex safety rules inherited from the reference implementation, all of which
 * were paid for once already:
 *
 *  - **Every quantifier is bounded.** These patterns run over pasted documents.
 *  - **No pattern starts with a lazy `(.+?)`.** Combined with a trailing anchor
 *    it backtracks quadratically, and the capture is never used anyway —
 *    the name is extracted separately.
 *  - **Word-boundary guards on every stripped word.** Removing a trigger word
 *    by substring is how "Commission" becomes "Comm" and an Act name is
 *    destroyed.
 */

import { extractCaseCitations, type CaseCitationResult, type MncCitation } from "./case-citation.js"
import { escapeRegex } from "./escape-regex.js"
import { extractQueryDates, type QueryDates } from "./au-dates.js"
import { LAW_ALIAS_ENTRIES, resolveLawAlias, type AliasJurisdiction, type LawAliasEntry } from "./law-alias.js"
import { extractSectionRefs, formatRef, type SectionRef } from "./section-ref.js"

// ──────────────────────────────────────────────────────────────────────────
// Statute names
// ──────────────────────────────────────────────────────────────────────────

/**
 * The title-case Act-name grammar.
 *
 * At least one capitalised word is required before the kind word. Allowing
 * zero would make the bare noun "Act" a law name, and the pasted-letter case
 * ("...as required by the Act") would resolve to whatever the alias table
 * happened to return — which is exactly the failure the corpus's N18 names.
 *
 * The leading-word repeat is capped at seven: the longest Commonwealth short
 * titles ("Environment Protection and Biodiversity Conservation Act 1999") sit
 * inside that, and an uncapped repeat in front of an alternation is the shape
 * that turns a title scan into a hang.
 */
const ACT_KIND = "Act|Acts|Regulation|Regulations|Rules|Code|Constitution|Determination|Standards|Ordinance|By-?laws?|Order"
const ACT_NAME_SOURCE =
  `(?:[A-Z][A-Za-z'’&\\-]{0,24}\\s+){1,7}(?:${ACT_KIND})\\b` + // capitalised run + kind word
  `(?:\\s+\\(?No\\.?\\s?\\d{1,3}\\)?)?` +                      // "(No. 2)"
  `(?:\\s+((?:1[89]|20)\\d{2}))?` +                            // trailing year
  `(?:\\s*\\((Cth|NSW|Vic|Qld|SA|WA|Tas|ACT|NT)\\))?`          // AGLC jurisdiction bracket

const ACT_NAME_RE = new RegExp(ACT_NAME_SOURCE, "g")

/**
 * Aliases as a literal alternation, longest first.
 *
 * Built from the alias table so a new abbreviation becomes routable the moment
 * it is added there — the alternative, a hand-kept list in the router, is the
 * copy that goes stale. Longest-first matters: `Competition and Consumer Act`
 * must win over nothing, and `Crimes Act (Cth)` over `Crimes Act`.
 *
 * Short all-caps aliases (`MA`, `CCA`, `ACL`) are matched **case-sensitively**.
 * Lower-cased, `\bma\b` fires inside ordinary prose and every sentence
 * containing the word "ma" acquires a statute.
 */
function aliasAlternation(entries: readonly LawAliasEntry[], predicate: (e: LawAliasEntry) => boolean): string[] {
  return [...new Set(entries.filter(predicate).map((e) => e.alias))].sort((a, b) => b.length - a.length)
}

const SHORT_ALIAS_MAX = 4
const shortAliases = aliasAlternation(LAW_ALIAS_ENTRIES, (e) => e.alias.length <= SHORT_ALIAS_MAX)
const longAliases = aliasAlternation(LAW_ALIAS_ENTRIES, (e) => e.alias.length > SHORT_ALIAS_MAX)

/** `\b` is wrong at a `)` or `&` edge, so the guards are explicit character lookarounds. */
const EDGE_BEFORE = "(?<![A-Za-z0-9])"
const EDGE_AFTER = "(?![A-Za-z0-9])"

const SHORT_ALIAS_SOURCE = `${EDGE_BEFORE}(?:${shortAliases.map(escapeRegex).join("|")})${EDGE_AFTER}`
const LONG_ALIAS_SOURCE = `${EDGE_BEFORE}(?:${longAliases.map(escapeRegex).join("|")})${EDGE_AFTER}`

const SHORT_ALIAS_RE = new RegExp(SHORT_ALIAS_SOURCE, "g")
const LONG_ALIAS_RE = new RegExp(LONG_ALIAS_SOURCE, "gi")

/**
 * Non-global twins for pattern *detection*.
 *
 * `String.prototype.match` on a global regex discards capture groups and
 * indices, and the router hands the match object to an extractor. Two
 * declarations of the same source string, one flag apart, is the smallest
 * safe way to have both.
 */
export const ACT_NAME_DETECT = new RegExp(ACT_NAME_SOURCE)
export const SHORT_ALIAS_DETECT = new RegExp(SHORT_ALIAS_SOURCE)
export const LONG_ALIAS_DETECT = new RegExp(LONG_ALIAS_SOURCE, "i")

/**
 * A cheap prefilter for "this sentence may contain a provision reference".
 *
 * It is **not** the grammar — `section-ref` owns that, and `extractProvisions`
 * is what decides. This exists so a pattern can be rejected in one bounded
 * scan instead of running the full reference parser over every candidate, and
 * a false positive here costs nothing because the extractor skips it.
 */
export const PROVISION_HINT_RE =
  /(?<![A-Za-z])(?:ss|s|sections?|sch|schs|schedules?|pt|pts|parts?|div|divs|divisions?|reg|regs|regulations?|rr|r|rules?|cl|cls|clauses?|art|arts|articles?|ch|chs|chapters?|items?|para|paras|paragraphs?)\s?\.?\s?\d/i

/** Federal Register title ids: `C2004A00109` (Act), `F2011L00287` (instrument). */
export const FRL_TITLE_ID_RE = /(?<![A-Za-z0-9])([CF]\d{4}[A-Z]\d{5})(?![A-Za-z0-9])/

/**
 * Aliases that name a statute by a title it no longer carries.
 *
 * Derived from the table's own notes rather than listed here: the *Trade
 * Practices Act* is the CCA, and answering "TPA s 52" with today's s 52 is a
 * confidently wrong answer, not a near miss. Agency aliases are excluded — a
 * regulator being replaced is not a statute being renamed.
 */
const SUPERSEDED_NOTE = /\b(?:renamed\s+from|former\s+name\s+of|previously\s+(?:called|named|known\s+as))\b/i
const supersededAliases = aliasAlternation(
  LAW_ALIAS_ENTRIES,
  (e) => !e.body && !!e.notes && SUPERSEDED_NOTE.test(e.notes),
)
export const SUPERSEDED_ALIAS_RE = new RegExp(
  `${EDGE_BEFORE}(?:${supersededAliases.map(escapeRegex).join("|")})${EDGE_AFTER}`,
  "i",
)

export interface LawMention {
  /** The text as it appeared in the query. */
  raw: string
  /** Character offset in the query — used to pick the first-named Act. */
  index: number
  /** Official short title when the alias table resolves it, otherwise `raw`. */
  name: string
  titleId?: string
  /** Schedule the alias actually names: ACL -> sch 2 of the CCA. */
  sch?: string
  jurisdiction?: AliasJurisdiction
  /** Several jurisdictions share this name and the query did not say which. */
  needsJurisdiction: boolean
  /** The other jurisdictions in play, for a clarification message. */
  otherJurisdictions: AliasJurisdiction[]
  /** The alias names a regulator or tribunal, not a statute. */
  body: boolean
  /** The alias is a title the Act no longer carries. */
  superseded: boolean
}

/**
 * A trailing year that is not part of the short title.
 *
 * "amendments to the Fair Work Act 2024" names the *Fair Work Act 2009* and
 * an amendment year; resolving the literal string finds nothing and the query
 * degrades to a raw text search. Retrying without the year recovers it — but
 * only as a fallback, because "Crimes Act 1900" *is* the title and dropping
 * its year turns an unambiguous NSW Act into a four-jurisdiction guess.
 */
const TRAILING_YEAR_RE = /\s*(?:\(?No\.?\s?\d{1,3}\)?\s*)?(?:1[89]|20)\d{2}\s*$/

/**
 * A jurisdiction written in front of the title rather than in AGLC's trailing
 * bracket: "QLD WHS Act", "Vic Civil Liability Act". Both capitalised, so the
 * title grammar swallows them and the resulting string matches nothing.
 */
const LEADING_JURISDICTION_RE =
  /^(?:NSW|VIC|QLD|WA|SA|TAS|NT|ACT|Vic|Qld|Tas|Cth|New\s+South\s+Wales|Victorian?|Queensland|Western\s+Australia|South\s+Australia|Tasmanian?|Northern\s+Territory|Commonwealth)\s+/

function mentionFrom(raw: string, index: number): LawMention {
  let resolution = resolveLawAlias(raw)
  // Fallbacks, in order of how much they give up. Each one only runs when the
  // fuller string resolved to nothing, so an unambiguous title is never
  // weakened: dropping the year from "Crimes Act 1900" would turn one NSW Act
  // into a four-jurisdiction guess.
  for (const narrow of [
    () => raw.replace(LEADING_JURISDICTION_RE, "").trim(),
    () => raw.replace(TRAILING_YEAR_RE, "").trim(),
    () => raw.replace(LEADING_JURISDICTION_RE, "").replace(TRAILING_YEAR_RE, "").trim(),
  ]) {
    if (resolution.candidates.length > 0) break
    const candidate = narrow()
    if (candidate.length < 3 || candidate === raw) continue
    const retry = resolveLawAlias(candidate)
    if (retry.candidates.length > 0) resolution = retry
  }
  const first = resolution.candidates[0]
  const jurisdictions = [...new Set(resolution.candidates.map((c) => c.jurisdiction))]
  // Nothing in the table matched. The jurisdiction word still has to come off
  // the search term — "Vic Civil Liability Act" is not the title of anything,
  // and sending it to the Victorian register finds nothing at all.
  const unresolvedName = raw.replace(LEADING_JURISDICTION_RE, "").trim() || raw
  return {
    raw,
    index,
    name: first ? first.official : unresolvedName,
    ...(first?.titleId ? { titleId: first.titleId } : {}),
    ...(first?.sch ? { sch: first.sch } : {}),
    ...(first?.jurisdiction ? { jurisdiction: first.jurisdiction } : {}),
    needsJurisdiction: resolution.needsJurisdiction,
    otherJurisdictions: jurisdictions.slice(1),
    body: Boolean(first?.body),
    superseded: SUPERSEDED_ALIAS_RE.test(raw),
  }
}

/**
 * Every statute named in the query, in order of appearance.
 *
 * Both grammars run and the results are merged by position: at the same start
 * offset the longer match wins, so `Crimes Act 1900` beats the alias `Crimes
 * Act` and keeps the year that decides which jurisdiction's Act it is.
 */
export function extractLawMentions(query: string): LawMention[] {
  if (!query) return []
  const found = new Map<number, string>()

  const record = (text: string, index: number): void => {
    const existing = found.get(index)
    if (existing === undefined || text.length > existing.length) found.set(index, text)
  }

  for (const re of [ACT_NAME_RE, SHORT_ALIAS_RE, LONG_ALIAS_RE]) {
    re.lastIndex = 0
    for (const match of query.matchAll(re)) {
      if (match.index === undefined) continue
      record(match[0].trim(), match.index)
    }
  }

  // Drop a match that starts inside a longer one ("Act 1900" inside "Crimes
  // Act 1900"): the enclosing name is the one the caller meant.
  const starts = [...found.entries()].sort((a, b) => a[0] - b[0])
  const kept: Array<[number, string]> = []
  for (const [index, text] of starts) {
    const previous = kept[kept.length - 1]
    if (previous && index < previous[0] + previous[1].length) {
      if (index + text.length > previous[0] + previous[1].length) kept[kept.length - 1] = [previous[0], query.slice(previous[0], index + text.length)]
      continue
    }
    kept.push([index, text])
  }

  return kept.map(([index, text]) => mentionFrom(text, index))
}

/** The statute the question is about: the first named one that is not an agency. */
export function primaryLawMention(query: string): LawMention | undefined {
  const mentions = extractLawMentions(query)
  return mentions.find((m) => !m.body) ?? mentions[0]
}

/** The search string for a law mention — the official title when it resolved. */
export function lawSearchText(mention: LawMention): string {
  return mention.name
}

// ──────────────────────────────────────────────────────────────────────────
// Provisions
// ──────────────────────────────────────────────────────────────────────────

export type { SectionRef }

/**
 * Blank out every statute name, keeping the offsets.
 *
 * A short title carries its own numbers — *Fair Work Regulations 2009*, *High
 * Court Rules 2004* — and the provision scanner reads "Regulations 2009" as
 * regulation 2009. The real reference is the one *after* the title, so the
 * title is removed before scanning rather than the results being sorted out
 * afterwards. Spaces, not deletion: the offsets have to survive so the
 * fragment guard below can still see word boundaries.
 */
function maskLawNames(query: string): string {
  let masked = query
  for (const mention of extractLawMentions(query)) {
    masked =
      masked.slice(0, mention.index) +
      " ".repeat(mention.raw.length) +
      masked.slice(mention.index + mention.raw.length)
  }
  return masked
}

/**
 * Reject a reference that is a fragment of an ordinary word.
 *
 * `section-ref`'s scanner is case-insensitive, which makes its roman-numeral
 * branch match lower-case letters: "applied" parses as appendix "lie" and
 * "since" as section "in". Both then travel as a provision the caller never
 * wrote. The scanner guards its left edge and not its right, so this is the
 * matching guard on the other side — a reference must be followed by
 * something that is not a letter.
 */
function isWholeWordRef(source: string, ref: SectionRef): boolean {
  // The parser normalises whitespace, so the raw text may not appear verbatim.
  const flexible = ref.raw
    .split(/\s+/)
    .map(escapeRegex)
    .join("\\s*")
  const guarded = new RegExp(`(?<![A-Za-z])${flexible}(?![A-Za-z])`, "i")
  return guarded.test(source)
}

/**
 * Every provision reference in the query, in order.
 *
 * The grammar belongs to `section-ref`; this adds the two context guards that
 * a document scanner cannot apply for itself — the statute's own title is
 * masked out first, and word fragments are dropped.
 */
export function extractProvisions(query: string): SectionRef[] {
  const source = query ?? ""
  if (!source) return []
  const masked = maskLawNames(source)
  return extractSectionRefs(masked).filter((ref) => isWholeWordRef(masked, ref))
}

/**
 * The provision parameter to send, canonicalised.
 *
 * The schedule prefix is the whole point: the alias table records that `ACL`
 * *is* schedule 2 of the CCA, so "s 18 of the ACL" must go out as
 * `sch 2 s 18`. Dropping it returns CCA s 18 — "Meetings of Commission" —
 * under the heading the caller asked about. A reference that already names a
 * schedule keeps its own.
 */
export function provisionParam(ref: SectionRef, mention?: LawMention): string {
  if (!mention?.sch || ref.schedule || ref.kind === "schedule") return formatRef(ref)
  return formatRef({ ...ref, schedule: mention.sch })
}

/** The first provision in the query, canonicalised against the named statute. */
export function firstProvision(query: string, mention?: LawMention): string | undefined {
  const refs = extractProvisions(query)
  return refs[0] ? provisionParam(refs[0], mention) : undefined
}

// ──────────────────────────────────────────────────────────────────────────
// Citations
// ──────────────────────────────────────────────────────────────────────────

/** Every case citation in the query, including the ones whose court code is unknown. */
export function extractCitations(query: string): CaseCitationResult[] {
  return extractCaseCitations(query ?? "")
}

/** The first medium-neutral citation, re-emitted as written. */
export function firstMnc(query: string): MncCitation | undefined {
  for (const result of extractCitations(query)) {
    if (result.ok && result.citation.kind === "mnc") return result.citation
  }
  return undefined
}

/** Any parseable citation at all — MNC or report series. */
export function hasCitation(query: string): boolean {
  return extractCitations(query).some((result) => result.ok)
}

// ──────────────────────────────────────────────────────────────────────────
// Dates
// ──────────────────────────────────────────────────────────────────────────

export type { QueryDates }

/**
 * Split the query into its time condition and its search terms.
 *
 * Statute titles are masked first. Australian short titles end in a year, and
 * "amendments to the Fair Work Act 2024" would otherwise be read as a request
 * for the 2024 calendar year — a window the caller never asked for, silently
 * narrowing the answer.
 */
export function extractDates(query: string, now?: Date): QueryDates {
  const source = query ?? ""
  if (!source) return { rest: "" }
  return extractQueryDates(maskLawNames(source), now)
}

/**
 * The single day a point-in-time question is about.
 *
 * A bare year is a range, and the end of it is the right answer: "what did s
 * 52 say in 2009" wants the law as it stood at the end of 2009, not on 1
 * January — the same convention `au-date-patterns` uses for "last year".
 */
export function pointInTimeDate(query: string, now?: Date): string | undefined {
  const dates = extractDates(query, now)
  if (dates.date) return dates.date.iso
  if (dates.range) return dates.range.range.to
  return undefined
}

// ──────────────────────────────────────────────────────────────────────────
// Jurisdictions
// ──────────────────────────────────────────────────────────────────────────

/**
 * Abbreviations are matched case-sensitively and full names are not.
 *
 * `\bact\b` lower-cased is the word "act", which appears in nearly every
 * legislation query; `\bsa\b` and `\bwa\b` are inside ordinary words in other
 * languages and in pasted text. Requiring the capitals costs nothing — nobody
 * writes the territory as "act".
 */
const JURISDICTION_ABBREV: ReadonlyArray<[RegExp, AliasJurisdiction]> = [
  [/(?<![A-Za-z])NSW(?![A-Za-z])/, "NSW"],
  [/(?<![A-Za-z])(?:VIC|Vic)(?![A-Za-z])/, "Vic"],
  [/(?<![A-Za-z])(?:QLD|Qld)(?![A-Za-z])/, "Qld"],
  [/(?<![A-Za-z])WA(?![A-Za-z])/, "WA"],
  [/(?<![A-Za-z])SA(?![A-Za-z])/, "SA"],
  [/(?<![A-Za-z])(?:TAS|Tas)(?![A-Za-z])/, "Tas"],
  [/(?<![A-Za-z])NT(?![A-Za-z])/, "NT"],
  [/(?<![A-Za-z])ACT(?![A-Za-z])/, "ACT"],
  [/(?<![A-Za-z])(?:Cth|CTH)(?![A-Za-z])/, "Cth"],
]

const JURISDICTION_WORD: ReadonlyArray<[RegExp, AliasJurisdiction]> = [
  [/\bnew\s+south\s+wales\b/i, "NSW"],
  [/\bvictoria(?:n)?\b/i, "Vic"],
  [/\bqueensland\b/i, "Qld"],
  [/\bwestern\s+australia\b/i, "WA"],
  [/\bsouth\s+australia\b/i, "SA"],
  [/\btasmania(?:n)?\b/i, "Tas"],
  [/\bnorthern\s+territory\b/i, "NT"],
  [/\baustralian\s+capital\s+territory\b/i, "ACT"],
  [/\b(?:commonwealth|federal)\b/i, "Cth"],
]

/** Jurisdiction tokens in the query, in table order, deduplicated. */
export function extractJurisdictions(query: string): AliasJurisdiction[] {
  const text = query ?? ""
  const out: AliasJurisdiction[] = []
  for (const [pattern, value] of [...JURISDICTION_ABBREV, ...JURISDICTION_WORD]) {
    if (pattern.test(text) && !out.includes(value)) out.push(value)
  }
  return out
}

/** The first jurisdiction that is not the Commonwealth — what the state tools need. */
export function statePreference(query: string): AliasJurisdiction | undefined {
  return extractJurisdictions(query).find((value) => value !== "Cth")
}

/** `search_state_law` spells its jurisdictions in upper case. */
export function stateRegisterToken(jurisdiction: AliasJurisdiction): string {
  return jurisdiction.toUpperCase()
}

// ──────────────────────────────────────────────────────────────────────────
// Domain hints
// ──────────────────────────────────────────────────────────────────────────

/**
 * Subject vocabulary to `legal_research`'s `domain` enum.
 *
 * Only the words a person actually types. A synonym list broad enough to be
 * "complete" starts claiming a domain for every query, and a wrong specialist
 * body is worse than none.
 */
const DOMAIN_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:employment|employee|employer|dismissal|award|enterprise\s+agreement|fair\s+work|FWC)\b/i, "workplace"],
  [/\b(?:tax|taxation|GST|ATO|ruling|deduction|assessable)\b/i, "tax"],
  [/\b(?:privacy|personal\s+information|data\s+breach|OAIC)\b/i, "privacy"],
  [/\b(?:competition|cartel|merger|ACCC|misuse\s+of\s+market\s+power|consumer\s+law)\b/i, "competition"],
  [/\b(?:corruption|integrity|whistleblow|NACC|public\s+interest\s+disclosure)\b/i, "integrity"],
  [/\b(?:APS|public\s+service|code\s+of\s+conduct|merit\s+protection)\b/i, "public_service"],
]

/** The specialist body a dispute would also reach, when the query names one. */
export function extractDomainHint(query: string): string | undefined {
  for (const [pattern, domain] of DOMAIN_HINTS) {
    if (pattern.test(query ?? "")) return domain
  }
  return undefined
}

// ──────────────────────────────────────────────────────────────────────────
// Search-term shaping
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a search-term extractor from a strip pattern.
 *
 * `strip` is deliberately a different regex from the pattern that detected the
 * intent. Detection may match a fragment ("cite" inside "citation"); removal
 * may not, or the search term is left holding "ation". Declaring the two next
 * to each other is what makes a mismatch visible.
 *
 * When the trigger words were the whole query there is nothing left, and the
 * original is returned — an empty search string is never sent upstream.
 */
export function searchExtract(strip: RegExp): (query: string) => string {
  return (query: string): string => {
    const out = query.replace(strip, " ").replace(/\s+/g, " ").trim()
    return out || query.trim()
  }
}

/**
 * Filler that carries no search signal once the intent has been read off it.
 *
 * Interrogatives, auxiliaries and articles only. Prepositions are deliberately
 * left in: stripping "of" turns "code of conduct" into "code conduct" and
 * "rules of origin" into "rules origin", and upstream search engines score a
 * broken phrase worse than a slightly long one.
 */
const QUESTION_NOISE =
  /(?:^|\s)(?:what|whats|what's|which|who|whom|when|where|why|how|does|do|did|is|are|was|were|can|could|should|would|will|the|a|an|i|we|there|please|show|me|tell|find|get|say|says)(?=\s|$)/gi

/** Strip question filler; keep everything that could be a search term. */
export function stripQuestionNoise(query: string): string {
  const out = query.replace(QUESTION_NOISE, " ").replace(/\s+/g, " ").trim()
  return out || query.trim()
}

/**
 * Does the caller want the unabridged text?
 *
 * "full" on its own is not enough — "full-time employee", "full bench" and
 * "in full force" all contain it, and each would silently switch off the
 * abridgement that keeps a judgment inside a context window.
 */
export function wantsFullText(query: string): boolean {
  return /\b(?:full\s+(?:text|reasons|judgment|judgement|decision)|verbatim|unabridged|entire\s+(?:text|judgment)|complete\s+text)\b/i.test(
    query ?? "",
  )
}

/**
 * A bare noun phrase with no Act, provision, citation or intent word.
 *
 * "penalty unit" is a defined statutory concept, not a research question, and
 * the terminology tools are the right first stop. The gate is deliberately
 * tight — a short lower-case phrase only — because everything else in the
 * router has already had its chance by the time this runs.
 */
export function isBareTermQuery(query: string): boolean {
  const text = (query ?? "").trim()
  if (!text || /[0-9?:;]/.test(text)) return false
  const words = text.split(/\s+/)
  if (words.length < 1 || words.length > 4) return false
  // Any capitalised word after the first suggests a proper noun — a name, a
  // court, an Act — and those belong to the patterns above this one.
  if (words.slice(1).some((word) => /^[A-Z]/.test(word))) return false
  if (/\b(?:what|which|who|how|is|are|can|does|do|search|find|show|list|tell)\b/i.test(text)) return false
  return /^[A-Za-z][A-Za-z\s'’-]{2,60}$/.test(text)
}

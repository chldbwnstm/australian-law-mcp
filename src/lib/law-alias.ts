/**
 * Resolving what a user typed to an official short title.
 *
 * Two guarantees, both of them about *not overclaiming*:
 *
 *  - An alias that resolves to Acts in several jurisdictions comes back as
 *    several candidates flagged `needsJurisdiction`, never as a single best
 *    guess. "Evidence Act s 138" means different law in NSW and Queensland,
 *    and picking one silently produces a confident wrong answer.
 *  - An alias that resolves to nothing is a **miss in this table**, not
 *    evidence that the Act does not exist. `hasRelatedHit` is the same guard
 *    applied at the other end: an upstream that ignores the query and returns
 *    an unrelated list must not be read as confirmation.
 */

import { LAW_ALIAS_ENTRIES, type AliasJurisdiction, type LawAliasEntry } from "./law-alias-data.js"

export type { AliasJurisdiction, LawAliasEntry }
export { LAW_ALIAS_ENTRIES } from "./law-alias-data.js"

/** All jurisdiction abbreviations AGLC r 3.1.3 allows — never `Cwlth`, never `NSW.`. */
export const JURISDICTIONS: readonly AliasJurisdiction[] = [
  "Cth", "NSW", "Vic", "Qld", "SA", "WA", "Tas", "ACT", "NT",
]

/**
 * Fold a query to a comparison key: lower case, no punctuation, no spaces.
 *
 * Space removal is what lets `FW Act`, `FWAct` and `fw act` be one key, and
 * ampersand/apostrophe removal handles `EP&A Act` and `Governor-General's`.
 * The cost is that the key is a dense string, so containment tests on it need
 * a length floor — see `hasRelatedHit`.
 */
export function normaliseAliasKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9]/g, "")
}

export interface AliasCandidate extends LawAliasEntry {
  /** How the alias was reached: an exact table hit or a title-text match. */
  matchedBy: "alias" | "official"
  /**
   * True when the same alias resolves to Acts in more than one jurisdiction,
   * so the caller must ask rather than choose.
   */
  needsJurisdiction: boolean
}

export interface AliasResolution {
  /** The query as typed. */
  query: string
  /** Jurisdiction lifted out of the query, e.g. the `(NSW)` in `Crimes Act (NSW)`. */
  jurisdiction?: AliasJurisdiction
  candidates: AliasCandidate[]
  /** True when several jurisdictions remain in play. */
  needsJurisdiction: boolean
  /**
   * The search string to send upstream: the single official title when the
   * query is unambiguous, otherwise the query itself. Never a guess between
   * jurisdictions.
   */
  searchText: string
}

const byAliasKey = new Map<string, LawAliasEntry[]>()
const byOfficialKey = new Map<string, LawAliasEntry[]>()
for (const entry of LAW_ALIAS_ENTRIES) {
  push(byAliasKey, normaliseAliasKey(entry.alias), entry)
  push(byOfficialKey, normaliseAliasKey(entry.official), entry)
}
function push(map: Map<string, LawAliasEntry[]>, key: string, entry: LawAliasEntry): void {
  const list = map.get(key)
  if (list) list.push(entry)
  else map.set(key, [entry])
}

/** `Crimes Act 1900 (NSW)` -> `{ jurisdiction: "NSW", rest: "Crimes Act 1900" }`. */
function splitJurisdiction(query: string): { jurisdiction?: AliasJurisdiction; rest: string } {
  const match = /\(\s*(Cth|NSW|Vic|Qld|SA|WA|Tas|ACT|NT)\s*\)\s*$/i.exec(query.trim())
  if (!match) return { rest: query.trim() }
  const canonical = JURISDICTIONS.find((value) => value.toLowerCase() === match[1].toLowerCase())
  return { jurisdiction: canonical, rest: query.slice(0, match.index).trim() }
}

/**
 * Resolve a spoken or typed statute name.
 *
 * A jurisdiction written in the query (`Crimes Act (NSW)`) narrows the
 * candidates; without one, an ambiguous alias returns every candidate and
 * `needsJurisdiction: true`.
 */
export function resolveLawAlias(query: string): AliasResolution {
  const raw = (query ?? "").trim()
  const { jurisdiction, rest } = splitJurisdiction(raw)
  const key = normaliseAliasKey(rest)

  const aliasHits = (byAliasKey.get(key) ?? []).map(
    (entry): AliasCandidate => ({ ...entry, matchedBy: "alias", needsJurisdiction: false }),
  )
  const officialHits = (byOfficialKey.get(key) ?? [])
    .filter((entry) => !aliasHits.some((hit) => hit.official === entry.official && hit.jurisdiction === entry.jurisdiction))
    .map((entry): AliasCandidate => ({ ...entry, matchedBy: "official", needsJurisdiction: false }))

  let candidates = dedupe([...aliasHits, ...officialHits])
  if (jurisdiction) {
    const narrowed = candidates.filter((entry) => entry.jurisdiction === jurisdiction)
    // Only narrow when something survives: `CCA (NSW)` should still surface
    // the Commonwealth CCA rather than silently returning nothing.
    if (narrowed.length > 0) candidates = narrowed
  }

  const jurisdictions = new Set(candidates.map((entry) => entry.jurisdiction))
  const needsJurisdiction = jurisdictions.size > 1
  for (const candidate of candidates) candidate.needsJurisdiction = needsJurisdiction

  const searchText = !needsJurisdiction && candidates.length > 0 ? candidates[0].official : raw
  return {
    query: raw,
    ...(jurisdiction ? { jurisdiction } : {}),
    candidates,
    needsJurisdiction,
    searchText,
  }
}

function dedupe(candidates: AliasCandidate[]): AliasCandidate[] {
  const seen = new Set<string>()
  const out: AliasCandidate[] = []
  for (const candidate of candidates) {
    const key = `${candidate.official}|${candidate.jurisdiction}|${candidate.sch ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

/** The shape `hasRelatedHit` needs from a result row — any search client can supply it. */
export interface RelatableResult {
  name?: string
  /** Any alternative name the source carries (previous title, abbreviation). */
  altName?: string
}

/**
 * Containment on a folded key is meaningless below this length: `act`,
 * `law` and `the` are substrings of nearly every Australian statute title, so
 * a short key would make every result "related".
 */
const MIN_OVERLAP_KEY_LENGTH = 5

/**
 * Does any result actually correspond to what was asked for?
 *
 * Upstream search endpoints sometimes ignore a query they cannot parse and
 * return a generic list. Passing that back reads as "here is your Act" when
 * it is really "the search did not work" — so at least one result must share
 * a name with the query (or with the official title the alias expands to)
 * before the result set is treated as an answer.
 */
export function hasRelatedHit(query: string, results: readonly RelatableResult[]): boolean {
  if (results.length === 0) return false

  const keys = new Set<string>()
  const add = (value?: string) => {
    const key = normaliseAliasKey(value ?? "")
    if (key.length >= MIN_OVERLAP_KEY_LENGTH) keys.add(key)
  }
  const { rest } = splitJurisdiction((query ?? "").trim())
  add(rest)
  for (const candidate of resolveLawAlias(query).candidates) add(candidate.official)
  if (keys.size === 0) return false

  return results.some((result) => {
    for (const value of [result.name, result.altName]) {
      const resultKey = normaliseAliasKey(value ?? "")
      if (resultKey.length < MIN_OVERLAP_KEY_LENGTH) continue
      for (const key of keys) {
        if (resultKey.includes(key) || key.includes(resultKey)) return true
      }
    }
    return false
  })
}

/** Every alias that points at a given official title — used to widen a search. */
export function aliasesFor(official: string, jurisdiction?: AliasJurisdiction): string[] {
  const key = normaliseAliasKey(official)
  return LAW_ALIAS_ENTRIES
    .filter((entry) => normaliseAliasKey(entry.official) === key)
    .filter((entry) => !jurisdiction || entry.jurisdiction === jurisdiction)
    .map((entry) => entry.alias)
}

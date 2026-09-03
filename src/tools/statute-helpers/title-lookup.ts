/**
 * "What did the user mean?" → one FRL title.
 *
 * FRL's `text(...,name,contains)` search is relevance-ordered, and relevance
 * does not know that a *principal Act* is almost always the intended answer:
 * searching "competition and consumer act" puts three repealed price-notification
 * instruments above `C2004A00109` (verified live 2026-09-04). So every tool
 * that accepts a name goes through `rankTitles` here, and none of them takes
 * "the first hit" on trust.
 *
 * `hasRelatedHit` is applied at the other end: when nothing in the result set
 * overlaps the query, the tools say the search did not connect rather than
 * describing unrelated statutes as if they were the answer.
 */

import type { AuApiClient } from "../../lib/api-client.js"
import { ErrorCodes, LawApiError } from "../../lib/errors.js"
import { hasRelatedHit, normaliseAliasKey, resolveLawAlias, type AliasResolution } from "../../lib/law-alias.js"
import type { FrlTitle } from "../../lib/types.js"

export const TITLE_SELECT =
  "id,name,collection,subCollection,status,isPrincipal,isInForce,year,number,seriesType," +
  "nameHistory,statusHistory,hasCommencedUnincorporatedAmendments"

/** Register ids are `C2004A00109` / `F2011L00287` — alphanumeric, no punctuation. */
export function looksLikeRegisterId(value: string): boolean {
  return /^[A-Za-z]\d{4}[A-Za-z]\d{4,6}$/.test(value.trim())
}

function score(query: string, title: FrlTitle): number {
  const q = normaliseAliasKey(query)
  const name = normaliseAliasKey(title.name)
  let points = 0
  if (name === q) points += 100
  else if (name.startsWith(q)) points += 60
  else if (name.includes(q)) points += 30
  if (title.isPrincipal) points += 25
  if (title.collection === "Act") points += 20
  if (title.status === "InForce") points += 15
  else if (title.status === "Repealed") points -= 10
  // Historical-name hits are real answers (TPA → CCA), just below a live match.
  for (const entry of title.nameHistory ?? []) {
    if (normaliseAliasKey(entry.name) === q) points += 45
  }
  return points
}

/**
 * Rank search hits so the principal Act wins over same-named instruments.
 * Stable: equal scores keep the upstream (relevance) order.
 */
export function rankTitles(query: string, titles: readonly FrlTitle[]): FrlTitle[] {
  return titles
    .map((title, index) => ({ title, index, points: score(query, title) }))
    .sort((a, b) => b.points - a.points || a.index - b.index)
    .map((entry) => entry.title)
}

export interface TitleLookup {
  title: FrlTitle
  /** Every candidate considered, ranked — so a tool can show the runners-up. */
  candidates: FrlTitle[]
  alias: AliasResolution
  /** Human-readable note about how the query was resolved, when non-obvious. */
  notes: string[]
}

/**
 * Resolve `registerId` (used as given) or a name/alias (alias table → FRL name
 * search → ranking). Throws `LawApiError` rather than guessing when the query
 * is ambiguous across jurisdictions or nothing related came back.
 */
export async function resolveTitle(
  client: AuApiClient,
  input: { registerId?: string; query?: string; collection?: string },
): Promise<TitleLookup> {
  const alias = resolveLawAlias(input.query ?? "")

  if (input.registerId) {
    const title = await client.getTitle(input.registerId)
    return { title, candidates: [title], alias, notes: [] }
  }

  const query = (input.query ?? "").trim()
  if (!query) {
    throw new LawApiError("Provide either registerId or a law name/alias", ErrorCodes.INVALID_PARAM, [
      'e.g. { "query": "Competition and Consumer Act" } or { "registerId": "C2004A00109" }',
    ])
  }

  if (looksLikeRegisterId(query)) {
    const title = await client.getTitle(query)
    return { title, candidates: [title], alias, notes: [`Treated "${query}" as a register id.`] }
  }

  const notes: string[] = []
  if (alias.needsJurisdiction) {
    const list = alias.candidates.map((c) => `${c.official} (${c.jurisdiction})`).join("; ")
    throw new LawApiError(
      `"${query}" names Acts in more than one jurisdiction: ${list}`,
      ErrorCodes.INVALID_PARAM,
      [
        'Add the jurisdiction, e.g. "Evidence Act (NSW)".',
        "Only Commonwealth law is on the Federal Register; state Acts need get_state_equivalents / the state register.",
      ],
    )
  }
  if (alias.candidates.length > 0 && alias.searchText !== query) {
    const hit = alias.candidates[0]
    notes.push(
      `Alias "${query}" → ${hit.official} (${hit.jurisdiction})${hit.sch ? `, sch ${hit.sch}` : ""}.` +
        (hit.notes ? ` ${hit.notes}` : ""),
    )
  }

  const searchText = alias.searchText || query
  let found = await client.searchTitles({
    text: searchText,
    searchType: "name",
    ...(input.collection ? { collection: input.collection } : {}),
    top: 20,
    select: TITLE_SELECT,
  })
  if (found.titles.length === 0) {
    // A name search misses when the phrase only appears in the body; widen once.
    found = await client.searchTitles({ text: searchText, searchType: "nameAndText", top: 20, select: TITLE_SELECT })
    if (found.titles.length > 0) notes.push("No title-name match; fell back to a full-text search.")
  }

  if (found.titles.length === 0) {
    throw new LawApiError(`The Federal Register returned no title matching "${searchText}"`, ErrorCodes.NOT_FOUND, [
      "Try fewer words, or the official short title with its year.",
      "State and territory Acts are not on the Federal Register — use get_state_equivalents.",
    ])
  }

  const relatable = found.titles.map((title) => ({
    name: title.name,
    altName: title.nameHistory?.map((entry) => entry.name).join(" "),
  }))
  if (!hasRelatedHit(searchText, relatable)) {
    throw new LawApiError(
      `The Federal Register answered "${searchText}" with ${found.titles.length} titles, none of which share a name with the query`,
      ErrorCodes.NOT_FOUND,
      [
        "This looks like the search ignoring the query rather than a real match — do not report these titles as the answer.",
        `Unrelated top hit was: ${found.titles[0].name} [${found.titles[0].id}].`,
        "Retry with the official short title, or use advanced_search for a full-text query.",
      ],
    )
  }

  const ranked = rankTitles(searchText, found.titles)
  return { title: ranked[0], candidates: ranked, alias, notes }
}

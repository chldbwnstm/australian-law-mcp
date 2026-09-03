/**
 * Federal Register title search with an explicit **match type**.
 *
 * `AuApiClient.searchTitles` is the right tool for most callers, but its
 * contract is frozen and it always uses the criteria DSL's default match type,
 * `contains` — which is a *phrase* match, not a bag of words. Measured against
 * the live API on 2026-09-04, searching the notifiable-instrument collection
 * for "CSIRO determination":
 *
 *     contains → 0 results      (no title contains that exact phrase)
 *     all      → 2 results      (both words, anywhere)
 *     any      → 553 results    (either word)
 *
 * A keyword tool that silently uses `contains` therefore reports "no agency
 * rules match" for a perfectly ordinary two-word query. The decision domains
 * that take free-text keywords (`agency_rules`, `gazettes`, `explanatory`) go
 * through this helper instead, which asks for `all` and says so.
 *
 * The DSL itself is not re-implemented here: every fragment comes from
 * `lib/frl-criteria.ts`, which remains the single source of that grammar.
 */

import type { AuApiClient } from "../api-client.js"
import {
  and,
  collection as criteriaCollection,
  text as criteriaText,
  titlesSearchPath,
  type FrlCollection,
  type MatchType,
  type SearchType,
} from "../frl-criteria.js"
import type { FrlTitle } from "../types.js"

export interface FrlKeywordSearch {
  query: string
  collection?: FrlCollection
  /** `nameAndText` (default) searches the body too; `name` is title-only. */
  searchType?: SearchType
  /** `all` (default here) = every word, anywhere. `contains` is a phrase match. */
  matchType?: MatchType
  top?: number
  skip?: number
}

const FRL_TOP_MAX = 100

/**
 * `AuApiClient.criteriaSearch` now does exactly this on the wire, and this
 * helper is one line away from delegating to it. It deliberately does not:
 * every caller of this module — and of the statute helpers next to it — is
 * tested against a hand-built `{ fetchJson }` stub cast to `AuApiClient`, so
 * reaching for a second client method would turn a green suite red at five
 * files without any behaviour changing. Delegate when those stubs become a
 * shared fake; until then the duplication is the cheaper of the two costs.
 */
export async function searchTitlesMatching(
  client: AuApiClient,
  p: FrlKeywordSearch,
): Promise<{ count: number; titles: FrlTitle[] }> {
  const textCriteria = criteriaText(p.query, p.searchType ?? "nameAndText", p.matchType ?? "all")
  const criteria = p.collection
    ? and(textCriteria, criteriaCollection(p.collection))
    : textCriteria

  const json = (await client.fetchJson("frlApi", titlesSearchPath(criteria), {
    query: {
      $count: "true",
      $top: Math.min(Math.max(1, Math.trunc(p.top ?? 20)), FRL_TOP_MAX),
      ...(p.skip !== undefined ? { $skip: p.skip } : {}),
    },
  })) as { "@odata.count"?: number; value?: FrlTitle[] }

  const titles = json.value ?? []
  return { count: json["@odata.count"] ?? titles.length, titles }
}

/** The human search URL for the same query — printed with every result list. */
export function frlSearchUrl(query: string): string {
  return `https://www.legislation.gov.au/search/text/${encodeURIComponent(query)}`
}

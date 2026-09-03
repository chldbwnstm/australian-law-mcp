/**
 * Finding the Act a chain is about.
 *
 * Every chain stacks upward from one title — Act → instruments → provisions →
 * cases — so if the first step comes back empty the whole chain does. And the
 * Federal Register's title search is a *name* search: hand it "can my landlord
 * keep my bond in Queensland" and it returns nothing, even though the routing
 * was perfectly correct. The chain then reports "no such law", which is a lie.
 *
 * Four attempts, cheapest first, each recorded so a failure can say what was
 * tried (a caller who is not told the search terms cannot rephrase):
 *
 *  1. The **alias table** — "the ACL", "FW Act", "TPA" are how people write.
 *  2. A **statute-shaped phrase lifted out of the query** ("… Fair Work Act
 *     2009 …"), because a question usually contains the title it is about.
 *  3. The **query as given**, which works whenever the user typed a name.
 *  4. **Full-text search** (`search_ai_law`'s ranked titles) — this is the step
 *     that turns a subject into a statute, and the only one that costs a second
 *     round trip, which is why it is last.
 */

import type { AuApiClient } from "../lib/api-client.js"
import { resolveLawAlias } from "../lib/law-alias.js"
import type { FrlTitle } from "../lib/types.js"
import { searchAiLawStructured } from "./ai-search.js"
import { TITLE_SELECT, looksLikeRegisterId, rankTitles } from "./statute-helpers/title-lookup.js"

export interface ChainBaseLaw {
  registerId: string
  name: string
  collection?: string
  status?: string
}

export interface ChainBaseLawResult {
  laws: ChainBaseLaw[]
  /** The search term that actually produced results, if any. */
  searchedWith?: string
  /** Every term tried, in order — printed verbatim in the failure message. */
  attempts: string[]
}

/**
 * `Competition and Consumer Act 2010`, `Fair Work Regulations 2009` — the shape
 * of an Australian short title: capitalised words, then Act/Regulations/Rules/
 * Determination/Order/Code, then optionally a year.
 */
const TITLE_PHRASE =
  /\b([A-Z][A-Za-z'’-]*(?:\s+(?:of|and|for|the|in|on|to|[A-Z][A-Za-z'’-]*)){0,8}\s+(?:Act|Regulations?|Rules?|Determination|Instrument|Order|Code|Standard|Constitution)(?:\s+(?:19|20)\d{2})?)\b/

/** The statute-shaped phrase inside a question, if there is one. */
export function titlePhraseFrom(query: string): string | undefined {
  const match = TITLE_PHRASE.exec(query)
  return match?.[1]?.trim()
}

function toBaseLaw(title: FrlTitle): ChainBaseLaw {
  return {
    registerId: title.id,
    name: title.name,
    ...(title.collection ? { collection: title.collection } : {}),
    ...(title.status ? { status: title.status } : {}),
  }
}

/**
 * Prefer the principal Act over its own delegated legislation.
 *
 * Full-text relevance ranks by word overlap, and a regulation repeats its
 * enabling Act's vocabulary — so "Fair Work Regulations 2009" routinely outranks
 * the *Fair Work Act 2009*. A chain built on the regulations produces a
 * three-tier view with nothing above it.
 */
function actsFirst(laws: ChainBaseLaw[]): ChainBaseLaw[] {
  const subordinate = (law: ChainBaseLaw) => law.collection !== undefined && law.collection !== "Act"
  return [...laws.filter((law) => !subordinate(law)), ...laws.filter(subordinate)]
}

export async function resolveChainBaseLaw(
  apiClient: AuApiClient,
  query: string,
  max = 3,
): Promise<ChainBaseLawResult> {
  const attempts: string[] = []
  const tried = new Set<string>()

  const byName = async (text: string): Promise<ChainBaseLaw[]> => {
    const key = text.trim()
    if (!key || tried.has(key)) return []
    tried.add(key)
    attempts.push(key)
    try {
      const found = await apiClient.searchTitles({
        text: key,
        searchType: "name",
        top: Math.max(max * 3, 10),
        select: TITLE_SELECT,
      })
      return rankTitles(key, found.titles).slice(0, max).map(toBaseLaw)
    } catch {
      // A failed attempt is not a failed chain: the next rung may answer, and
      // if none does, the caller is told which terms were tried.
      return []
    }
  }

  // 0) A register id typed straight in is a lookup, not a search.
  const trimmed = query.trim()
  if (looksLikeRegisterId(trimmed)) {
    try {
      const title = await apiClient.getTitle(trimmed)
      return { laws: [toBaseLaw(title)], searchedWith: trimmed, attempts: [trimmed] }
    } catch {
      attempts.push(trimmed)
    }
  }

  // 1) Alias table.
  const alias = resolveLawAlias(trimmed)
  if (!alias.needsJurisdiction && alias.searchText && alias.searchText !== trimmed) {
    const hits = await byName(alias.searchText)
    if (hits.length > 0) return { laws: actsFirst(hits), searchedWith: alias.searchText, attempts }
  }

  // 2) A title-shaped phrase inside the question.
  const phrase = titlePhraseFrom(trimmed)
  if (phrase && phrase !== trimmed) {
    const hits = await byName(phrase)
    if (hits.length > 0) return { laws: actsFirst(hits), searchedWith: phrase, attempts }
  }

  // 3) The query as typed.
  const asTyped = await byName(trimmed)
  if (asTyped.length > 0) return { laws: actsFirst(asTyped), searchedWith: trimmed, attempts }

  // 4) Subject → statute, via full text. Last because it costs an extra call
  //    and returns titles whose *body* mentions the words, not whose name does.
  attempts.push(`${trimmed} (full text)`)
  try {
    const { titleSignals } = await searchAiLawStructured(apiClient, {
      query: trimmed,
      limit: Math.max(max, 5),
      provisionHints: false,
    })
    const laws = titleSignals.slice(0, max).map((signal) => ({
      registerId: signal.registerId,
      name: signal.name,
      ...(signal.collection ? { collection: signal.collection } : {}),
      ...(signal.status ? { status: signal.status } : {}),
    }))
    if (laws.length > 0) {
      return { laws: actsFirst(laws), searchedWith: `${trimmed} (full text)`, attempts }
    }
  } catch {
    // Same contract as the name attempts: a broken rung never becomes a claim.
  }

  return { laws: [], attempts }
}

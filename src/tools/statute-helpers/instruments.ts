/**
 * Act ⇄ delegated legislation, both directions — **live-verified 2026-09-04**.
 *
 * docs/research/frl-api-reference.md does not settle how to find instruments
 * made under an Act, so the question was answered against the live API before
 * a line of tool code was written. Findings, in the order they were probed:
 *
 *  - `Title` has a navigation property `authorisedBy` of type
 *    `Collection(Affect)` (in `$metadata`). `$expand=authorisedBy` **works**,
 *    and for an instrument it returns the enabling Act *with the enabling
 *    provision*: `Competition and Consumer Regulations 2010` →
 *    `{affectingTitleId:"C2004A00109", affectingProvisions:"s 172"}`.
 *    Expanded on an Act it is empty (the Act is not itself authorised).
 *  - `$expand=textApplies` is a different relation entirely — disallowance
 *    regime and sunsetting-exemption pointers, not the enabling Act. Not used
 *    for this.
 *  - Two **undocumented criteria functions exist**, found by probing the
 *    parser (unknown names 400 with `cannot parse <token>`, so a 200 is proof):
 *      · `authorises("C2004A00109")` → 647 titles made under the CCA.
 *      · `authorisedby("F1996B01420")` → the 1 Act that authorises it.
 *    `enabledby`, `madeunder`, `enables`, `authorizedby` (z) all 400.
 *    Both compose inside `and(...)` with `collection(...)` / `status(...)`.
 *
 * So neither direction is heuristic: this is the Register's own relation, and
 * `$expand=authorisedBy` on the results attaches the enabling provision. The
 * name-matching fallback the brief allowed for is not needed and is not here —
 * a guess would be strictly worse than the real edge.
 *
 * These two functions are not in `lib/frl-criteria.ts` (a Wave-1 shared file
 * this agent must not edit); they belong there eventually.
 */

import type { AuApiClient } from "../../lib/api-client.js"
import { and, collection as criteriaCollection, status as criteriaStatus, titlesSearchPath, type Criteria, type FrlCollection, type FrlStatus } from "../../lib/frl-criteria.js"
import { SEARCH_CACHE_TTL, lawCache } from "../../lib/cache.js"
import type { FrlTitle } from "../../lib/types.js"

function assertId(titleId: string, fn: string): string {
  const value = titleId.trim()
  if (!/^[A-Za-z0-9]+$/.test(value)) {
    throw new Error(`Invalid FRL title id for ${fn}(): ${JSON.stringify(titleId)}`)
  }
  return value
}

/** `authorises("C2004A00109")` — every instrument made under that Act. */
export function authorises(titleId: string): Criteria {
  return `authorises("${assertId(titleId, "authorises")}")`
}

/** `authorisedby("F1996B01420")` — the Act(s) an instrument was made under. */
export function authorisedby(titleId: string): Criteria {
  return `authorisedby("${assertId(titleId, "authorisedby")}")`
}

/** One row of the `authorisedBy` expansion: who authorised what, under which provision. */
export interface AuthorisedByRow {
  affectingTitleId: string
  affectedTitleId: string
  affectingProvisions: string | null
  affectedProvisions: string | null
}

export interface RelatedTitle extends FrlTitle {
  authorisedBy?: AuthorisedByRow[]
}

const SELECT = "id,name,collection,subCollection,status,isPrincipal,isInForce,year,number"

interface ODataList {
  "@odata.count"?: number
  value?: RelatedTitle[]
}

async function criteriaSearch(
  client: AuApiClient,
  criteria: Criteria,
  opts: { top: number; skip?: number; expand?: string; orderby?: string; cacheKey: string },
): Promise<{ count: number; titles: RelatedTitle[] }> {
  const cached = lawCache.get<{ count: number; titles: RelatedTitle[] }>(opts.cacheKey)
  if (cached) return cached
  const query: Record<string, string | number> = {
    $count: "true",
    $top: Math.min(Math.max(opts.top, 1), 100),
    $select: SELECT,
  }
  if (opts.skip !== undefined) query.$skip = opts.skip
  if (opts.expand) query.$expand = opts.expand
  if (opts.orderby) query.$orderby = opts.orderby
  const json = (await client.fetchJson("frlApi", titlesSearchPath(criteria), { query })) as ODataList
  const titles = json.value ?? []
  const result = { count: json["@odata.count"] ?? titles.length, titles }
  lawCache.set(opts.cacheKey, result, SEARCH_CACHE_TTL)
  return result
}

/**
 * The delegated-legislation tier: what a caller means by "made under this Act".
 *
 * `authorises()` unrestricted also returns Gazette price notifications and
 * notifiable instruments (acting-chairperson appointments and the like) —
 * genuinely authorised by the Act, but not legislation. The *Legislation Act
 * 2003* draws the same line: a legislative instrument has legislative
 * character and is disallowable; a notifiable instrument is not. So the
 * default is legislative instruments only, and everything else is opt-in.
 */
export const INSTRUMENT_COLLECTIONS: readonly FrlCollection[] = ["LegislativeInstrument"]

/**
 * Instruments made under an Act. `inForceOnly` is the sensible default for a
 * legal question — the CCA authorises 647 titles in total, of which far fewer
 * are instruments currently in force.
 */
export async function enabledInstruments(
  client: AuApiClient,
  actId: string,
  opts: { inForceOnly?: boolean; collections?: readonly FrlCollection[]; top?: number; skip?: number } = {},
): Promise<{ count: number; titles: RelatedTitle[] }> {
  const collections = opts.collections ?? INSTRUMENT_COLLECTIONS
  const parts: Criteria[] = [authorises(actId)]
  if (collections.length > 0) parts.push(criteriaCollection(...collections))
  if (opts.inForceOnly !== false) parts.push(criteriaStatus("InForce" as FrlStatus))
  const top = opts.top ?? 25
  return criteriaSearch(client, and(...parts), {
    top,
    ...(opts.skip !== undefined ? { skip: opts.skip } : {}),
    expand: "authorisedBy",
    orderby: "name asc",
    cacheKey: `authorises:${actId}:${collections.join("+") || "any"}:${opts.inForceOnly !== false}:${top}:${opts.skip ?? 0}`,
  })
}

/** The Act(s) an instrument was made under, with the enabling provision when the Register records one. */
export async function enablingActs(
  client: AuApiClient,
  instrumentId: string,
): Promise<{ acts: RelatedTitle[]; provisions: string[] }> {
  const found = await criteriaSearch(client, authorisedby(instrumentId), {
    top: 20,
    orderby: "name asc",
    cacheKey: `authorisedby:${instrumentId}`,
  })
  // The enabling *provision* lives on the instrument's own authorisedBy rows.
  const rows = await expandAuthorisedBy(client, instrumentId)
  const provisions = rows
    .filter((row) => row.affectingProvisions)
    .map((row) => `${row.affectingProvisions} of [${row.affectingTitleId}]`)
  return { acts: found.titles, provisions }
}

/** `$expand=authorisedBy` for a single title — the enabling-provision detail. */
export async function expandAuthorisedBy(client: AuApiClient, titleId: string): Promise<AuthorisedByRow[]> {
  const id = assertId(titleId, "expandAuthorisedBy")
  const key = `authorisedByExpand:${id}`
  const cached = lawCache.get<AuthorisedByRow[]>(key)
  if (cached) return cached
  const json = (await client.fetchJson("frlApi", "Titles", {
    query: { $filter: `id eq '${id}'`, $select: "id,name", $expand: "authorisedBy" },
  })) as ODataList
  const rows = json.value?.[0]?.authorisedBy ?? []
  lawCache.set(key, rows, SEARCH_CACHE_TTL)
  return rows
}

/** `s 172` for the row naming `actId`, when the Register records one. */
export function enablingProvisionFor(rows: readonly AuthorisedByRow[], actId: string): string | undefined {
  const row = rows.find((entry) => entry.affectingTitleId === actId && entry.affectingProvisions)
  return row?.affectingProvisions ?? undefined
}

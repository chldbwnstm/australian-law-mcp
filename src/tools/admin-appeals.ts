/**
 * `admin_appeals` decision domain — merits review of administrative decisions.
 *
 * Australia splits this across a federal tribunal and eight state ones. Of
 * those, exactly two publish in a form this server can read:
 *
 *  - **NCAT** (NSW Civil and Administrative Tribunal) — on NSW Caselaw, under
 *    five division ids; those ids and which division each belongs to were
 *    resolved live and live in `sources/nsw-caselaw.ts`.
 *  - **QCAT** (Queensland Civil and Administrative Tribunal) — on Queensland
 *    Judgments, citation-addressable like every other Queensland court.
 *
 * The **Administrative Review Tribunal** (and the AAT before it) publishes only
 * to AustLII, which this server refuses to fetch. That is stated on every
 * response as a deep link, because the ART is the tribunal most callers mean
 * and silently omitting it would read as "there are no federal decisions".
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { austliiSearchUrl } from "../lib/external-links-map.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { LooseToolResponse } from "../lib/types.js"
import * as nsw from "../lib/sources/nsw-caselaw.js"
import * as qld from "../lib/sources/qld-judgments.js"
import { interleave, renderDocument, renderSearch } from "../lib/sources/render.js"
import type { SourceHit, SourceSearchResult } from "../lib/sources/types.js"

/**
 * Court tokens Queensland Judgments accepts in `multiSelectCourt[]`.
 *
 * `QCATA` (the appeal tribunal) is NOT one of them — sending it makes the
 * search endpoint answer 302 with an empty body, which parses as a shape
 * failure and looks like the tribunal has no decisions. Appeal decisions are
 * still reachable by citation: `/caselaw/qcata/2020/5` returns 200.
 */
const QCAT_SEARCH_COURTS = ["QCAT"] as const

/** Tokens accepted when resolving a citation to a judgment URL. */
const QCAT_CITATION_COURTS = ["QCAT", "QCATA"] as const

export type AdminTribunal = "ncat" | "qcat"

/** Browser links for the tribunals this server does not fetch. */
export function artLinks(query: string): string[] {
  return [
    austliiSearchUrl(query, ["au/cases/cth/ARTA"]),
    austliiSearchUrl(query, ["au/cases/cth/AATA"]),
    "https://www.art.gov.au/",
  ]
}

export const SearchAdminAppealsSchema = z.object({
  query: z.string().min(1).describe("Keywords, e.g. 'tenancy mould', 'occupational discipline', 'guardianship'."),
  tribunal: z.enum(["ncat", "qcat", "all"]).optional().describe(
    "Which reachable tribunal to search. 'all' (default) searches NCAT and QCAT together.",
  ),
  /** NCAT division token, when the caller knows which one. */
  division: z.enum(["NSWCATAD", "NSWCATAP", "NSWCATCD", "NSWCATGD", "NSWCATOD"]).optional().describe(
    "Restrict NCAT to one division: AD administrative/equal opportunity, AP appeal panel, " +
    "CD consumer and commercial, GD guardianship, OD occupational.",
  ),
  limit: z.number().min(1).max(50).default(10).optional(),
  page: z.number().min(1).default(1).optional(),
})

export type SearchAdminAppealsInput = z.infer<typeof SearchAdminAppealsSchema>

export async function searchAdminAppeals(
  client: AuApiClient,
  input: SearchAdminAppealsInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `admin_appeals:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const tribunal = input.tribunal ?? "all"
    const page = (input.page ?? 1) - 1
    const tasks: Array<Promise<SourceSearchResult>> = []
    const labels: AdminTribunal[] = []

    if (tribunal === "ncat" || tribunal === "all") {
      const courts = input.division ? [nsw.NSW_COURT_IDS[input.division]] : nsw.NCAT_COURT_IDS
      tasks.push(nsw.advancedSearch(client, { body: input.query, courts, page }))
      labels.push("ncat")
    }
    if (tribunal === "qcat" || tribunal === "all") {
      tasks.push(
        qld.search(client, { text: input.query, courts: QCAT_SEARCH_COURTS, page: input.page ?? 1, perPage: 20 }),
      )
      labels.push("qcat")
    }

    const settled = await Promise.allSettled(tasks)
    const results: SourceSearchResult[] = []
    const notes: string[] = [
      "The Administrative Review Tribunal (and the AAT before it) publishes reasons only through " +
      `AustLII, which this server does not fetch. Search it in a browser: ${artLinks(input.query)[0]}`,
    ]
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        results.push(prefix(outcome.value, labels[index]))
      } else {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        notes.push(`${labels[index].toUpperCase()} did not answer (${reason}) — it was not searched, not ruled out.`)
      }
    })

    if (results.length === 0) {
      throw new LawApiError(
        "Neither NCAT nor QCAT answered this request.",
        ErrorCodes.API_ERROR,
        ["⚠️ Transport failure on every source; this is not evidence about the decisions themselves.", "Retry shortly."],
      )
    }

    const merged: SourceSearchResult = {
      hits: interleave(results).slice(0, input.limit ?? 10),
      sourceUrl: results[0].sourceUrl,
      total: results.reduce((sum, result) => sum + (result.total ?? result.hits.length), 0),
      totalIsUnreliable: results.some((result) => result.totalIsUnreliable),
      page: input.page ?? 1,
    }
    if (merged.totalIsUnreliable) {
      merged.totalNote = results.map((result) => result.totalNote).filter(Boolean).join(" ")
    }

    const text = renderSearch(merged, {
      heading: "Administrative appeals — NCAT + QCAT",
      query: input.query,
      showSource: true,
      notes,
      followUp: 'get_decision_text(domain="admin_appeals", id="ncat:<id>" | "qcat:<id>")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[admin_appeals]")
  }
}

function prefix(result: SourceSearchResult, tribunal: AdminTribunal): SourceSearchResult {
  return {
    ...result,
    hits: result.hits.map((hit: SourceHit) =>
      hit.id.includes(":") ? hit : { ...hit, id: `${tribunal}:${hit.id}` },
    ),
  }
}

export const GetAdminAppealSchema = z.object({
  id: z.string().min(1).describe(
    "Id from the search results: 'ncat:<24-hex NSW Caselaw id>' or 'qcat:<numeric id>'. " +
    "A bare '[2020] QCAT 123' citation also works.",
  ),
  full: z.boolean().optional().describe("true = reasons verbatim; omitted = long bodies shortened with the gap marked."),
})

export type GetAdminAppealInput = z.infer<typeof GetAdminAppealSchema>

export async function getAdminAppealText(
  client: AuApiClient,
  input: GetAdminAppealInput,
): Promise<LooseToolResponse> {
  try {
    const full = input.full === true
    const raw = input.id.trim()
    const [maybePrefix, ...rest] = raw.split(":")
    const id = rest.length > 0 ? rest.join(":") : raw

    if (maybePrefix === "ncat") {
      return render(await nsw.getDecision(client, id), full)
    }
    if (maybePrefix === "qcat") {
      return render(/^\d+$/.test(id) ? await qld.getById(client, id) : await qld.getByCitation(client, id), full)
    }
    if (/^\[/.test(raw)) {
      const court = /\]\s*([A-Za-z]+)/.exec(raw)?.[1]?.toUpperCase()
      if (court && QCAT_CITATION_COURTS.includes(court as (typeof QCAT_CITATION_COURTS)[number])) {
        return render(await qld.getByCitation(client, raw), full)
      }
      if (court && nsw.NSW_COURT_IDS[court]) {
        const found = await nsw.lookupByCitation(client, raw)
        const hit = found.hits[0]
        if (hit) return render(await nsw.getDecision(client, hit.id), full)
      }
    }
    if (/^[0-9a-f]{16,32}$/i.test(raw)) return render(await nsw.getDecision(client, raw), full)

    throw new LawApiError(
      `Unrecognised administrative-appeal id: ${JSON.stringify(input.id)}`,
      ErrorCodes.INVALID_PARAM,
      [
        "Use the id printed by search_decisions(domain=\"admin_appeals\") — 'ncat:…' or 'qcat:…'.",
        "ART/AAT decisions cannot be fetched here at all; this server links them instead.",
      ],
    )
  } catch (error) {
    return formatToolError(error, "get_decision_text[admin_appeals]")
  }
}

function render(document: Parameters<typeof renderDocument>[0], full: boolean): LooseToolResponse {
  return { content: [{ type: "text", text: renderDocument(document, { bodyHeading: "Reasons", full }) }] }
}

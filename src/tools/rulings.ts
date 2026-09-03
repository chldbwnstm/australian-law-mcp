/**
 * `search_rulings` / `get_ruling_text` — the ATO Legal Database side of three
 * decision domains: `tax_rulings`, `interpretations` and `customs`
 * (docs/research/tribunals-states-treaties.md §4, grok-followup.md §3.4–3.5).
 *
 * The ATO's own document ids are **not derivable from a product code**. The
 * research doc's `{PREFIX}/{CODE}/NAT/ATO/00001` pattern holds for rulings and
 * determinations, but ATO IDs are three-segment (`AID/AID200634/00001`) and
 * court extracts are different again (`JUD/2026ATC10-800/00001`). Guessing one
 * produces a 404 that reads like "no such ruling".
 *
 * So this file never constructs a docid. A product code is resolved by exact
 * phrase search — verified 2026-09-04: `tm_phrase=TR 2024/1` returns exactly
 * one row carrying `TXR/TR20241/NAT/ATO/00001`, `GSTR 2001/1` returns
 * `GST/GSTR20011/…`, `PS LA 2009/9` returns `PSR/PS20099/…`. One extra request
 * buys a correct answer instead of a plausible one.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { LooseToolResponse } from "../lib/types.js"
import * as ato from "../lib/sources/ato.js"
import { searchAdrp } from "../lib/sources/integrity-sources.js"
import { interleave, renderDocument, renderSearch } from "../lib/sources/render.js"
import type { SourceSearchResult } from "../lib/sources/types.js"

export type RulingDomain = "tax_rulings" | "interpretations" | "customs"

/**
 * Phrases that bias a keyword search toward one product family. These are
 * `tm_phrase` values, which AND with `tm_and` (measured, not assumed: adding a
 * phrase to `tm_and=capital gains` cuts 16,051 hits to 2,545).
 */
const DOMAIN_PHRASE: Record<RulingDomain, string | undefined> = {
  tax_rulings: "Taxation Ruling",
  interpretations: "ATO Interpretative Decision",
  customs: "excise",
}

const DOMAIN_HEADING: Record<RulingDomain, string> = {
  tax_rulings: "ATO public rulings and determinations",
  interpretations: "ATO interpretative decisions and practice statements",
  customs: "Customs, excise and anti-dumping",
}

/** Australian Border Force is not scraped; its tariff material lives here as links. */
export const ABF_LINKS = [
  "https://www.abf.gov.au/importing-exporting-and-manufacturing/tariff-classification",
  "https://www.abf.gov.au/help-and-support/notices/australian-customs-notices",
]

/** Does this look like an ATO document id rather than a product code? */
export function looksLikeDocId(value: string): boolean {
  const prefix = value.split("/")[0]?.toUpperCase()
  return value.includes("/") && Boolean(prefix && ato.ATO_PREFIXES[prefix])
}

export const SearchRulingsSchema = z.object({
  query: z.string().min(1).describe(
    "Keywords ('main residence exemption'), or an exact product code ('TR 2024/1', 'GSTR 2001/1', 'PS LA 2009/9').",
  ),
  domain: z.enum(["tax_rulings", "interpretations", "customs"]).optional().describe(
    "tax_rulings = TR/TD/GSTR/PCG public rulings (default); interpretations = ATO IDs and PS LAs; " +
    "customs = excise/customs ATO material plus the Anti-Dumping Review Panel indexes.",
  ),
  exactPhrase: z.string().optional().describe(
    "Words that must appear together verbatim. Combines with `query` as an AND.",
  ),
  limit: z.number().min(1).max(50).default(10).optional(),
  page: z.number().min(1).default(1).optional(),
})

export type SearchRulingsInput = z.infer<typeof SearchRulingsSchema>

/** `TR 2024/1`, `GSTR 2001/1`, `PS LA 2009/9`, `TD 2017/20`, `ATO ID 2006/34`. */
export const PRODUCT_CODE = /^(?:[A-Z]{2,5}(?:\s+LA)?|ATO\s+ID)\s+(?:19|20)\d{2}\/\d{1,4}[A-Z]?$/i

export async function searchRulings(
  client: AuApiClient,
  input: SearchRulingsInput,
): Promise<LooseToolResponse> {
  try {
    const domain: RulingDomain = input.domain ?? "tax_rulings"
    const cacheKey = `rulings:${domain}:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const limit = input.limit ?? 10
    const page = input.page ?? 1
    const isCode = PRODUCT_CODE.test(input.query.trim())

    const params: ato.AtoSearchParams = {
      start: (page - 1) * limit + 1,
      pageSize: limit,
    }
    if (isCode) {
      // An exact code identifies one document; a keyword AND would only dilute it.
      params.phrase = input.query.trim()
    } else {
      params.allWords = input.query
      const phrase = input.exactPhrase ?? DOMAIN_PHRASE[domain]
      if (phrase) params.phrase = phrase
    }

    const tasks: Array<Promise<SourceSearchResult>> = [ato.search(client, params)]
    if (domain === "customs") tasks.push(searchAdrp(client, { query: input.query, index: "past", limit }))

    const settled = await Promise.allSettled(tasks)
    const results: SourceSearchResult[] = []
    const notes: string[] = []
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value)
      } else {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        notes.push(
          `${index === 0 ? "The ATO Legal Database" : "The Anti-Dumping Review Panel index"} did not answer ` +
          `(${reason}) — it was not searched, which is not a finding that nothing matches.`,
        )
      }
    })

    if (results.length === 0) {
      throw new LawApiError(
        "The ATO Legal Database did not answer this search.",
        ErrorCodes.API_ERROR,
        [
          "⚠️ A transport failure says nothing about whether the ruling exists.",
          "The endpoint can take up to 60 seconds under load — retry shortly.",
        ],
      )
    }

    if (!isCode) {
      notes.push(
        "`tm_and` words are ANDed and `tm_phrase` is an exact phrase, so extra words narrow this " +
        "search. If nothing comes back, drop a word rather than adding one.",
      )
    }
    if (domain === "customs") {
      notes.push(`Australian Border Force tariff and notice pages are not scraped: ${ABF_LINKS.join(" · ")}`)
    }

    const merged: SourceSearchResult = {
      hits: interleave(results).slice(0, limit),
      sourceUrl: results[0].sourceUrl,
      total: results.reduce((sum, result) => sum + (result.total ?? result.hits.length), 0),
      page,
    }

    const text = renderSearch(merged, {
      heading: DOMAIN_HEADING[domain],
      query: input.query,
      showSource: results.length > 1,
      notes,
      followUp: 'get_ruling_text(id="TR 2024/1") or get_ruling_text(id="<DocID from above>")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, `search_rulings`)
  }
}

export const GetRulingTextSchema = z.object({
  id: z.string().min(1).describe(
    "An ATO product code ('TR 2024/1', 'PS LA 2009/9', 'GSTR 2001/1') or a DocID from search " +
    "results ('TXR/TR20241/NAT/ATO/00001'). Product codes are resolved by exact search, never guessed.",
  ),
  asAt: z.string().optional().describe(
    "Point-in-time date, YYYY-MM-DD. Omitted = the current version. The ATO keeps historical " +
    "versions of rulings under its own point-in-time index, separate from the FRL compilation series.",
  ),
  full: z.boolean().optional().describe("true = the ruling verbatim; omitted = long bodies shortened with the gap marked."),
})

export type GetRulingTextInput = z.infer<typeof GetRulingTextSchema>

/** Resolve a product code to its real DocID via exact phrase search. */
export async function resolveDocId(client: AuApiClient, code: string): Promise<string> {
  const result = await ato.search(client, { phrase: code.trim(), pageSize: 10 })
  const wanted = code.trim().toLowerCase().replace(/\s+/g, " ")
  const exact = result.hits.find((hit) => hit.title.toLowerCase().replace(/\s+/g, " ") === wanted)
  const hit = exact ?? result.hits[0]
  if (!hit) {
    throw new LawApiError(
      `The ATO Legal Database returned no document titled ${JSON.stringify(code)}.`,
      ErrorCodes.UPSTREAM_NO_DATA,
      [
        "⚠️ This is one register's answer to one exact-phrase query — not a finding that the ruling does not exist.",
        "Check the code's spacing and year/number form ('TR 2024/1', not 'TR2024/1'), then retry.",
        "If you already have a DocID from search_rulings, pass that instead — it needs no resolution step.",
      ],
    )
  }
  return hit.id
}

export async function getRulingText(
  client: AuApiClient,
  input: GetRulingTextInput,
): Promise<LooseToolResponse> {
  try {
    const docId = looksLikeDocId(input.id) ? input.id.trim() : await resolveDocId(client, input.id)
    const pit = input.asAt ? ato.pitForDate(input.asAt) : ato.ATO_PIT_CURRENT
    const document = await ato.getDocument(client, docId, pit)
    return {
      content: [
        {
          type: "text",
          text: renderDocument(document, {
            bodyHeading: "Ruling",
            full: input.full === true,
            notes: input.asAt
              ? [`Point-in-time view as at ${input.asAt} (ATO PiT stamp ${pit}).`]
              : [],
          }),
        },
      ],
    }
  } catch (error) {
    return formatToolError(error, "get_ruling_text")
  }
}

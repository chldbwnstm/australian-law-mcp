/**
 * `tax_tribunal` decision domain — tax merits review and what the ATO says
 * about it (docs/research/tribunals-states-treaties.md §3–4, grok-followup.md §3.5).
 *
 * The honest shape of this domain matters more than its coverage:
 *
 *  - The **Administrative Review Tribunal** (ART, formerly the AAT) is the tax
 *    merits-review body, and it publishes reasons *only* through AustLII. This
 *    server does not fetch AustLII, so ART/AATA decisions are deep links here —
 *    never "no results".
 *  - The **ATO Legal Database** carries two things that are genuinely reachable
 *    and genuinely useful: **decision impact statements** (the Commissioner's
 *    response to a decision) and court/tribunal extracts under the `JUD/`
 *    prefix. Those are what this tool actually searches.
 *
 * Decision impact statements cannot be isolated by a URL parameter — `fid=` is
 * a help-page selector, not a filter, and the advanced-search UI is JavaScript.
 * What does work, measured on 2026-09-04, is the exact phrase: `tm_phrase=
 * Decision impact statement` cuts the corpus to 849 documents and ANDs cleanly
 * with keywords. That is the filter this tool uses, and it is labelled as an
 * approximation rather than presented as a category filter.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { austliiSearchUrl, lawCiteUrl } from "../lib/external-links-map.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { LooseToolResponse } from "../lib/types.js"
import * as ato from "../lib/sources/ato.js"
import { renderDocument, renderSearch } from "../lib/sources/render.js"
import { getRulingText } from "./rulings.js"

/** The phrase that approximates the "decision impact statements" category. */
export const DIS_PHRASE = "Decision impact statement"

export function tribunalLinks(query: string): string[] {
  return [
    austliiSearchUrl(query, ["au/cases/cth/ARTA"]),
    austliiSearchUrl(query, ["au/cases/cth/AATA"]),
    "https://www.art.gov.au/",
  ]
}

export const SearchTaxTribunalSchema = z.object({
  query: z.string().min(1).describe(
    "Keywords, a case name, or a citation such as '[2019] HCA 3'. Matched across the ATO Legal Database.",
  ),
  decisionImpactOnly: z.boolean().optional().describe(
    "true (default) narrows to documents containing the phrase 'Decision impact statement'. " +
    "Set false to search the whole database including JUD/ court and tribunal extracts.",
  ),
  limit: z.number().min(1).max(50).default(10).optional(),
  page: z.number().min(1).default(1).optional(),
})

export type SearchTaxTribunalInput = z.infer<typeof SearchTaxTribunalSchema>

export async function searchTaxTribunalDecisions(
  client: AuApiClient,
  input: SearchTaxTribunalInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `tax_tribunal:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const limit = input.limit ?? 10
    const page = input.page ?? 1
    const decisionImpactOnly = input.decisionImpactOnly ?? true

    const params: ato.AtoSearchParams = {
      allWords: input.query,
      start: (page - 1) * limit + 1,
      pageSize: limit,
    }
    if (decisionImpactOnly) params.phrase = DIS_PHRASE

    const result = await ato.search(client, params)

    const notes = [
      "Administrative Review Tribunal (and older AAT) reasons are published only via AustLII, which " +
      `this server does not fetch. [UPSTREAM_BLOCKED] — open in a browser: ${tribunalLinks(input.query)[0]}`,
      decisionImpactOnly
        ? `Narrowed by the exact phrase "${DIS_PHRASE}". The ATO has no URL parameter that isolates ` +
          "decision impact statements, so this is a text filter, not a category filter — a DIS that " +
          "phrases itself differently would be missed."
        : "Searching the whole ATO Legal Database, including JUD/ court and tribunal extracts.",
    ]

    const text = renderSearch(result, {
      heading: "Tax merits review — ATO Legal Database",
      query: input.query,
      notes,
      followUp: 'get_decision_text(domain="tax_tribunal", id="<DocID from above>")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[tax_tribunal]")
  }
}

export const GetTaxTribunalSchema = z.object({
  id: z.string().min(1).describe(
    "An ATO DocID from the search results, e.g. 'JUD/2026ATC10-800/00001', or an ATO product code.",
  ),
  asAt: z.string().optional().describe("Point-in-time date, YYYY-MM-DD."),
  full: z.boolean().optional(),
})

export type GetTaxTribunalInput = z.infer<typeof GetTaxTribunalSchema>

export async function getTaxTribunalDecisionText(
  client: AuApiClient,
  input: GetTaxTribunalInput,
): Promise<LooseToolResponse> {
  // A tribunal-related ATO document is fetched exactly like a ruling; the only
  // difference is the caveat printed with it, which `renderDocument` adds via
  // the source's own `note`. Reusing the ruling path keeps the DocID-versus-
  // product-code resolution in one place.
  const citationShaped = /^\[(?:1[89]|20)\d{2}\]/.test(input.id.trim())
  if (citationShaped) {
    return {
      content: [
        {
          type: "text",
          text: [
            `[UPSTREAM_BLOCKED] ${input.id} is a case citation, and tribunal reasons are published ` +
            "through AustLII, which this server does not fetch.",
            "",
            "⚠️ This is a refusal to request, not a finding that the decision does not exist.",
            `Open it in a browser: ${lawCiteUrl(input.id)}`,
            `AustLII search: ${austliiSearchUrl(input.id)}`,
            "",
            'To read the ATO\'s response to the decision instead, run search_decisions(domain="tax_tribunal", ' +
            `query="${input.id}") and pass back the DocID it prints.`,
          ].join("\n"),
        },
      ],
      isError: true,
    }
  }

  const args: Parameters<typeof getRulingText>[1] = { id: input.id }
  if (input.asAt !== undefined) args.asAt = input.asAt
  if (input.full !== undefined) args.full = input.full
  return getRulingText(client, args)
}


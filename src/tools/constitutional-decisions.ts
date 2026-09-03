/**
 * `constitutional` decision domain — High Court judgments on constitutional
 * questions (docs/research/tribunals-states-treaties.md, "Constitutional
 * matters").
 *
 * There is no constitutional-law database in Australia because there does not
 * need to be one: the High Court is the forum, and its judgment listing indexes
 * catchwords, which for these cases read "Constitutional law (Cth) — s 92 —
 * …". So the domain is the High Court source with a catchword filter.
 *
 * One correction to the research note, measured on 2026-09-04: the `keywords`
 * parameter is an **OR**, not an AND. `constitutional implied freedom` returns
 * 519 results where `constitutional` alone returns 482 — extra words widen the
 * search rather than narrowing it. Combining the user's terms with the word
 * "constitutional" would therefore make the result *less* constitutional, so
 * this tool does not do it. It searches the user's terms and offers an opt-in
 * catchword verification pass instead, which is the only filtering that is
 * actually true to the data.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { LooseToolResponse } from "../lib/types.js"
import * as hca from "../lib/sources/hcourt.js"
import { renderDocument, renderSearch } from "../lib/sources/render.js"
import type { SourceHit } from "../lib/sources/types.js"

const CONSTITUTIONAL = /constitution/i

/** How many detail pages a verification pass will fetch. Bounded by the budget. */
export const MAX_VERIFY = 6

export const SearchConstitutionalSchema = z.object({
  query: z.string().optional().describe(
    "Keywords matched against case names and catchwords. Defaults to 'constitutional', which " +
    "returns the catchword-tagged constitutional line of cases. NOTE: extra words WIDEN this " +
    "search (the parameter is an OR), so keep queries short.",
  ),
  year: z.number().min(1998).max(2100).optional().describe(
    "Restrict to one year of judgments (the site's `d:` facet).",
  ),
  page: z.number().min(1).default(1).optional().describe("1-based page; 12 judgments per page."),
  verifyCatchwords: z.boolean().optional().describe(
    "true = fetch the detail page of the first few hits and keep only those whose catchwords " +
    "mention the Constitution. Costs one request per hit checked (max 6).",
  ),
})

export type SearchConstitutionalInput = z.infer<typeof SearchConstitutionalSchema>

export async function searchConstitutionalDecisions(
  client: AuApiClient,
  input: SearchConstitutionalInput,
): Promise<LooseToolResponse> {
  try {
    const query = input.query?.trim() || "constitutional"
    const cacheKey = `constitutional:${JSON.stringify({ ...input, query })}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const params: hca.HcourtSearchParams = { keywords: query, page: (input.page ?? 1) - 1 }
    if (input.year !== undefined) params.year = input.year
    const result = await hca.search(client, params)
    // hcourt pages from 0; this tool's `page` is 1-based.
    result.page = input.page ?? 1

    const notes: string[] = [
      "hcourt.gov.au matches `keywords` against case names and catchwords with OR semantics — " +
      "adding words broadens the result set rather than narrowing it.",
    ]

    let hits: SourceHit[] = result.hits
    if (input.verifyCatchwords && hits.length > 0) {
      const checked: SourceHit[] = []
      let unverified = 0
      for (const hit of hits.slice(0, MAX_VERIFY)) {
        const detail = await hca.getDetail(client, hit.id)
        const catchwords = detail.metadata.find(([label]) => label === "Catchwords")?.[1]
        if (catchwords && CONSTITUTIONAL.test(catchwords)) {
          checked.push({ ...hit, catchwords })
        } else {
          unverified += 1
        }
      }
      notes.push(
        `Catchword verification: ${checked.length} of the first ${Math.min(MAX_VERIFY, hits.length)} hits ` +
        `carry constitutional catchwords; ${unverified} did not. Hits beyond the first ${MAX_VERIFY} were ` +
        "not checked and are omitted from this list — they are unverified, not excluded.",
      )
      hits = checked
    }

    const text = renderSearch(
      { ...result, hits },
      {
        heading: "High Court — constitutional judgments",
        query,
        notes,
        followUp: 'get_decision_text(domain="constitutional", id="<slug from above>")',
      },
    )
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[constitutional]")
  }
}

export const GetConstitutionalSchema = z.object({
  id: z.string().min(1).describe(
    "Judgment slug from the search results, e.g. 'potter-pseudonym-v-king'.",
  ),
})

export type GetConstitutionalInput = z.infer<typeof GetConstitutionalSchema>

export async function getConstitutionalDecisionText(
  client: AuApiClient,
  input: GetConstitutionalInput,
): Promise<LooseToolResponse> {
  try {
    const detail = await hca.getDetail(client, input.id)
    return {
      content: [
        {
          type: "text",
          text: renderDocument(detail, {
            bodyHeading: "Reasons",
            notes: [
              "Catchwords are the Court's own subject tagging — 'Constitutional law (Cth) — s 92' " +
              "and the like — and are the reliable signal that a judgment is constitutional.",
            ],
          }),
        },
      ],
    }
  } catch (error) {
    return formatToolError(error, "get_decision_text[constitutional]")
  }
}

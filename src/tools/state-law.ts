/**
 * `search_state_law` / `get_state_law_text` — the `state_law` domain.
 *
 * A thin, honest wrapper over `lib/sources/state-legislation.ts`. The value it
 * adds is the per-register truth-telling: Australia's eight sub-national
 * registers have wildly different public surfaces, and a tool that presented
 * them as one uniform "state legislation search" would make Victoria's missing
 * search endpoint and New South Wales's blocked host look like empty results.
 *
 * Grades, as measured:
 *   QLD, TAS — full-text search and whole-act HTML.
 *   WA       — A–Z index search; full text via the `mrdoc_*` document.
 *   NT       — title-list search; text is a PDF/Word download.
 *   VIC      — slug-addressed act pages and version history; the authorised
 *              PDF/DOCX links are client-side only.
 *   ACT      — register numbers only; no reachable index at all.
 *   NSW, SA  — blocked. `[UPSTREAM_BLOCKED]` plus a deep link, every time.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, UpstreamBlockedError, formatToolError } from "../lib/errors.js"
import { followupEnvelope, makeGap } from "../lib/research-followup.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { LooseToolResponse } from "../lib/types.js"
import {
  getStateLawText as fetchStateLawText,
  normaliseJurisdiction,
  searchStateLaw as runStateSearch,
  STATE_JURISDICTIONS,
  type StateJurisdiction,
} from "../lib/sources/state-legislation.js"
import { renderSearch } from "../lib/sources/render.js"
import { sourceDocumentResponse } from "./source-document.js"

/** What each register can actually answer — printed with every search. */
export const REGISTER_GRADES: Readonly<Record<StateJurisdiction, string>> = {
  QLD: "full-text search (EnAct projectdata) and whole-act HTML; content searches can take up to 90 seconds",
  TAS: "full-text search (EnAct projectdata) and whole-act HTML",
  WA: "title search over the A–Z in-force index; full text via the register's mrdoc document",
  VIC: "act pages addressed by slug, with version history; the authorised PDF/DOCX links are rendered client-side and are not in the server response",
  NT: "title search over the By-Title list; act text is a PDF/Word download",
  ACT: "register numbers only (YYYY-N) — every browse and search path returns 404 to a non-browser client",
  NSW: "blocked: no public query surface and the register discourages automated access — links only",
  SA: "blocked: no public query surface and the register discourages automated access — links only",
}

function requireJurisdiction(input: string): StateJurisdiction {
  const jurisdiction = normaliseJurisdiction(input)
  if (!jurisdiction) {
    throw new LawApiError(
      `Unknown jurisdiction: ${JSON.stringify(input)}`,
      ErrorCodes.INVALID_PARAM,
      [`Use one of: ${STATE_JURISDICTIONS.join(", ")} (full names such as "Queensland" also work).`],
    )
  }
  return jurisdiction
}

export const SearchStateLawSchema = z.object({
  jurisdiction: z.string().min(2).describe(
    "QLD | TAS | WA | VIC | NT | ACT | NSW | SA (full state names accepted). " +
    "NSW and SA are blocked hosts and return deep links rather than results.",
  ),
  query: z.string().min(1).describe(
    "For QLD/TAS: words to find in the text (or the title, with field='Title'). " +
    "For WA/NT: title words. For VIC: the act title, which is turned into the register's slug. " +
    "For ACT: the register number, e.g. '2001-14'.",
  ),
  field: z.enum(["Content", "Title", "Heading", "Schedule", "DefinedTerm"]).optional().describe(
    "QLD/TAS only — which CCL index to search. 'Content' (default) is full text; " +
    "'DefinedTerm' finds acts that define a term.",
  ),
  includeRepealed: z.boolean().optional().describe("QLD/TAS only — include repealed legislation."),
  limit: z.number().min(1).max(50).default(10).optional(),
})

export type SearchStateLawInput = z.infer<typeof SearchStateLawSchema>

export async function searchStateLaw(
  client: AuApiClient,
  input: SearchStateLawInput,
): Promise<LooseToolResponse> {
  try {
    const jurisdiction = requireJurisdiction(input.jurisdiction)
    const cacheKey = `state_law:${jurisdiction}:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const options: Parameters<typeof runStateSearch>[3] = { limit: input.limit ?? 10 }
    if (input.field) options.field = input.field
    if (input.includeRepealed !== undefined) options.includeRepealed = input.includeRepealed

    const result = await runStateSearch(client, jurisdiction, input.query, options)
    const text = renderSearch(result, {
      heading: `${jurisdiction} legislation`,
      query: input.query,
      notes: [`Register surface: ${REGISTER_GRADES[jurisdiction]}.`],
      followUp: `get_state_law_text(jurisdiction="${jurisdiction}", id="<id from above>")`,
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    const response = formatToolError(error, "search_state_law")
    const jurisdiction = normaliseJurisdiction(input.jurisdiction)
    if (error instanceof UpstreamBlockedError && jurisdiction) {
      response.structuredContent = { followup: followupEnvelope([makeGap({
        kind: "source_access",
        originTool: "search_state_law",
        originalErrorCode: ErrorCodes.UPSTREAM_BLOCKED,
        target: { query: input.query },
        jurisdiction,
        reason: `${jurisdiction} legislation was not searched because its register is blocked to this server.`,
        sourceUrls: error.links,
        sourceAccess: "requires_access",
        evidenceNeeded: ["The official register search result", "The matching title and relevant provision text"],
      })], { pending: true }) }
    }
    return response
  }
}

export const GetStateLawTextSchema = z.object({
  jurisdiction: z.string().min(2).describe("QLD | TAS | WA | VIC | NT | ACT | NSW | SA."),
  id: z.string().min(1).describe(
    "The id printed by search_state_law: QLD/TAS 'act-1899-009', WA 'mrdoc_23112' or 'law_a101', " +
    "VIC 'crimes-act-1958', NT 'CRIMINAL-CODE-ACT-1983', ACT '2001-14'.",
  ),
  full: z.boolean().optional().describe("true = the act text verbatim; omitted = long bodies shortened with the gap marked."),
})

export type GetStateLawTextInput = z.infer<typeof GetStateLawTextSchema>

export async function getStateLawText(
  client: AuApiClient,
  input: GetStateLawTextInput,
): Promise<LooseToolResponse> {
  try {
    const jurisdiction = requireJurisdiction(input.jurisdiction)
    const document = await fetchStateLawText(client, jurisdiction, input.id)
    return sourceDocumentResponse(document, {
      bodyHeading: "Text",
      full: input.full === true,
      notes: [`Register surface: ${REGISTER_GRADES[jurisdiction]}.`],
      originTool: "get_state_law_text",
      documentId: input.id,
      jurisdiction,
    })
  } catch (error) {
    const response = formatToolError(error, "get_state_law_text")
    const jurisdiction = normaliseJurisdiction(input.jurisdiction)
    if (error instanceof UpstreamBlockedError && jurisdiction) {
      response.structuredContent = { followup: followupEnvelope([makeGap({
        kind: "document_body",
        originTool: "get_state_law_text",
        originalErrorCode: ErrorCodes.UPSTREAM_BLOCKED,
        target: { documentId: input.id },
        jurisdiction,
        reason: `${jurisdiction} legislation body was not retrieved because its register is blocked to this server.`,
        sourceUrls: error.links,
        sourceAccess: "requires_access",
        evidenceNeeded: ["The official authorised document body", "An exact relevant passage with provision and page locator"],
      })], { pending: true }) }
    }
    return response
  }
}

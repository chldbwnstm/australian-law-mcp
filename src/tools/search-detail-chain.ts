/**
 * "Search, then fetch the top hit."
 *
 * A search result is a list of identifiers; a caller almost always wants the
 * first one or two records as well. Doing that inside the chain saves a round
 * trip per branch, and — more importantly — it saves the calling LLM from
 * *inventing* the follow-up id, which is what happens when a chain hands back
 * a list and asks for another turn.
 *
 * Three rules, each learned rather than assumed:
 *
 *  - **A failed search is never followed.** `renderSearch` prints an explicit
 *    "no rows came back, this is not proof of absence" paragraph; extracting
 *    ids from it yields none, and an errored result is skipped outright.
 *  - **Per-record failures are reported, not dropped.** Each id gets its own
 *    block; a block that failed says so. `isError` is only set when *every*
 *    record failed, because a partial detail fetch is still information.
 *  - **`full` is only passed to tools whose schema has it** — the table in
 *    `tool-chain-config.ts` says which. Zod strips unknown keys silently, so
 *    passing it blindly would make "give me the whole thing" vanish without a
 *    trace.
 */

import type { AuApiClient } from "../lib/api-client.js"
import { SEARCH_DETAIL_CHAINS } from "../lib/tool-chain-config.js"
import type { LooseToolResponse } from "../lib/types.js"
import type { FollowupEnvelope } from "../lib/research-followup.js"
import { followupEnvelope, mergeGaps } from "../lib/research-followup.js"
import { extractHitIds } from "./search-hits.js"

import { getLawText } from "./law-text.js"
import { getHistoricalLaw } from "./historical-law.js"
import { getRegisteredInstrumentText } from "./institutional-rules.js"
import { getExplanatoryText } from "./explanatory.js"
import { getCaseText } from "./precedents.js"
import { getConstitutionalDecisionText } from "./constitutional-decisions.js"
import { getAdminAppealText } from "./admin-appeals.js"
import { getTaxTribunalDecisionText } from "./tax-tribunal-decisions.js"
import { getRulingText } from "./rulings.js"
import {
  getIntegrityDecisionText,
  getPrivacyDecisionText,
  getPublicServiceDecisionText,
  getWorkplaceDecisionText,
} from "./committee-decisions.js"

export interface SearchDetailCallResult {
  text: string
  isError: boolean
  followup?: FollowupEnvelope
}

export interface SearchDetailOptions {
  /** How many top hits to expand. Defaults to 2 for cases, 1 elsewhere. */
  limit?: number
}

type DetailHandler = (apiClient: AuApiClient, input: Record<string, unknown>) => Promise<LooseToolResponse>

const DETAIL_HANDLERS: Record<string, DetailHandler> = {
  get_law_text: getLawText as DetailHandler,
  get_historical_law: getHistoricalLaw as DetailHandler,
  get_registered_instrument_text: getRegisteredInstrumentText as DetailHandler,
  get_explanatory_text: getExplanatoryText as DetailHandler,
  get_case_text: getCaseText as DetailHandler,
  get_constitutional_decision_text: getConstitutionalDecisionText as DetailHandler,
  get_admin_appeal_text: getAdminAppealText as DetailHandler,
  get_tax_tribunal_decision_text: getTaxTribunalDecisionText as DetailHandler,
  get_ruling_text: getRulingText as DetailHandler,
  get_workplace_decision_text: getWorkplaceDecisionText as DetailHandler,
  get_privacy_decision_text: getPrivacyDecisionText as DetailHandler,
  get_integrity_decision_text: getIntegrityDecisionText as DetailHandler,
  get_public_service_decision_text: getPublicServiceDecisionText as DetailHandler,
}

/**
 * Judgments are the one place two records beat one: a chain that shows a single
 * authority reads as if that authority settles the point.
 */
function defaultLimit(searchTool: string): number {
  return searchTool === "search_cases" ? 2 : 1
}

export function extractDetailIds(searchTool: string, output: string, limit?: number): string[] {
  const chain = SEARCH_DETAIL_CHAINS[searchTool]
  if (!chain) return []
  return extractHitIds(output, chain.idRegex, limit ?? defaultLimit(searchTool))
}

async function callDetailTool(
  apiClient: AuApiClient,
  searchTool: string,
  id: string,
): Promise<SearchDetailCallResult> {
  const chain = SEARCH_DETAIL_CHAINS[searchTool]
  const handler = chain ? DETAIL_HANDLERS[chain.detailTool] : undefined
  if (!chain || !handler) {
    return { text: `No detail tool is registered for ${searchTool}.`, isError: true }
  }

  const input: Record<string, unknown> = { [chain.detailParam]: id }
  // Shortened bodies are the point of the auto-fetch: the chain is showing
  // evidence, not reproducing a judgment. `full` stays available on the
  // individual tool.
  if (chain.supportsFull) input.full = false

  try {
    const result = await handler(apiClient, input)
    return {
      text: result.content?.map((item) => item.text).join("\n") || "",
      isError: !!result.isError,
      ...(result.structuredContent?.followup ? { followup: result.structuredContent.followup } : {}),
    }
  } catch (error) {
    return {
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    }
  }
}

function header(searchTool: string, count: number): string {
  const chain = SEARCH_DETAIL_CHAINS[searchTool]
  const shortened = chain.supportsFull ? ", bodies shortened" : ""
  return `Auto-fetched detail: ${searchTool} → ${chain.detailTool} (top ${count}${shortened})`
}

export async function fetchSearchDetailChain(
  apiClient: AuApiClient,
  searchTool: string,
  searchResult: SearchDetailCallResult,
  options: SearchDetailOptions = {},
): Promise<SearchDetailCallResult | null> {
  const chain = SEARCH_DETAIL_CHAINS[searchTool]
  if (!chain || searchResult.isError) return null

  const ids = extractDetailIds(searchTool, searchResult.text, options.limit)
  if (ids.length === 0) return null

  const details = await Promise.all(
    ids.map(async (id) => ({ id, detail: await callDetailTool(apiClient, searchTool, id) })),
  )

  const blocks: string[] = [header(searchTool, ids.length)]
  for (const { id, detail } of details) {
    blocks.push(`[${id}]\n${detail.text || "The detail lookup returned an empty body."}`)
  }

  const failures = details.filter(({ detail }) => detail.isError).length
  const gaps = mergeGaps(...details.map(({ detail }) => detail.followup?.gaps))
  return { text: blocks.join("\n\n"), isError: failures === ids.length, ...(gaps.length ? { followup: followupEnvelope(gaps, { pending: true }) } : {}) }
}

/**
 * The same, over several search results at once — used where a chain fans a
 * query across sources and wants the best few records overall rather than the
 * best few from each.
 */
export async function fetchCombinedSearchDetailChain(
  apiClient: AuApiClient,
  searchTool: string,
  searchResults: SearchDetailCallResult[],
  options: SearchDetailOptions = {},
): Promise<SearchDetailCallResult | null> {
  const combined = searchResults
    .filter((result) => !result.isError && result.text.trim())
    .map((result) => result.text)
    .join("\n")

  if (!combined.trim()) return null
  return fetchSearchDetailChain(apiClient, searchTool, { text: combined, isError: false }, options)
}

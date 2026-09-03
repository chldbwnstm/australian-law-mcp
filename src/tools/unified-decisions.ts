/**
 * `search_decisions` / `get_decision_text` — two tools over eighteen domains.
 *
 * Exposing thirty-six separate tools would spend most of an MCP client's tool
 * budget on descriptions; the dispatch tables below collapse them to two while
 * keeping each domain's own handler, schema and caveats intact. The domain enum
 * is the one frozen in docs/ARCHITECTURE.md and is not extended here — a domain
 * that exists in this file but not in that table is a domain no caller was told
 * about.
 *
 * Two behaviours are worth knowing before reading the tables:
 *
 *  - **`options` is a passthrough with a reserved-key guard.** Domain-specific
 *    parameters (`benchType`, `division`, `field`, `facets`, …) travel through
 *    it, but a key that would overwrite `query`, `id`, `page`, `limit`, `domain`
 *    or `full` is dropped rather than merged. Without that guard an
 *    `options.id` silently redirects the fetch to a different document than the
 *    one the caller named.
 *  - **Post-processing compaction is skipped for domains that already do it.**
 *    Handlers that take a `full` flag shorten their own body through
 *    `renderDocument`; running `compactLongSections` over their output as well
 *    would put a second gap marker inside the first gap's tail, and the
 *    character counts in the two markers would contradict each other.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { compactLongSections } from "../lib/decision-compact.js"
import { formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import type { LooseToolResponse } from "../lib/types.js"

import { getCaseText, searchCases } from "./precedents.js"
import { getConstitutionalDecisionText, searchConstitutionalDecisions } from "./constitutional-decisions.js"
import { getAdminAppealText, searchAdminAppeals } from "./admin-appeals.js"
import { getTaxTribunalDecisionText, searchTaxTribunalDecisions } from "./tax-tribunal-decisions.js"
import { getRulingText, searchRulings } from "./rulings.js"
import {
  getCompetitionDecisionText,
  getIntegrityDecisionText,
  getPrivacyDecisionText,
  getPublicServiceDecisionText,
  getWorkplaceDecisionText,
  searchCompetitionDecisions,
  searchIntegrityDecisions,
  searchPrivacyDecisions,
  searchPublicServiceDecisions,
  searchWorkplaceDecisions,
} from "./committee-decisions.js"
import {
  getRegisteredInstrumentText,
  searchAgencyRules,
  searchGazettes,
  searchUniversityRules,
} from "./institutional-rules.js"
import { getTreatyText, searchTreaties } from "./treaties.js"
import { getExplanatoryText, searchExplanatory } from "./explanatory.js"
import { getStateLawText, searchStateLaw } from "./state-law.js"

/** The 18 domains of docs/ARCHITECTURE.md, in that document's order. */
export const DECISION_DOMAINS = [
  "cases",
  "constitutional",
  "admin_appeals",
  "tax_tribunal",
  "tax_rulings",
  "interpretations",
  "customs",
  "competition",
  "workplace",
  "privacy",
  "integrity",
  "public_service",
  "university_rules",
  "agency_rules",
  "gazettes",
  "treaties",
  "explanatory",
  "state_law",
] as const

export type DecisionDomain = (typeof DECISION_DOMAINS)[number]

export const DOMAIN_LABELS: Record<DecisionDomain, string> = {
  cases: "court judgments (NSW Caselaw + High Court + Queensland Judgments)",
  constitutional: "High Court constitutional judgments",
  admin_appeals: "merits review — NCAT and QCAT (ART is link-only)",
  tax_tribunal: "tax merits review and ATO decision impact statements",
  tax_rulings: "ATO public rulings and determinations (TR/TD/GSTR/PCG)",
  interpretations: "ATO interpretative decisions and practice statements",
  customs: "customs and excise material plus Anti-Dumping Review Panel reviews",
  competition: "ACCC and Competition Tribunal (blocked — links plus a case-law fallback)",
  workplace: "Fair Work Commission decisions",
  privacy: "OAIC privacy determinations",
  integrity: "NACC investigation reports (Ombudsman is blocked)",
  public_service: "Merit Protection Commissioner case studies",
  university_rules: "university legislation in the state registers",
  agency_rules: "Commonwealth notifiable instruments",
  gazettes: "Commonwealth Gazette notices",
  treaties: "Australian Treaties Database (DFAT)",
  explanatory: "explanatory statements (instruments) and memoranda (Acts)",
  state_law: "state and territory legislation",
}

type Handler = (client: AuApiClient, args: any) => Promise<LooseToolResponse>

const SEARCH_HANDLERS: Record<DecisionDomain, Handler> = {
  cases: searchCases,
  constitutional: searchConstitutionalDecisions,
  admin_appeals: searchAdminAppeals,
  tax_tribunal: searchTaxTribunalDecisions,
  tax_rulings: (client, args) => searchRulings(client, { ...args, domain: "tax_rulings" }),
  interpretations: (client, args) => searchRulings(client, { ...args, domain: "interpretations" }),
  customs: (client, args) => searchRulings(client, { ...args, domain: "customs" }),
  competition: searchCompetitionDecisions,
  workplace: searchWorkplaceDecisions,
  privacy: searchPrivacyDecisions,
  integrity: searchIntegrityDecisions,
  public_service: searchPublicServiceDecisions,
  university_rules: searchUniversityRules,
  agency_rules: searchAgencyRules,
  gazettes: searchGazettes,
  treaties: searchTreaties,
  explanatory: searchExplanatory,
  state_law: searchStateLaw,
}

const GET_HANDLERS: Record<DecisionDomain, Handler> = {
  cases: getCaseText,
  constitutional: getConstitutionalDecisionText,
  admin_appeals: getAdminAppealText,
  tax_tribunal: getTaxTribunalDecisionText,
  tax_rulings: getRulingText,
  interpretations: getRulingText,
  customs: getRulingText,
  competition: getCompetitionDecisionText,
  workplace: getWorkplaceDecisionText,
  privacy: getPrivacyDecisionText,
  integrity: getIntegrityDecisionText,
  public_service: getPublicServiceDecisionText,
  university_rules: getStateLawText,
  agency_rules: getRegisteredInstrumentText,
  gazettes: getRegisteredInstrumentText,
  treaties: getTreatyText,
  explanatory: getExplanatoryText,
  state_law: getStateLawText,
}

/**
 * Domains whose `get` handler shortens its own body (it accepts `full` and
 * passes it to `renderDocument`). Running the post-processor over these again
 * would nest one gap marker inside another.
 */
export const SELF_COMPACTING: ReadonlySet<DecisionDomain> = new Set<DecisionDomain>([
  "cases",
  "admin_appeals",
  "tax_tribunal",
  "tax_rulings",
  "interpretations",
  "customs",
  "university_rules",
  "state_law",
])

/** Domains whose handler takes an `id` under a different name. */
const ID_KEY: Partial<Record<DecisionDomain, string>> = {
  cases: "id",
}

/** Domains that need a jurisdiction alongside the id. */
const NEEDS_JURISDICTION: ReadonlySet<DecisionDomain> = new Set<DecisionDomain>([
  "state_law",
  "university_rules",
])

const SEARCH_RESERVED = new Set(["query", "domain", "limit", "page"])
const GET_RESERVED = new Set(["id", "domain", "full"])

function mergeOptions(
  target: Record<string, unknown>,
  options: Record<string, unknown> | undefined,
  reserved: ReadonlySet<string>,
): string[] {
  const dropped: string[] = []
  for (const [key, value] of Object.entries(options ?? {})) {
    if (reserved.has(key)) {
      dropped.push(key)
      continue
    }
    target[key] = value
  }
  return dropped
}

function droppedNote(dropped: string[]): LooseToolResponse["content"][number] | undefined {
  if (dropped.length === 0) return undefined
  return {
    type: "text",
    text:
      `Note: options.${dropped.join(", options.")} ${dropped.length === 1 ? "was" : "were"} ignored — ` +
      "those keys are set by the tool's own parameters and cannot be overridden through `options`.",
  }
}

// ── search_decisions ──────────────────────────────────────────────────────

export const SearchDecisionsSchema = z.object({
  domain: z.enum(DECISION_DOMAINS).describe(
    "Which body of decisions to search. " +
    Object.entries(DOMAIN_LABELS)
      .map(([domain, label]) => `${domain}: ${label}`)
      .join("; "),
  ),
  query: z.string().optional().describe(
    "Search terms. Required for most domains; optional for privacy, integrity and public_service, " +
    "whose sources are browsable indexes.",
  ),
  limit: z.number().min(1).max(50).default(10).optional().describe("Maximum hits (default 10)."),
  page: z.number().min(1).default(1).optional().describe("1-based page number."),
  options: z.record(z.string(), z.unknown()).optional().describe(
    "Domain-specific parameters. cases:{jurisdiction,court} constitutional:{year,verifyCatchwords} " +
    "admin_appeals:{tribunal,division} tax_tribunal:{decisionImpactOnly} " +
    "tax_rulings|interpretations|customs:{exactPhrase} workplace:{benchType} " +
    "public_service:{facets} treaties:{facets,dateFilters} explanatory:{collection,verifyEs} " +
    "state_law|university_rules:{jurisdiction,field,includeRepealed}",
  ),
})

export type SearchDecisionsInput = z.infer<typeof SearchDecisionsSchema>

export async function searchDecisions(
  client: AuApiClient,
  input: SearchDecisionsInput,
): Promise<LooseToolResponse> {
  const handler = SEARCH_HANDLERS[input.domain]
  if (!handler) {
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] Unknown decision domain: ${input.domain}` }],
      isError: true,
    }
  }

  try {
    const args: Record<string, unknown> = {}
    if (input.query !== undefined) args.query = input.query
    if (input.limit !== undefined) args.limit = input.limit
    if (input.page !== undefined) args.page = input.page
    const dropped = mergeOptions(args, input.options, SEARCH_RESERVED)

    const result = await handler(client, args)
    const note = droppedNote(dropped)
    return note ? { ...result, content: [note, ...result.content] } : result
  } catch (error) {
    return formatToolError(error, `search_decisions[${input.domain}]`)
  }
}

// ── get_decision_text ─────────────────────────────────────────────────────

export const GetDecisionTextSchema = z.object({
  domain: z.enum(DECISION_DOMAINS).describe("The same domain the id came from."),
  id: z.string().min(1).describe(
    "The identifier printed by search_decisions for that domain — a source id, a citation, a " +
    "register id or a slug depending on the domain. Never invent one.",
  ),
  full: z.boolean().optional().describe(
    "true = return the body verbatim. Omitted = a long body is shortened from the middle and the " +
    "gap is marked with the exact number of characters removed.",
  ),
  options: z.record(z.string(), z.unknown()).optional().describe(
    "Domain-specific parameters. state_law|university_rules:{jurisdiction} (required) " +
    "privacy:{page} treaties:{keyword,page} tax_tribunal|tax_rulings:{asAt}",
  ),
})

export type GetDecisionTextInput = z.infer<typeof GetDecisionTextSchema>

export async function getDecisionText(
  client: AuApiClient,
  input: GetDecisionTextInput,
): Promise<LooseToolResponse> {
  const handler = GET_HANDLERS[input.domain]
  if (!handler) {
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] Unknown decision domain: ${input.domain}` }],
      isError: true,
    }
  }

  try {
    const args: Record<string, unknown> = { [ID_KEY[input.domain] ?? "id"]: input.id }
    if (input.full !== undefined) args.full = input.full
    const dropped = mergeOptions(args, input.options, GET_RESERVED)

    if (NEEDS_JURISDICTION.has(input.domain) && !args.jurisdiction) {
      return {
        content: [
          {
            type: "text",
            text:
              `[INVALID_PARAMETER] domain "${input.domain}" needs a jurisdiction. ` +
              `Call get_decision_text(domain="${input.domain}", id="${input.id}", ` +
              'options={"jurisdiction":"QLD"}) — the id alone does not say which register it belongs to.',
          },
        ],
        isError: true,
      }
    }

    const result = await handler(client, args)

    if (input.full !== true && !result.isError && !SELF_COMPACTING.has(input.domain)) {
      result.content = result.content.map((entry) => {
        if (typeof entry.text !== "string") return entry
        const compacted = compactLongSections(entry.text)
        return compacted === entry.text ? entry : { ...entry, text: truncateResponse(compacted) }
      })
    }

    const note = droppedNote(dropped)
    return note ? { ...result, content: [note, ...result.content] } : result
  } catch (error) {
    return formatToolError(error, `get_decision_text[${input.domain}]`)
  }
}

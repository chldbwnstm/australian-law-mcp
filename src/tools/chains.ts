/**
 * Chain tools — the eight multi-step questions, run as one call.
 *
 * A chain is *not* a convenience wrapper. It exists because the alternative —
 * the calling model issuing eight tool calls and stitching them together — is
 * where hallucination enters: between two turns a model fills gaps with what it
 * remembers, and what it remembers about Australian law is often the pre-2010
 * *Trade Practices Act*. A chain runs the branches itself, in parallel, and
 * hands back one document in which **every gap is labelled**.
 *
 * Three rules hold across all eight, and the tests pin each of them:
 *
 *  - **A failed branch is a marked section, never a failed chain.** `secOrSkip`
 *    prints why the branch is missing and which single tool retrieves it. An
 *    omitted section would be read as "there is nothing there".
 *  - **The three wide chains carry a 45-second deadline** (`chain-deadline.ts`).
 *    When it fires the chain assembles what arrived, marks the rest, and
 *    returns a normal result: a partial answer is a valid answer, so it is not
 *    `isError`. Expiry is never reported as `[NOT_FOUND]` — that would turn
 *    "we ran out of time" into "it does not exist".
 *  - **Nothing here re-implements a tool.** Every branch calls the same
 *    handler the MCP surface exposes, so a fix to `search_cases` reaches every
 *    chain that shows cases.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, formatToolError } from "../lib/errors.js"
import { truncateSections } from "../lib/schemas.js"
import { getRequestSignal, runWithRequestContext, throwIfRequestCancelled } from "../lib/session-state.js"
import type { LooseToolResponse, ToolResponse } from "../lib/types.js"
import {
  raceDeadline,
  startChainDeadline,
  timedOutChainNotice,
  timedOutSection,
  type ChainDeadline,
  type LegOutcome,
} from "./chain-deadline.js"
import { resolveChainBaseLaw, type ChainBaseLaw, type ChainBaseLawResult } from "./chain-law-lookup.js"
import { fetchSearchDetailChain } from "./search-detail-chain.js"

// Tool handlers — reused, never re-implemented.
import { searchAdminAppeals } from "./admin-appeals.js"
import { getBatchProvisions } from "./batch-provisions.js"
import {
  searchCompetitionDecisions,
  searchIntegrityDecisions,
  searchPrivacyDecisions,
  searchPublicServiceDecisions,
  searchWorkplaceDecisions,
} from "./committee-decisions.js"
import { compareOldNew } from "./comparison.js"
import { analyzeDocument } from "./document-analysis.js"
import { getEnabledInstruments, getStateEquivalents } from "./law-linkage.js"
import { getLawText } from "./law-text.js"
import { searchCases } from "./precedents.js"
import { getProvisionHistory } from "./provision-history.js"
import { searchRulings } from "./rulings.js"
import { getSchedules } from "./schedules.js"
import { searchAiLaw } from "./ai-search.js"
import { searchStateLaw } from "./state-law.js"
import { searchTaxTribunalDecisions } from "./tax-tribunal-decisions.js"
import { getThreeTier } from "./three-tier.js"

/**
 * Ceiling on a chain `query` (the reference's #121).
 *
 * Chain queries are "a law name plus a few keywords" — short. Without a limit
 * an unbounded user paste flows into the criteria encoder and the title-phrase
 * regex, and a backtracking pattern over 8 KB of text holds the event loop for
 * hundreds of milliseconds while every other request waits.
 */
export const MAX_CHAIN_QUERY = 2000
const chainQuery = (description: string) => z.string().min(2).max(MAX_CHAIN_QUERY).describe(description)

// ──────────────────────────────────────────────────────────────────────────
// Shared machinery
// ──────────────────────────────────────────────────────────────────────────

export interface CallResult {
  text: string
  isError: boolean
}

type Handler = (apiClient: AuApiClient, input: never) => Promise<LooseToolResponse>

/**
 * Run one tool and flatten it to text + a failure flag.
 *
 * Cancellation is re-thrown rather than turned into a section: an aborted
 * request has no consumer, and formatting an answer for one wastes the budget
 * the *next* request needs.
 */
async function callTool(
  handler: Handler,
  apiClient: AuApiClient,
  input: Record<string, unknown>,
): Promise<CallResult> {
  try {
    throwIfRequestCancelled()
    const result = await handler(apiClient, input as never)
    throwIfRequestCancelled()
    return { text: result.content?.[0]?.text ?? "", isError: !!result.isError }
  } catch (error) {
    if (getRequestSignal()?.aborted) throw error
    return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}

function sec(title: string, content: string): string {
  if (!content || !content.trim()) return ""
  return `\n▶ ${title}\n${content}\n`
}

/**
 * A section that failed says so, in the machine-readable bracket vocabulary,
 * and forbids the reader from filling it in. That last sentence is not
 * decoration: without it a model treats an empty section as an invitation.
 */
function secOrSkip(title: string, result: CallResult): string {
  if (!result.isError) return sec(title, result.text)
  const reason = result.text.trim() ? clip(result.text.trim(), 300) : "no reason was reported"
  return (
    `\n▶ ${title} [NOT RETRIEVED]\n` +
    `   ⚠️ This branch did not return data. Do not infer, guess or generate its contents.\n` +
    `   Reason: ${reason}\n`
  )
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function wrapResult(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateSections(text) }] }
}

function wrapError(error: unknown, toolName?: string): ToolResponse {
  const response = formatToolError(error, toolName)
  return { content: [{ type: "text", text: response.content[0]?.text ?? String(error) }], isError: true }
}

/** The failed rungs, one per line, for either of the two no-base-law answers. */
function failureLines(base: ChainBaseLawResult): string[] {
  const failures = base.failures ?? []
  if (failures.length === 0) return []
  return ["", "Lookups that failed:", ...failures.map((failure) => `  - "${failure.term}": ${clip(failure.message, 200)}`)]
}

/**
 * The base-law search did not come back empty — it did not come back.
 *
 * `[NOT_FOUND]` here would turn an unreachable Federal Register into "there is
 * no such Commonwealth law", which is the one thing this server may never say.
 * The label is the upstream one, the failed rungs are named so the caller can
 * see it was transport rather than vocabulary, and nothing invites a rephrase —
 * rephrasing a query the Register never answered changes nothing.
 */
function unreachableBaseLaw(query: string, base: ChainBaseLawResult): ToolResponse {
  const lines = [
    `[${ErrorCodes.API_ERROR}] The base-law search for "${query}" could not be completed — ` +
      `${(base.failures ?? []).length} of the Federal Register lookups failed, so no title was matched.`,
    "",
    "⚠️ This is an upstream failure, NOT a finding that no such law exists. Do not tell the user there is no such " +
      "Act, and do not invent one. Report that the Register could not be searched.",
  ]
  lines.push(...failureLines(base))
  if (base.attempts.length > 0) {
    lines.push("")
    lines.push(`Search terms tried: ${base.attempts.map((attempt) => `"${attempt}"`).join(" → ")}`)
  }
  lines.push("")
  lines.push("Worth trying:")
  lines.push("  - retry shortly — the Federal Register was unreachable, not empty;")
  lines.push("  - search_state_law, which uses different hosts entirely, if the subject may be state law.")
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true }
}

/**
 * No base law — the chain has nothing to stand on, so it stops and says what it
 * searched for. Listing the attempted terms is the difference between a user
 * who can rephrase and one who concludes the law does not exist.
 *
 * Only reached when every rung actually ran: a rung that failed for transport
 * reasons establishes no absence, and takes the `unreachableBaseLaw` route.
 */
function noBaseLaw(query: string, base: ChainBaseLawResult): ToolResponse {
  if ((base.failures ?? []).length > 0) return unreachableBaseLaw(query, base)
  const attempts = base.attempts
  const lines = [`[NOT_FOUND] No Commonwealth title could be matched to "${query}".`, ""]
  lines.push(
    "⚠️ The chain stopped because it never found a law to build on. Do not invent an Act, a section or a case. " +
      "Tell the user the search did not connect.",
  )
  if (attempts.length > 0) {
    lines.push("")
    lines.push(`Search terms tried: ${attempts.map((attempt) => `"${attempt}"`).join(" → ")}`)
  }
  lines.push("")
  lines.push("Worth trying:")
  lines.push("  - the official short title with its year, e.g. \"Fair Work Act 2009\";")
  lines.push("  - search_ai_law, which searches the text of legislation rather than its name;")
  lines.push("  - search_state_law — the Federal Register holds Commonwealth law only, and tenancy, crime,")
  lines.push("    land and most consumer-facing regulation are state law.")
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true }
}

/** Partial return when the deadline fired during the chain's groundwork. */
function expiredChainResult(parts: string[]): ToolResponse {
  return wrapResult([...parts, "", timedOutChainNotice()].join("\n"))
}

/**
 * Race a search and its auto-fetched detail against the deadline **separately**.
 *
 * Racing the pair as one unit throws away a search result that did arrive
 * because the detail lookup behind it did not. When the search itself expires
 * the detail leg is reported as `{ok: true, value: null}`: the search marker
 * already states the cause, and a second marker for the same cause reads as two
 * failures.
 */
async function searchThenDetail(
  deadline: ChainDeadline,
  apiClient: AuApiClient,
  searchTool: string,
  search: () => Promise<CallResult>,
): Promise<{ searchO: LegOutcome<CallResult>; detailO: LegOutcome<CallResult | null> }> {
  const searchO = await raceDeadline(deadline, search())
  if (!searchO.ok) return { searchO, detailO: { ok: true, value: null } }
  const detailO = await raceDeadline(deadline, fetchSearchDetailChain(apiClient, searchTool, searchO.value))
  return { searchO, detailO }
}

/** Print a leg: its value if it arrived, a timeout marker if it did not. */
function leg(parts: string[], title: string, outcome: LegOutcome<CallResult>, toolHint: string): void {
  if (outcome.ok) parts.push(secOrSkip(title, outcome.value))
  else parts.push(timedOutSection(title, toolHint))
}

/** The same for an optional detail leg — silent when the detail was never requested. */
function detailLeg(
  parts: string[],
  title: string,
  outcome: LegOutcome<CallResult | null>,
  toolHint: string,
): void {
  if (!outcome.ok) parts.push(timedOutSection(title, toolHint))
  else if (outcome.value) parts.push(secOrSkip(title, outcome.value))
}

// ── Query reading ─────────────────────────────────────────────────────────

/** Which specialist body a dispute belongs to. */
export type DisputeDomain = "tax" | "workplace" | "privacy" | "competition" | "integrity" | "public_service" | "general"

/**
 * Every stem carries an explicit `\w*`. A bare stem inside `\b…\b` never fires
 * — `\bemploy\b` does not match "employer" — and the resulting silence looks
 * exactly like "this question has no specialist forum".
 */
const DOMAIN_PATTERNS: Array<[Exclude<DisputeDomain, "general">, RegExp]> = [
  ["tax", /\b(?:tax|taxation|gst|income tax|deduction\w*|assessment\w*|ato|excise|customs|duty|superannuation)\b/i],
  ["workplace", /\b(?:employ\w*|dismissal|redundan\w*|award|enterprise agreement|wage\w*|underpay\w*|fair work|industrial|stand ?down)\b/i],
  ["privacy", /\b(?:privacy|personal information|data breach|surveillance|oaic|credit report\w*)\b/i],
  ["competition", /\b(?:competition|cartel\w*|misuse of market power|merger\w*|accc|anti-?competitive|price fixing)\b/i],
  ["integrity", /\b(?:corrupt\w*|integrity|whistleblow\w*|public interest disclosure|nacc|maladministration)\b/i],
  ["public_service", /\b(?:aps|public service|code of conduct|merit protection|promotion review)\b/i],
]

export function detectDisputeDomain(query: string): DisputeDomain {
  for (const [domain, pattern] of DOMAIN_PATTERNS) if (pattern.test(query)) return domain
  return "general"
}

/** Extra material a question implies without asking for it. */
export type Expansion = "schedule_fee" | "schedule_form" | "schedule_table" | "cases" | "rulings"

export function detectExpansions(query: string): Expansion[] {
  const found: Expansion[] = []
  if (/\$\s?\d|\b(?:fees?|charges?|penalt(?:y|ies)|fines?|infringement\w*|levy|levies|costs?|penalty units?)\b/i.test(query)) {
    found.push("schedule_fee")
  }
  if (/\b(?:forms?|approved form|notice of|template)\b/i.test(query)) found.push("schedule_form")
  if (/\b(?:schedules?|table|rates?|scale|thresholds?)\b/i.test(query)) found.push("schedule_table")
  if (/\b(?:cases?|judgm?ents?|court|decided|authority|precedents?)\b/i.test(query)) found.push("cases")
  if (/\b(?:rulings?|interpretations?|guidance|ato view|determinations?)\b/i.test(query)) found.push("rulings")
  return found
}

function wantsSchedules(expansions: Expansion[]): boolean {
  return expansions.some((expansion) => expansion.startsWith("schedule_"))
}

/**
 * The `Base law:` line, plus how it was chosen when that is not obvious.
 *
 * The notes come from the resolver's full-text rung, which re-ranks the
 * Register's relevance order and says so. Printing them here rather than
 * burying them is the point: a base law picked on body-text relevance alone
 * may be the wrong Act, and the reader has to be able to see that from the
 * answer itself.
 */
function baseLawHeader(law: ChainBaseLaw, notes: readonly string[] = []): string {
  const facts = [`registerId: ${law.registerId}`]
  if (law.collection) facts.push(law.collection)
  if (law.status) facts.push(law.status)
  return [`Base law: ${law.name} (${facts.join(" | ")})`, ...notes.map((note) => `  note: ${note}`)].join("\n")
}

// ──────────────────────────────────────────────────────────────────────────
// 1. chain_law_system — how one Act is put together
// ──────────────────────────────────────────────────────────────────────────

export const chainLawSystemSchema = z.object({
  query: chainQuery("Act name, alias or registerId, e.g. 'Competition and Consumer Act', 'CCA', 'C2004A00109'."),
  provisions: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Provisions to pull in the same call, e.g. ["s 18", "sch 2 s 18"].'),
})

export const chainLawSystemDescription =
  "[chain] The whole shape of one Act in a single call: the title itself, the Act → regulations → rules tier " +
  "(what is made under it), and the text of any provisions you name. Use it for 'how does the Fair Work Act fit " +
  "together', 'what regulations sit under the Privacy Act', 'show me the CCA structure and s 18'. For a single " +
  "section use get_law_text; for the delegated-legislation list alone use get_three_tier.";

export async function chainLawSystem(
  apiClient: AuApiClient,
  input: z.infer<typeof chainLawSystemSchema>,
): Promise<ToolResponse> {
  try {
    const base = await resolveChainBaseLaw(apiClient, input.query)
    if (base.laws.length === 0) return noBaseLaw(input.query, base)

    const law = base.laws[0]
    const parts = [`═══ Legislative structure: ${law.name} ═══`, baseLawHeader(law, base.notes)]

    const wanted = detectExpansions(input.query)
    const [threeTier, provisions, schedules] = await Promise.all([
      callTool(getThreeTier as Handler, apiClient, { registerId: law.registerId }),
      input.provisions?.length
        ? // The query goes with the id, not instead of it: `resolveTitle`
          // prefers the registerId, so the title is still the one this chain
          // picked, while `get_batch_provisions` reads the alias off `query`
          // to scope a bare provision to the schedule the alias names. "ACL"
          // *is* CCA sch 2, so dropping it answers "s 18" with the body's
          // "Meetings of Commission" under an Australian-Consumer-Law heading.
          callTool(getBatchProvisions as Handler, apiClient, {
            registerId: law.registerId,
            query: input.query,
            provisions: input.provisions,
          })
        : Promise.resolve(null),
      wantsSchedules(wanted)
        ? callTool(getSchedules as Handler, apiClient, { registerId: law.registerId })
        : Promise.resolve(null),
    ])

    parts.push(secOrSkip("Act → regulations → rules (what is made under it)", threeTier))
    if (provisions) parts.push(secOrSkip("Provisions you asked for", provisions))
    if (schedules) parts.push(secOrSkip("Schedules (rates, forms, tables)", schedules))

    if (base.laws.length > 1) {
      parts.push(
        sec(
          "Other titles that matched",
          base.laws.slice(1).map((other) => `  - ${other.name} [${other.registerId}]`).join("\n") +
            "\n  Re-run with a more exact name if the wrong one was chosen.",
        ),
      )
    }
    return wrapResult(parts.join("\n"))
  } catch (error) {
    return wrapError(error, "chain_law_system")
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 2. chain_action_basis — what authorises a decision, and how it has been read
// ──────────────────────────────────────────────────────────────────────────

export const chainActionBasisSchema = z.object({
  query: chainQuery("The power or decision in question, e.g. 'infringement notice for misleading advertising'."),
})

export const chainActionBasisDescription =
  "[chain] The legal basis for an administrative action or power, assembled from four places at once: the " +
  "Act → regulations tier, the regulator's rulings and interpretations, the case law, and tribunal review " +
  "decisions. Use it for 'what lets the ATO amend an assessment after four years', 'basis for a stop-work " +
  "direction', 'can this penalty be reviewed'. Runs under a 45-second deadline and returns partial results with " +
  "the gaps marked rather than timing out.";

export async function chainActionBasis(
  apiClient: AuApiClient,
  input: z.infer<typeof chainActionBasisSchema>,
): Promise<ToolResponse> {
  let deadline: ChainDeadline | undefined
  const parts = [`═══ Legal basis: ${input.query} ═══`]
  try {
    deadline = startChainDeadline()
    const dl = deadline
    // The whole chain runs under the deadline's signal, so expiry also cuts the
    // upstream requests still in flight. The race handles hosts that ignore it.
    return await runWithRequestContext({ signal: dl.signal }, async () => {
      const baseO = await raceDeadline(dl, resolveChainBaseLaw(apiClient, input.query))
      if (!baseO.ok) return expiredChainResult(parts)
      if (baseO.value.laws.length === 0) {
        // An empty result *caused by* expiry is not an absence claim.
        if (dl.expired()) return expiredChainResult(parts)
        return noBaseLaw(input.query, baseO.value)
      }

      const law = baseO.value.laws[0]
      parts.push(baseLawHeader(law, baseO.value.notes))

      const wanted = detectExpansions(input.query)
      const needSchedules = wantsSchedules(wanted)

      const [threeTier, rulings, cases, appeals, schedules] = await Promise.all([
        raceDeadline(dl, callTool(getThreeTier as Handler, apiClient, { registerId: law.registerId })),
        searchThenDetail(dl, apiClient, "search_rulings", () =>
          callTool(searchRulings as Handler, apiClient, { query: input.query, limit: 5 }),
        ),
        searchThenDetail(dl, apiClient, "search_cases", () =>
          callTool(searchCases as Handler, apiClient, { query: law.name, limit: 5 }),
        ),
        searchThenDetail(dl, apiClient, "search_admin_appeals", () =>
          callTool(searchAdminAppeals as Handler, apiClient, { query: input.query, limit: 5 }),
        ),
        raceDeadline(
          dl,
          needSchedules
            ? callTool(getSchedules as Handler, apiClient, { registerId: law.registerId })
            : Promise.resolve(null),
        ),
      ])

      leg(parts, "Act → regulations → rules", threeTier, "get_three_tier")
      leg(parts, "Rulings and interpretations", rulings.searchO, "search_rulings")
      leg(parts, "Case law", cases.searchO, "search_decisions(domain=\"cases\")")
      leg(parts, "Tribunal review decisions", appeals.searchO, "search_decisions(domain=\"admin_appeals\")")

      detailLeg(parts, "Ruling in full", rulings.detailO, "get_ruling_text")
      detailLeg(parts, "Case in full", cases.detailO, "get_decision_text")
      detailLeg(parts, "Tribunal decision in full", appeals.detailO, "get_decision_text")

      // A branch that was never requested gets no marker: a race *started*
      // after expiry resolves `{ok:false}`, including `Promise.resolve(null)`
      // — while one started before expiry settles `{ok:true, value:null}`,
      // which the `else if (schedules.value)` below drops the same way.
      if (!schedules.ok) {
        if (needSchedules) parts.push(timedOutSection("Schedules (penalties, fees)", "get_schedules"))
      } else if (schedules.value) {
        parts.push(secOrSkip("Schedules (penalties, fees)", schedules.value))
      }

      return wrapResult(parts.join("\n"))
    })
  } catch (error) {
    if (deadline?.expired()) return expiredChainResult(parts)
    return wrapError(error, "chain_action_basis")
  } finally {
    deadline?.dispose()
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 3. chain_dispute_prep — everything decided on the point, in parallel
// ──────────────────────────────────────────────────────────────────────────

const DISPUTE_BRANCHES: Partial<
  Record<DisputeDomain, { handler: Handler; searchTool: string; label: string }>
> = {
  tax: {
    handler: searchTaxTribunalDecisions as Handler,
    searchTool: "search_tax_tribunal_decisions",
    label: "Tax tribunal and decision impact statements",
  },
  workplace: {
    handler: searchWorkplaceDecisions as Handler,
    searchTool: "search_workplace_decisions",
    label: "Fair Work Commission decisions",
  },
  privacy: {
    handler: searchPrivacyDecisions as Handler,
    searchTool: "search_privacy_decisions",
    label: "Privacy determinations (OAIC)",
  },
  competition: {
    handler: searchCompetitionDecisions as Handler,
    searchTool: "search_competition_decisions",
    label: "Competition matters",
  },
  integrity: {
    handler: searchIntegrityDecisions as Handler,
    searchTool: "search_integrity_decisions",
    label: "Integrity investigations (NACC)",
  },
  public_service: {
    handler: searchPublicServiceDecisions as Handler,
    searchTool: "search_public_service_decisions",
    label: "Public-service review case studies",
  },
}

export const chainDisputePrepSchema = z.object({
  query: chainQuery("What is in dispute, e.g. 'unfair dismissal small business', 'objection to amended assessment'."),
  domain: z
    .enum(["tax", "workplace", "privacy", "competition", "integrity", "public_service", "general"])
    .optional()
    .describe("Which specialist body also hears this. Detected from the query when omitted."),
})

export const chainDisputePrepDescription =
  "[chain] What has already been decided on the point you are arguing: court judgments, tribunal review " +
  "decisions and the specialist body for the subject (Fair Work, OAIC, the tax tribunal, NACC…) searched " +
  "together, with the leading records fetched. Use it before advising on prospects — 'has anyone won on this', " +
  "'what did the tribunal do with a late objection'. Runs under a 45-second deadline and marks what it could not " +
  "reach. For one source only, use search_decisions.";

export async function chainDisputePrep(
  apiClient: AuApiClient,
  input: z.infer<typeof chainDisputePrepSchema>,
): Promise<ToolResponse> {
  let deadline: ChainDeadline | undefined
  const domain = input.domain ?? detectDisputeDomain(input.query)
  const parts = [`═══ Dispute preparation: ${input.query} ═══`, `Specialist domain: ${domain}`]
  try {
    deadline = startChainDeadline()
    const dl = deadline
    return await runWithRequestContext({ signal: dl.signal }, async () => {
      const branch = DISPUTE_BRANCHES[domain]

      const [cases, appeals, specialist] = await Promise.all([
        searchThenDetail(dl, apiClient, "search_cases", () =>
          callTool(searchCases as Handler, apiClient, { query: input.query, limit: 8 }),
        ),
        searchThenDetail(dl, apiClient, "search_admin_appeals", () =>
          callTool(searchAdminAppeals as Handler, apiClient, { query: input.query, limit: 8 }),
        ),
        branch
          ? searchThenDetail(dl, apiClient, branch.searchTool, () =>
              callTool(branch.handler, apiClient, { query: input.query, limit: 5 }),
            )
          : Promise.resolve(null),
      ])

      leg(parts, "Court judgments", cases.searchO, "search_decisions(domain=\"cases\")")
      leg(parts, "Tribunal review decisions", appeals.searchO, "search_decisions(domain=\"admin_appeals\")")
      detailLeg(parts, "Leading judgments in full", cases.detailO, "get_decision_text")
      detailLeg(parts, "Tribunal decision in full", appeals.detailO, "get_decision_text")

      if (specialist && branch) {
        leg(parts, branch.label, specialist.searchO, branch.searchTool)
        detailLeg(parts, `${branch.label} — in full`, specialist.detailO, "get_decision_text")
      } else {
        parts.push(
          sec(
            "Specialist body",
            "No specialist forum was detected for this question, so only the courts and the review tribunals " +
              "were searched. Pass `domain` explicitly if one applies.",
          ),
        )
      }

      parts.push(
        sec(
          "Before relying on any of these",
          "None of the above has been checked for later treatment. Run legal_analysis(mode=\"cite_check\") on any " +
            "authority you intend to rely on — a judgment can be overruled or its statutory basis repealed without " +
            "anything in the search result saying so.",
        ),
      )
      return wrapResult(parts.join("\n"))
    })
  } catch (error) {
    if (deadline?.expired()) return expiredChainResult(parts)
    return wrapError(error, "chain_dispute_prep")
  } finally {
    deadline?.dispose()
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 4. chain_amendment_track — what changed, and when
// ──────────────────────────────────────────────────────────────────────────

export const chainAmendmentTrackSchema = z.object({
  query: chainQuery("Act name, alias or registerId whose amendments you are tracking."),
  provision: z
    .string()
    .optional()
    .describe('A single provision to trace through the endnotes, e.g. "s 45" or "sch 2 s 18".'),
  fromDate: z.string().optional().describe("Earlier point in time, YYYY-MM-DD. Defaults to the previous compilation."),
  toDate: z.string().optional().describe("Later point in time, YYYY-MM-DD. Defaults to the current compilation."),
})

export const chainAmendmentTrackDescription =
  "[chain] What changed in an Act and when: a compilation-to-compilation comparison plus, for a provision you " +
  "name, its amendment history read out of the endnotes with the amending Acts identified. Use it for 'what did " +
  "the 2023 amendments do to the Privacy Act', 'when did s 45 last change', 'is this section the same as it was " +
  "in 2019'. For the text as it stood on a date, use legal_analysis(mode=\"applicable_law\").";

export async function chainAmendmentTrack(
  apiClient: AuApiClient,
  input: z.infer<typeof chainAmendmentTrackSchema>,
): Promise<ToolResponse> {
  try {
    const base = await resolveChainBaseLaw(apiClient, input.query, 1)
    if (base.laws.length === 0) return noBaseLaw(input.query, base)

    const law = base.laws[0]
    const parts = [`═══ Amendment tracking: ${law.name} ═══`, baseLawHeader(law, base.notes)]

    // Both legs take the id *and* the words the caller used, for the reason
    // chain_law_system does: the id fixes the title, the alias is what tells a
    // bare "s 18" which schedule it belongs to (ACL = CCA sch 2, whose s 18 has
    // an entirely different amendment history from the body's).
    const [diff, history] = await Promise.all([
      callTool(compareOldNew as Handler, apiClient, {
        registerId: law.registerId,
        query: input.query,
        ...(input.fromDate ? { fromDate: input.fromDate } : {}),
        ...(input.toDate ? { toDate: input.toDate } : {}),
        ...(input.provision ? { provision: input.provision } : {}),
      }),
      input.provision
        ? callTool(getProvisionHistory as Handler, apiClient, {
            registerId: law.registerId,
            query: input.query,
            provision: input.provision,
          })
        : Promise.resolve(null),
    ])

    parts.push(secOrSkip("Compilation comparison", diff))
    if (history) parts.push(secOrSkip(`Amendment history of ${input.provision}`, history))
    else {
      parts.push(
        sec(
          "Provision history",
          "Not requested. Pass `provision` (e.g. \"s 45\") to have the endnotes traced for that section, " +
            "with each amending Act identified.",
        ),
      )
    }
    return wrapResult(parts.join("\n"))
  } catch (error) {
    return wrapError(error, "chain_amendment_track")
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. chain_state_law_compare — the same subject across the federation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Two registers per call. Every jurisdiction is a different site with its own
 * timeout (Queensland is documented at up to 90 seconds), so a fan-out across
 * eight would spend the whole budget before the Commonwealth half printed.
 */
const MAX_STATE_SEARCHES = 2

export const chainStateLawCompareSchema = z.object({
  query: chainQuery("The subject or Commonwealth Act to compare, e.g. 'Australian Consumer Law', 'work health and safety'."),
  jurisdictions: z
    .array(z.string())
    .max(MAX_STATE_SEARCHES)
    .optional()
    .describe(`Which registers to search, at most ${MAX_STATE_SEARCHES} (QLD | TAS | WA | VIC | NT | ACT).`),
})

export const chainStateLawCompareDescription =
  "[chain] The same subject on both sides of the federal/state line: the Commonwealth Act, the mapped " +
  "state/territory counterparts (applied, uniform or merely comparable — the relationship is stated), and a live " +
  "search of one or two state registers. Use it for 'is the ACL the same in Queensland', 'WHS Act across the " +
  "states', 'does Victoria have an equivalent'. This is the chain that catches the commonest Australian error: " +
  "answering a state-law question out of Commonwealth legislation.";

export async function chainStateLawCompare(
  apiClient: AuApiClient,
  input: z.infer<typeof chainStateLawCompareSchema>,
): Promise<ToolResponse> {
  try {
    const parts = [`═══ Commonwealth ↔ state comparison: ${input.query} ═══`]

    // The Commonwealth side may legitimately be empty — plenty of subjects have
    // no federal Act at all — so its absence is a note, not a stop.
    const base = await resolveChainBaseLaw(apiClient, input.query, 1)
    if (base.laws.length > 0) {
      const law = base.laws[0]
      parts.push(baseLawHeader(law, base.notes))
      const threeTier = await callTool(getThreeTier as Handler, apiClient, { registerId: law.registerId })
      parts.push(secOrSkip("Commonwealth Act and what is made under it", threeTier))
    } else if ((base.failures ?? []).length > 0) {
      // The Commonwealth half is missing because the Register did not answer.
      // "That is the correct answer rather than a failure" is true of a search
      // that ran; said of one that did not, it manufactures a federal/state
      // conclusion out of an outage. The state half below still stands, so this
      // is a marked gap rather than a failed chain.
      parts.push(
        sec(
          "Commonwealth position [NOT RETRIEVED]",
          `[${ErrorCodes.API_ERROR}] The Federal Register could not be searched (tried ` +
            `${base.attempts.map((a) => `"${a}"`).join(" → ")}).` +
            failureLines(base).join("\n") +
            "\n\n⚠️ No Commonwealth title is shown because the lookup failed, NOT because none exists. Do not " +
            "conclude that this subject is state law only, and do not read the state material below as the whole " +
            "answer — re-run once the Register responds.",
        ),
      )
    } else {
      parts.push(
        sec(
          "Commonwealth position",
          `No Commonwealth title matched (tried ${base.attempts.map((a) => `"${a}"`).join(" → ")}). ` +
            "For many subjects — tenancy, most crime, land, health practitioner regulation — that is the correct " +
            "answer rather than a failure: they are state law.",
        ),
      )
    }

    const equivalents = await callTool(getStateEquivalents as Handler, apiClient, { query: input.query })
    parts.push(secOrSkip("Mapped state/territory counterparts", equivalents))

    const jurisdictions = (input.jurisdictions ?? ["QLD", "TAS"]).slice(0, MAX_STATE_SEARCHES)
    const searches = await Promise.all(
      jurisdictions.map((jurisdiction) =>
        callTool(searchStateLaw as Handler, apiClient, { jurisdiction, query: input.query, limit: 5 }),
      ),
    )
    jurisdictions.forEach((jurisdiction, index) => {
      parts.push(secOrSkip(`${jurisdiction} register`, searches[index]))
    })

    parts.push(
      sec(
        "Reading this comparison",
        "'Applied' means the state adopted the Commonwealth text as its own law and the wording is identical; " +
          "'uniform' means separately enacted from an agreed model, so section numbers usually match but " +
          "amendments diverge; 'comparable' means the subject is covered but the text is not. Never quote one " +
          "jurisdiction's section as another's without checking which of the three applies. NSW and SA are " +
          "link-only here — their registers are not searched, which is not evidence that they have no counterpart.",
      ),
    )
    return wrapResult(parts.join("\n"))
  } catch (error) {
    return wrapError(error, "chain_state_law_compare")
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 6. chain_full_research — the fallback when nothing is known yet
// ──────────────────────────────────────────────────────────────────────────

export const chainFullResearchSchema = z.object({
  query: chainQuery("A question in plain English, e.g. 'can my employer stand me down without pay'."),
})

export const chainFullResearchDescription =
  "[chain] The general-purpose starting point when neither the Act nor the area of law is known: a full-text " +
  "search of the legislation, the text of the best-matching Act, the case law, and the regulator's rulings — all " +
  "in one call. Use it for open questions such as 'can my employer stand me down without pay' or 'what are the " +
  "rules on unsolicited consumer agreements'. Runs under a 45-second deadline and returns whatever arrived with " +
  "the rest marked. If you already know the Act, search_law → get_law_text is faster and more precise.";

export async function chainFullResearch(
  apiClient: AuApiClient,
  input: z.infer<typeof chainFullResearchSchema>,
): Promise<ToolResponse> {
  let deadline: ChainDeadline | undefined
  const parts = [`═══ Research: ${input.query} ═══`]
  try {
    deadline = startChainDeadline()
    const dl = deadline
    return await runWithRequestContext({ signal: dl.signal }, async () => {
      // Step 1: the full-text search and the base-law resolution together — the
      // second is what the text branch needs, the first is shown either way.
      const step1 = await raceDeadline(
        dl,
        Promise.all([
          callTool(searchAiLaw as Handler, apiClient, { query: input.query, limit: 8 }),
          // A rejection here is a lookup that never ran, so it is kept as a
          // failure rather than flattened to an empty result: an empty result
          // is what "the Register was searched and holds no such title" looks
          // like, and the section below reads the two differently.
          resolveChainBaseLaw(apiClient, input.query, 2).catch(
            (error): ChainBaseLawResult => ({
              laws: [],
              attempts: [input.query],
              failures: [{ term: input.query, message: error instanceof Error ? error.message : String(error) }],
            }),
          ),
        ]),
      )
      if (!step1.ok) return expiredChainResult(parts)
      const [aiResult, base] = step1.value

      // Pushed as soon as it lands, so an expiry further down still returns it.
      parts.push(secOrSkip("Legislation matching the question", aiResult))

      const law = base.laws[0]
      if (law) {
        parts.push(baseLawHeader(law, base.notes))
        const textO = await raceDeadline(
          dl,
          callTool(getLawText as Handler, apiClient, { registerId: law.registerId, maxChars: 8000 }),
        )
        if (!textO.ok) return expiredChainResult(parts)
        parts.push(secOrSkip(`${law.name} — structure`, textO.value))
      }

      const [cases, rulings] = await Promise.all([
        searchThenDetail(dl, apiClient, "search_cases", () =>
          callTool(searchCases as Handler, apiClient, { query: input.query, limit: 5 }),
        ),
        searchThenDetail(dl, apiClient, "search_rulings", () =>
          callTool(searchRulings as Handler, apiClient, { query: input.query, limit: 5 }),
        ),
      ])

      leg(parts, "Case law", cases.searchO, "search_decisions(domain=\"cases\")")
      leg(parts, "Rulings and interpretations", rulings.searchO, "search_rulings")
      detailLeg(parts, "Leading judgments in full", cases.detailO, "get_decision_text")
      detailLeg(parts, "Ruling in full", rulings.detailO, "get_ruling_text")

      if (!law) {
        // "No single Act" and "the Register never answered" are different
        // facts, and only the first supports the state-law nudge — routing a
        // 503 to it turns an outage into a federal/state conclusion. The
        // full-text half above is real data, so this is a marked gap rather
        // than a failed chain.
        if ((base.failures ?? []).length > 0) {
          parts.push(
            sec(
              "No Act was identified [NOT RETRIEVED]",
              `[${ErrorCodes.API_ERROR}] The base-law lookup could not be completed — ` +
                `${(base.failures ?? []).length} of the Federal Register lookups failed, so no title was matched` +
                (base.attempts.length > 0
                  ? ` (tried ${base.attempts.map((attempt) => `"${attempt}"`).join(" → ")})`
                  : "") +
                "." +
                failureLines(base).join("\n") +
                "\n\n⚠️ This is an upstream failure, NOT a finding that no Commonwealth Act covers the question. Do " +
                "not tell the user there is no such Act, do not invent one, and do not conclude that the subject is " +
                "state law — re-run once the Register responds.",
            ),
          )
        } else {
          parts.push(
            sec(
              "No single Act was identified",
              "The full-text search above is the whole legislative answer this chain found. If the subject is " +
                "tenancy, crime, land, or most consumer-facing licensing, it is state law — try " +
                "legal_research(task=\"state_law_compare\").",
            ),
          )
        }
      }
      return wrapResult(parts.join("\n"))
    })
  } catch (error) {
    if (deadline?.expired()) return expiredChainResult(parts)
    return wrapError(error, "chain_full_research")
  } finally {
    deadline?.dispose()
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 7. chain_procedure_detail — fees, forms and the steps
// ──────────────────────────────────────────────────────────────────────────

export const chainProcedureDetailSchema = z.object({
  query: chainQuery("The procedure, e.g. 'registering a business name', 'applying for a protection visa'."),
  scheduleFilter: z
    .string()
    .optional()
    .describe("Only show schedules whose heading contains this word, e.g. 'fees', 'forms'."),
})

export const chainProcedureDetailDescription =
  "[chain] Fees, forms and prescribed steps for a procedure. Australian procedural detail is almost never in the " +
  "Act — it is in the schedules of the regulations made under it — so this chain finds the Act, walks down to its " +
  "instruments, and opens the schedules on both levels. Use it for 'what does it cost to register X', 'which form " +
  "do I lodge', 'what are the prescribed time limits'. For one schedule you already know, use get_schedules.";

export async function chainProcedureDetail(
  apiClient: AuApiClient,
  input: z.infer<typeof chainProcedureDetailSchema>,
): Promise<ToolResponse> {
  try {
    const base = await resolveChainBaseLaw(apiClient, input.query)
    if (base.laws.length === 0) return noBaseLaw(input.query, base)

    const law = base.laws[0]
    const parts = [`═══ Procedure, fees and forms: ${input.query} ═══`, baseLawHeader(law, base.notes)]

    const filter = input.scheduleFilter ? { titleContains: input.scheduleFilter } : {}
    const [actSchedules, instruments] = await Promise.all([
      callTool(getSchedules as Handler, apiClient, { registerId: law.registerId, ...filter }),
      callTool(getEnabledInstruments as Handler, apiClient, { registerId: law.registerId, limit: 10 }),
    ])

    parts.push(secOrSkip(`${law.name} — schedules`, actSchedules))
    parts.push(secOrSkip("Instruments made under the Act (where fees and forms usually live)", instruments))

    // The schedules that actually carry the fee table are the instrument's, not
    // the Act's. Take the first instrument the Register listed and open it.
    const instrumentId = firstRegisterId(instruments)
    if (instrumentId) {
      const instrumentSchedules = await callTool(getSchedules as Handler, apiClient, {
        registerId: instrumentId,
        ...filter,
      })
      parts.push(secOrSkip(`Schedules of the first instrument [${instrumentId}]`, instrumentSchedules))
    } else if (!instruments.isError) {
      parts.push(
        sec(
          "Instrument schedules",
          "The Register lists no legislative instrument made under this Act, so there is no second level of " +
            "schedules to open. Fees, if any, are in the Act itself or in a state instrument.",
        ),
      )
    }

    parts.push(
      sec(
        "Caution on amounts",
        "Fee and penalty figures in Commonwealth legislation are usually expressed in *penalty units* or indexed " +
          "annually by a separate determination, so the number printed in a schedule may not be the amount " +
          "payable today. Check the compilation date shown above against the current indexation instrument.",
      ),
    )
    return wrapResult(parts.join("\n"))
  } catch (error) {
    return wrapError(error, "chain_procedure_detail")
  }
}

/** The first FRL register id in a rendered instrument list. */
function firstRegisterId(result: CallResult): string | undefined {
  if (result.isError) return undefined
  return /\b([CF]\d{4}[A-Z]\d{4,6})\b/.exec(result.text)?.[1]
}

// ──────────────────────────────────────────────────────────────────────────
// 8. chain_document_review — triage a document, then find the law behind it
// ──────────────────────────────────────────────────────────────────────────

/** Follow-up searches the triage suggested — at most this many are run. */
const MAX_DOCUMENT_HINTS = 3

export const chainDocumentReviewSchema = z.object({
  text: z.string().min(40).describe("The full text of the contract, terms, letter or notice to review."),
  maxClauses: z.number().int().min(1).max(60).optional().default(30).describe("Numbered clauses to analyse (default 30)."),
})

export const chainDocumentReviewDescription =
  "[chain] Triage a document and then go and find the law behind what it flagged: risk signals clause by clause, " +
  "then the legislation and case law for the two or three strongest signals. Use it for 'is there anything wrong " +
  "with this contract', 'review these terms of service', 'what should I look at in this notice'. Pattern matching, " +
  "not advice — it never establishes that a clause is void or enforceable. For the triage alone use analyze_document.";

export async function chainDocumentReview(
  apiClient: AuApiClient,
  input: z.infer<typeof chainDocumentReviewSchema>,
): Promise<ToolResponse> {
  try {
    throwIfRequestCancelled()
    const parts = ["═══ Document review ═══"]

    const analysis = await callTool(analyzeDocument as Handler, apiClient, {
      text: input.text,
      maxClauses: input.maxClauses ?? 30,
    })
    // The triage is the chain's foundation: without it there is nothing to
    // search for, so its failure is the chain's failure rather than a section.
    if (analysis.isError) return { content: [{ type: "text", text: analysis.text }], isError: true }
    parts.push(sec("Risk triage", analysis.text))

    const hints = extractSearchHints(analysis.text).slice(0, MAX_DOCUMENT_HINTS)
    if (hints.length === 0) {
      parts.push(
        sec(
          "Related law",
          "The triage raised no signal specific enough to search on. That is not a clearance — see the caveat in " +
            "the triage above.",
        ),
      )
      return wrapResult(parts.join("\n"))
    }

    const [laws, cases] = await Promise.all([
      Promise.all(hints.map((hint) => callTool(searchAiLaw as Handler, apiClient, { query: hint, limit: 3 }))),
      Promise.all(hints.map((hint) => callTool(searchCases as Handler, apiClient, { query: hint, limit: 3 }))),
    ])
    throwIfRequestCancelled()

    parts.push(sec("Searches run from the triage", hints.map((hint) => `  - ${hint}`).join("\n")))
    hints.forEach((hint, index) => {
      parts.push(secOrSkip(`Legislation — ${hint}`, laws[index]))
      parts.push(secOrSkip(`Case law — ${hint}`, cases[index]))
    })

    parts.push(
      sec(
        "Before acting on this",
        "Which jurisdiction governs the document changes the answer, and the searches above cover Commonwealth " +
          "law and the reachable court sources only. A clause that looks safe here may be unenforceable under a " +
          "state Act that was never searched.",
      ),
    )
    return wrapResult(parts.join("\n"))
  } catch (error) {
    return wrapError(error, "chain_document_review")
  }
}

/**
 * Search terms out of a triage report.
 *
 * `analyze_document` emits two shapes worth following: the `Read:` line each
 * fired rule carries, and the bulleted "Suggested follow-up searches" block.
 * Both are read in document order, which puts the `Read:` references first —
 * and that is the right way round, because a reference names the legislation
 * behind a signal that actually fired on *this* document, while the suggestions
 * are generic to the document type. Only the first few are searched, so the
 * specific ones must come first.
 */
export function extractSearchHints(analysisText: string): string[] {
  const hints: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    const trimmed = value.trim().replace(/[.;]+$/, "")
    if (!trimmed || seen.has(trimmed.toLowerCase())) return
    seen.add(trimmed.toLowerCase())
    hints.push(trimmed)
  }

  let inSuggestions = false
  for (const line of analysisText.split("\n")) {
    if (/^---\s*Suggested follow-up searches/i.test(line)) {
      inSuggestions = true
      continue
    }
    if (inSuggestions) {
      const bullet = /^\s*-\s+(.+)$/.exec(line)
      if (bullet) {
        add(bullet[1])
        continue
      }
      if (line.trim()) inSuggestions = false
    }
    const read = /^\s*Read:\s*(.+)$/.exec(line)
    if (read) for (const reference of read[1].split(/\s*;\s*/)) add(reference)
  }
  return hints
}

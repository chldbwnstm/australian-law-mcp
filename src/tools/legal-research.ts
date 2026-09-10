/**
 * `legal_research` — one exposed entry point for the eight chains.
 *
 * The chains stay registered under their own names (direct calls and
 * `execute_tool` keep working); what this adds is a single tool in the
 * ListTools payload instead of eight. Eight chain descriptions cost roughly
 * 4 KB of every client's context, and a caller choosing between eight
 * near-synonymous names picks wrong more often than one choosing a `task`
 * value out of a list.
 *
 * The tolerant parameter handling is the other half of the point. Watching the
 * reference server, the two ways a model gets this call wrong are stable:
 *
 *  1. It puts a **scenario-ish word in `task`** — the description mentions both
 *     in one breath, so `task: "penalty"` and `task: "fees"` happen. Those are
 *     absorbed to the task that actually serves them rather than rejected.
 *  2. It invents a task name outright. That falls back to `full_research`,
 *     which is the correct answer to "I don't know where to start" anyway.
 *
 * Both are corrected *and announced*: a silently rewritten parameter teaches
 * the caller nothing, so the note rides on the first line of the response.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { truncateResponse } from "../lib/schemas.js"
import { throwIfRequestCancelled } from "../lib/session-state.js"
import type { LooseToolResponse } from "../lib/types.js"
import { FollowupPolicySchema } from "../lib/research-followup.js"
import {
  MAX_CHAIN_QUERY,
  chainActionBasis,
  chainAmendmentTrack,
  chainDisputePrep,
  chainDocumentReview,
  chainFullResearch,
  chainLawSystem,
  chainProcedureDetail,
  chainStateLawCompare,
} from "./chains.js"

export const RESEARCH_TASKS = [
  "full_research",
  "law_system",
  "action_basis",
  "dispute_prep",
  "amendment_track",
  "state_law_compare",
  "procedure_detail",
  "document_review",
] as const

export type ResearchTask = (typeof RESEARCH_TASKS)[number]

const TASK_VALUES = new Set<string>(RESEARCH_TASKS)

/**
 * Words that are not tasks but name one unambiguously. Kept small and literal:
 * a fuzzy matcher here would silently route "compare" (state comparison? old
 * versus new?) to whichever branch happened to sort first.
 */
const ABSORBED_TASK: Record<string, ResearchTask> = {
  // subject-matter words a model reaches for instead of the task name
  penalty: "action_basis",
  penalties: "action_basis",
  basis: "action_basis",
  power: "action_basis",
  fees: "procedure_detail",
  forms: "procedure_detail",
  procedure: "procedure_detail",
  process: "procedure_detail",
  timeline: "amendment_track",
  history: "amendment_track",
  amendments: "amendment_track",
  compare_states: "state_law_compare",
  state_law: "state_law_compare",
  states: "state_law_compare",
  structure: "law_system",
  system: "law_system",
  hierarchy: "law_system",
  dispute: "dispute_prep",
  litigation: "dispute_prep",
  appeal: "dispute_prep",
  document: "document_review",
  contract: "document_review",
  review: "document_review",
  research: "full_research",
}

/**
 * The absorption happens in `preprocess`, before Zod sees the value — an enum
 * that rejects the input first would turn a recoverable mislabel into a failed
 * tool call, and the model's next attempt is usually the same mistake.
 */
export const LegalResearchSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object") return raw
    const input = { ...(raw as Record<string, unknown>) }
    const task = input.task
    if (typeof task === "string" && !TASK_VALUES.has(task)) {
      const key = task.trim().toLowerCase().replace(/[\s-]+/g, "_")
      input.task = ABSORBED_TASK[key] ?? "full_research"
      input.__taskWas = task
    }
    return input
  },
  z.object({
    query: z
      .string()
      .max(MAX_CHAIN_QUERY)
      .optional()
      .describe(
        "The question, subject or Act name. Required for every task except document_review — " +
          "e.g. 'unfair dismissal small business', 'Privacy Act structure', 'is the ACL the same in Queensland'.",
      ),
    // The task table lives in the tool description, not here: repeating it
    // would put the same 600 characters into every client's context twice.
    task: z
      .enum(RESEARCH_TASKS)
      .optional()
      .default("full_research")
      .describe("Which research pattern to run — see the task table in this tool's description. Default full_research."),
    provisions: z
      .array(z.string())
      .max(20)
      .optional()
      .describe('[law_system] Provisions to fetch alongside, e.g. ["s 18", "sch 2 s 18"].'),
    provision: z.string().optional().describe('[amendment_track] One provision to trace, e.g. "s 45".'),
    fromDate: z.string().optional().describe("[amendment_track] Earlier point in time, YYYY-MM-DD."),
    toDate: z.string().optional().describe("[amendment_track] Later point in time, YYYY-MM-DD."),
    domain: z
      .enum(["tax", "workplace", "privacy", "competition", "integrity", "public_service", "general"])
      .optional()
      .describe("[dispute_prep] Which specialist body also hears this. Detected from the query when omitted."),
    jurisdictions: z
      .array(z.string())
      .max(2)
      .optional()
      .describe("[state_law_compare] Up to two state registers to search (QLD | TAS | WA | VIC | NT | ACT)."),
    scheduleFilter: z.string().optional().describe("[procedure_detail] Only schedules whose heading contains this word."),
    text: z.string().optional().describe("[document_review, required] The full text of the document to review."),
    maxClauses: z.number().int().min(1).max(60).optional().describe("[document_review] Numbered clauses to analyse."),
    followup: FollowupPolicySchema.optional().describe("Optional matter policy consumed by the host companion after this stateless law call."),
    /** Set by `preprocess` when `task` had to be corrected; never sent by a caller. */
    __taskWas: z.string().optional(),
  }),
)

export type LegalResearchInput = z.infer<typeof LegalResearchSchema>

export const legalResearchDescription =
  "Multi-step Australian legal research in one call: eight patterns behind `task`, each running several searches in " +
  "parallel and returning one document with every gap explicitly marked. " +
  "task: full_research (default — open question, no Act known) · law_system (an Act's structure and what is made " +
  "under it) · action_basis (what authorises a decision: tiers, rulings, cases, tribunal review) · dispute_prep " +
  "(what has already been decided, incl. the specialist body) · amendment_track (what changed, when) · " +
  "state_law_compare (Commonwealth vs state counterparts — the usual source of wrong Australian answers) · " +
  "procedure_detail (fees, forms, steps) · document_review (triage a document, then find the law behind the flags; " +
  "needs `text`). " +
  "For a single lookup, search_law → get_law_text is faster; for citation checking and point-in-time text, use " +
  "legal_analysis.";

function inputError(message: string): LooseToolResponse {
  return { content: [{ type: "text", text: message }], isError: true }
}

/**
 * Put the correction note on the *first* line of the first block, not in a
 * block of its own.
 *
 * A chain response is often already at the character limit; appending a note
 * would push the whole thing over it. Merging and re-truncating means the text
 * that gets cut is the tail of the body — which is what should lose, not the
 * warning explaining why the caller got a different task than it asked for.
 */
export function withNote(note: string | undefined, response: LooseToolResponse): LooseToolResponse {
  if (!note) return response
  const [first, ...rest] = response.content
  const merged = first?.text ? `${note}\n${first.text}` : note
  return { ...response, content: [{ type: "text", text: truncateResponse(merged) }, ...rest] }
}

function correctionNote(input: LegalResearchInput, task: ResearchTask): string | undefined {
  if (!input.__taskWas) return undefined
  return (
    `⚠ task="${input.__taskWas}" is not one of the eight research patterns; it was read as task="${task}". ` +
    `Valid values: ${RESEARCH_TASKS.join(", ")}.`
  )
}

export async function legalResearch(
  apiClient: AuApiClient,
  input: LegalResearchInput,
): Promise<LooseToolResponse> {
  throwIfRequestCancelled()
  const task = (input.task ?? "full_research") as ResearchTask
  const note = correctionNote(input, task)

  if (task === "document_review") {
    if (!input.text) {
      return inputError(
        'task="document_review" needs `text` — the document to review. Pass the full text of the contract, ' +
          "terms or notice.",
      )
    }
    return withNote(
      note,
      await chainDocumentReview(apiClient, {
        text: input.text,
        maxClauses: input.maxClauses ?? 30,
      }),
    )
  }

  if (!input.query) {
    return inputError(
      `task="${task}" needs \`query\` — the question, subject or Act name. ` +
        '(Only task="document_review" is driven by `text` instead.)',
    )
  }
  const query = input.query

  switch (task) {
    case "law_system":
      return withNote(
        note,
        await chainLawSystem(apiClient, {
          query,
          ...(input.provisions ? { provisions: input.provisions } : {}),
        }),
      )
    case "action_basis":
      return withNote(note, await chainActionBasis(apiClient, { query }))
    case "dispute_prep":
      return withNote(
        note,
        await chainDisputePrep(apiClient, { query, ...(input.domain ? { domain: input.domain } : {}) }),
      )
    case "amendment_track":
      return withNote(
        note,
        await chainAmendmentTrack(apiClient, {
          query,
          ...(input.provision ? { provision: input.provision } : {}),
          ...(input.fromDate ? { fromDate: input.fromDate } : {}),
          ...(input.toDate ? { toDate: input.toDate } : {}),
        }),
      )
    case "state_law_compare":
      return withNote(
        note,
        await chainStateLawCompare(apiClient, {
          query,
          ...(input.jurisdictions ? { jurisdictions: input.jurisdictions } : {}),
        }),
      )
    case "procedure_detail":
      return withNote(
        note,
        await chainProcedureDetail(apiClient, {
          query,
          ...(input.scheduleFilter ? { scheduleFilter: input.scheduleFilter } : {}),
        }),
      )
    case "full_research":
    default:
      return withNote(note, await chainFullResearch(apiClient, { query }))
  }
}

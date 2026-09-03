/**
 * `search_all` — one query across the three families of Australian law.
 *
 * Australian law is federated in a way Commonwealth-only search hides:
 * "residential tenancy" is almost entirely state law, "unfair dismissal" is
 * almost entirely Commonwealth, and either question answered from one family
 * alone reads as complete while being wrong. So this tool asks all three —
 * Commonwealth legislation, a state/territory register, and case law — in
 * parallel, and says which of them answered.
 *
 * Design constraints that shaped it:
 *
 *  - **A dead branch is a marked section, never a failed tool.** Each family is
 *    caught separately; a section that failed says why and names the tool that
 *    retrieves it alone. Silence would read as "nothing there".
 *  - **One state register per call.** The eight registers are eight different
 *    sites, two of them blocked and one (Queensland) documented at up to 90
 *    seconds; fanning out across all of them would spend the whole request
 *    budget on the least certain branch. The caller picks, or Queensland is
 *    used and the choice is stated.
 *  - **Budget-aware output.** Each family is clipped to a share of the response
 *    allowance *before* assembly, so a verbose branch cannot crowd out a terse
 *    one — the failure mode where a 40 KB judgment list buries three statutes.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { MAX_RESPONSE_SIZE, truncateResponse } from "../lib/schemas.js"
import { STATE_JURISDICTIONS } from "../lib/sources/state-legislation.js"
import type { LooseToolResponse, ToolResponse } from "../lib/types.js"
import { searchCases } from "./precedents.js"
import { searchLaw } from "./search.js"
import { searchLawFallbacks } from "./search-fallbacks.js"
import { searchStateLaw } from "./state-law.js"

/** The three families, in the order a lawyer would check them. */
const FAMILIES = ["legislation", "state_law", "cases"] as const
type Family = (typeof FAMILIES)[number]

/**
 * Queensland when the caller does not choose: it and Tasmania are the only
 * registers with a full-text search, and Queensland is by far the larger
 * corpus. The default is always printed, never assumed to be understood.
 */
const DEFAULT_STATE = "QLD"

export const SearchAllSchema = z.object({
  query: z.string().min(2).describe("What to look for, e.g. 'unfair contract terms', 'residential tenancy bond'."),
  jurisdiction: z
    .string()
    .optional()
    .describe(
      `Which state/territory register to include: ${STATE_JURISDICTIONS.join(" | ")}. ` +
        `Default ${DEFAULT_STATE} (one register per call — they are separate sites, two of them blocked).`,
    ),
  families: z
    .array(z.enum(FAMILIES))
    .optional()
    .describe(
      "Limit the search to some families. legislation = Commonwealth register, state_law = one state register, " +
        "cases = courts. Default: all three.",
    ),
  limit: z.number().int().min(1).max(20).optional().default(5).describe("Hits per family (default 5)."),
})

export type SearchAllInput = z.infer<typeof SearchAllSchema>

export const searchAllDescription =
  "Search Commonwealth legislation, one state/territory register and case law at once, and return a compact merged " +
  "answer with a section per family. Use it when you do not yet know which family of Australian law governs the " +
  "question — the federal/state split is the usual reason a confident single-source answer is wrong. Each family " +
  "degrades on its own: a source that fails becomes a marked section naming the tool to retry it with, never a " +
  "silent gap. For depth in one family use search_law / search_state_law / search_decisions instead.";

interface FamilyOutcome {
  family: Family
  heading: string
  /** The tool that retrieves this family on its own — printed on failure. */
  tool: string
  text: string
  isError: boolean
}

export async function searchAll(apiClient: AuApiClient, input: SearchAllInput): Promise<ToolResponse> {
  try {
    const wanted = new Set<Family>(input.families ?? FAMILIES)
    const limit = input.limit ?? 5
    const jurisdiction = (input.jurisdiction ?? DEFAULT_STATE).trim()

    const all: Array<{ family: Family; heading: string; tool: string; run: () => Promise<LooseToolResponse> }> = [
      {
        family: "legislation",
        heading: "Commonwealth legislation (Federal Register)",
        tool: "search_law",
        // A Commonwealth title search that finds nothing is the single most
        // misread result this server produces, so the ladder runs before the
        // section is written rather than leaving the caller with a blank:
        // delegated legislation and repealed/renamed titles are in different
        // indexes, and most of what an ordinary question is about is state law.
        run: async () => {
          const found = await searchLaw(apiClient, { query: input.query, limit })
          if (!found.isError) return found
          return searchLawFallbacks(apiClient, { query: input.query, limit })
        },
      },
      {
        family: "state_law",
        heading: `State/territory legislation (${jurisdiction})`,
        tool: `search_state_law(jurisdiction="${jurisdiction}")`,
        run: () => searchStateLaw(apiClient, { jurisdiction, query: input.query, limit }),
      },
      {
        family: "cases",
        heading: "Case law (NSW Caselaw · High Court · Queensland Judgments)",
        tool: "search_decisions(domain=\"cases\")",
        run: () => searchCases(apiClient, { query: input.query, limit }),
      },
    ]
    const planned = all.filter((entry) => wanted.has(entry.family))

    // Parallel on purpose: these are three unrelated hosts, and the slowest
    // (a Queensland content search) is documented at up to 90 seconds. Run in
    // sequence they add up; run together they cost the slowest one.
    const outcomes = await Promise.all(planned.map(runFamily))

    const budget = Math.floor((MAX_RESPONSE_SIZE - 1500) / Math.max(1, outcomes.length))
    const lines: string[] = []
    lines.push(`=== Search across Australian law: "${input.query}" ===`)
    lines.push(
      `Families searched: ${planned.map((entry) => entry.family).join(", ")}` +
        (wanted.has("state_law") ? ` · state register: ${jurisdiction}` : ""),
    )
    lines.push("")

    for (const outcome of outcomes) {
      lines.push(section(outcome, budget))
    }

    const failed = outcomes.filter((outcome) => outcome.isError)
    if (failed.length > 0) {
      lines.push(
        `⚠️ ${failed.length} of ${outcomes.length} families did not return results. ` +
          "Those sections say so explicitly — treat them as unsearched, not as empty.",
      )
    }
    lines.push(
      "Go deeper in one family: search_law (Commonwealth) · search_state_law (a register) · " +
        "search_decisions(domain=\"cases\") · legal_research for a multi-step answer.",
    )

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (error) {
    return formatToolError(error, "search_all")
  }
}

async function runFamily(entry: {
  family: Family
  heading: string
  tool: string
  run: () => Promise<LooseToolResponse>
}): Promise<FamilyOutcome> {
  try {
    const result = await entry.run()
    return {
      family: entry.family,
      heading: entry.heading,
      tool: entry.tool,
      text: result.content?.map((item) => item.text).join("\n") ?? "",
      isError: !!result.isError,
    }
  } catch (error) {
    return {
      family: entry.family,
      heading: entry.heading,
      tool: entry.tool,
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    }
  }
}

function section(outcome: FamilyOutcome, budget: number): string {
  if (outcome.isError) {
    const reason = outcome.text.trim() ? clip(outcome.text.trim(), 600) : "no reason was reported"
    return (
      `▶ ${outcome.heading} [NOT RETRIEVED]\n` +
      `   ⚠️ This family was not searched successfully — do not treat it as empty, and do not fill the gap in.\n` +
      `   Reason: ${reason}\n` +
      `   Retrieve it on its own with: ${outcome.tool}\n`
    )
  }
  const body = outcome.text.trim() || "(the source returned nothing to display)"
  return `▶ ${outcome.heading}\n${clip(body, budget)}\n`
}

/** Cut with the loss announced — an unmarked elision reads as the whole answer. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const notice = `\n   … ${(text.length - max).toLocaleString()} more characters in this section; use the family's own tool for the full list.`
  return `${text.slice(0, Math.max(0, max - notice.length)).trimEnd()}${notice}`
}

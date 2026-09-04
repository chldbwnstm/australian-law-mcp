/**
 * What to do when a federal search comes back with nothing.
 *
 * Zero hits on the Federal Register does **not** mean "there is no such law".
 * In Australia it usually means one of four other things, and each has a
 * different next step — which is the whole reason this ladder exists rather
 * than a single "no results" message:
 *
 *  1. **It is state law.** Tenancy, most crime, land, health-practitioner
 *     regulation, workers' compensation, retail leases: none of it is on the
 *     Federal Register, and a Commonwealth-only "not found" is how a model
 *     ends up telling a Queensland tenant that no bond rules exist.
 *  2. **It is delegated legislation.** People say "the Fair Work Regulations"
 *     and "the Aged Care Quality Standards" as though they were Acts. They sit
 *     in a different collection, which a `collection=Act` search never sees.
 *  3. **It was repealed or renamed.** The *Trade Practices Act 1974* is not
 *     absent; it is `C2004A00109` under another name. An in-force-only search
 *     hides that, and "no such Act" is exactly the wrong answer.
 *  4. **The words are in the body, not the title.** A name search cannot find
 *     "stand down" — the phrase is in s 524 of the Fair Work Act, not in its
 *     title.
 *
 * Every rung is an *attempt*, never an assertion, and the closing message says
 * what was tried. The ladder is cheap on purpose: at most two extra upstream
 * calls, and both are skipped when the query does not look like their case.
 *
 * A rung that *threw* is kept strictly apart from a rung that found nothing.
 * Every message below the rungs reads as "the Commonwealth register was
 * searched and holds nothing" — the state-law rung says so in those words — so
 * a failed rung ends the ladder with `[UPSTREAM_NO_DATA]` instead. The ladder
 * is only ever entered on a genuine `[NOT_FOUND]`; see `isNoMatch` in
 * `search-all.ts`.
 */

import type { AuApiClient } from "../lib/api-client.js"
import { noResultHint } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import { STATE_JURISDICTIONS } from "../lib/sources/state-legislation.js"
import type { FrlTitle, ToolResponse } from "../lib/types.js"
import { TITLE_SELECT, rankTitles } from "./statute-helpers/title-lookup.js"
import { formatTitleBlock } from "./statute-helpers/format.js"

/**
 * Subjects that are state law in every Australian jurisdiction. The list is
 * short and specific because a broad one would divert genuine Commonwealth
 * questions ("consumer" would catch the ACL, which *is* federal).
 */
const STATE_SUBJECTS =
  /\b(?:residential tenanc|tenanc|landlord|bond|strata|body corporate|conveyanc|stamp duty|land tax|payroll tax|workers[’']? compensation|retail lease|liquor licen[cs]|traffic|speeding|drink driv|assault|burglary|shoplift|domestic violence|apprehended violence|guardianship|coron|health practitioner|working with children)\b/i

/** Words that name delegated legislation rather than an Act. */
const INSTRUMENT_WORDS =
  /\b(?:regulation|regulations|rules?|determination|instrument|standard|standards|order|by-?law|code of practice|principles)\b/i

export interface FallbackInput {
  query: string
  limit?: number
}

const asText = (text: string): ToolResponse => ({
  content: [{ type: "text", text: truncateResponse(text) }],
})

/** Does this query look like it is really about state law? */
export function looksLikeStateLawQuery(query: string): boolean {
  if (STATE_SUBJECTS.test(query)) return true
  return STATE_JURISDICTIONS.some((jurisdiction) =>
    new RegExp(`\\b${jurisdiction}\\b`, "i").test(query),
  ) || /\b(?:new south wales|victoria|queensland|western australia|south australia|tasmania|northern territory)\b/i.test(query)
}

/** Does this query name delegated legislation rather than an Act? */
export function looksLikeInstrumentQuery(query: string): boolean {
  return INSTRUMENT_WORDS.test(query)
}

/**
 * The ladder. Returns a *result* — never throws — because it is only ever
 * called from a path that already has nothing to show.
 */
export async function searchLawFallbacks(
  apiClient: AuApiClient,
  input: FallbackInput,
): Promise<ToolResponse> {
  const query = input.query.trim()
  const limit = input.limit ?? 10
  const tried: string[] = ["Commonwealth Acts, by title"]
  /** Rungs that threw. A rung that failed found nothing *and proved nothing*. */
  const failures: string[] = []

  // 1) Delegated legislation. Cheap, and the commonest cause of a miss for
  //    anyone who said "regulations" out loud.
  if (looksLikeInstrumentQuery(query)) {
    tried.push("legislative instruments, by title")
    const instruments = await safeSearch(apiClient, query, limit, "LegislativeInstrument")
    if (instruments.failure) failures.push(`legislative instruments, by title: ${instruments.failure}`)
    if (instruments.titles.length > 0) {
      return asText(
        [
          `[FALLBACK] No Act matched "${query}", but the Register has matching legislative instruments.`,
          "Regulations, rules, determinations and standards are a separate collection from Acts — that is why the",
          "first search missed them.",
          "",
          ...instruments.titles.map((title, index) => formatTitleBlock(title, index + 1, query)),
          "",
          "Next: get_law_text(registerId) for the text, get_enabling_acts(registerId) for the Act it is made under.",
        ].join("\n"),
      )
    }
  }

  // 2) Repealed or renamed. `status` is left unset so repealed titles come back
  //    annotated with what repealed them — a rename must not read as a repeal.
  tried.push("repealed and former-name titles")
  const historical = await safeSearch(apiClient, query, limit)
  if (historical.failure) failures.push(`repealed and former-name titles: ${historical.failure}`)
  if (historical.titles.length > 0) {
    return asText(
      [
        `[FALLBACK] No title matched "${query}" among in-force Acts, but the Register knows these.`,
        "They may be repealed, ceased, or in force under a different name — each block below says which.",
        "⚠️ A renamed Act is NOT a repealed one: the Trade Practices Act 1974 is the Competition and Consumer",
        "Act 2010, still in force. Read the annotation before describing any of these as no longer law.",
        "",
        ...historical.titles.map((title, index) => formatTitleBlock(title, index + 1, query)),
        "",
        "Next: get_law_history(registerId) for the amendment trail, get_historical_law for the text as it stood.",
      ].join("\n"),
    )
  }

  // Nothing to show — so before saying so, check whether the Register actually
  // answered. A rung that threw is not a rung that found nothing, and every
  // message below this point reads as "the Commonwealth register was searched".
  if (failures.length > 0) return rungFailure(query, tried, failures)

  // 3) State law. No search is run here: the state registers need a nominated
  //    jurisdiction, two of the eight are blocked, and a Queensland content
  //    search alone is documented at up to 90 seconds. Guessing one register
  //    and reporting its silence would be worse than pointing at the right tool.
  if (looksLikeStateLawQuery(query)) {
    tried.push("(state registers: not searched — they need a nominated jurisdiction)")
    return asText(
      [
        `[FALLBACK] Nothing on the Federal Register matched "${query}", and the subject reads as state law.`,
        "",
        "⚠️ This is not a finding that no such law exists. Tenancy, most crime, land, retail leases, workers'",
        "compensation and health-practitioner regulation are State and Territory law, and none of it is on the",
        "Commonwealth register that was just searched.",
        "",
        "Next:",
        `  - search_state_law(jurisdiction="QLD", query="${query}") — and the same for the jurisdiction you need;`,
        `  - get_state_equivalents(query="${query}") to see which states have a counterpart at all;`,
        "  - legal_research(task=\"state_law_compare\") to do both sides at once.",
        "",
        `Searched so far: ${tried.join("; ")}.`,
      ].join("\n"),
    )
  }

  // 4) Nothing above applied. Say what was tried, and point at full text —
  //    a title search cannot find a phrase that lives in a section.
  const hint = noResultHint(query, "search_law:")
  return {
    content: [
      {
        type: "text",
        text: truncateResponse(
          [
            hint.content[0].text,
            "",
            `Searched: ${tried.join("; ")}.`,
            "",
            "Australian-specific next steps:",
            "  - search_ai_law — searches the TEXT of legislation, not just titles ('stand down' is in s 524 of",
            "    the Fair Work Act, and no title contains the phrase);",
            "  - search_state_law / get_state_equivalents — the Federal Register is Commonwealth law only;",
            "  - suggest_law_names for a prefix list if you are unsure of the exact short title.",
          ].join("\n"),
        ),
      },
    ],
    isError: true,
  }
}

/**
 * A rung that failed, reported as the observation it is.
 *
 * The rungs below this point all read as "the Commonwealth register was
 * searched and holds nothing" — the state-law rung says so in those words. If a
 * rung threw, that sentence is an absence claim nobody established, so the
 * ladder stops and hands back the distinct label instead. The next steps are
 * kept: a caller in this position still needs somewhere to go.
 */
function rungFailure(query: string, tried: string[], failures: string[]): ToolResponse {
  const lines = [
    `[UPSTREAM_NO_DATA] The Federal Register did not answer every search for "${query}", so this response ` +
      "carries no finding about whether a Commonwealth title matches.",
    "",
    "⚠️ Do not report this as 'no such Act'. The register was asked and did not hand over a result — that is " +
      "not evidence either way.",
    ...failures.map((failure) => `  - ${failure}`),
    "",
    `Attempted: ${tried.join("; ")}.`,
    "",
    "Next:",
    "  - retry shortly — a register that did not answer is usually transient;",
    `  - search_ai_law(query="${query}") searches the TEXT of legislation rather than titles;`,
  ]
  if (looksLikeStateLawQuery(query)) {
    lines.push(
      "  - the subject also reads as State or Territory law, which is on no Commonwealth register at all: " +
        `search_state_law(jurisdiction="QLD", query="${query}") or get_state_equivalents(query="${query}").`,
    )
  }
  return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }], isError: true }
}

/** What one rung produced: its ranked titles, and why it produced none. */
interface RungResult {
  titles: FrlTitle[]
  /** Set when the rung threw — an empty `titles` that proves nothing. */
  failure?: string
}

/** A search rung never throws: a broken rung must not become the chain's answer. */
async function safeSearch(
  apiClient: AuApiClient,
  query: string,
  limit: number,
  collection?: string,
): Promise<RungResult> {
  try {
    const found = await apiClient.searchTitles({
      text: query,
      searchType: "name",
      ...(collection ? { collection } : {}),
      top: Math.min(limit * 2, 50),
      select: TITLE_SELECT,
    })
    return { titles: rankTitles(query, found.titles).slice(0, limit) }
  } catch (error) {
    return { titles: [], failure: error instanceof Error ? error.message : String(error) }
  }
}

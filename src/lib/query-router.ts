/**
 * The natural-language router — the matching engine over `route-patterns.ts`.
 *
 * Everything that decides *where a sentence goes* is data in that file; this
 * one only walks it. The split matters because routing decisions are reviewed
 * as decisions ("should 'CCA s 46 cases' be a citation graph?") and control
 * flow is reviewed as code. Mixing them means neither gets read properly.
 *
 * Three ordering rules, each of which was a bug in the reference
 * implementation before it was a rule:
 *
 *  1. **Patterns match the original text, before any date is stripped.**
 *     Removing "since 2020" first destroys the trigger of the very pattern
 *     that wanted it.
 *  2. **A date range is attached after the match, not folded into it.** The
 *     search term loses the time words; the route keeps the window.
 *  3. **Scenario labels come from `scenario-rules`, never from a second table
 *     here.** The CLI and the chains must agree about what a query is.
 */

import { extractDates } from "./query-extract.js"
import {
  sortedRoutePatterns,
  yieldsToOther,
  type Pattern,
  type PipelineStep,
  type RouteAlternate,
} from "./route-patterns.js"
import { TASK_TO_CHAIN, detectScenarioName, type ScenarioName } from "./scenario-rules.js"
import type { DateRange } from "./au-dates.js"
import type { ResearchTask } from "../tools/legal-research.js"

export type { RouteAlternate, PipelineStep }

export interface RouteResult {
  /** The tool to run. */
  tool: string
  /** Which rule won — the first thing to look at when a route surprises someone. */
  matchedPattern?: string
  /** Parameters for `tool`, with every internal flag removed. */
  params: Record<string, unknown>
  /** Why, in one line, for the CLI to print. */
  reason: string
  /** Tools the caller might have meant. Offered, never run. */
  alternates: RouteAlternate[]
  /** Follow-up calls. */
  pipeline?: PipelineStep[]
  /** The time window read out of the query, if any. */
  dateRange?: DateRange
  /** A single point in time read out of the query, if any. */
  date?: string
  /** Something the caller should confirm before trusting the answer. */
  clarify?: string
  /** The scenario label, when the destination is a research chain. */
  scenario?: ScenarioName
  /** Parameters the destination will silently drop — surfaced rather than lost. */
  unsupportedParams?: string[]
}

/** The empty query is not a routing failure; it is a request for the map. */
const EMPTY_QUERY_ROUTE = (): RouteResult => ({
  tool: "discover_tools",
  params: { intent: "getting started with Australian legal research" },
  reason: "no query → discover_tools (the tool index)",
  alternates: [],
  clarify: "Nothing to route. Describe what you are looking for, or run `list` to see every tool.",
})

/**
 * Route one natural-language query.
 *
 * Always returns a destination. There is no "unroutable" result — the last
 * resort is `legal_research`, which fans out across statute, cases and
 * procedure, and it carries a `discover_tools` alternate so a caller who
 * wanted something specific can find it.
 */
export function routeQuery(query: string): RouteResult {
  const text = (query ?? "").trim()
  if (!text) return EMPTY_QUERY_ROUTE()

  // Rule 1: match the original text. Stripping the date first would take the
  // trigger words with it.
  const result = matchRoute(text)

  // Rule 2: attach the time condition after the fact.
  const dates = extractDates(text)
  if (dates.range) result.dateRange = dates.range.range
  else if (dates.date) result.date = dates.date.iso

  // Rule 3: the scenario label comes from the single source.
  const task = result.params.task
  if (result.tool === "legal_research" && typeof task === "string") {
    const scenario = detectScenarioName(text, task as ResearchTask)
    if (scenario) result.scenario = scenario
  } else if (result.tool.startsWith("chain_")) {
    const entry = Object.entries(TASK_TO_CHAIN).find(([, chain]) => chain === result.tool)
    if (entry) {
      const scenario = detectScenarioName(text, entry[0] as ResearchTask)
      if (scenario) result.scenario = scenario
    }
  }

  // The last defence against sending an empty search term upstream: a pattern
  // whose trigger words were the whole query has nothing left to search for.
  if (typeof result.params.query === "string" && !result.params.query.trim()) {
    result.params.query = text
  }

  return result
}

/** Internal flag names, stripped before anything is called with these params. */
const CONTROL_KEYS = ["_skip", "_fallback", "_reroute", "_clarify", "_alternates", "_pipeline", "_extraProvisions"]

function cleanParams(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (CONTROL_KEYS.includes(key)) continue
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * The generic fallback.
 *
 * `full_research` runs statute, case-law and procedure searches together, so a
 * question nothing recognised still gets a real answer rather than a shrug —
 * and the alternate points at the tool index for a caller who knows the shape
 * of what they want but not its name.
 */
function researchFallback(query: string, reason: string, matchedPattern?: string): RouteResult {
  return {
    tool: "legal_research",
    ...(matchedPattern ? { matchedPattern } : {}),
    params: { task: "full_research", query },
    reason,
    alternates: [
      {
        tool: "discover_tools",
        params: { intent: query },
        why: "No rule claimed this query. discover_tools lists the specialist tools by area of law if a broad research pass is not what was wanted.",
      },
    ],
  }
}

function matchRoute(query: string): RouteResult {
  for (const pattern of sortedRoutePatterns) {
    for (const regex of pattern.patterns) {
      const match = query.match(regex)
      if (!match) continue

      // A trailing intent belongs to someone else. The guard evaluates the
      // receiving pattern's own regexes, so the vocabulary is never duplicated.
      // `break`, not `continue`: the whole pattern steps aside, not just this
      // one of its regexes.
      if (yieldsToOther(pattern, query)) break

      const raw = pattern.extract(query, match)

      // Pulled off before any early return, or an internal flag leaks into the
      // parameters of whichever tool the early return picks.
      const clarify = typeof raw._clarify === "string" ? raw._clarify : undefined
      const alternates = (raw._alternates as RouteAlternate[] | undefined) ?? []
      const pipeline = raw._pipeline as PipelineStep[] | undefined
      const extraProvisions = raw._extraProvisions as string[] | undefined

      // Matched, but this is not this pattern's case. Move to the next one.
      if (raw._skip) break

      // The intent is right and a required value is missing. Falling back is
      // better than calling a tool that will reject the input.
      if (raw._fallback) {
        return {
          ...researchFallback(query, `${pattern.reason} — but the query names no statute, so a broad research pass runs instead`, pattern.name),
          ...(clarify ? { clarify } : {}),
        }
      }

      // Same intent, better tool.
      if (raw._reroute) {
        const tool = raw._reroute as string
        return buildResult(tool, pattern, cleanParams(raw), `${pattern.reason} → rerouted to ${tool}`, {
          alternates,
          pipeline,
          clarify,
          extraProvisions,
        })
      }

      return buildResult(pattern.tool, pattern, cleanParams(raw), pattern.reason, {
        alternates,
        pipeline,
        clarify,
        extraProvisions,
      })
    }
  }

  return researchFallback(query, "no rule matched → legal_research(task=\"full_research\")")
}

function buildResult(
  tool: string,
  pattern: Pattern,
  params: Record<string, unknown>,
  reason: string,
  extras: {
    alternates: RouteAlternate[]
    pipeline?: PipelineStep[]
    clarify?: string
    extraProvisions?: string[]
  },
): RouteResult {
  const steps: PipelineStep[] = [...(extras.pipeline ?? [])]

  // Several provisions in one sentence ("ss 18 and 29 of the ACL"): each needs
  // its own call, and dropping the rest is a silent loss of half the question.
  for (const provision of extras.extraProvisions ?? []) {
    steps.push({ tool, params: { ...params, provision }, standalone: true })
  }

  return {
    tool,
    matchedPattern: pattern.name,
    params,
    reason,
    alternates: extras.alternates,
    ...(steps.length ? { pipeline: steps } : {}),
    ...(extras.clarify ? { clarify: extras.clarify } : {}),
  }
}

/**
 * Every tool a route touches — the destination plus anything the pipeline
 * runs. Tests assert on this rather than on `tool` alone, because a query
 * whose answer arrives through a search-then-fetch pair has reached its
 * labelled tool even though the first call was the search.
 */
export function routeDestinations(query: string): string[] {
  const route = routeQuery(query)
  return [route.tool, ...(route.pipeline ?? []).map((step) => step.tool)]
}

/** A one-line explanation of a route, for `--verbose` and the REPL's `explain`. */
export function explainRoute(query: string, route?: RouteResult): string {
  const result = route ?? routeQuery(query)
  const lines = [
    `query      ${query}`,
    `tool       ${result.tool}`,
    `rule       ${result.matchedPattern ?? "(fallback)"}`,
    `why        ${result.reason}`,
    `params     ${JSON.stringify(result.params)}`,
  ]
  if (result.scenario) lines.push(`scenario   ${result.scenario}`)
  if (result.date) lines.push(`date       ${result.date}`)
  if (result.dateRange) lines.push(`window     ${result.dateRange.from} → ${result.dateRange.to}`)
  if (result.pipeline?.length) {
    lines.push(`then       ${result.pipeline.map((step) => step.tool).join(" → ")}`)
  }
  for (const alternate of result.alternates) {
    lines.push(`alternate  ${alternate.tool} — ${alternate.why}`)
  }
  if (result.clarify) lines.push(`check      ${result.clarify}`)
  return lines.join("\n")
}

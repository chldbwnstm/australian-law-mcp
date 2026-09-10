/**
 * Running a route, or a named tool, against the registry — the console path.
 *
 * This is the CLI's execution engine and it is deliberately separate from the
 * MCP transport in `server/`. The two share `allTools` and nothing else: MCP
 * speaks JSON-RPC over stdio and must never print to stdout, while everything
 * here exists to print. A single "execute" that tried to serve both would have
 * to guess which, and the guess that writes a banner to a stdio transport
 * breaks every client at once.
 *
 * Three things it does that a bare `tool.handler(...)` call would not:
 *
 *  - **Validation failures come back as results, not exceptions.** A Zod error
 *    is what the caller most needs to read, and it is a normal outcome of
 *    typing a parameter wrong.
 *  - **Parameters the destination cannot accept are reported.** Zod strips an
 *    unknown key silently, so a date filter the caller asked for can vanish
 *    with nothing in the output to say the answer is unfiltered.
 *  - **Pipelines carry an identifier forward.** A search prints an id; the
 *    detail tool takes one. `SEARCH_DETAIL_CHAINS` already knows which
 *    parameter and which line for every search tool, so that table is read
 *    rather than restated.
 *  - **The run is charged to an execution budget.** This is a front door like
 *    the other two, and the upstream ceilings live in AsyncLocalStorage rather
 *    than in the client, so a call made outside a request context is not
 *    "unlimited" by design — it is unmetered by accident.
 */

import { z } from "zod"
import { AuApiClient } from "./api-client.js"
import { RequestExecutionBudget, readExecutionLimits } from "./execution-limits.js"
import { requestContext, runWithRequestContext } from "./session-state.js"
import { allTools } from "../tool-registry.js"
import { SEARCH_DETAIL_CHAINS } from "./tool-chain-config.js"
import { ID_LINE, extractHitIds } from "../tools/search-hits.js"
import { fmt, formatOutput } from "./cli-format.js"
import { routeQuery, explainRoute, type RouteResult } from "./query-router.js"
import type { McpTool, ToolResponse } from "./types.js"
import { boundToolResponse } from "./research-followup.js"

/** The registry a run executes against. Injectable so tests need no network client. */
export type ToolRegistry = readonly McpTool<AuApiClient>[]

/**
 * Every Australian source this server reads is keyless, so there is no
 * credential check here and no environment variable to forget. A client is
 * always constructible.
 */
export function getApiClient(): AuApiClient {
  return new AuApiClient()
}

// ──────────────────────────────────────────────────────────────────────────
// Core
// ──────────────────────────────────────────────────────────────────────────

/**
 * The console path's request boundary — the counterpart of `tool-registry`'s
 * CallTool wrapper, and deliberately the same shape.
 *
 * `fetchWithRetry` charges `consumeUpstreamRequest` and `readResponseBytes`
 * enforces the per-response and per-request byte ceilings by reading the budget
 * out of AsyncLocalStorage. With no context those are silently no-ops, so
 * without this the CLI would run every chain with no attempt ceiling and buffer
 * a pathological response whole, while the identical query over MCP is bounded.
 *
 * An existing budget is reused rather than replaced: an embedder that already
 * opened a request (or a future outer CLI scope) must not have its allowance
 * multiplied by the number of tools a run happens to call.
 */
function withRequestBudget<T>(work: () => Promise<T>): Promise<T> {
  const budget = requestContext.getStore()?.budget ?? new RequestExecutionBudget(readExecutionLimits())
  return runWithRequestContext({ budget }, work)
}

/**
 * Run one tool by name.
 *
 * Never throws. An unknown name, a schema rejection and an upstream failure
 * are all outcomes the caller has to read, and turning any of them into an
 * exception means the pipeline that follows loses the results it already had.
 */
export async function executeTool(
  apiClient: AuApiClient,
  toolName: string,
  params: Record<string, unknown>,
  registry: ToolRegistry = allTools,
): Promise<ToolResponse> {
  const tool = registry.find((entry) => entry.name === toolName)
  if (!tool) {
    const near = registry
      .map((entry) => entry.name)
      .filter((name) => name.includes(toolName) || toolName.includes(name))
      .slice(0, 5)
    return {
      content: [
        {
          type: "text",
          text:
            `[NOT_FOUND] No tool named "${toolName}".` +
            (near.length ? `\nDid you mean: ${near.join(", ")}?` : "") +
            `\nRun \`list\` for every tool, or \`discover_tools\` to search them by intent.`,
        },
      ],
      isError: true,
    }
  }

  try {
    const parsed = tool.schema.parse(params)
    const result = await withRequestBudget(() => tool.handler(apiClient, parsed))
    return boundToolResponse(result, toolName, readExecutionLimits().maxToolResponseChars)
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ")
        : error instanceof Error
          ? error.message
          : String(error)
    return { content: [{ type: "text", text: `[ERROR] ${toolName}: ${message}` }], isError: true }
  }
}

/**
 * Which parameters would this tool silently drop?
 *
 * Zod strips unknown keys without complaint, so a caller who asked for a date
 * window on a tool that has none gets an unfiltered answer that looks filtered.
 * Reporting the names is the difference between a wrong answer and a narrower
 * one.
 */
export function unsupportedParams(
  toolName: string,
  params: Record<string, unknown>,
  registry: ToolRegistry = allTools,
): string[] {
  const tool = registry.find((entry) => entry.name === toolName)
  if (!tool) return []
  const shape = shapeOf(tool.schema)
  if (!shape) return []
  return Object.keys(params).filter((key) => !(key in shape))
}

/** The object shape behind a schema, seeing through the wrappers Zod adds. */
function shapeOf(schema: unknown): Record<string, unknown> | undefined {
  let current: unknown = schema
  // `z.preprocess` and `.refine` wrap the object; `legal_research` uses the
  // former, and reading `.shape` off the wrapper returns undefined rather than
  // failing, which would make every parameter look unsupported.
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof z.ZodObject) return current.shape as Record<string, unknown>
    const def = (current as { _def?: { innerType?: unknown; schema?: unknown; in?: unknown; out?: unknown } })._def
    if (!def) return undefined
    current = def.innerType ?? def.schema ?? def.out ?? def.in
  }
  return undefined
}

// ──────────────────────────────────────────────────────────────────────────
// Natural-language execution
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fold a route's time condition into its parameters, without overwriting.
 *
 * A pattern that already read a date out of the sentence read it in context —
 * "GSTR 2001/1 as at 30 June 2002" pins the ruling, not the year in its code.
 * The generic window only fills the gaps it finds.
 */
export function applyDateRange(route: RouteResult): void {
  if (route.dateRange) {
    if (route.params.fromDate === undefined) route.params.fromDate = route.dateRange.from
    if (route.params.toDate === undefined) route.params.toDate = route.dateRange.to
  }
}

export interface RunOptions {
  verbose?: boolean
  registry?: ToolRegistry
  /** Where output goes. Injected so tests can read it instead of the terminal. */
  log?: (line: string) => void
}

/**
 * Route a sentence and run what it chose, printing as it goes.
 *
 * Returns the route so a caller (and a test) can see what was decided without
 * parsing the printed output back out again.
 */
export async function executeNaturalQuery(
  apiClient: AuApiClient,
  query: string,
  options: RunOptions = {},
): Promise<RouteResult> {
  const log = options.log ?? ((line: string) => console.log(line))
  const registry = options.registry ?? allTools
  const route = routeQuery(query)

  // Everything goes through `log`, including the banner. `cli-format`'s
  // printers write straight to console, which is right for the terminal layer
  // in `cli.ts` and wrong here: this function has to be capturable, both so
  // tests can read its output and so a caller embedding it can decide where
  // the text lands.
  if (options.verbose) log(fmt.dim(explainRoute(query, route)))
  else log(fmt.dim(`  [routing] ${route.tool} — ${route.reason}`))

  if (route.clarify) log(fmt.yellow(`? ${route.clarify}`))
  for (const alternate of route.alternates) {
    log(fmt.dim(`  also: ${alternate.tool} — ${alternate.why}`))
  }

  applyDateRange(route)
  const dropped = unsupportedParams(route.tool, route.params, registry)
  if (dropped.length > 0) {
    for (const key of dropped) delete route.params[key]
    log(
      fmt.yellow(
        `! ${route.tool} does not accept ${dropped.join(", ")} — that condition was read from the query but is not applied to this result.`,
      ),
    )
  }

  const result = await executeTool(apiClient, route.tool, route.params, registry)
  const firstOutput = result.content.map((part) => part.text).join("\n")

  const steps = route.pipeline ?? []
  if (steps.length === 0 || result.isError) {
    log(formatOutput(firstOutput))
    if (result.isError) process.exitCode = 1
    return route
  }

  log(formatOutput(firstOutput))
  const identifier = extractPipelineId(route.tool, firstOutput)
  for (const step of steps) {
    if (!identifier && !step.standalone) {
      log(
        fmt.yellow(
          `! Could not read an identifier out of the ${route.tool} result, so ${step.tool} was not run. ` +
            `Pick one from the list above and call ${step.tool} directly.`,
        ),
      )
      continue
    }
    const stepResult = await executeTool(apiClient, step.tool, { ...step.params, ...(identifier ?? {}) }, registry)
    log(formatOutput(stepResult.content.map((part) => part.text).join("\n")))
    if (stepResult.isError) process.exitCode = 1
  }

  return route
}

/** The same run, as one JSON document. */
export async function executeNaturalQueryJson(
  apiClient: AuApiClient,
  query: string,
  options: RunOptions = {},
): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line))
  const registry = options.registry ?? allTools
  const route = routeQuery(query)
  applyDateRange(route)
  for (const key of unsupportedParams(route.tool, route.params, registry)) delete route.params[key]

  const result = await executeTool(apiClient, route.tool, route.params, registry)
  const firstOutput = result.content.map((part) => part.text).join("\n")

  const pipeline: Array<{ tool: string; result: string; isError: boolean; structuredContent?: ToolResponse["structuredContent"] }> = []
  if (!result.isError && route.pipeline?.length) {
    const identifier = extractPipelineId(route.tool, firstOutput)
    for (const step of route.pipeline) {
      if (!identifier && !step.standalone) continue
      const stepResult = await executeTool(apiClient, step.tool, { ...step.params, ...(identifier ?? {}) }, registry)
      pipeline.push({
        tool: step.tool,
        result: stepResult.content.map((part) => part.text).join("\n"),
        isError: Boolean(stepResult.isError),
        ...(stepResult.structuredContent ? { structuredContent: stepResult.structuredContent } : {}),
      })
    }
  }

  log(
    JSON.stringify(
      {
        query,
        route: {
          tool: route.tool,
          rule: route.matchedPattern,
          reason: route.reason,
          params: route.params,
          ...(route.scenario ? { scenario: route.scenario } : {}),
          ...(route.date ? { date: route.date } : {}),
          ...(route.dateRange ? { dateRange: route.dateRange } : {}),
          ...(route.clarify ? { clarify: route.clarify } : {}),
          alternates: route.alternates,
        },
        result: firstOutput,
        ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        ...(pipeline.length ? { pipeline } : {}),
        isError: Boolean(result.isError),
      },
      null,
      2,
    ),
  )
  if (result.isError) process.exitCode = 1
}

/** Run one named tool and print it. Used by `<tool> --param value` and `@tool {...}`. */
export async function executeDirect(
  apiClient: AuApiClient,
  toolName: string,
  params: Record<string, unknown>,
  options: RunOptions = {},
): Promise<ToolResponse> {
  const log = options.log ?? ((line: string) => console.log(line))
  const result = await executeTool(apiClient, toolName, params, options.registry ?? allTools)
  log(formatOutput(result.content.map((part) => part.text).join("\n")))
  if (result.isError) process.exitCode = 1
  return result
}

// ──────────────────────────────────────────────────────────────────────────
// Pipeline identifiers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Lift the first result's identifier out of printed output.
 *
 * `SEARCH_DETAIL_CHAINS` holds the regex and the parameter name for every
 * search tool that has a detail partner, and it is deliberately incomplete —
 * a detail tool needing more than an id (a domain, a jurisdiction) is listed
 * there as absent with a reason. Those routes carry their extra parameters on
 * the pipeline step itself, so the generic `id:` line is enough here.
 */
export function extractPipelineId(searchTool: string, output: string): Record<string, string> | null {
  const chain = SEARCH_DETAIL_CHAINS[searchTool]
  // `extractHitIds` is the module that owns the `id:` convention — it adds the
  // multiline flag the shared pattern deliberately omits, and it knows which
  // trailing decorations terminate an id (` | ` after a statute's facts, a
  // two-space `·` before a source label). Matching here by hand got the flag
  // wrong and read nothing at all.
  const ids = extractHitIds(output, chain?.idRegex ?? ID_LINE, 1)
  if (ids.length === 0) return null
  return { [chain?.detailParam ?? "id"]: ids[0] }
}

/**
 * The two-hop layer: `discover_tools` finds an unadvertised tool, then
 * `execute_tool` runs it.
 *
 * Sixty tools cannot all be advertised — every ListTools entry is context every
 * client pays for on every request, and a model choosing between sixty
 * near-synonyms chooses badly. Ten are advertised (`V3_EXPOSED`) and the rest
 * live behind these two.
 *
 * Which vocabulary reaches which category is `lib/tool-discovery`'s decision;
 * this file only shapes the answer and proxies the call.
 */

import { z } from "zod"
import { formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import { browsableCategories, selectSections, suggestCategories } from "../lib/tool-discovery.js"
import { TOOL_CATEGORIES, V3_EXPOSED, describeCallPath } from "../lib/tool-profiles.js"
import type { AuApiClient } from "../lib/api-client.js"
import type { McpTool, ToolResponse } from "../lib/types.js"
import { MAX_CHAIN_QUERY } from "./chains.js"

/**
 * The registry, injected at load time rather than imported — `tool-registry`
 * imports this module, so importing it back would be a cycle. Held as a name
 * index because looking a tool up by name is all this module does with it.
 */
let toolIndex = new Map<string, McpTool<AuApiClient>>()

export function setAllToolsRef(tools: McpTool<AuApiClient>[]): void {
  toolIndex = new Map(tools.map((tool) => [tool.name, tool]))
}

// ── discover_tools ─────────────────────────────────────────────────────────

export const DiscoverToolsSchema = z.object({
  // Same ceiling as a chain query: this string runs through alias and
  // description matching loops, and an unbounded one holds the event loop.
  intent: z
    .string()
    .min(1)
    .max(MAX_CHAIN_QUERY)
    .describe(
      "What you are trying to do, or the area of law — e.g. 'tax rulings', 'tribunal', 'point in time', " +
        "'explanatory memorandum', 'state law', 'check a citation'.",
    ),
})

export const discoverToolsDescription =
  "Find the specialist tool for a task. This server exposes ten tools directly and keeps around fifty more — " +
  "state and territory registers, tribunals, tax rulings, treaties, explanatory memoranda, point-in-time " +
  "compilations, terminology, citation checking — behind this lookup. Give it an intent or an area of law and it " +
  "returns the matching tools by category, saying which can be called directly and which go through execute_tool. " +
  "Use it when none of the advertised tools fits.";

/**
 * One tool as a line.
 *
 * An advertised tool's description is already in the client's context from
 * ListTools; repeating it here is pure duplication, and the two aggregate
 * entry points have descriptions long enough to swamp the answer. Name and
 * call path are all that is added.
 */
function toolLine(name: string): string {
  if (V3_EXPOSED.has(name)) return `  - ${name}: exposed — call directly (see the tool list for its description)`
  return `  - ${name}: ${toolIndex.get(name)?.description ?? "(no description registered)"}`
}

export async function discoverTools(
  _apiClient: AuApiClient,
  input: z.infer<typeof DiscoverToolsSchema>,
): Promise<ToolResponse> {
  // Normalise once, at the top. Leading whitespace otherwise defeats every
  // word-boundary match and `"  tribunal  "` returns less than `"tribunal"`.
  const query = input.intent.toLowerCase().trim()
  const { sections, omitted } = selectSections(query, (name) => toolIndex.get(name))

  if (sections.length === 0) {
    const near = suggestCategories(query)
    const nearLine = near.length > 0 ? `\nClosest categories: ${near.join(", ")}` : ""
    const anchors = browsableCategories().join(" · ")
    return {
      content: [
        {
          type: "text",
          text:
            `No tool matched "${input.intent}".${nearLine}\n` +
            `There are ${Object.keys(TOOL_CATEGORIES).length} categories — try a broader word ` +
            `(${anchors}) or the name of a tool.`,
        },
      ],
    }
  }

  const listed = new Set<string>()
  const body = sections
    .map((section) => {
      section.tools.forEach((name) => listed.add(name))
      return `[${section.category}]\n${section.tools.map(toolLine).join("\n")}`
    })
    .join("\n\n")

  // Truncation is always announced. Cut silently, the caller reads the answer
  // as the complete set — and the cut is by tier and coverage, not by any
  // measure of relevance, so it must not be described as one.
  const cut =
    omitted > 0
      ? `\n\n(${omitted} further categor${omitted === 1 ? "y" : "ies"} not shown — narrow the intent to see them.)`
      : ""

  return {
    content: [
      {
        type: "text",
        text: truncateResponse(`Tools for "${input.intent}":\n\n${body}${cut}\n\n${describeCallPath(listed)}`),
      },
    ],
  }
}

// ── execute_tool ───────────────────────────────────────────────────────────

export const ExecuteToolSchema = z.object({
  tool_name: z.string().min(1).describe("Exact tool name, as printed by discover_tools."),
  params: z
    .record(z.string(), z.unknown())
    .describe("The tool's parameters, as an object. Pass {} for a tool that takes none."),
})

export const executeToolDescription =
  "Run any tool on this server by name, including the ~50 that are not advertised in the tool list. " +
  "Pair it with discover_tools: that returns the name, this runs it. Parameters are passed straight through and " +
  "validated by the target tool, so an unknown or malformed parameter comes back as that tool's own error.";

const META_TOOL_NAMES: ReadonlySet<string> = new Set(["discover_tools", "execute_tool"])

export async function executeTool(
  apiClient: AuApiClient,
  input: z.infer<typeof ExecuteToolSchema>,
): Promise<ToolResponse> {
  // No self-proxying: `execute_tool("execute_tool", …)` recurses, and
  // `execute_tool("discover_tools", …)` is a hop for nothing since
  // discover_tools is advertised.
  if (META_TOOL_NAMES.has(input.tool_name)) {
    return {
      content: [
        {
          type: "text",
          text:
            `${input.tool_name} is a meta tool and is advertised in the tool list — call it directly rather ` +
            "than through execute_tool.",
        },
      ],
      isError: true,
    }
  }

  const tool = toolIndex.get(input.tool_name)
  if (!tool) {
    return { content: [{ type: "text", text: unknownToolMessage(input.tool_name) }], isError: true }
  }

  try {
    const parsed = tool.schema.parse(input.params)
    return (await tool.handler(apiClient, parsed)) as ToolResponse
  } catch (error) {
    return formatToolError(error, input.tool_name)
  }
}

/**
 * An unknown name is usually a near miss — a plural, a wrong prefix, the
 * reference server's name for the same idea. Say so, and offer the neighbours,
 * rather than returning a bare "not found" that invites a second guess.
 */
function unknownToolMessage(name: string): string {
  const near = nearestToolNames(name)
  const lines = [`No tool is registered under the name "${name}".`]
  if (near.length > 0) lines.push(`Did you mean: ${near.join(", ")}?`)
  lines.push(
    `Run discover_tools({intent: "${name.replace(/_/g, " ")}"}) to find the right one — ` +
      "do not guess a name, and do not answer as if the capability were missing.",
  )
  return lines.join("\n")
}

function nearestToolNames(name: string, limit = 3): string[] {
  const wanted = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  if (wanted.size === 0) return []
  return [...toolIndex.keys()]
    .map((candidate) => {
      const parts = candidate.split("_")
      const shared = parts.filter((part) => wanted.has(part)).length
      return { candidate, shared }
    })
    .filter((entry) => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

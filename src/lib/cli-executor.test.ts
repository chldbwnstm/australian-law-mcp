/**
 * The CLI execution engine, against a fake registry.
 *
 * Nothing here touches the network. The registry is a parameter for exactly
 * this reason: the behaviour worth testing is what happens around a tool call
 * — validation failures becoming readable results, a dropped parameter being
 * reported rather than vanishing, an identifier being carried from a search to
 * a fetch — and none of it depends on which tools are registered.
 */

import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  applyDateRange,
  executeDirect,
  executeNaturalQuery,
  executeNaturalQueryJson,
  executeTool,
  extractPipelineId,
  unsupportedParams,
  type ToolRegistry,
} from "./cli-executor.js"
import { routeQuery } from "./query-router.js"
import type { AuApiClient } from "./api-client.js"
import type { McpTool } from "./types.js"

/** No upstream is reached, so the client is never read. */
const client = {} as AuApiClient

function tool(
  name: string,
  schema: z.ZodSchema,
  handler: McpTool<AuApiClient>["handler"],
): McpTool<AuApiClient> {
  return { name, description: `[Test] ${name}`, schema, handler }
}

const calls: Array<{ tool: string; input: unknown }> = []

const registry: ToolRegistry = [
  tool(
    "search_law",
    z.object({ query: z.string().min(2), limit: z.number().optional() }),
    async (_client, input) => {
      calls.push({ tool: "search_law", input })
      return { content: [{ type: "text", text: "1. Competition and Consumer Act 2010\n   id: C2004A00109" }] }
    },
  ),
  tool("get_law_text", z.object({ registerId: z.string().optional(), query: z.string().optional(), provision: z.string().optional() }), async (_client, input) => {
    calls.push({ tool: "get_law_text", input })
    return { content: [{ type: "text", text: `TEXT ${JSON.stringify(input)}` }] }
  }),
  tool("search_cases", z.object({ query: z.string().min(1), court: z.string().optional() }), async () => ({
    content: [{ type: "text", text: "no id line here" }],
  })),
  tool("get_case_text", z.object({ id: z.string() }), async (_client, input) => {
    calls.push({ tool: "get_case_text", input })
    return { content: [{ type: "text", text: "CASE" }] }
  }),
  tool("exploding", z.object({}), async () => {
    throw new Error("upstream said no")
  }),
  tool("returns_error", z.object({}), async () => ({
    content: [{ type: "text", text: "[UPSTREAM_BLOCKED] nope" }],
    isError: true,
  })),
  // A preprocessed schema, like `legal_research` — reading `.shape` off the
  // wrapper returns undefined, which would make every parameter look dropped.
  tool(
    "legal_research",
    z.preprocess((raw) => raw, z.object({ query: z.string().optional(), task: z.string().optional() })),
    async (_client, input) => {
      calls.push({ tool: "legal_research", input })
      return { content: [{ type: "text", text: `RESEARCH ${JSON.stringify(input)}` }] }
    },
  ),
  tool(
    "wrapped",
    z.preprocess((raw) => raw, z.object({ query: z.string(), task: z.string().optional() })),
    async (_client, input) => ({ content: [{ type: "text", text: `WRAPPED ${JSON.stringify(input)}` }] }),
  ),
]

const sink = () => {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line), text: () => lines.join("\n") }
}

describe("executeTool", () => {
  it("runs a registered tool", async () => {
    const result = await executeTool(client, "get_law_text", { query: "CCA" }, registry)
    expect(result.content[0].text).toContain("TEXT")
    expect(result.isError).toBeUndefined()
  })

  it("returns an unknown-tool result instead of throwing", async () => {
    const result = await executeTool(client, "get_law_txt", {}, registry)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[NOT_FOUND]")
  })

  it("suggests near names, because the commonest unknown tool is a typo", async () => {
    const result = await executeTool(client, "law_text", {}, registry)
    expect(result.content[0].text).toContain("get_law_text")
  })

  it("turns a validation failure into a readable result", async () => {
    const result = await executeTool(client, "search_law", { query: "x" }, registry)
    expect(result.isError).toBe(true)
    // The parameter has to be named: "invalid input" sends the caller looking
    // through every flag they typed.
    expect(result.content[0].text).toContain("query")
  })

  it("catches a handler that throws", async () => {
    const result = await executeTool(client, "exploding", {}, registry)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("upstream said no")
  })

  it("passes an error result through as an error", async () => {
    const result = await executeTool(client, "returns_error", {}, registry)
    expect(result.isError).toBe(true)
  })
})

describe("unsupportedParams", () => {
  it("names the keys a tool would silently drop", () => {
    expect(unsupportedParams("get_law_text", { query: "CCA", fromDate: "2020-01-01" }, registry)).toEqual(["fromDate"])
  })

  it("sees through a preprocess wrapper", () => {
    // Without this the wrapper's shape is undefined and every parameter reads
    // as unsupported, so a correct call is reported as a broken one.
    expect(unsupportedParams("wrapped", { query: "x", task: "full_research" }, registry)).toEqual([])
    expect(unsupportedParams("wrapped", { query: "x", nonsense: 1 }, registry)).toEqual(["nonsense"])
  })

  it("says nothing about a tool that is not there", () => {
    expect(unsupportedParams("absent", { a: 1 }, registry)).toEqual([])
  })
})

describe("applyDateRange", () => {
  it("fills an empty slot", () => {
    const route = routeQuery("what changed in the Privacy Act since 2020")
    route.params.fromDate = undefined
    route.params.toDate = undefined
    applyDateRange(route)
    expect(route.params.fromDate).toBe(route.dateRange?.from)
  })

  it("never overwrites a date a pattern read in context", () => {
    // "GSTR 2001/1 as at 30 June 2002" pins the ruling. Letting the generic
    // window write over `asAt` would answer about a different version.
    const route = routeQuery("GSTR 2001/1 as at 30 June 2002")
    const before = route.params.asAt
    applyDateRange(route)
    expect(route.params.asAt).toBe(before)
  })

  it("does nothing when there is no window", () => {
    const route = routeQuery("s 46 CCA")
    applyDateRange(route)
    expect(route.params.fromDate).toBeUndefined()
  })
})

describe("extractPipelineId", () => {
  it("reads the id line a search prints", () => {
    expect(extractPipelineId("search_law", "1. Something\n   id: C2004A00109")).toEqual({ registerId: "C2004A00109" })
  })

  it("reads a compilation's registerId line", () => {
    expect(extractPipelineId("search_historical_law", "• 2015 · registerId: C2015C00019")).toEqual({
      compilationId: "C2015C00019",
    })
  })

  it("returns null rather than a guess when there is no identifier", () => {
    expect(extractPipelineId("search_law", "nothing here")).toBeNull()
  })

  it("falls back to a bare id line for a tool with no chain entry", () => {
    expect(extractPipelineId("search_decisions", "  id: nsw:abc123")).toEqual({ id: "nsw:abc123" })
  })
})

describe("executeNaturalQuery", () => {
  it("routes, runs, and reports what it chose", async () => {
    calls.length = 0
    const out = sink()
    const route = await executeNaturalQuery(client, "Competition and Consumer Act 2010 section 18", {
      registry,
      log: out.log,
    })
    expect(route.tool).toBe("get_law_text")
    expect(calls.map((call) => call.tool)).toEqual(["get_law_text"])
    expect(out.text()).toContain("TEXT")
  })

  it("prints the alternates, so a near-miss route is recoverable", async () => {
    const out = sink()
    // The ACL is schedule 2 of the CCA, so the route offers the body section
    // of the same number as the reading it did not take.
    await executeNaturalQuery(client, "what does s 18 of the ACL say", { registry, log: out.log })
    expect(out.text()).toContain("also:")
  })

  it("prints the clarification a route attached", async () => {
    const out = sink()
    await executeNaturalQuery(client, "Crimes Act 1900 s 61I", { registry, log: out.log })
    expect(out.text()).toMatch(/ACT/)
  })

  it("drops an unsupported parameter and says so", async () => {
    const out = sink()
    const route = await executeNaturalQuery(client, "what changed in the Privacy Act since 2020", {
      registry,
      log: out.log,
    })
    // The route wanted a window; nothing in this registry takes one.
    expect(route.params.fromDate).toBeUndefined()
    expect(out.text()).toContain("does not accept")
  })

  it("says when a pipeline could not find its identifier", async () => {
    const out = sink()
    await executeNaturalQuery(client, "[2010] NSWCCA 333", { registry, log: out.log })
    // search_cases in this registry prints no id line, so get_case_text
    // cannot be called — and that has to be said, not silently skipped.
    expect(out.text()).toContain("Could not read an identifier")
  })

  it("carries the identifier into the pipeline when there is one", async () => {
    calls.length = 0
    const out = sink()
    const withId: ToolRegistry = [
      ...registry.filter((entry) => entry.name !== "search_cases"),
      tool("search_cases", z.object({ query: z.string(), court: z.string().optional() }), async () => ({
        content: [{ type: "text", text: "1. Dela Cruz v R\n   id: nsw:deadbeef" }],
      })),
    ]
    await executeNaturalQuery(client, "[2010] NSWCCA 333", { registry: withId, log: out.log })
    expect(calls.find((call) => call.tool === "get_case_text")?.input).toMatchObject({ id: "nsw:deadbeef" })
  })

  it("verbose mode explains the routing decision", async () => {
    const out = sink()
    await executeNaturalQuery(client, "s 46 CCA", { registry, log: out.log })
    await executeNaturalQuery(client, "s 46 CCA", { registry, log: out.log, verbose: true })
    expect(out.text()).toContain("specific_provision")
  })

  it("does not run the pipeline when the first step failed", async () => {
    calls.length = 0
    const out = sink()
    const failing: ToolRegistry = [
      ...registry.filter((entry) => entry.name !== "search_cases"),
      tool("search_cases", z.object({ query: z.string(), court: z.string().optional() }), async () => ({
        content: [{ type: "text", text: "[ERROR] blocked\n   id: nsw:deadbeef" }],
        isError: true,
      })),
    ]
    await executeNaturalQuery(client, "[2010] NSWCCA 333", { registry: failing, log: out.log })
    expect(calls.some((call) => call.tool === "get_case_text")).toBe(false)
  })
})

describe("executeNaturalQueryJson", () => {
  it("emits one parseable document with the route inside it", async () => {
    const out = sink()
    await executeNaturalQueryJson(client, "what does s 18 of the ACL say", { registry, log: out.log })
    const parsed = JSON.parse(out.text()) as {
      query: string
      route: { tool: string; rule: string; params: Record<string, unknown>; alternates: unknown[] }
      result: string
      isError: boolean
    }
    expect(parsed.route.tool).toBe("get_law_text")
    expect(parsed.route.rule).toBe("specific_provision")
    expect(parsed.route.params).toMatchObject({ provision: "sch 2 s 18" })
    expect(parsed.isError).toBe(false)
  })

  it("reports an error without throwing", async () => {
    const out = sink()
    await executeNaturalQueryJson(client, "s 46 CCA", {
      registry: registry.filter((entry) => entry.name !== "get_law_text"),
      log: out.log,
    })
    const parsed = JSON.parse(out.text()) as { isError: boolean; result: string }
    expect(parsed.isError).toBe(true)
    expect(parsed.result).toContain("[NOT_FOUND]")
  })
})

describe("executeDirect", () => {
  it("runs a named tool with the parameters as given", async () => {
    calls.length = 0
    const out = sink()
    await executeDirect(client, "get_law_text", { query: "CCA", provision: "s 18" }, { registry, log: out.log })
    expect(calls[0].input).toMatchObject({ query: "CCA", provision: "s 18" })
  })

  it("prints a validation failure instead of throwing", async () => {
    const out = sink()
    const result = await executeDirect(client, "search_law", { query: "x" }, { registry, log: out.log })
    expect(result.isError).toBe(true)
    expect(out.text()).toContain("query")
  })
})

describe("the console path is not the MCP path", () => {
  it("writes through the injected log, never straight to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    const out = sink()
    await executeNaturalQuery(client, "s 46 CCA", { registry, log: out.log })
    await executeNaturalQuery(client, "s 46 CCA", { registry, log: out.log, verbose: true })
    // Nothing reaches stdout when a sink is supplied — not the result, not
    // the routing banner. An MCP transport shares stdout with the protocol,
    // and a stray banner corrupts every message on it, so this layer never
    // writes there on its own initiative.
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

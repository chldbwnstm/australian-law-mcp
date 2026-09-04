import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import type { McpTool } from "../lib/types.js"
import { DiscoverToolsSchema, discoverTools, executeTool, setAllToolsRef } from "./meta-tools.js"

const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }))

const tools: McpTool<AuApiClient>[] = [
  { name: "search_law", description: "Advertised statute search", schema: z.object({ query: z.string() }), handler },
  { name: "legal_analysis", description: "Advertised analysis", schema: z.object({ mode: z.string() }), handler },
  {
    name: "search_treaties",
    description: "Unadvertised: DFAT treaty database search",
    schema: z.object({ query: z.string(), limit: z.number().optional() }),
    handler,
  },
  {
    name: "get_treaty_text",
    description: "Unadvertised: one treaty's text",
    schema: z.object({ id: z.string() }),
    handler,
  },
  { name: "cite_check", description: "Unadvertised: citator", schema: z.object({ citation: z.string() }), handler },
]

const client = {} as AuApiClient

beforeEach(() => {
  handler.mockClear()
  setAllToolsRef(tools)
})

describe("discover_tools", () => {
  it("finds the unadvertised tool for an area of law", async () => {
    const text = (await discoverTools(client, { intent: "treaty" })).content[0].text
    expect(text).toContain("search_treaties")
    expect(text).toContain("execute_tool")
  })

  it("says 'call directly' for an advertised tool instead of adding a hop", async () => {
    const text = (await discoverTools(client, { intent: "statute" })).content[0].text
    expect(text).toContain("search_law: exposed — call directly")
  })

  it("does not repeat an advertised tool's description", async () => {
    // It is already in the client's context from ListTools, and the two
    // aggregate entry points have descriptions long enough to swamp the answer.
    const text = (await discoverTools(client, { intent: "statute" })).content[0].text
    expect(text).not.toContain("Advertised statute search")
  })

  it("returns a tool's own group when the caller names the tool", async () => {
    const text = (await discoverTools(client, { intent: "cite_check" })).content[0].text
    expect(text).toContain("cite_check")
    expect(text).toContain("named directly")
  })

  it("survives leading and trailing whitespace", async () => {
    // Without a trim at the top, the padded form matches strictly less.
    const padded = (await discoverTools(client, { intent: "  treaty  " })).content[0].text
    const plain = (await discoverTools(client, { intent: "treaty" })).content[0].text
    expect(padded.replace(/"\s+treaty\s+"/, '"treaty"')).toBe(plain)
  })

  it("suggests a direction instead of dumping the catalogue when nothing matched", async () => {
    const text = (await discoverTools(client, { intent: "zzzqqq" })).content[0].text
    expect(text).toContain("No tool matched")
    expect(text).toContain("categories")
  })

  it("bounds the intent so an unbounded paste cannot reach the matching loops", () => {
    expect(DiscoverToolsSchema.safeParse({ intent: "x".repeat(3000) }).success).toBe(false)
  })
})

describe("execute_tool", () => {
  it("runs an unadvertised tool with its parameters", async () => {
    const result = await executeTool(client, { tool_name: "search_treaties", params: { query: "AUSFTA" } })
    expect(handler).toHaveBeenCalledWith(client, { query: "AUSFTA" })
    expect(result.content[0].text).toBe("ran")
  })

  it("returns the target tool's own validation error, not a generic one", async () => {
    const result = await executeTool(client, { tool_name: "get_treaty_text", params: { wrong: 1 } })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("INVALID_PARAMETER")
    expect(result.content[0].text).toContain("get_treaty_text")
  })

  it("refuses to proxy itself", async () => {
    const result = await executeTool(client, { tool_name: "execute_tool", params: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("call it directly")
  })

  it("suggests the neighbours for a near-miss name", async () => {
    const result = await executeTool(client, { tool_name: "search_treaty", params: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Did you mean")
    expect(result.content[0].text).toContain("search_treaties")
  })

  it("tells the caller to discover rather than guess again", async () => {
    const result = await executeTool(client, { tool_name: "totally_made_up", params: {} })
    expect(result.content[0].text).toContain("discover_tools")
    expect(result.content[0].text).toContain("do not answer as if the capability were missing")
  })
})

// discover_tools prints no parameter schemas, so a guessed parameter name is
// the expected input here — and Zod's strip mode answers a guess that missed
// with the *unfiltered* result. `asAt` is a real parameter name on this
// server's get_ruling_text; get_law_text's is `date`.
describe("execute_tool parameter checking", () => {
  beforeEach(() => {
    setAllToolsRef([
      ...tools,
      {
        name: "get_law_text",
        description: "Unadvertised: statute text",
        schema: z.object({
          query: z.string().optional(),
          date: z.string().optional(),
          maxChars: z.number().default(20000),
        }),
        handler,
      },
      {
        // `legal_research` is a z.preprocess around its object; reading `.shape`
        // off the wrapper gives undefined, which would make every parameter of
        // every wrapped tool look unknown.
        name: "wrapped_tool",
        description: "Unadvertised: preprocess-wrapped",
        schema: z.preprocess((raw) => raw, z.object({ query: z.string().optional(), task: z.string().default("full") })),
        handler,
      },
    ])
  })

  it("names a parameter the target tool does not have instead of dropping it", async () => {
    const result = await executeTool(client, {
      tool_name: "get_law_text",
      params: { query: "Privacy Act 1988", asAt: "2015-06-30" },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[INVALID_PARAMETER]")
    expect(result.content[0].text).toContain('has no parameter named "asAt"')
    // The accepted list is the correction: nothing else on this path publishes it.
    expect(result.content[0].text).toContain("get_law_text accepts: query, date, maxChars.")
    expect(result.content[0].text).toContain("NOT applied")
    // The point of the check: the tool must not run and answer as if the date applied.
    expect(handler).not.toHaveBeenCalled()
  })

  it("suggests the closest accepted name for a misspelling", async () => {
    const result = await executeTool(client, { tool_name: "get_law_text", params: { quer: "Privacy Act" } })
    expect(result.content[0].text).toContain('"quer" is closest to "query"')
  })

  it("offers no suggestion for a name that is wrong rather than mistyped", async () => {
    const result = await executeTool(client, { tool_name: "get_law_text", params: { asAt: "2015-06-30" } })
    expect(result.content[0].text).not.toContain("did you mean that?")
  })

  it("leaves optional and defaulted parameters alone", async () => {
    const result = await executeTool(client, { tool_name: "get_law_text", params: { query: "Privacy Act 1988" } })
    expect(result.isError).toBeUndefined()
    expect(handler).toHaveBeenCalledWith(client, { query: "Privacy Act 1988", maxChars: 20000 })
  })

  it("reads the shape through a preprocess wrapper rather than rejecting everything", async () => {
    const ran = await executeTool(client, { tool_name: "wrapped_tool", params: { query: "x" } })
    expect(ran.isError).toBeUndefined()
    expect(handler).toHaveBeenCalledWith(client, { query: "x", task: "full" })

    const rejected = await executeTool(client, { tool_name: "wrapped_tool", params: { querry: "x" } })
    expect(rejected.isError).toBe(true)
    expect(rejected.content[0].text).toContain('has no parameter named "querry"')
  })
})

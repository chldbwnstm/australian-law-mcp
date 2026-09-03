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

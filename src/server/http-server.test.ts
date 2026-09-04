/**
 * Integration tests for the stateless Streamable HTTP transport.
 *
 * These start a real listener on an ephemeral port and speak to it with
 * `node:http` rather than `fetch`, on purpose: the upstream stub replaces
 * `globalThis.fetch`, and a test client built on the same function would be
 * answering its own requests with a fixture.
 */

import { readFileSync } from "node:fs"
import { request as httpRequest, type Server as HttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { ExecutionLimits } from "../lib/execution-limits.js"
import { V3_EXPOSED } from "../lib/tool-profiles.js"
import { registerTools } from "../tool-registry.js"
import { VERSION } from "../version.js"
import { readHttpServerConfig } from "./http-config.js"
import { countToolCalls, startHTTPServer } from "./http-server.js"

/** Recorded live 2026-09-04 — see src/tools/__fixtures__/PROVENANCE.txt. */
const FRL_SEARCH_CCA = readFileSync(new URL("../tools/__fixtures__/frl-search-cca.json", import.meta.url), "utf8")

const MCP_HEADERS = {
  "content-type": "application/json",
  // The transport requires both, per the Streamable HTTP spec.
  accept: "application/json, text/event-stream",
}

const apiClient = new AuApiClient()

function createServer(executionLimits: ExecutionLimits): Server {
  const server = new Server({ name: "australian-law", version: VERSION }, { capabilities: { tools: {} } })
  registerTools(server, apiClient, executionLimits)
  return server
}

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: {
          ...options.headers,
          ...(options.body ? { "content-length": Buffer.byteLength(options.body) } : {}),
        },
      },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          body += chunk
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on("error", reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

const rpc = (method: string, params: Record<string, unknown> = {}, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params })

/** A tools/call that reaches a purely local tool — enough to be counted, no upstream. */
const localCall = (id = 1) => rpc("tools/call", { name: "parse_section_ref", arguments: { ref: "s 18" } }, id)

const started: HttpServer[] = []

async function startTestServer(env: NodeJS.ProcessEnv = {}): Promise<number> {
  const config = readHttpServerConfig({ ALLOWED_ORIGINS: "https://allowed.example", ...env })
  const server = await startHTTPServer(createServer, 0, { config, registerSignalHandlers: false })
  started.push(server)
  return (server.address() as AddressInfo).port
}

afterEach(async () => {
  lawCache.clear()
  vi.unstubAllGlobals()
  await Promise.all(started.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe("counting tool calls", () => {
  it("counts every item of a batch, not the envelope", () => {
    expect(countToolCalls({ method: "tools/call" })).toBe(1)
    expect(countToolCalls({ method: "tools/list" })).toBe(0)
    expect(countToolCalls([{ method: "tools/call" }, { method: "initialize" }, { method: "tools/call" }])).toBe(2)
    expect(countToolCalls("not an envelope")).toBe(0)
  })
})

describe("health and method policy", () => {
  it("answers /health without authentication or an Origin", async () => {
    const port = await startTestServer({ MCP_AUTH_TOKEN: "s3cret" })
    const reply = await send(port, { path: "/health" })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body).status).toBe("ok")
  })

  it("describes the server and its advertised tool count at /", async () => {
    const port = await startTestServer()
    const body = JSON.parse((await send(port, { path: "/" })).body)
    expect(body.name).toBe("Australian Law MCP Server")
    expect(body.transport).toBe("streamable-http (stateless)")
    expect(body.tools.exposed).toBe(V3_EXPOSED.size)
    expect(body.tools.total).toBeGreaterThan(body.tools.exposed)
  })

  // Stateless mode has no stream to resume and no session to delete, so both
  // verbs are refused rather than silently doing nothing.
  it("refuses GET and DELETE on /mcp with a JSON-RPC shaped 405", async () => {
    const port = await startTestServer()
    for (const method of ["GET", "DELETE"]) {
      const reply = await send(port, { method, path: "/mcp", headers: MCP_HEADERS })
      expect(reply.status).toBe(405)
      const body = JSON.parse(reply.body)
      expect(body.jsonrpc).toBe("2.0")
      expect(body.error.code).toBe(-32000)
      expect(body.error.message).toMatch(/stateless/i)
    }
  })
})

describe("origin validation", () => {
  it("refuses an Origin that is not on the allowlist", async () => {
    const port = await startTestServer()
    const reply = await send(port, {
      method: "POST",
      path: "/mcp",
      headers: { ...MCP_HEADERS, origin: "https://evil.example" },
      body: rpc("tools/list"),
    })
    expect(reply.status).toBe(403)
    expect(JSON.parse(reply.body).error.message).toBe("Origin not allowed.")
  })

  it("echoes an allowlisted Origin and varies on it", async () => {
    const port = await startTestServer()
    const reply = await send(port, {
      method: "POST",
      path: "/mcp",
      headers: { ...MCP_HEADERS, origin: "https://allowed.example" },
      body: rpc("tools/list"),
    })
    expect(reply.status).toBe(200)
    expect(reply.headers["access-control-allow-origin"]).toBe("https://allowed.example")
    expect(reply.headers.vary).toBe("Origin")
  })

  it("lets a non-browser client through untouched", async () => {
    const port = await startTestServer()
    const reply = await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: rpc("tools/list") })
    expect(reply.status).toBe(200)
  })
})

describe("access authentication", () => {
  const authed = () => startTestServer({ MCP_AUTH_TOKEN: "s3cret" })

  it("rejects a missing or wrong token with a JSON-RPC error", async () => {
    const port = await authed()
    const anonymous = await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: rpc("tools/list") })
    expect(anonymous.status).toBe(401)
    expect(JSON.parse(anonymous.body).error.code).toBe(-32001)

    const wrong = await send(port, {
      method: "POST",
      path: "/mcp",
      headers: { ...MCP_HEADERS, "x-mcp-token": "wrong" },
      body: rpc("tools/list"),
    })
    expect(wrong.status).toBe(401)
  })

  it("accepts the token as x-mcp-token or as a bearer credential", async () => {
    const port = await authed()
    for (const headers of [{ "x-mcp-token": "s3cret" }, { authorization: "Bearer s3cret" }]) {
      const reply = await send(port, {
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, ...headers },
        body: rpc("tools/list"),
      })
      expect(reply.status).toBe(200)
    }
  })
})

describe("request bounds", () => {
  it("caps the tool calls carried by one envelope", async () => {
    const port = await startTestServer({ MCP_MAX_BATCH_CALLS: "2" })
    const batch = JSON.stringify(
      [1, 2, 3].map((id) => JSON.parse(localCall(id)) as unknown),
    )
    const reply = await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: batch })
    expect(reply.status).toBe(429)
    expect(JSON.parse(reply.body).error.message).toBe("Too many tool calls in one request (max 2).")
  })

  it("rate limits tool calls per IP with a Retry-After and a JSON-RPC body", async () => {
    const port = await startTestServer({ RATE_LIMIT_RPM: "1" })
    const first = await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: localCall(1) })
    expect(first.status).toBe(200)

    const second = await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: localCall(2) })
    expect(second.status).toBe(429)
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0)
    const body = JSON.parse(second.body)
    expect(body.jsonrpc).toBe("2.0")
    expect(body.error.code).toBe(-32000)
    expect(body.error.message).toMatch(/^Too many requests/)
    expect(body.id).toBe(null)
  })

  // The handshake must never be rate limited: a client that is refused
  // tools/list has no tool list at all and reports the capability as missing.
  it("never rate limits the handshake", async () => {
    const port = await startTestServer({ RATE_LIMIT_RPM: "1" })
    for (const method of ["initialize", "tools/list", "tools/list"]) {
      const body =
        method === "initialize"
          ? rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } })
          : rpc(method)
      expect((await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body })).status).toBe(200)
    }
  })

  it("refuses an oversized body without leaking a stack trace", async () => {
    const port = await startTestServer({ MCP_MAX_BODY_BYTES: "2048" })
    const oversized = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(4096) } })
    const reply = await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: oversized })
    expect(reply.status).toBe(413)
    const body = JSON.parse(reply.body)
    expect(body.error.message).toBe("Request entity too large.")
    expect(reply.body).not.toMatch(/node_modules|at Object/)
  })

  it("gates tool calls on the shared upstream allowance", async () => {
    const port = await startTestServer({ FALLBACK_RATE_LIMIT_RPM: "0" })
    const reply = await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: localCall() })
    expect(reply.status).toBe(429)
    expect(Number(reply.headers["retry-after"])).toBeGreaterThan(0)
    expect(JSON.parse(reply.body).error.message).toMatch(/Shared upstream quota exceeded/)
  })

  it("reports the daily cap separately from the per-minute quota", async () => {
    const port = await startTestServer({ FALLBACK_DAILY_CAP: "1" })
    expect((await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: localCall(1) })).status).toBe(200)
    const capped = await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: localCall(2) })
    expect(capped.status).toBe(429)
    expect(JSON.parse(capped.body).error.message).toMatch(/daily cap/)
  })
})

describe("MCP protocol over HTTP", () => {
  it("completes a handshake and advertises exactly the exposed tools", async () => {
    const port = await startTestServer()

    const initialize = await send(port, {
      method: "POST",
      path: "/mcp",
      headers: MCP_HEADERS,
      body: rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
    })
    expect(initialize.status).toBe(200)
    expect(JSON.parse(initialize.body).result.serverInfo.name).toBe("australian-law")

    // A second POST reaches a brand-new Server instance — that is the whole
    // point of stateless mode, and it must not need the handshake repeated.
    const list = await send(port, { method: "POST", path: "/mcp", headers: MCP_HEADERS, body: rpc("tools/list", {}, 2) })
    const tools = JSON.parse(list.body).result.tools as Array<{ name: string; inputSchema: unknown }>
    expect(tools).toHaveLength(V3_EXPOSED.size)
    expect(tools.map((tool) => tool.name).sort()).toEqual([...V3_EXPOSED].sort())
    expect(tools.every((tool) => typeof tool.inputSchema === "object")).toBe(true)
  })

  it("runs a tool through the registry against a stubbed upstream", async () => {
    const fetchStub = vi.fn(
      async () => new Response(FRL_SEARCH_CCA, { status: 200, headers: { "content-type": "application/json" } }),
    )
    vi.stubGlobal("fetch", fetchStub)

    const port = await startTestServer()
    const reply = await send(port, {
      method: "POST",
      path: "/mcp",
      headers: MCP_HEADERS,
      body: rpc("tools/call", { name: "search_law", arguments: { query: "competition and consumer act", limit: 5 } }, 7),
    })

    expect(reply.status).toBe(200)
    const result = JSON.parse(reply.body).result as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain("Competition and Consumer Act 2010")
    expect(fetchStub).toHaveBeenCalled()
    // The request never carried a key, and none was invented for the upstream.
    expect(String(fetchStub.mock.calls[0][0])).not.toMatch(/apikey|oc=/i)
  })
})

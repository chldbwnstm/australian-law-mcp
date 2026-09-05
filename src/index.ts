#!/usr/bin/env node

/**
 * Australian Law MCP server — process entry point.
 *
 * Two transports, one registry: stdio (the default, what an MCP client spawns)
 * and stateless Streamable HTTP (`--mode http`, what a container runs).
 *
 * The one rule that governs this file: **on the stdio path, stdout belongs to
 * the JSON-RPC framing**. A single stray `console.log` from anywhere in the
 * dependency tree corrupts the stream and the client reports a protocol error
 * that points nowhere near its cause, so the console writers are rebound to
 * stderr before the transport is connected.
 *
 * There is no API key to configure. Every upstream source is a keyless public
 * endpoint; the per-request key in the HTTP transport exists so a future keyed
 * source needs no transport change.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { AuApiClient } from "./lib/api-client.js"
import { readExecutionLimits, type ExecutionLimits } from "./lib/execution-limits.js"
import { parseHttpPort } from "./server/http-config.js"
import { startHTTPServer } from "./server/http-server.js"
import { registerTools } from "./tool-registry.js"
import { VERSION } from "./version.js"

/** One client per process: it holds the per-host politeness clock. */
const apiClient = new AuApiClient()

/**
 * HTTP mode builds a fresh server per request (stateless), so this has to stay
 * a factory rather than a singleton.
 */
function createServer(executionLimits: ExecutionLimits = readExecutionLimits()): Server {
  const server = new Server({ name: "australian-law", version: VERSION }, { capabilities: { tools: {} } })
  registerTools(server, apiClient, executionLimits)
  return server
}

const USAGE = `au-law-mcp ${VERSION}

  au-law-mcp                              start on stdio (what an MCP client spawns)
  au-law-mcp --mode http [--port 8000]
                                          start the stateless Streamable HTTP server
  au-law-mcp setup                        register this server in your MCP client configs
  au-law-mcp --version | --help

HTTP mode binds 127.0.0.1 by default. A non-loopback MCP_HTTP_HOST requires
MCP_AUTH_TOKEN (or an explicit MCP_ALLOW_UNAUTHENTICATED_REMOTE=1). See
.env.example for the full environment.`

/** `--flag value`, with the value validated by the caller. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

async function runStdio(): Promise<void> {
  // Rebind before anything else can write: a diagnostic on stdout is a
  // corrupted MCP frame, and the client's error will not name this line.
  const toStderr = (...parts: unknown[]) => process.stderr.write(parts.map(String).join(" ") + "\n")
  console.log = console.warn = console.info = console.debug = toStderr

  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // The client normally closes the pipe; a signal is the operator doing it by
  // hand, and an in-flight tool call should still get to finish its response.
  const shutdown = (signal: string) => {
    console.error(`${signal} received, shutting down.`)
    const forceExit = setTimeout(() => process.exit(0), 5_000)
    forceExit.unref()
    server
      .close()
      .catch(() => {})
      .finally(() => process.exit(0))
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args[0] === "setup") {
    const { runSetup } = await import("./setup.js")
    await runSetup()
    return
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE + "\n")
    return
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(VERSION + "\n")
    return
  }

  // `sse` is accepted as a legacy spelling of the HTTP transport: existing
  // container CMDs and process managers pass it, and silently starting stdio
  // instead would look like a server that boots and never answers.
  const mode = flagValue(args, "--mode") ?? "stdio"
  if (mode !== "stdio" && mode !== "http" && mode !== "sse") {
    throw new Error(`Unknown --mode ${JSON.stringify(mode)}. Use "stdio" or "http".`)
  }

  if (mode === "stdio") {
    await runStdio()
    return
  }

  // Validated here rather than at bind time, so a bad port fails before the
  // process reports itself as started.
  await startHTTPServer(createServer, parseHttpPort(flagValue(args, "--port")))
}

main().catch((error) => {
  console.error("Server error:", error instanceof Error ? error.message : error)
  process.exit(1)
})

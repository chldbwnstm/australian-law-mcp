/**
 * Streamable HTTP transport — stateless mode (the MCP reference pattern).
 *
 * Every POST builds a fresh `Server` + `StreamableHTTPServerTransport` and
 * releases both when the response closes. There is no session map, no event
 * store and no idle sweeper, which is what makes the process restart-, scale-
 * out- and OOM-tolerant: nothing survives a request, so nothing has to be
 * migrated or reaped.
 *
 * The middleware order below is the security order, and it is deliberate:
 *
 *  1. **Origin** before anything else. MCP requires Origin validation on HTTP
 *     transports; without it a page the user merely visits can drive this
 *     server through the browser and read the answers back (DNS rebinding).
 *  2. **Auth** before the body is parsed, so an unauthenticated caller cannot
 *     make the process spend memory on its payload.
 *  3. **Batch cap and per-IP rate accounting** *after* parsing, because both
 *     count items — a JSON-RPC array dispatches every element, so charging one
 *     request per envelope would let a batch multiply the quota.
 *
 * The batch cap bounds the **whole envelope**, not just its `tools/call` items.
 * Every element of an array is dispatched and its response buffered, so a
 * 1,600-element array of `tools/list` is a 26 MB response out of a 98 KB
 * request — amplification that a `tools/call`-only count never saw. `tools/call`
 * additionally spends the shared upstream allowance, which nothing else does.
 *
 * The handshake a client cannot skip — `initialize` and notifications — is
 * never rate limited: a 429 there costs the client its whole session, and
 * connectors funnel many users through a few egress IPs. Everything else,
 * `tools/list` and `ping` included, is charged per message: each one still
 * makes this process serialise a response, so leaving them free left an
 * unmetered CPU sink open to anyone who can reach `/mcp`.
 */

import { timingSafeEqual } from "node:crypto"
import type { Server as HttpServer } from "node:http"
import express from "express"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { RequestExecutionBudget, type ExecutionLimits } from "../lib/execution-limits.js"
import { maskSensitiveUrl } from "../lib/fetch-with-retry.js"
import { createDailyCap, createTokenBucket } from "../lib/rate-limit.js"
import { requestContext } from "../lib/session-state.js"
import { TOOL_COUNTS } from "../tool-registry.js"
import { VERSION } from "../version.js"
import { readHttpServerConfig, type HttpServerConfig } from "./http-config.js"

/** Constant-time comparison that tolerates a length mismatch instead of throwing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** `Authorization: Bearer x` → `x` (the raw value when there is no Bearer prefix). */
function bearerValue(raw: string | undefined): string {
  return raw ? raw.replace(/^Bearer\s+/i, "") : ""
}

/**
 * Strip credentials out of an error before it reaches a log or a response.
 * The current Australian sources are keyless, but a URL carrying a future
 * source's key must not be able to leak just by appearing in a stack trace.
 */
function scrubError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: maskSensitiveUrl(error.message),
      stack: error.stack ? maskSensitiveUrl(error.stack) : undefined,
    }
  }
  return { message: maskSensitiveUrl(String(error)) }
}

/** Count executable calls in an already-parsed JSON-RPC envelope (a batch is an array). */
export function countToolCalls(body: unknown): number {
  const messages = Array.isArray(body) ? body : [body]
  return messages.filter(
    (message) => typeof message === "object" && message !== null && (message as { method?: unknown }).method === "tools/call",
  ).length
}

export function exceedsBatchLimit(body: unknown, maxBatchCalls: number): boolean {
  return countEnvelopeItems(body) > maxBatchCalls
}

/**
 * Every JSON-RPC message an envelope carries, whatever its method.
 *
 * The transport dispatches each element of a batch and buffers each answer, so
 * this — not the `tools/call` subset — is what the batch cap has to bound.
 */
export function countEnvelopeItems(body: unknown): number {
  if (Array.isArray(body)) return body.length
  return typeof body === "object" && body !== null ? 1 : 0
}

/**
 * Messages charged to the per-IP limiter.
 *
 * `initialize` and notifications are exempt: the first is the handshake a
 * client cannot skip, and a notification is answered with an empty 202. Every
 * other method costs this process a serialised response and is counted.
 */
export function countRateLimitedItems(body: unknown): number {
  const messages = Array.isArray(body) ? body : [body]
  return messages.filter((message) => {
    if (typeof message !== "object" || message === null) return false
    const method = (message as { method?: unknown }).method
    if (method === "initialize") return false
    return !(typeof method === "string" && method.startsWith("notifications/"))
  }).length
}

const METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0" as const,
  error: { code: -32000, message: "Method not allowed. Server runs in stateless mode." },
  id: null,
}

export interface StartHttpServerOptions {
  /** Pre-validated configuration. Defaults to reading `env`. */
  config?: HttpServerConfig
  env?: NodeJS.ProcessEnv
  /**
   * Install SIGINT/SIGTERM handlers. Off for tests, which start several servers
   * in one process and would otherwise pile up listeners on the same signals.
   */
  registerSignalHandlers?: boolean
}

export async function startHTTPServer(
  createServer: (executionLimits: ExecutionLimits) => Server,
  port: number,
  options: StartHttpServerOptions = {},
): Promise<HttpServer> {
  // Parse every boundary before the listener opens: a bad value must fail
  // startup rather than degrade into a comparison that never fires.
  const config = options.config ?? readHttpServerConfig(options.env)
  const app = express()
  // A direct deployment must not trust a spoofable X-Forwarded-For. A
  // reverse-proxy deployment opts in with a bounded numeric hop count.
  app.set("trust proxy", config.trustProxy)

  const isPublicPath = (path: string) => path === "/health" || path === "/"

  if (config.accessLog) {
    // Path only — a query string can carry an API key, and access logs are the
    // classic place one ends up in plain text.
    app.use((req, _res, next) => {
      console.error(`[access] ${req.method} ${req.path} ip=${req.ip} ua="${req.headers["user-agent"] ?? "-"}"`)
      next()
    })
  }

  // ── Origin validation (DNS-rebinding defence) ───────────────────────────
  // No Origin header (an ordinary MCP client, server to server) passes. An
  // Origin must be on the allowlist; an explicitly configured CORS_ORIGIN also
  // counts as one entry of that list.
  if (!config.corsOriginConfigured && config.allowedOrigins.length === 0) {
    console.error(
      "ALLOWED_ORIGINS is unset — requests carrying an Origin header are refused (DNS-rebinding defence). " +
        "Set ALLOWED_ORIGINS to use a browser client.",
    )
  }

  /** The value to echo as Access-Control-Allow-Origin, or null to refuse. */
  function resolveOrigin(origin: string | undefined): string | null {
    if (!origin) return config.corsOrigin
    if (config.allowedOrigins.includes(origin)) return origin
    if (config.allowedOrigins.length === 0 && config.corsOriginConfigured) {
      if (config.corsOrigin === "*") return "*"
      if (config.corsOrigin === origin) return origin
    }
    return null
  }

  app.use((req, res, next) => {
    if (isPublicPath(req.path)) return next()
    const allowed = resolveOrigin(req.headers.origin as string | undefined)
    if (allowed === null) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Origin not allowed." }, id: null })
      return
    }
    res.header("Access-Control-Allow-Origin", allowed)
    if (allowed !== "*") res.header("Vary", "Origin")
    next()
  })

  // ── Access authentication (active only when MCP_AUTH_TOKEN is set) ───────
  // Non-loopback binds are refused at config time without it, so reaching here
  // unauthenticated means either loopback or a deliberate override.
  const authToken = config.authToken
  if (!authToken) {
    console.error(
      config.allowUnauthenticatedRemote
        ? "MCP_ALLOW_UNAUTHENTICATED_REMOTE=1 — /mcp is intentionally unauthenticated on a non-loopback bind."
        : "MCP_AUTH_TOKEN is unset — loopback HTTP only. Remote exposure requires a token or an explicit override.",
    )
  }
  app.use((req, res, next) => {
    if (!authToken) return next()
    if (req.method === "OPTIONS") return next() // a preflight cannot carry auth headers
    if (isPublicPath(req.path)) return next()

    const presented =
      (req.headers["x-mcp-token"] as string | undefined) || bearerValue(req.headers["authorization"] as string | undefined)

    if (!presented || !safeEqual(presented, authToken)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null })
      return
    }
    next()
  })

  app.use(express.json({ limit: config.bodyLimitBytes }))

  // ── Batch cap and per-IP rate accounting ─────────────────────────────────
  const rateBuckets = new Map<string, { count: number; resetAt: number }>()

  app.use((req, res, next) => {
    if (isPublicPath(req.path)) return next()

    // The envelope is bounded first, and by its total length: every element of
    // a batch is dispatched and its answer buffered, so an array of any method
    // multiplies the work one request buys. Bounded whether or not the per-IP
    // limiter is on, so RATE_LIMIT_RPM=0 does not disable this guard as well.
    const itemCount = countEnvelopeItems(req.body)
    if (itemCount > config.maxBatchCalls) {
      const callCount = countToolCalls(req.body)
      res.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            callCount > config.maxBatchCalls
              ? `Too many tool calls in one request (max ${config.maxBatchCalls}).`
              : `Too many messages in one request (max ${config.maxBatchCalls}).`,
        },
        id: null,
      })
      return
    }

    if (config.rateLimitRpm === 0) return next()

    // Charged per message, not per envelope: a batch of twenty costs twenty.
    const charge = countRateLimitedItems(req.body)
    if (charge === 0) return next()

    const ip = req.ip || req.socket.remoteAddress || "unknown"
    const now = Date.now()
    let bucket = rateBuckets.get(ip)
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 }
      rateBuckets.set(ip, bucket)
    }
    bucket.count += charge

    if (bucket.count > config.rateLimitRpm) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      res.setHeader("Retry-After", String(retryAfterSec))
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Too many requests — retry in ${retryAfterSec}s.` },
        id: null,
      })
      return
    }
    next()
  })

  if (config.rateLimitRpm > 0) {
    setInterval(() => {
      const now = Date.now()
      for (const [ip, bucket] of rateBuckets) {
        if (now >= bucket.resetAt) rateBuckets.delete(ip)
      }
    }, 5 * 60 * 1000).unref()
  }

  // Security headers (Access-Control-Allow-Origin is set by the Origin check).
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, mcp-session-id, last-event-id, apikey, x-api-key, x-mcp-token, authorization",
    )
    res.header("X-Content-Type-Options", "nosniff")
    res.header("X-Frame-Options", "DENY")
    res.header("Referrer-Policy", "strict-origin-when-cross-origin")
    if (req.method === "OPTIONS") {
      res.sendStatus(200)
      return
    }
    next()
  })

  app.get("/", (_req, res) => {
    res.json({
      name: "Australian Law MCP Server",
      version: VERSION,
      status: "running",
      transport: "streamable-http (stateless)",
      endpoints: { mcp: "/mcp", health: "/health" },
      tools: {
        exposed: TOOL_COUNTS.exposed,
        total: TOOL_COUNTS.total,
        description:
          `${TOOL_COUNTS.exposed} tools are advertised through ListTools; the other ` +
          `${TOOL_COUNTS.total - TOOL_COUNTS.exposed} are reached with discover_tools and execute_tool.`,
      },
    })
  })

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() })
  })

  // ── Shared upstream gate ─────────────────────────────────────────────────
  // Every Australian source here is keyless and several are scraped sites that
  // ask for a politeness interval, so the thing worth protecting is not an API
  // quota but this server's total footprint on them. A token bucket refills
  // continuously (a fixed window would 429 the rest of the minute after one
  // burst); the rolling daily cap is the backstop.
  const sharedMinute = createTokenBucket(config.sharedRpm, config.sharedBurst)
  const sharedDay = createDailyCap(config.sharedDailyCap)
  function sharedAllowance(n: number): { ok: boolean; retryAfterSec: number; daily: boolean } {
    const minute = sharedMinute.take(n)
    if (!minute.ok) return { ...minute, daily: false }
    // Only requests that pass the per-minute gate spend the daily allowance.
    const day = sharedDay.take(n)
    return { ok: day.ok, retryAfterSec: day.retryAfterSec, daily: !day.ok }
  }

  app.post("/mcp", async (req, res) => {
    // No current source needs a credential; the plumbing stays because the
    // request context carries one per request, so a future keyed source is a
    // client change rather than a transport change. When auth is on, the
    // Authorization header is an access token and must not be mistaken for it.
    const authHeader = bearerValue(req.headers["authorization"] as string | undefined)
    const authHeaderIsAccessToken = Boolean(authToken) && Boolean(authHeader) && safeEqual(authHeader, authToken)
    const queryKey = config.allowQueryApiKey ? (req.query.apikey as string | undefined) : undefined
    const apiKey =
      (req.headers["apikey"] as string | undefined) ||
      (req.headers["x-api-key"] as string | undefined) ||
      (authHeaderIsAccessToken ? undefined : authHeader || undefined) ||
      queryKey

    // Handshake methods spend no upstream work, so only tools/call is gated —
    // 429ing initialize would leave a client with no tool list at all.
    const callCount = countToolCalls(req.body)
    if (callCount > 0) {
      const verdict = sharedAllowance(callCount)
      if (!verdict.ok) {
        res.setHeader("Retry-After", String(verdict.retryAfterSec))
        res.status(429).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: verdict.daily
              ? "This server's daily cap on upstream requests has been reached. It fetches public Australian sources " +
                "on their own politeness terms; retry tomorrow or run your own instance."
              : `Shared upstream quota exceeded — retry in ${verdict.retryAfterSec}s.`,
          },
          id: null,
        })
        return
      }
    }

    let server: Server | undefined
    let transport: StreamableHTTPServerTransport | undefined

    try {
      server = createServer(config.executionLimits)
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      })

      // A disconnected HTTP client must stop its upstream work. This is
      // deliberately separate from MCP's per-item cancellation: batch siblings
      // share a budget but keep independent cancellation signals.
      const connectionAbort = new AbortController()
      const abortConnection = () => {
        if (!connectionAbort.signal.aborted) connectionAbort.abort("HTTP client disconnected")
      }
      req.once("aborted", abortConnection)

      res.on("close", () => {
        if (!res.writableEnded) abortConnection()
        try {
          transport?.close()
        } catch {
          /* already closed */
        }
        server?.close().catch(() => {})
      })

      await server.connect(transport)

      // One budget and one key for the whole envelope, isolated per request.
      await requestContext.run(
        {
          apiKey,
          signal: connectionAbort.signal,
          budget: new RequestExecutionBudget(config.executionLimits),
        },
        async () => {
          await transport!.handleRequest(req, res, req.body)
        },
      )
    } catch (error) {
      const scrubbed = scrubError(error)
      console.error("[POST /mcp] Error:", scrubbed.message)
      if (scrubbed.stack && process.env.NODE_ENV !== "production") console.error(scrubbed.stack)
      try {
        transport?.close()
      } catch {
        /* already closed */
      }
      server?.close().catch(() => {})
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null })
      }
    }
  })

  // Stateless mode has no stream to resume and no session to delete.
  app.get("/mcp", (_req, res) => {
    res.status(405).json(METHOD_NOT_ALLOWED)
  })
  app.delete("/mcp", (_req, res) => {
    res.status(405).json(METHOD_NOT_ALLOWED)
  })

  // Final error handler. Express's default sends the stack trace and the
  // install path in the body when NODE_ENV is unset; body-parser's 413/400 also
  // arrive here.
  app.use((err: { status?: unknown; type?: unknown } | undefined, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.status === "number" ? err.status : 500
    // An unparseable body is the client's syntax error, and JSON-RPC reserves
    // -32700 for exactly it. Answering -32603 tells an operator debugging a
    // truncated request that this server failed, which sends them looking in
    // the wrong process.
    const unparseable = err?.type === "entity.parse.failed" || (status === 400 && err instanceof SyntaxError)
    const scrubbed = scrubError(err)
    console.error(`[express] ${status} ${scrubbed.message}`)
    if (res.headersSent) return
    res.status(status).json({
      jsonrpc: "2.0",
      error: {
        code: status === 413 ? -32600 : unparseable ? -32700 : -32603,
        message: status === 413 ? "Request entity too large." : unparseable ? "Parse error" : "Internal server error",
      },
      id: null,
    })
  })

  // Loopback is the safe default; a remote bind is an explicit MCP_HTTP_HOST
  // that has already been validated against MCP_AUTH_TOKEN above.
  const expressServer = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(port, config.host, () => resolve(listener))
    listener.once("error", reject)
  })

  const address = expressServer.address()
  const boundPort = typeof address === "object" && address ? address.port : port
  console.error(`Australian Law MCP server (HTTP, stateless) listening on ${config.host}:${boundPort}`)
  console.error(`  MCP endpoint: http://${config.host}:${boundPort}/mcp`)
  console.error(`  Health check: http://${config.host}:${boundPort}/health`)

  if (options.registerSignalHandlers !== false) {
    // Wait for in-flight requests, then force the exit. Idle keep-alive sockets
    // are not closed by close(), so without closeIdleConnections() every
    // deployment restart would sit out the full timeout and record a dirty exit.
    const gracefulShutdown = (signal: string) => {
      console.error(`${signal} received, shutting down.`)
      const forceExit = setTimeout(() => {
        console.error("Shutdown timeout (10s) — forcing exit.")
        process.exit(0)
      }, 10_000)
      forceExit.unref()
      expressServer.closeIdleConnections()
      expressServer.close(() => {
        clearTimeout(forceExit)
        console.error("Server shutdown complete.")
        process.exit(0)
      })
    }
    process.on("SIGINT", () => gracefulShutdown("SIGINT"))
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
  }

  return expressServer
}

/**
 * Validated HTTP configuration, kept in its own module so every security
 * boundary is parsed — and can fail startup — before a socket is opened.
 *
 * The rule this file exists to enforce: a malformed value is a startup error,
 * never a disabled limit. `parseInt("60x")` is `60`, `Number("")` is `0`, and
 * `parseInt("nope")` is `NaN` — and `NaN > limit` is `false`, so a single typo
 * in a deployment's environment silently switches a gate off and nothing in the
 * logs says so. Every numeric setting therefore goes through
 * `parseIntegerLimit`, which accepts whole digits and nothing else.
 */

import { parseIntegerLimit, readExecutionLimits, type ExecutionLimits } from "../lib/execution-limits.js"
import { resolveChainDeadlineMs } from "../tools/chain-deadline.js"

const DEFAULT_BODY_LIMIT_BYTES = 100 * 1024
const MAX_BODY_LIMIT_BYTES = 10 * 1024 * 1024

export interface HttpServerConfig {
  host: string
  trustProxy: number | false
  authToken: string
  allowUnauthenticatedRemote: boolean
  bodyLimitBytes: number
  rateLimitRpm: number
  maxBatchCalls: number
  /** `Access-Control-Allow-Origin` to send when the request carries no Origin. */
  corsOrigin: string
  /** Whether CORS_ORIGIN was set at all — an explicit `*` is a decision, an absent one is not. */
  corsOriginConfigured: boolean
  /** Origin-header allowlist (DNS-rebinding defence). Empty means "no browser origin passes". */
  allowedOrigins: string[]
  /** Whether `?apikey=` is honoured. Query keys leak into proxy access logs. */
  allowQueryApiKey: boolean
  /** Whether to log one line per request (path only — never the query string). */
  accessLog: boolean
  sharedRpm: number
  sharedBurst: number
  sharedDailyCap: number
  executionLimits: ExecutionLimits
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

/** A 0/1 switch, parsed strictly: "true", "yes" and "" are configuration mistakes, not values. */
function parseFlag(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (raw === "0") return false
  if (raw === "1") return true
  throw new Error(`${name} must be 0 or 1.`)
}

/** Only explicit, bounded hop counts are safe to infer from X-Forwarded-For. */
function parseTrustProxy(raw: string | undefined): number | false {
  if (raw === undefined || raw === "false" || raw === "0") return false
  return parseIntegerLimit("TRUST_PROXY", raw, 0, 1, 10)
}

/**
 * MCP_MAX_BODY_BYTES is the current numeric setting. The older `MCP_BODY_LIMIT`
 * spelling ("100kb") is accepted as a compatibility bridge, but validated here
 * rather than handed to Express to reject at request time — a body limit that
 * only fails on the first large request is a limit nobody knows is broken.
 */
function parseBodyLimit(env: NodeJS.ProcessEnv): number {
  if (env.MCP_MAX_BODY_BYTES !== undefined) {
    return parseIntegerLimit(
      "MCP_MAX_BODY_BYTES",
      env.MCP_MAX_BODY_BYTES,
      DEFAULT_BODY_LIMIT_BYTES,
      1_024,
      MAX_BODY_LIMIT_BYTES,
    )
  }
  const legacy = env.MCP_BODY_LIMIT
  if (legacy === undefined) return DEFAULT_BODY_LIMIT_BYTES

  const match = legacy.match(/^(\d+)(b|kb|mb)?$/i)
  if (!match) {
    throw new Error(`MCP_BODY_LIMIT must be a size from 1024 to ${MAX_BODY_LIMIT_BYTES} bytes (for example 100kb).`)
  }
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1
  const value = Number(match[1]) * multiplier
  if (!Number.isSafeInteger(value) || value < 1_024 || value > MAX_BODY_LIMIT_BYTES) {
    throw new Error(`MCP_BODY_LIMIT must be a size from 1024 to ${MAX_BODY_LIMIT_BYTES} bytes (for example 100kb).`)
  }
  return value
}

/** `*`, or a single origin. Whitespace here is always a typo, so it fails rather than never matching. */
function parseCorsOrigin(raw: string | undefined): string {
  if (raw === undefined) return "*"
  const value = raw.trim()
  if (!value || /\s/.test(value)) {
    throw new Error('CORS_ORIGIN must be "*" or a single origin such as https://example.com.')
  }
  return value
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export function parseHttpPort(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  return parseIntegerLimit("PORT", raw ?? env.PORT, 8000, 1, 65_535)
}

export function readHttpServerConfig(env: NodeJS.ProcessEnv = process.env): HttpServerConfig {
  const host = (env.MCP_HTTP_HOST ?? "127.0.0.1").trim()
  if (!host || /\s/.test(host)) {
    throw new Error("MCP_HTTP_HOST must be a non-empty host without whitespace.")
  }

  const authToken = env.MCP_AUTH_TOKEN ?? ""
  const hasAuthToken = authToken.trim().length > 0
  const allowUnauthenticatedRemote = parseFlag("MCP_ALLOW_UNAUTHENTICATED_REMOTE", env.MCP_ALLOW_UNAUTHENTICATED_REMOTE, false)
  if (!isLoopbackHost(host) && !hasAuthToken && !allowUnauthenticatedRemote) {
    throw new Error(
      "MCP_HTTP_HOST is non-loopback. Set MCP_AUTH_TOKEN or explicitly set MCP_ALLOW_UNAUTHENTICATED_REMOTE=1.",
    )
  }

  // The shared-traffic gate is validated here for the same reason as the rest:
  // left to parse at call time, one typo becomes NaN and the token bucket stops
  // comparing, which opens the server's whole upstream allowance.
  const sharedRpm = parseIntegerLimit("FALLBACK_RATE_LIMIT_RPM", env.FALLBACK_RATE_LIMIT_RPM, 120, 0, 100_000)

  // The chain deadline is consumed by the chain tools at call time from their
  // own env read; validating it here brings the failure forward to boot, so a
  // typo cannot ship as "only the chain tools are quietly dead".
  resolveChainDeadlineMs(env)

  return {
    host,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    authToken,
    allowUnauthenticatedRemote,
    bodyLimitBytes: parseBodyLimit(env),
    rateLimitRpm: parseIntegerLimit("RATE_LIMIT_RPM", env.RATE_LIMIT_RPM, 60, 0, 100_000),
    maxBatchCalls: parseIntegerLimit("MCP_MAX_BATCH_CALLS", env.MCP_MAX_BATCH_CALLS, 20, 1, 100),
    corsOrigin: parseCorsOrigin(env.CORS_ORIGIN),
    corsOriginConfigured: env.CORS_ORIGIN !== undefined,
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    allowQueryApiKey: parseFlag("ALLOW_QUERY_API_KEY", env.ALLOW_QUERY_API_KEY, true),
    accessLog: parseFlag("ACCESS_LOG", env.ACCESS_LOG, false),
    sharedRpm,
    sharedBurst: parseIntegerLimit("FALLBACK_RATE_LIMIT_BURST", env.FALLBACK_RATE_LIMIT_BURST, sharedRpm, 0, 100_000),
    sharedDailyCap: parseIntegerLimit("FALLBACK_DAILY_CAP", env.FALLBACK_DAILY_CAP, 0, 0, 100_000_000),
    executionLimits: readExecutionLimits(env),
  }
}

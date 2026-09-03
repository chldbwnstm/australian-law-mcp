/**
 * Request-wide execution limits.
 *
 * A single HTTP JSON-RPC envelope can contain a batch and a single tool can
 * fan out into several upstream calls.  Keep the accounting object in the
 * request context so those inner calls share one budget instead of each
 * receiving a fresh allowance.
 */

export interface ExecutionLimits {
  /** Total upstream HTTP attempts, including retries and redirect hops. */
  maxUpstreamRequests: number
  /** Maximum bytes read from one upstream response body. */
  maxUpstreamBodyBytes: number
  /** Maximum bytes read from all upstream response bodies in one request. */
  maxTotalUpstreamBodyBytes: number
  /** Maximum characters returned in an MCP tool response. */
  maxToolResponseChars: number
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  // A document-review style chain can legitimately issue well over a dozen
  // upstream calls.  48 leaves room for the documented chain workflows and
  // bounded retry recovery while stopping unbounded fan-out from one outer
  // MCP request.
  maxUpstreamRequests: 48,
  maxUpstreamBodyBytes: 2 * 1024 * 1024,
  maxTotalUpstreamBodyBytes: 8 * 1024 * 1024,
  maxToolResponseChars: 50_000,
}

const MAX_CONFIGURED_REQUESTS = 1_000
const MAX_CONFIGURED_BYTES = 100 * 1024 * 1024
const MAX_CONFIGURED_RESPONSE_CHARS = 1_000_000

export class ExecutionLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExecutionLimitError"
  }
}

/** Parse a security boundary as a whole integer; never accept parseInt's 12x → 12 behaviour. */
export function parseIntegerLimit(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }
  return value
}

export function readExecutionLimits(env: NodeJS.ProcessEnv = process.env): ExecutionLimits {
  const limits: ExecutionLimits = {
    maxUpstreamRequests: parseIntegerLimit(
      "MCP_MAX_UPSTREAM_REQUESTS",
      env.MCP_MAX_UPSTREAM_REQUESTS,
      DEFAULT_EXECUTION_LIMITS.maxUpstreamRequests,
      1,
      MAX_CONFIGURED_REQUESTS,
    ),
    maxUpstreamBodyBytes: parseIntegerLimit(
      "MCP_MAX_UPSTREAM_BODY_BYTES",
      env.MCP_MAX_UPSTREAM_BODY_BYTES,
      DEFAULT_EXECUTION_LIMITS.maxUpstreamBodyBytes,
      1_024,
      MAX_CONFIGURED_BYTES,
    ),
    maxTotalUpstreamBodyBytes: parseIntegerLimit(
      "MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES",
      env.MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES,
      DEFAULT_EXECUTION_LIMITS.maxTotalUpstreamBodyBytes,
      1_024,
      MAX_CONFIGURED_BYTES,
    ),
    maxToolResponseChars: parseIntegerLimit(
      "MCP_MAX_TOOL_RESPONSE_CHARS",
      env.MCP_MAX_TOOL_RESPONSE_CHARS,
      DEFAULT_EXECUTION_LIMITS.maxToolResponseChars,
      1_024,
      MAX_CONFIGURED_RESPONSE_CHARS,
    ),
  }

  if (limits.maxTotalUpstreamBodyBytes < limits.maxUpstreamBodyBytes) {
    throw new Error("MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES must be at least MCP_MAX_UPSTREAM_BODY_BYTES.")
  }

  return limits
}

/** Mutable per-request accounting; this object is intentionally shared by a JSON-RPC batch. */
export class RequestExecutionBudget {
  private upstreamRequests = 0
  private upstreamBodyBytes = 0

  constructor(readonly limits: ExecutionLimits) {}

  consumeUpstreamRequest(): void {
    this.upstreamRequests += 1
    if (this.upstreamRequests > this.limits.maxUpstreamRequests) {
      throw new ExecutionLimitError(
        `Request upstream work budget exceeded (max ${this.limits.maxUpstreamRequests} attempts).`,
      )
    }
  }

  consumeUpstreamBody(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ExecutionLimitError("Invalid upstream response body size.")
    }
    this.upstreamBodyBytes += bytes
    if (this.upstreamBodyBytes > this.limits.maxTotalUpstreamBodyBytes) {
      throw new ExecutionLimitError(
        `Request upstream response-body budget exceeded (max ${this.limits.maxTotalUpstreamBodyBytes} bytes).`,
      )
    }
  }

  ensureResponseBodySize(bytes: number): void {
    if (bytes > this.limits.maxUpstreamBodyBytes) {
      // Report the observed size next to the limit — an operator has to be able
      // to decide how far to raise MCP_MAX_UPSTREAM_BODY_BYTES from this one line.
      throw new ExecutionLimitError(
        `Upstream response body is ${bytes} bytes, over the per-response limit of ` +
        `${this.limits.maxUpstreamBodyBytes} bytes (MCP_MAX_UPSTREAM_BODY_BYTES).`,
      )
    }
  }

  snapshot(): { upstreamRequests: number; upstreamBodyBytes: number } {
    return { upstreamRequests: this.upstreamRequests, upstreamBodyBytes: this.upstreamBodyBytes }
  }
}

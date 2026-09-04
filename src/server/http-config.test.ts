import { describe, expect, it } from "vitest"
import { parseHttpPort, readHttpServerConfig } from "./http-config.js"
import { exceedsBatchLimit } from "./http-server.js"

describe("HTTP configuration defaults", () => {
  it("is a loopback server that trusts nothing it was not told to trust", () => {
    const config = readHttpServerConfig({})
    expect(config.host).toBe("127.0.0.1")
    expect(config.trustProxy).toBe(false)
    expect(config.authToken).toBe("")
    expect(config.rateLimitRpm).toBe(60)
    expect(config.maxBatchCalls).toBe(20)
    expect(config.bodyLimitBytes).toBe(102_400)
    expect(config.allowQueryApiKey).toBe(true)
    expect(config.accessLog).toBe(false)
    expect(config.corsOrigin).toBe("*")
    expect(config.corsOriginConfigured).toBe(false)
    expect(config.allowedOrigins).toEqual([])
    expect(config.sharedRpm).toBe(120)
    expect(config.sharedBurst).toBe(120)
    expect(config.sharedDailyCap).toBe(0)
    expect(config.executionLimits.maxUpstreamRequests).toBe(48)
  })
})

describe("remote exposure", () => {
  it("requires explicit authentication or an explicit override off loopback", () => {
    expect(() => readHttpServerConfig({ MCP_HTTP_HOST: "0.0.0.0" })).toThrow("MCP_HTTP_HOST is non-loopback")
    // Whitespace is not a token: a blank-looking value must not read as "configured".
    expect(() => readHttpServerConfig({ MCP_HTTP_HOST: "0.0.0.0", MCP_AUTH_TOKEN: "   " })).toThrow("MCP_HTTP_HOST is non-loopback")
    expect(readHttpServerConfig({ MCP_HTTP_HOST: "0.0.0.0", MCP_AUTH_TOKEN: "secret" }).host).toBe("0.0.0.0")
    expect(
      readHttpServerConfig({ MCP_HTTP_HOST: "0.0.0.0", MCP_ALLOW_UNAUTHENTICATED_REMOTE: "1" }).allowUnauthenticatedRemote,
    ).toBe(true)
  })

  it("recognises every loopback spelling as local", () => {
    for (const host of ["127.0.0.1", "127.0.0.53", "localhost", "LOCALHOST", "::1"]) {
      expect(readHttpServerConfig({ MCP_HTTP_HOST: host }).host).toBe(host.trim())
    }
  })

  it("rejects an unusable bind address instead of handing it to listen()", () => {
    expect(() => readHttpServerConfig({ MCP_HTTP_HOST: "" })).toThrow("MCP_HTTP_HOST")
    expect(() => readHttpServerConfig({ MCP_HTTP_HOST: "   " })).toThrow("MCP_HTTP_HOST")
    expect(() => readHttpServerConfig({ MCP_HTTP_HOST: "127.0.0.1 8000" })).toThrow("MCP_HTTP_HOST")
  })

  it("takes the override switch as 0 or 1 and nothing else", () => {
    expect(readHttpServerConfig({ MCP_ALLOW_UNAUTHENTICATED_REMOTE: "0" }).allowUnauthenticatedRemote).toBe(false)
    expect(() => readHttpServerConfig({ MCP_ALLOW_UNAUTHENTICATED_REMOTE: "true" })).toThrow(
      "MCP_ALLOW_UNAUTHENTICATED_REMOTE must be 0 or 1",
    )
  })
})

describe("proxy trust", () => {
  it("accepts only an explicit, bounded hop count", () => {
    expect(readHttpServerConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(1)
    expect(readHttpServerConfig({ TRUST_PROXY: "0" }).trustProxy).toBe(false)
    expect(readHttpServerConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false)
    // "true" means "trust every hop", which makes X-Forwarded-For — and so the
    // per-IP rate limit — client-controlled.
    expect(() => readHttpServerConfig({ TRUST_PROXY: "true" })).toThrow("TRUST_PROXY must be an integer")
    expect(() => readHttpServerConfig({ TRUST_PROXY: "11" })).toThrow("TRUST_PROXY must be an integer")
  })
})

describe("numeric limits fail startup rather than degrade", () => {
  it("rejects values parseInt would have quietly accepted", () => {
    expect(() => readHttpServerConfig({ RATE_LIMIT_RPM: "nope" })).toThrow("RATE_LIMIT_RPM must be an integer")
    expect(() => readHttpServerConfig({ RATE_LIMIT_RPM: "60x" })).toThrow("RATE_LIMIT_RPM must be an integer")
    expect(() => readHttpServerConfig({ MCP_MAX_BATCH_CALLS: "0" })).toThrow("MCP_MAX_BATCH_CALLS must be an integer")
    expect(() => readHttpServerConfig({ MCP_MAX_BATCH_CALLS: "101" })).toThrow("MCP_MAX_BATCH_CALLS must be an integer")
    expect(() => readHttpServerConfig({ MCP_MAX_BODY_BYTES: "NaN" })).toThrow("MCP_MAX_BODY_BYTES must be an integer")
    expect(() => readHttpServerConfig({ MCP_MAX_BODY_BYTES: "512" })).toThrow("MCP_MAX_BODY_BYTES must be an integer")
    expect(() => readHttpServerConfig({ FALLBACK_DAILY_CAP: "-1" })).toThrow("FALLBACK_DAILY_CAP must be an integer")
    expect(() => readHttpServerConfig({ MCP_MAX_TOOL_RESPONSE_CHARS: "lots" })).toThrow("MCP_MAX_TOOL_RESPONSE_CHARS")
  })

  it("keeps the batch cap active when per-IP limiting is switched off", () => {
    const config = readHttpServerConfig({ RATE_LIMIT_RPM: "0", MCP_MAX_BATCH_CALLS: "2" })
    expect(config.rateLimitRpm).toBe(0)
    expect(exceedsBatchLimit(Array.from({ length: 3 }, () => ({ method: "tools/call" })), config.maxBatchCalls)).toBe(true)
    expect(exceedsBatchLimit(Array.from({ length: 2 }, () => ({ method: "tools/call" })), config.maxBatchCalls)).toBe(false)
  })

  it("defaults the shared burst to one minute of the shared rate", () => {
    expect(readHttpServerConfig({ FALLBACK_RATE_LIMIT_RPM: "30" }).sharedBurst).toBe(30)
    expect(readHttpServerConfig({ FALLBACK_RATE_LIMIT_RPM: "30", FALLBACK_RATE_LIMIT_BURST: "90" }).sharedBurst).toBe(90)
  })

  // Validated at boot with the rest, so a typo cannot ship as "only the chain
  // tools are quietly dead" — they read this value at call time.
  it("fails startup for an invalid chain deadline instead of at call time", () => {
    expect(() => readHttpServerConfig({ MCP_CHAIN_DEADLINE_MS: "45s" })).toThrow("MCP_CHAIN_DEADLINE_MS")
    expect(() => readHttpServerConfig({ MCP_CHAIN_DEADLINE_MS: "1000" })).toThrow("MCP_CHAIN_DEADLINE_MS")
    expect(() => readHttpServerConfig({ MCP_CHAIN_DEADLINE_MS: "30000" })).not.toThrow()
  })
})

describe("request body limit", () => {
  it("takes the numeric setting", () => {
    expect(readHttpServerConfig({ MCP_MAX_BODY_BYTES: "204800" }).bodyLimitBytes).toBe(204_800)
  })

  it("accepts the legacy size spelling, validated here rather than by Express", () => {
    expect(readHttpServerConfig({ MCP_BODY_LIMIT: "100kb" }).bodyLimitBytes).toBe(102_400)
    expect(readHttpServerConfig({ MCP_BODY_LIMIT: "1mb" }).bodyLimitBytes).toBe(1_048_576)
    expect(readHttpServerConfig({ MCP_BODY_LIMIT: "4096" }).bodyLimitBytes).toBe(4_096)
    expect(() => readHttpServerConfig({ MCP_BODY_LIMIT: "huge" })).toThrow("MCP_BODY_LIMIT")
    expect(() => readHttpServerConfig({ MCP_BODY_LIMIT: "20mb" })).toThrow("MCP_BODY_LIMIT")
    expect(() => readHttpServerConfig({ MCP_BODY_LIMIT: "512b" })).toThrow("MCP_BODY_LIMIT")
  })

  it("prefers the current setting when both are present", () => {
    expect(readHttpServerConfig({ MCP_MAX_BODY_BYTES: "8192", MCP_BODY_LIMIT: "1mb" }).bodyLimitBytes).toBe(8_192)
  })
})

describe("browser-facing configuration", () => {
  it("distinguishes an unset CORS_ORIGIN from an explicit one", () => {
    const explicit = readHttpServerConfig({ CORS_ORIGIN: "https://example.com" })
    expect(explicit.corsOrigin).toBe("https://example.com")
    expect(explicit.corsOriginConfigured).toBe(true)
    expect(readHttpServerConfig({ CORS_ORIGIN: "*" }).corsOriginConfigured).toBe(true)
  })

  // An empty CORS_ORIGIN in the reference read as "*" while still counting as
  // configured — i.e. blanking the variable silently allowed every browser
  // origin. It is a startup error here instead.
  it("refuses a blank or malformed CORS_ORIGIN", () => {
    expect(() => readHttpServerConfig({ CORS_ORIGIN: "" })).toThrow("CORS_ORIGIN")
    expect(() => readHttpServerConfig({ CORS_ORIGIN: "https://a.example https://b.example" })).toThrow("CORS_ORIGIN")
  })

  it("parses the origin allowlist, ignoring spacing and empty entries", () => {
    expect(
      readHttpServerConfig({ ALLOWED_ORIGINS: " https://a.example , https://b.example ,," }).allowedOrigins,
    ).toEqual(["https://a.example", "https://b.example"])
  })

  it("takes the query-key and access-log switches as 0 or 1", () => {
    expect(readHttpServerConfig({ ALLOW_QUERY_API_KEY: "0" }).allowQueryApiKey).toBe(false)
    expect(readHttpServerConfig({ ACCESS_LOG: "1" }).accessLog).toBe(true)
    expect(() => readHttpServerConfig({ ALLOW_QUERY_API_KEY: "no" })).toThrow("ALLOW_QUERY_API_KEY must be 0 or 1")
    expect(() => readHttpServerConfig({ ACCESS_LOG: "verbose" })).toThrow("ACCESS_LOG must be 0 or 1")
  })
})

describe("port", () => {
  it("is a whole number, from the flag or the environment", () => {
    expect(parseHttpPort(undefined, {})).toBe(8000)
    expect(parseHttpPort(undefined, { PORT: "8123" })).toBe(8123)
    expect(parseHttpPort("3999", { PORT: "8123" })).toBe(3999)
    expect(() => parseHttpPort(undefined, { PORT: "8123oops" })).toThrow("PORT must be an integer")
    expect(() => parseHttpPort("0", {})).toThrow("PORT must be an integer")
    expect(() => parseHttpPort("70000", {})).toThrow("PORT must be an integer")
  })
})

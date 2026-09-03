import { describe, expect, it } from "vitest"
import {
  BLOCKED_HOSTS,
  DEFAULT_USER_AGENT,
  HOST_KEYS,
  UPSTREAM_HOSTS,
  defaultAcceptFor,
  defaultHeadersFor,
  getHostConfig,
  isBlockedHost,
  resolveUserAgent,
  type HostKey,
} from "./upstream-hosts.js"

describe("host table", () => {
  it("covers every host named in ARCHITECTURE.md", () => {
    const expected: HostKey[] = [
      "frlApi", "frlDocs", "nswCaselaw", "hcourt", "qldJudgments", "qldLegislation",
      "tasLegislation", "waLegislation", "vicLegislation", "ntLegislation",
      "actLegislation", "ato", "fwc", "oaic", "dfat", "glossary",
      // `parlinfo` is the second half of the ARCHITECTURE.md `aph` row
      // (www.aph.gov.au / parlinfo): a separate origin with its own politeness
      // clock and its own Referer requirement, so a separate row.
      "mpc", "nacc", "adrp", "aph", "parlinfo",
      "austlii", "lawcite", "fedcourt", "nswLegislation", "saLegislation",
      "accc", "competitionTribunal", "ombudsman",
    ]
    expect(HOST_KEYS.sort()).toEqual(expected.sort())
  })

  it("keys the table by its own key field", () => {
    for (const key of HOST_KEYS) expect(UPSTREAM_HOSTS[key].key).toBe(key)
  })

  it("uses https everywhere and never a trailing slash", () => {
    for (const key of HOST_KEYS) {
      const { base } = UPSTREAM_HOSTS[key]
      expect(base.startsWith("https://")).toBe(true)
      expect(base.endsWith("/")).toBe(false)
    }
  })

  it("pins the base URLs the research verified", () => {
    expect(getHostConfig("frlApi").base).toBe("https://api.prod.legislation.gov.au/v1")
    expect(getHostConfig("frlDocs").base).toBe("https://www.legislation.gov.au")
    expect(getHostConfig("nswCaselaw").base).toBe("https://www.caselaw.nsw.gov.au")
    expect(getHostConfig("dfat").base).toBe("https://docs.dfat.gov.au")
  })

  it("throws on an unknown key rather than returning undefined", () => {
    expect(() => getHostConfig("nope" as HostKey)).toThrow(/Unknown upstream host/)
  })
})

describe("politeness and timeouts", () => {
  it("keeps scraped hosts at >= 1 request per second", () => {
    const scraped: HostKey[] = [
      "nswCaselaw", "hcourt", "qldJudgments", "qldLegislation", "tasLegislation",
      "waLegislation", "vicLegislation", "ntLegislation", "actLegislation",
      "ato", "fwc", "oaic", "dfat", "glossary", "mpc", "nacc", "adrp", "aph",
    ]
    for (const key of scraped) {
      expect(UPSTREAM_HOSTS[key].minIntervalMs).toBeGreaterThanOrEqual(1000)
    }
  })

  it("never lets an interval be zero — even the keyless API is spaced out", () => {
    for (const key of HOST_KEYS) expect(UPSTREAM_HOSTS[key].minIntervalMs).toBeGreaterThan(0)
  })

  // A single global timeout would either cut these endpoints off or make a
  // dead host stall every other tool for as long as the slowest one.
  it("gives the slow endpoints the timeout their own docs describe", () => {
    expect(getHostConfig("qldLegislation").timeoutMs).toBe(90_000)
    expect(getHostConfig("tasLegislation").timeoutMs).toBe(90_000)
    expect(getHostConfig("ato").timeoutMs).toBe(60_000)
  })
})

describe("blocked set", () => {
  it("is exactly the eight sources ARCHITECTURE.md lists", () => {
    expect([...BLOCKED_HOSTS].sort()).toEqual(
      ["accc", "austlii", "competitionTribunal", "fedcourt", "lawcite",
        "nswLegislation", "ombudsman", "saLegislation"].sort(),
    )
  })

  it("marks each blocked host with a reason a user can read", () => {
    for (const key of BLOCKED_HOSTS) {
      expect(isBlockedHost(key)).toBe(true)
      expect(UPSTREAM_HOSTS[key].blockedReason).toBeTruthy()
    }
  })

  it("leaves every fetched host unblocked", () => {
    for (const key of HOST_KEYS) {
      if (BLOCKED_HOSTS.has(key)) continue
      expect(UPSTREAM_HOSTS[key].blocked).toBeUndefined()
      expect(isBlockedHost(key)).toBe(false)
    }
  })
})

describe("headers", () => {
  it("defaults to a browser UA", () => {
    expect(defaultHeadersFor("frlApi", {} as NodeJS.ProcessEnv)["user-agent"]).toBe(DEFAULT_USER_AGENT)
  })

  it("lets LAW_USER_AGENT override it", () => {
    const env = { LAW_USER_AGENT: "custom-agent/1.0" } as unknown as NodeJS.ProcessEnv
    expect(resolveUserAgent(env)).toBe("custom-agent/1.0")
    expect(defaultHeadersFor("nswCaselaw", env)["user-agent"]).toBe("custom-agent/1.0")
  })

  it("ignores an empty LAW_USER_AGENT instead of sending a blank header", () => {
    expect(resolveUserAgent({ LAW_USER_AGENT: "" } as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_USER_AGENT)
  })

  it("asks each kind for the content type it actually serves", () => {
    expect(defaultAcceptFor("odata")).toContain("application/json")
    expect(defaultAcceptFor("json")).toBe("application/json")
    expect(defaultAcceptFor("html")).toContain("text/html")
    expect(defaultAcceptFor("documents")).toBe("*/*")
  })
})

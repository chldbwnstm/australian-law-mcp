import { describe, expect, it } from "vitest"
import { ASIDE_HOST_FLOORS, boundFollowupEnvelope, boundToolResponse, gapId, isEligibleLocalAside, makeGap, mergeGaps, osMajor } from "./research-followup.js"
import { ASIDE_HOST_FLOORS as HELPER_FLOORS } from "../../companion/au-law-followup/scripts/followup.mjs"

const base = {
  kind: "source_access" as const,
  originTool: "search_state_law",
  target: { query: "  Residential   Tenancies Act " },
  jurisdiction: "NSW",
  sourceUrls: ["https://legislation.nsw.gov.au/search"],
  sourceAccess: "requires_access" as const,
}

describe("research follow-up identity and eligibility", () => {
  it("keeps gap identity stable across mutable prose and normalised whitespace", () => {
    const a = makeGap({ ...base, reason: "blocked", evidenceNeeded: ["text"] })
    const b = makeGap({ ...base, target: { query: "residential tenancies act" }, reason: "a different explanation", evidenceNeeded: ["body"] })
    expect(a.id).toBe(b.id)
    expect(gapId(base)).toBe(a.id)
    expect(mergeGaps([a], [b])).toHaveLength(1)
  })

  it("normalises URL hosts but preserves case-sensitive path and query identity", () => {
    const upperHost = makeGap({ ...base, sourceUrls: ["HTTPS://LEGISLATION.NSW.GOV.AU/Record?Id=ABC"], reason: "blocked", evidenceNeeded: ["text"] })
    const lowerHost = makeGap({ ...base, sourceUrls: ["https://legislation.nsw.gov.au/Record?Id=ABC"], reason: "blocked", evidenceNeeded: ["text"] })
    const differentRecord = makeGap({ ...base, sourceUrls: ["https://legislation.nsw.gov.au/record?Id=abc"], reason: "blocked", evidenceNeeded: ["text"] })
    expect(upperHost.id).toBe(lowerHost.id)
    expect(differentRecord.id).not.toBe(lowerHost.id)
  })

  const probe = { probe: "local_companion" as const, execution: "local" as const, asideConnected: true, asideTools: ["repl" as const] }

  it.each([
    [{ ...probe, platform: "win32" as const, osVersion: "6.3.9600" }, "Windows 10"],
    [{ ...probe, platform: "win32" as const, osVersion: "garbage" }, "Windows 10"],
    [{ ...probe, platform: "linux" as const, osVersion: "6.8" }, "only on macOS and Windows"],
    [{ ...probe, platform: "unknown" as const, osVersion: "unknown" }, "only on macOS and Windows"],
    [{ ...probe, execution: "remote" as const, platform: "darwin" as const, osVersion: "15.0" }, "local client"],
    [{ ...probe, execution: "remote" as const, platform: "win32" as const, osVersion: "10.0.26200" }, "local client"],
    [{ ...probe, platform: "darwin" as const, osVersion: "14.7" }, "macOS 15"],
    [{ ...probe, platform: "darwin" as const, osVersion: "15garbage" }, "macOS 15"],
    [{ ...probe, platform: "darwin" as const, osVersion: "15.0", asideConnected: false, asideTools: [] }, "not connected"],
    [{ ...probe, platform: "win32" as const, osVersion: "10.0.26200", asideConnected: false, asideTools: [] }, "not connected"],
    [{ ...probe, platform: "win32" as const, osVersion: "10.0.26200", asideTools: ["exec" as const] }, "repl"],
  ])("rejects ineligible environments", (input, reason) => {
    expect(isEligibleLocalAside(input)).toEqual(expect.objectContaining({ eligible: false, reason: expect.stringContaining(reason) }))
  })

  // Windows 11 reports NT major 10 — "10.0.26200" is Windows 11 24H2 — so the
  // floor is 10 and a rule written "11 or later" would refuse every Windows 11 PC.
  it("accepts a local Windows 10/11 host on the same terms as a Mac", () => {
    for (const osVersion of ["10.0.26200", "10.0.19045", "10.0", "10", "11"]) {
      expect(isEligibleLocalAside({ ...probe, platform: "win32", osVersion })).toEqual({ eligible: true, reason: expect.stringContaining("Local Windows 10+") })
    }
    expect(isEligibleLocalAside({ ...probe, platform: "darwin", osVersion: "15.1" })).toEqual({ eligible: true, reason: expect.stringContaining("Local macOS 15+") })
    expect(osMajor(" 10.0.26200 ")).toBe(10)
    expect(osMajor("10.0.26200.1")).toBe(10)
    expect(osMajor("Windows 11")).toBeNaN()
  })

  // The installed helper is copied into user projects and cannot import this
  // package, so its floor table is a copy. This is the test that keeps the copy honest.
  it("keeps the installed helper's floor table in lock-step with this one", () => {
    const shape = (table: Record<string, { name: string; minMajor: number }>) =>
      Object.fromEntries(Object.entries(table).map(([platform, floor]) => [platform, { name: floor.name, minMajor: floor.minMajor }]))
    expect(shape(HELPER_FLOORS as never)).toEqual(shape(ASIDE_HOST_FLOORS as never))
  })

  it("replaces one oversized gap with a counted recoverable marker", () => {
    const huge = makeGap({ ...base, sourceUrls: Array.from({ length: 20 }, (_, index) => `https://example.test/${index}?value=${"X".repeat(1000)}`), reason: "r".repeat(1900), evidenceNeeded: ["e".repeat(900)] })
    const bounded = boundFollowupEnvelope({ schemaVersion: "1.0", gaps: [huge], pending: false }, 2000)
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(2000)
    expect(bounded.gaps).toEqual([expect.objectContaining({ originTool: "followup_envelope" })])
    expect(bounded.omittedGapCount).toBe(1)
    expect(bounded.pending).toBe(true)
  })

  it("never turns omitted evidence or tasks into a successful assessment", () => {
    const evidence = Array.from({ length: 4 }, (_, index) => ({
      taskId: `task_${index}`, requestedUrl: "https://example.test/source", finalUrl: "https://example.test/source",
      sourcePublisher: "Publisher", observedTitle: "T".repeat(600), retrievedAt: "2026-09-10T00:00:00.000Z",
      extractionMethod: "browser_text" as const, passage: "P".repeat(5000), locator: { paragraph: "1" },
      coverage: { status: "original_body" as const }, acquisition: "host_or_aside_supplied" as const,
    }))
    const bounded = boundFollowupEnvelope({ schemaVersion: "1.0", gaps: [], evidence, pending: false }, 2000)
    expect(bounded.omittedEvidenceCount).toBeGreaterThan(0)
    expect(bounded.pending).toBe(true)
    expect(bounded.notices?.join(" ")).toContain("cannot be treated as a successful assessment")
  })

  it("bounds combined escaped text, structured data and existing omissions", () => {
    const gap = makeGap({ ...base, reason: "blocked", evidenceNeeded: ["body"] })
    const response = boundToolResponse({
      content: [{ type: "text", text: `\\\"\n`.repeat(5000) }],
      isError: true,
      structuredContent: { followup: { schemaVersion: "1.0", gaps: [gap], pending: true, omittedGapCount: 7 } },
    }, "test_tool", 3000)
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(3000)
    expect(response.structuredContent?.followup.pending).toBe(true)
    expect(response.structuredContent?.followup.omittedGapCount).toBeGreaterThanOrEqual(7)
    expect(response.structuredContent?.followup.gaps.some((item) => item.kind === "truncated")).toBe(true)
    expect(response.isError).toBe(true)
  })
})

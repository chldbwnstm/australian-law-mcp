/**
 * Chain deadline + partial results
 *
 * Parallelism cannot cap the upstream tail — the same query has been measured
 * finishing in 12 seconds and in 71. Past the 60-second client limit the user
 * gets **nothing**. When time runs out we assemble what did arrive and leave a
 * marker, not silence, where something did not.
 *
 * Every delay here is mocked — no real upstream is waited on.
 */
import { describe, it, expect } from "vitest"
import {
  DEFAULT_CHAIN_DEADLINE_MS,
  resolveChainDeadlineMs,
  startChainDeadline,
  raceDeadline,
  timedOutSection,
  timedOutChainNotice,
} from "./chain-deadline.js"

/** A branch that never settles on its own — the deadline has to cut it */
const never = <T>(): Promise<T> => new Promise<T>(() => {})
const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), ms))

describe("deadline value", () => {
  it("defaults comfortably below the client limit (60s)", () => {
    expect(DEFAULT_CHAIN_DEADLINE_MS).toBeLessThanOrEqual(45_000)
    expect(DEFAULT_CHAIN_DEADLINE_MS).toBeGreaterThan(10_000)
  })

  it("is adjustable through the environment", () => {
    expect(resolveChainDeadlineMs({ MCP_CHAIN_DEADLINE_MS: "20000" })).toBe(20_000)
    expect(resolveChainDeadlineMs({})).toBe(DEFAULT_CHAIN_DEADLINE_MS)
  })

  it("rejects non-integer and out-of-range values", () => {
    expect(() => resolveChainDeadlineMs({ MCP_CHAIN_DEADLINE_MS: "20x" })).toThrow()
    expect(() => resolveChainDeadlineMs({ MCP_CHAIN_DEADLINE_MS: "-1" })).toThrow()
    expect(() => resolveChainDeadlineMs({ MCP_CHAIN_DEADLINE_MS: "1" })).toThrow()
    expect(() => resolveChainDeadlineMs({ MCP_CHAIN_DEADLINE_MS: "999999999" })).toThrow()
  })
})

describe("partial result assembly", () => {
  it("keeps the value of a branch that finished in time and marks only the one that did not", async () => {
    const d = startChainDeadline(60)
    try {
      const [fast, slow] = await Promise.all([
        raceDeadline(d, after(5, "completed section")),
        raceDeadline(d, never<string>()),
      ])
      expect(fast).toEqual({ ok: true, value: "completed section" })
      expect(slow.ok).toBe(false)
    } finally {
      d.dispose()
    }
  })

  it("cancels in-flight requests once the deadline passes — no dangling sockets", async () => {
    const d = startChainDeadline(30)
    try {
      expect(d.signal.aborted).toBe(false)
      await raceDeadline(d, never<string>())
      expect(d.signal.aborted).toBe(true)
      expect(d.expired()).toBe(true)
    } finally {
      d.dispose()
    }
  })

  it("does not swallow a branch failure that happens before the deadline", async () => {
    const d = startChainDeadline(5_000)
    try {
      await expect(raceDeadline(d, Promise.reject(new Error("upstream parse failure"))))
        .rejects.toThrow("upstream parse failure")
    } finally {
      d.dispose()
    }
  })

  it("treats a failure after the deadline as a timeout", async () => {
    const d = startChainDeadline(20)
    try {
      const work = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("aborted")), 60))
      expect((await raceDeadline(d, work)).ok).toBe(false)
    } finally {
      d.dispose()
    }
  })
})

describe("incomplete-section marker", () => {
  it("says what is missing and how to get it, instead of staying silent", () => {
    const s = timedOutSection("Related case law", "search_case_law")
    expect(s).toContain("Related case law")
    expect(s).toContain("time limit")
    expect(s).toContain("search_case_law")
  })

  // A prefix (groundwork) expiry is not per-section but "everything from here
  // on", so it needs its own marker.
  it("states the cause and the next action for a prefix expiry too", () => {
    const s = timedOutChainNotice()
    expect(s).toContain("time limit")
    expect(s).toContain("individual tools")
  })
})

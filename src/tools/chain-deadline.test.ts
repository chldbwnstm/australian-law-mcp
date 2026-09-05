/**
 * Chain deadline + partial results
 *
 * Parallelism cannot cap the upstream tail — the same query has been measured
 * finishing in 12 seconds and in 71. Past the 60-second client limit the user
 * gets **nothing**. When time runs out we assemble what did arrive and leave a
 * marker, not silence, where something did not.
 *
 * Expiry is the one wall-clock event in a chain, so it is driven by hand here
 * through `createManualChainClock()`: "the branch answered" and "the limit
 * passed" must not be a race the machine adjudicates. Exactly one test below
 * still uses the real timer, and it is the one asserting that production still
 * has one.
 */
import { afterEach, describe, it, expect } from "vitest"
import {
  DEFAULT_CHAIN_DEADLINE_MS,
  createManualChainClock,
  resolveChainDeadlineMs,
  setChainDeadlineTimer,
  startChainDeadline,
  raceDeadline,
  timedOutSection,
  timedOutChainNotice,
  type ManualChainClock,
} from "./chain-deadline.js"

/** A branch that never settles on its own — the deadline has to cut it */
const never = <T>(): Promise<T> => new Promise<T>(() => {})

let installed: ManualChainClock | undefined
function manualClock(): ManualChainClock {
  installed = createManualChainClock()
  return installed
}

afterEach(() => {
  installed?.restore()
  installed = undefined
})

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

describe("the timer seam", () => {
  it("still arms a real timer when nothing is installed — production keeps its wall clock", async () => {
    // The one wall-clock test in the file, and the reason the seam is safe: if
    // a future change left `setChainDeadlineTimer` installed, or wired
    // `startChainDeadline` to a timer that is never armed, no deadline would
    // ever fire in production and this would hang rather than pass quietly.
    const d = startChainDeadline(10)
    try {
      expect((await raceDeadline(d, never<string>())).ok).toBe(false)
      expect(d.expired()).toBe(true)
    } finally {
      d.dispose()
    }
  })

  it("hands the limit to the test, with no clock involved", () => {
    const clock = manualClock()
    const d = startChainDeadline(45_000)
    try {
      expect(clock.armed).toBe(1)
      expect(d.expired()).toBe(false)
      expect(d.signal.aborted).toBe(false)

      clock.expire()

      expect(d.expired()).toBe(true)
      expect(d.signal.aborted).toBe(true)
      expect(clock.armed).toBe(0)
    } finally {
      d.dispose()
    }
  })

  it("counts a disposed deadline as no longer waiting on time", () => {
    const clock = manualClock()
    const d = startChainDeadline(45_000)
    expect(clock.armed).toBe(1)
    d.dispose()
    expect(clock.armed).toBe(0)
    // Firing an empty clock is a no-op, not a crash: a chain that finished
    // early must not be abortable after the fact.
    clock.expire()
    expect(d.expired()).toBe(false)
    expect(d.signal.aborted).toBe(false)
  })

  it("arms the timer with the limit that was configured, not a fixed one", () => {
    // The seam's one real hazard: a deadline that is armed with the wrong
    // duration still fires, so nothing else here would notice that
    // MCP_CHAIN_DEADLINE_MS had quietly stopped reaching the timer.
    const armedWith: number[] = []
    const restore = setChainDeadlineTimer((_fire, ms) => {
      armedWith.push(ms)
      return () => {}
    })
    const previous = process.env.MCP_CHAIN_DEADLINE_MS
    try {
      process.env.MCP_CHAIN_DEADLINE_MS = "20000"
      startChainDeadline().dispose()
      delete process.env.MCP_CHAIN_DEADLINE_MS
      startChainDeadline().dispose()
      startChainDeadline(7_000).dispose()
      expect(armedWith).toEqual([20_000, DEFAULT_CHAIN_DEADLINE_MS, 7_000])
    } finally {
      if (previous === undefined) delete process.env.MCP_CHAIN_DEADLINE_MS
      else process.env.MCP_CHAIN_DEADLINE_MS = previous
      restore()
    }
  })

  it("restores the real timer, so one file's clock never leaks into another's", async () => {
    const restore = setChainDeadlineTimer(() => () => {})
    restore()
    const d = startChainDeadline(10)
    try {
      expect((await raceDeadline(d, never<string>())).ok).toBe(false)
    } finally {
      d.dispose()
    }
  })
})

describe("partial result assembly", () => {
  it("keeps the value of a branch that finished in time and marks only the one that did not", async () => {
    const clock = manualClock()
    const d = startChainDeadline(45_000)
    try {
      const fastLeg = raceDeadline(d, Promise.resolve("completed section"))
      const slowLeg = raceDeadline(d, never<string>())
      // The fast branch settles on the microtask queue; only then does the
      // limit pass. Ordering by construction, not by measurement.
      const fast = await fastLeg
      clock.expire()
      const slow = await slowLeg

      expect(fast).toEqual({ ok: true, value: "completed section" })
      expect(slow.ok).toBe(false)
    } finally {
      d.dispose()
    }
  })

  it("cancels in-flight requests once the deadline passes — no dangling sockets", async () => {
    const clock = manualClock()
    const d = startChainDeadline(45_000)
    try {
      expect(d.signal.aborted).toBe(false)
      const leg = raceDeadline(d, never<string>())
      clock.expire()
      await leg
      expect(d.signal.aborted).toBe(true)
      expect(d.expired()).toBe(true)
    } finally {
      d.dispose()
    }
  })

  it("does not swallow a branch failure that happens before the deadline", async () => {
    // The clock is installed and never fired: "before the deadline" is then a
    // fact of construction rather than a bet that five seconds of wall clock
    // outlast a rejection. With a real timer armed, a machine slow enough to
    // cross the limit first would turn this assertion into a timeout — the one
    // flake the rest of the file was rewritten to remove.
    manualClock()
    const d = startChainDeadline(5_000)
    try {
      await expect(raceDeadline(d, Promise.reject(new Error("upstream parse failure"))))
        .rejects.toThrow("upstream parse failure")
    } finally {
      d.dispose()
    }
  })

  it("treats a failure after the deadline as a timeout", async () => {
    const clock = manualClock()
    const d = startChainDeadline(45_000)
    try {
      let fail: (error: Error) => void = () => {}
      const work = new Promise<string>((_, reject) => { fail = reject })
      const leg = raceDeadline(d, work)
      clock.expire()
      fail(new Error("aborted"))
      expect((await leg).ok).toBe(false)
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

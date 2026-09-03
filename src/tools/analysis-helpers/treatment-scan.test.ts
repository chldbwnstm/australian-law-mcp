import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { findCaseAliases, hasOverrulingSignal, scanTreatment } from "./treatment-scan.js"

const OVERRULING = readFileSync(new URL("../__fixtures__/nsw-decision-overruling.html", import.meta.url), "utf8")

describe("findCaseAliases", () => {
  it("harvests the short name a judgment defines for a case", () => {
    const body = "The applicant relies on Dela Cruz v R [2010] NSWCCA 333 ('the earlier decision') for that."
    expect(findCaseAliases(body, "[2010] NSWCCA 333")).toContain("the earlier decision")
  })

  it("returns nothing when no short name is defined", () => {
    expect(findCaseAliases("See [2010] NSWCCA 333 at [14].", "[2010] NSWCCA 333")).toEqual([])
  })
})

describe("scanTreatment", () => {
  it("finds overruling language near the citation in a real-shaped judgment", () => {
    const scan = scanTreatment(OVERRULING, "[2010] NSWCCA 333")
    expect(scan.mentions).toBeGreaterThan(0)
    expect(hasOverrulingSignal(scan)).toBe(true)
    expect(scan.signals.map((signal) => signal.label)).toEqual(
      expect.arrayContaining(["overruled", "wrongly decided", "should not be followed"]),
    )
  })

  it("notes the dissent and plurality language in the same passage", () => {
    const scan = scanTreatment(OVERRULING, "[2010] NSWCCA 333")
    expect(scan.signals.some((signal) => signal.nearDissent)).toBe(true)
    expect(scan.signals.some((signal) => signal.nearPlurality)).toBe(true)
  })

  it("follows the alias the judgment defined, not only the citation", () => {
    const body =
      "The applicant relies on Dela Cruz v R [2010] NSWCCA 333 ('the earlier decision'). " +
      "Much later in these reasons, and far from any citation, we hold that the earlier decision is overruled."
    expect(hasOverrulingSignal(scanTreatment(body, "[2010] NSWCCA 333"))).toBe(true)
  })

  it("ignores overruling language that is about some other case", () => {
    const body =
      "We applied [2010] NSWCCA 333 without difficulty. " +
      "x".repeat(900) +
      " Quite separately, Smith v Jones [1999] NSWCA 1 is overruled."
    const scan = scanTreatment(body, "[2010] NSWCCA 333")
    expect(scan.mentions).toBe(1)
    expect(hasOverrulingSignal(scan)).toBe(false)
  })

  it("classifies distinguishing as doubting, never as overruling", () => {
    const scan = scanTreatment("The judge distinguished [2010] NSWCCA 333 on the facts.", "[2010] NSWCCA 333")
    expect(scan.signals.map((signal) => signal.kind)).toEqual(["doubting"])
    expect(hasOverrulingSignal(scan)).toBe(false)
  })

  it("reports no mentions when the case is not discussed at all", () => {
    const scan = scanTreatment("A judgment about something else entirely.", "[2010] NSWCCA 333")
    expect(scan.mentions).toBe(0)
    expect(scan.signals).toEqual([])
  })
})

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseNcx } from "../../lib/ncx-parser.js"
import { parseSectionRef } from "../../lib/section-ref.js"
import { bestHeadingMatch, numberOfLabel, provisionRangeHint, refStringForEntry, scheduleOf } from "./heading-index.js"

const ENTRIES = parseNcx(readFileSync(new URL("../__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))
const bodyS18 = ENTRIES.find((entry) => entry.label.startsWith("18 ") && !scheduleOf(entry))!
const aclS18 = ENTRIES.find((entry) => entry.label.startsWith("18 ") && scheduleOf(entry))!

describe("label reading", () => {
  it("reads the provision number off a numbered navLabel", () => {
    expect(numberOfLabel("18  Meetings of Commission")).toBe("18")
    expect(numberOfLabel("Part 2-1—Misleading or deceptive conduct")).toBeUndefined()
  })

  it("finds the schedule a navPoint sits inside, with its name", () => {
    expect(scheduleOf(aclS18)).toEqual({ number: "2", name: "Australian Consumer Law" })
    expect(scheduleOf(bodyS18)).toBeUndefined()
  })

  it("writes the AGLC pinpoint for an entry, schedule prefix included", () => {
    expect(refStringForEntry(bodyS18)).toBe("s 18")
    expect(refStringForEntry(aclS18)).toBe("sch 2 s 18")
  })
})

describe("bestHeadingMatch", () => {
  it("points from the misleading-conduct claim to the ACL provision", () => {
    const match = bestHeadingMatch(ENTRIES, "misleading or deceptive conduct", bodyS18)
    expect(match?.ref).toBe("sch 2 s 18")
    expect(match?.scheduleName).toBe("Australian Consumer Law")
    expect(match?.heading).toBe("Misleading or deceptive conduct")
  })

  it("excludes the provision already cited, so a match is always a redirect", () => {
    expect(bestHeadingMatch(ENTRIES, "meetings of commission", bodyS18)?.entry).not.toBe(bodyS18)
  })

  it("returns nothing when no heading in the Act matches the claim", () => {
    expect(bestHeadingMatch(ENTRIES, "compulsory acquisition of pastoral leases", bodyS18)).toBeUndefined()
  })
})

describe("provisionRangeHint", () => {
  it("describes the body's range and the nearest entries", () => {
    const hint = provisionRangeHint(ENTRIES, parseSectionRef("s 4242")!)
    expect(hint).toContain("the body of the Act runs from s")
    expect(hint).toContain("Nearest entries:")
    expect(hint).toContain("Meetings of Commission")
  })

  it("scopes the range to a schedule when the reference names one", () => {
    const hint = provisionRangeHint(ENTRIES, parseSectionRef("sch 2 s 4242")!)
    expect(hint).toContain("schedule 2 runs from s")
    expect(hint).toContain("Misleading or deceptive conduct")
  })

  it("says plainly when a schedule has no numbered provisions in the table", () => {
    expect(provisionRangeHint(ENTRIES, parseSectionRef("sch 9 s 1")!)).toContain("no numbered provisions in schedule 9")
  })
})

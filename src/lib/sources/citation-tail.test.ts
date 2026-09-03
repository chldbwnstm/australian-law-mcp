import { describe, expect, it } from "vitest"
import { isMediumNeutral, splitTrailingCitation } from "./citation-tail.js"

describe("splitTrailingCitation", () => {
  it("splits a medium-neutral citation", () => {
    expect(splitTrailingCitation("Dela Cruz v R [2010] NSWCCA 333")).toEqual({
      title: "Dela Cruz v R",
      citation: "[2010] NSWCCA 333",
    })
  })

  it("splits a year-as-volume report citation without mistaking the volume for a court", () => {
    expect(splitTrailingCitation("White v Patterson [2010] 2 Qd R 591")).toEqual({
      title: "White v Patterson",
      citation: "[2010] 2 Qd R 591",
    })
  })

  it("splits a volume-first report citation", () => {
    expect(splitTrailingCitation("Mabo v Queensland (No 2) (1992) 175 CLR 1")).toEqual({
      title: "Mabo v Queensland (No 2)",
      citation: "(1992) 175 CLR 1",
    })
  })

  it("trims a dash separator, as the FWC listing uses", () => {
    expect(splitTrailingCitation("Werner v BHPM Enterprises - [2014] FWC 3013")).toEqual({
      title: "Werner v BHPM Enterprises",
      citation: "[2014] FWC 3013",
    })
  })

  it("keeps an unrecognised title whole rather than dropping the hit", () => {
    expect(splitTrailingCitation("Re an application by Smith")).toEqual({
      title: "Re an application by Smith",
    })
  })

  it("treats a bare citation as its own title", () => {
    expect(splitTrailingCitation("[2020] HCA 41")).toEqual({
      title: "[2020] HCA 41",
      citation: "[2020] HCA 41",
    })
  })
})

describe("isMediumNeutral", () => {
  it("accepts an MNC and rejects report citations", () => {
    expect(isMediumNeutral("[2020] QSC 100")).toBe(true)
    expect(isMediumNeutral("[2010] 2 Qd R 591")).toBe(false)
    expect(isMediumNeutral("(1992) 175 CLR 1")).toBe(false)
    expect(isMediumNeutral(undefined)).toBe(false)
  })
})

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { mapTreaty, parseSearchResponse } from "./dfat-treaties.js"

const RAW = JSON.parse(
  readFileSync(new URL("./__fixtures__/dfat-search-extradition.json", import.meta.url), "utf-8"),
) as unknown

const result = parseSearchResponse(RAW, "https://docs.dfat.gov.au/api/search")

describe("parseSearchResponse — recorded POST /api/search", () => {
  it("keeps the API's own paging figures", () => {
    expect(result.total).toBe(177)
    expect(result.page).toBe(1)
    expect(result.totalPages).toBe(9)
  })

  it("maps the 40-field record down to the fields that identify a treaty", () => {
    const record = result.records[0]
    expect(record.title).toBe("Treaty on Extradition between Australia and the United Arab Emirates")
    expect(record.id).toBe("3030")
    expect(record.atsNumber).toBe("[2011] ATS 29")
    expect(record.status).toBe("In force")
    expect(record.agreementType).toBe("Bilateral")
    expect(record.countries).toEqual(["United Arab Emirates"])
    expect(record.subject).toBe("Extradition")
  })

  it("shortens ISO timestamps to dates", () => {
    const record = result.records[0]
    expect(record.doneAtDate).toBe("2007-07-26")
    expect(record.entryIntoForceForAustralia).toBe("2011-09-07")
  })

  it("keeps the treaty-action history", () => {
    expect(result.records[0].actions).toEqual([{ date: "2011-08-08", action: "Ratification" }])
  })

  it("uses the AustLII ATS link as the hit URL, since that is what a human can open", () => {
    expect(result.hits[0].url).toBe("https://www.austlii.edu.au/au/other/dfat/treaties/ATS/2011/29.html")
    expect(result.hits[0].citation).toBe("[2011] ATS 29")
  })

  it("summarises status, type, parties and subject on the hit", () => {
    expect(result.hits[0].extra).toEqual([
      ["Status (Australia)", "In force"],
      ["Type", "Bilateral"],
      ["Parties", "United Arab Emirates"],
      ["Subject", "Extradition"],
    ])
  })
})

describe("mapTreaty", () => {
  it("treats the string 'None' as absent — the API uses it for empty fields", () => {
    const record = mapTreaty({ Title: "T", Id: 1, Depositary: "None", Subject: "  " })
    expect(record?.depositary).toBeUndefined()
    expect(record?.subject).toBeUndefined()
  })

  it("drops a row with no title or id rather than inventing one", () => {
    expect(mapTreaty({ Title: "T" })).toBeUndefined()
    expect(mapTreaty(null)).toBeUndefined()
  })

  it("survives a missing actions array", () => {
    expect(mapTreaty({ Title: "T", Id: 1 })?.actions).toEqual([])
  })
})

describe("empty responses", () => {
  it("returns no hits without throwing when the API answers with nothing", () => {
    const empty = parseSearchResponse({ totalCount: 0, results: [] }, "u")
    expect(empty.hits).toEqual([])
    expect(empty.total).toBe(0)
  })
})

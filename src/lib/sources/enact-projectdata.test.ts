import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ErrorCodes, LawApiError } from "../errors.js"
import {
  assertRegisterId,
  buildExpression,
  parseRecords,
  sanitiseTerm,
  unwrap,
  wholeTextPath,
} from "./enact-projectdata.js"

const json = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")) as unknown

const QLD = json("qld-projectdata-search.json")
const TAS = json("tas-projectdata-search.json")

describe("unwrap", () => {
  it("unwraps the {__type__,__value__} envelope", () => {
    expect(unwrap({ __type__: "UniString", __value__: "Act-2000-005" })).toBe("Act-2000-005")
    expect(unwrap({ __type__: "Integer", __value__: 1796 })).toBe(1796)
  })

  it("passes plain values through", () => {
    expect(unwrap("2012-01-30T00:00:00")).toBe("2012-01-30T00:00:00")
    expect(unwrap(null)).toBeNull()
  })
})

describe("buildExpression", () => {
  it("pins Queensland's reprint type but not Tasmania's", () => {
    expect(buildExpression("QLD", { query: "murder" })).toBe(
      'Repealed=N AND PrintType="act.reprint" AND Content=(murder)',
    )
    expect(buildExpression("TAS", { query: "dog" })).toBe("Repealed=N AND Content=(dog)")
  })

  it("drops the Repealed clause when repealed law is wanted", () => {
    expect(buildExpression("TAS", { query: "dog", includeRepealed: true })).toBe("Content=(dog)")
  })

  it("supports the other CCL fields", () => {
    expect(buildExpression("TAS", { query: "dog", field: "Title" })).toContain("Title=(dog)")
  })
})

describe("sanitiseTerm", () => {
  it("removes characters that would change the CCL expression's structure", () => {
    // There is no escape sequence in this grammar, so a stray bracket would
    // silently turn the query into a different boolean.
    expect(sanitiseTerm('murder) OR PrintType="x"')).toBe("murder OR PrintType x")
  })

  it("collapses whitespace", () => {
    expect(sanitiseTerm("  a   b ")).toBe("a b")
  })
})

describe("parseRecords — recorded Queensland full-text search", () => {
  const { total, records } = parseRecords(QLD)

  it("reads the wrapped total", () => {
    expect(total).toBe(1796)
  })

  it("unwraps every field of a record", () => {
    const first = records[0]
    expect(first.id).toBe("Act-2000-005")
    expect(first.title).toBe("Police Powers and Responsibilities Act 2000")
    expect(first.year).toBe(2000)
    expect(first.number).toBe("5")
    expect(first.printType).toBe("act.reprint")
    expect(first.repealed).toBe(false)
    expect(first.publicationDate).toBe("2012-01-30")
    expect(first.versionSeriesId).toBe("13728c9a-0e6c-41c2-8090-97af5880885b")
  })
})

describe("parseRecords — recorded Tasmanian full-text search", () => {
  const { total, records } = parseRecords(TAS)

  it("handles Tasmania's lower-case ids", () => {
    expect(total).toBe(1191)
    expect(records[0].id).toBe("act-1884-019")
    expect(records[0].title).toBe("Conveyancing and Law of Property Act 1884")
  })
})

describe("parseRecords — defensive", () => {
  it("returns nothing rather than throwing on an unexpected envelope", () => {
    expect(parseRecords({}).records).toEqual([])
    expect(parseRecords(null).records).toEqual([])
    expect(parseRecords({ data: [{ nope: 1 }] }).records).toEqual([])
  })
})

describe("wholeTextPath", () => {
  it("lower-cases the id and uses /view/whole/ (the plain /view/html/ path is a JS shell)", () => {
    expect(wholeTextPath("Act-2000-005")).toBe("view/whole/html/inforce/current/act-2000-005")
  })

  it("accepts every id shape the two registers publish", () => {
    expect(wholeTextPath("act-1884-019")).toBe("view/whole/html/inforce/current/act-1884-019")
    expect(wholeTextPath(" Act-1899-009 ")).toBe("view/whole/html/inforce/current/act-1899-009")
    expect(wholeTextPath("sl-2011-0045")).toBe("view/whole/html/inforce/current/sl-2011-0045")
  })

  it("refuses an id that would rewrite the request rather than name a record", () => {
    // The id is one path segment. `act-1899-009?view=full#top` would send a
    // query string and drop the fragment, and the page that came back would
    // still be reported under the register id that was asked for.
    for (const bad of [
      "act-1899-009?view=full#top",
      "act-1899-009/../../secret",
      "act 1899 009",
      "..",
      "%2e%2e%2fadmin",
      "",
    ]) {
      try {
        wholeTextPath(bad)
        throw new Error(`should have thrown for ${JSON.stringify(bad)}`)
      } catch (error) {
        expect((error as { code?: string }).code).toBe("INVALID_PARAMETER")
      }
    }
  })
})

describe("assertRegisterId", () => {
  it("names the shape it wants instead of asserting the record is absent", () => {
    const error = (() => {
      try {
        assertRegisterId("act-1899-009?view=full")
      } catch (e) {
        return e as LawApiError
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(LawApiError)
    expect(error?.code).toBe(ErrorCodes.INVALID_PARAM)
    expect(error?.suggestions.join(" ")).toMatch(/act-1899-009/)
  })
})

import { describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { LAW_ALIAS_ENTRIES } from "../lib/law-alias.js"
import { getLawAbbreviations, parseSectionRefTool } from "./utils.js"

/** Both tools are offline; the client argument exists only to keep one signature. */
const OFFLINE = {} as unknown as AuApiClient

const parseResult = (text: string, mode: "parse" | "extract" | "explain" = "parse") =>
  parseSectionRefTool(OFFLINE, { text, mode } as never)

const parse = async (text: string, mode: "parse" | "extract" | "explain" = "parse") =>
  (await parseResult(text, mode)).content[0].text

const abbrev = async (input: Record<string, unknown>) =>
  (await getLawAbbreviations(OFFLINE, input as never)).content[0].text

describe("parse_section_ref", () => {
  it("keeps the schedule prefix, which is the whole point", async () => {
    const text = await parse("sch 2 s 18")
    expect(text).toContain("AGLC form:  sch 2 s 18")
    expect(text).toContain("Schedule:   2")
  })

  it("normalises the spaceless form on input but never emits it", async () => {
    expect(await parse("s18")).toContain("AGLC form:  s 18")
  })

  it("distinguishes an ITAA section number from a range", async () => {
    expect(await parse("s 355-25")).toContain("AGLC form:  s 355-25")
    expect(await parse("ss 5-6")).toContain("Range end:  6")
  })

  it("explains why sch 2 s 18 is not s 18, with the CCA example", async () => {
    const text = await parse("sch 2 s 18", "explain")
    expect(text).toContain("It is not section 18 of the Act's body")
    expect(text).toContain("Meetings of Commission")
    expect(text).toContain("misleading or deceptive")
  })

  it("warns an unqualified reference that it addresses the body", async () => {
    const text = await parse("s 18", "explain")
    expect(text).toContain("addresses section 18 of the Act's BODY")
    expect(text).toContain("get_schedules")
  })

  it("extracts every reference from prose, in order", async () => {
    const text = await parse("Breach of s 18 and pt IVA, plus sch 2 s 29(1).", "extract")
    expect(text).toContain("s 18")
    expect(text).toContain("pt IVA")
    expect(text).toContain("sch 2 s 29(1)")
  })

  it("refuses to guess at prose that is not a reference", async () => {
    const result = await parseResult("the bit about advertising")
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[INVALID_PARAMETER]")
    expect(result.content[0].text).toContain("Nothing was guessed")
    expect(result.content[0].text).toContain("sch 2 s 18")
  })

  it("says so rather than returning an empty list when prose has no references", async () => {
    const result = await parseResult("There is nothing citable in this sentence.", "extract")
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[NOT_FOUND]")
    expect(result.content[0].text).toContain("designation word is required")
  })
})

describe("get_law_abbreviations", () => {
  it("lists the table grouped by jurisdiction", async () => {
    const text = await abbrev({})
    expect(text).toContain("── Cth")
    expect(text).toContain(`of ${LAW_ALIAS_ENTRIES.length} entries`)
  })

  it("filters by fragment across abbreviation and official title", async () => {
    const text = await abbrev({ filter: "consumer" })
    expect(text).toContain("Competition and Consumer Act 2010")
    expect(text).not.toContain("Fair Work Act 2009")
  })

  it("resolves an abbreviation exactly as the search tools would, with its caveat", async () => {
    const text = await abbrev({ resolve: "ACL" })
    expect(text).toContain("Competition and Consumer Act 2010 (Cth), sch 2 [C2004A00109]")
    expect(text).toContain("ACL s 18 (misleading or deceptive conduct) is NOT CCA s 18")
    expect(text).toContain('Search text the tools would use upstream: "Competition and Consumer Act 2010"')
  })

  it("flags a cross-jurisdiction ambiguity instead of choosing", async () => {
    const text = await abbrev({ resolve: "Evidence Act" })
    expect(text).toContain("⚠️ AMBIGUOUS across jurisdictions")
    expect(text).toContain("(NSW)")
  })

  it("says a resolve miss is a gap in the table, not evidence about the law", async () => {
    const text = await abbrev({ resolve: "Zzzq Act" })
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("NOT evidence that no such Act exists")
  })

  it("errors, with the same caveat, when a filter matches nothing", async () => {
    const result = await getLawAbbreviations(OFFLINE, { filter: "zzzq" } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("not evidence about the law")
  })

  it("marks entries that name a body rather than a statute", async () => {
    expect(await abbrev({ filter: "OAIC" })).toContain("a body/agency, not a statute")
  })
})

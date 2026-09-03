import { describe, expect, it } from "vitest"
import { getExternalLinks, type GetExternalLinksInput } from "./external-links.js"

const run = (input: GetExternalLinksInput) => getExternalLinks(null, input)
const textOf = (response: { content: Array<{ text: string }> }) => response.content[0].text

describe("input validation", () => {
  it("needs at least one addressable thing", async () => {
    const response = await run({})
    expect(response.isError).toBe(true)
    expect(textOf(response)).toContain("[INVALID_PARAMETER]")
  })
})

describe("statute links", () => {
  it("resolves an alias to the Federal Register human page", async () => {
    const text = textOf(await run({ law: "CCA" }))
    expect(text).toContain("Statute: Competition and Consumer Act 2010")
    expect(text).toContain("https://www.legislation.gov.au/C2004A00109/latest/text")
  })

  it("uses a compilation date when one is given", async () => {
    const text = textOf(await run({ titleId: "C2004A00109", date: "2015-06-30" }))
    expect(text).toContain("https://www.legislation.gov.au/C2004A00109/2015-06-30/text")
  })

  it("warns instead of picking a jurisdiction for an ambiguous alias", async () => {
    const text = textOf(await run({ law: "Evidence Act" }))
    expect(text).toContain("resolves in")
    expect(text).toContain("jurisdictions")
    expect(text).not.toContain("legislation.gov.au/C2004A04858")
  })

  it("warns that the ACL is schedule 2, so a bare section is a different provision", async () => {
    const text = textOf(await run({ law: "ACL", provision: "s 18" }))
    expect(text).toContain("schedule 2 of that Act")
    expect(text).toContain("sch 2 s 18")
  })

  it("normalises the provision reference in the heading", async () => {
    expect(textOf(await run({ law: "CCA", provision: "s18" }))).toContain("Competition and Consumer Act 2010 s 18")
  })

  it("builds an AustLII section URL only from a supplied slug", async () => {
    const withSlug = textOf(await run({ law: "CCA", provision: "s 18", austliiSlug: "caca2010265" }))
    expect(withSlug).toContain("consol_act/caca2010265/s18.html")

    const withoutSlug = textOf(await run({ law: "CCA", provision: "s 18" }))
    expect(withoutSlug).not.toContain("consol_act/")
    expect(withoutSlug).toContain("slug not supplied")
    expect(withoutSlug).toContain("sinosrch.cgi")
  })

  it("says an alias miss is not evidence the Act does not exist", async () => {
    const text = textOf(await run({ law: "Fictional Widgets Act 2099" }))
    expect(text).toContain("No verified Federal Register id")
    expect(text).toContain("not evidence the Act does not exist")
  })

  it("gives the NSW register base rather than a fabricated act-YYYY-NNN path", async () => {
    const text = textOf(await run({ law: "LEPRA" }))
    expect(text).toContain("https://legislation.nsw.gov.au")
    expect(text).not.toMatch(/act-\d{4}-\d{3}/)
  })
})

describe("case links", () => {
  it("builds AustLII, LawCite and High Court links for an HCA citation", async () => {
    const text = textOf(await run({ citation: "[2020] HCA 41" }))
    expect(text).toContain("cgi-bin/viewdoc/au/cases/cth/HCA/2020/41.html")
    expect(text).toContain("lawcite.austlii.edu.au/cgi-bin/LawCite?cit=")
    expect(text).toContain("hcourt.gov.au/cases-and-judgments")
  })

  it("adds the Federal Court judgment page for an FCA citation", async () => {
    expect(textOf(await run({ citation: "[2020] FCA 1" }))).toContain("/judgments/Judgments/fca/single/2020/2020fca0001")
  })

  it("adds Queensland Judgments for a Queensland court", async () => {
    const text = textOf(await run({ citation: "[2020] QSC 100" }))
    expect(text).toContain("queenslandjudgments.com.au/caselaw/qsc/2020/100")
    expect(text).toContain("/pdf")
  })

  it("explains the NSW decision-id addressing instead of guessing a URL", async () => {
    const text = textOf(await run({ citation: "[2019] NSWCA 7" }))
    expect(text).toContain("24-character id")
    expect(text).not.toContain("caselaw.nsw.gov.au/decision/")
  })

  it("uses a supplied NSW decision id when there is one", async () => {
    const text = textOf(await run({ citation: "[2019] NSWCA 7", nswDecisionId: "5c4f9d64e4b0196355264f2c" }))
    expect(text).toContain("caselaw.nsw.gov.au/decision/5c4f9d64e4b0196355264f2c")
  })

  it("notes when the court stopped allocating citations, without implying the case is gone", async () => {
    const text = textOf(await run({ citation: "[2015] AATA 100" }))
    expect(text).toContain("stopped allocating medium-neutral citations")
    expect(text).toContain("remain citable")
  })

  it("handles a reported citation by pointing at the citator rather than inventing a document URL", async () => {
    const text = textOf(await run({ citation: "(1992) 175 CLR 1" }))
    expect(text).toContain("Report series are not free-text addressable")
    expect(text).toContain("LawCite")
    expect(text).not.toContain("viewdoc/au/cases")
  })

  it("guesses nothing from an unparseable citation", async () => {
    const text = textOf(await run({ citation: "the Mabo case" }))
    expect(text).toContain("Citation not parsed")
    expect(text).not.toContain("viewdoc/au/cases")
  })
})

describe("registers and the blocked-host notice", () => {
  it("links an ATO document by DocID", async () => {
    expect(textOf(await run({ atoDocId: "TXR/TR20065/NAT/ATO/00001" }))).toContain("ato.gov.au/law/view/document?docid=")
  })

  it("adds the topic landing pages", async () => {
    expect(textOf(await run({ topic: "treaties" }))).toContain("australian-treaties-database")
    const competition = textOf(await run({ topic: "competition" }))
    expect(competition).toContain("accc.gov.au/public-registers")
    expect(competition).toContain("competitiontribunal.gov.au/decisions")
  })

  it("always closes by saying a refusal to fetch is not absence", async () => {
    const text = textOf(await run({ law: "CCA" }))
    expect(text).toContain("browser only")
    expect(text).toContain("Nothing about that refusal says the material is absent")
  })
})

import { describe, expect, it } from "vitest"
import {
  atoDocUrl,
  atoPdfUrl,
  austliiCaseUrl,
  austliiSearchUrl,
  austliiSectionUrl,
  fedCourtJudgmentUrl,
  frlHumanUrl,
  hcaJudgmentsUrl,
  lawCiteUrl,
  nswCaselawDecisionUrl,
  nswLegislationUrl,
  qldCaseUrl,
} from "./external-links-map.js"

describe("austliiCaseUrl", () => {
  const cases: Array<[string, number, number, string]> = [
    ["HCA", 2020, 41, "https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/HCA/2020/41.html"],
    ["FCAFC", 2024, 170, "https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/FCAFC/2024/170.html"],
    ["NSWCA", 2019, 7, "https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/nsw/NSWCA/2019/7.html"],
    ["VSCA", 2025, 315, "https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/vic/VSCA/2025/315.html"],
    ["QSC", 2020, 100, "https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/qld/QSC/2020/100.html"],
  ]
  it.each(cases)("%s %i %i", (court, year, num, expected) => {
    expect(austliiCaseUrl({ court, year, num })).toBe(expected)
  })

  it("returns null for an unknown court token instead of fabricating a URL", () => {
    expect(austliiCaseUrl({ court: "XYZZY", year: 2020, num: 1 })).toBeNull()
  })
})

describe("legislation links", () => {
  it("builds an AustLII section URL from a caller-supplied slug", () => {
    expect(austliiSectionUrl("caca2010265", "18")).toBe(
      "https://www.austlii.edu.au/cgi-bin/viewdoc/au/legis/cth/consol_act/caca2010265/s18.html",
    )
  })

  it("sanitises lettered sections", () => {
    expect(austliiSectionUrl("ma1958118", "18AA")).toContain("/s18aa.html")
  })

  it("addresses NSW legislation by year and padded number", () => {
    expect(nswLegislationUrl(1987, 68)).toBe(
      "https://legislation.nsw.gov.au/view/html/inforce/current/act-1987-068",
    )
  })

  it("builds FRL human URLs for latest and for a date", () => {
    expect(frlHumanUrl("C2004A00109")).toBe("https://www.legislation.gov.au/C2004A00109/latest/text")
    expect(frlHumanUrl("C2004A00109", "2015-06-30")).toBe(
      "https://www.legislation.gov.au/C2004A00109/2015-06-30/text",
    )
  })
})

describe("citator and search links", () => {
  it("encodes the citation for LawCite", () => {
    expect(lawCiteUrl("[2020] HCA 41")).toBe(
      "https://lawcite.austlii.edu.au/cgi-bin/LawCite?cit=%5B2020%5D%20HCA%2041",
    )
  })

  it("repeats mask_path for each database restriction", () => {
    const url = austliiSearchUrl("native title", ["au/cases/cth/HCA", "au/cases/cth/FCA"])
    expect(url).toContain("mask_path=au%2Fcases%2Fcth%2FHCA")
    expect(url).toContain("mask_path=au%2Fcases%2Fcth%2FFCA")
    expect(url).toContain("query=native+title")
  })

  it("keeps the HCA year facet brackets literal (the WAF 403s the encoded form)", () => {
    expect(hcaJudgmentsUrl({ year: 2020 })).toContain("f[0]=d:2020")
    expect(hcaJudgmentsUrl({ keywords: "native title" })).toContain("keywords=native%20title")
  })
})

describe("court and document links", () => {
  it("uses the Full Court directory while retaining FCAFC in the filename", () => {
    expect(fedCourtJudgmentUrl(2020, 130, "fcafc")).toBe(
      "https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/full/2020/2020fcafc0130",
    )
  })

  it("pads Federal Court judgment numbers to four digits", () => {
    expect(fedCourtJudgmentUrl(2020, 1)).toBe(
      "https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/single/2020/2020fca0001",
    )
  })

  it("lowercases the court for Queensland Judgments and offers a pdf variant", () => {
    expect(qldCaseUrl({ court: "QSC", year: 2020, num: 100 })).toBe(
      "https://www.queenslandjudgments.com.au/caselaw/qsc/2020/100",
    )
    expect(qldCaseUrl({ court: "QCA", year: 2019, num: 12 }, true)).toMatch(/\/caselaw\/qca\/2019\/12\/pdf$/)
  })

  it("builds ATO document and pdf URLs with the current PiT sentinel", () => {
    expect(atoDocUrl("TXR/TR20241/NAT/ATO/00001")).toBe(
      "https://www.ato.gov.au/law/view/document?docid=TXR%2FTR20241%2FNAT%2FATO%2F00001",
    )
    expect(atoPdfUrl("TXR/TR20241/NAT/ATO/00001")).toContain("PiT=99991231235958")
  })

  it("addresses NSW Caselaw decisions by hex id", () => {
    expect(nswCaselawDecisionUrl("549fff1d3004262463c85662")).toBe(
      "https://www.caselaw.nsw.gov.au/decision/549fff1d3004262463c85662",
    )
  })
})

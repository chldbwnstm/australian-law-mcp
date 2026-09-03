import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  ADRP_PATHS,
  buildMpcPath,
  parseAdrpIndex,
  parseMpcCaseStudies,
  parseMpcCaseStudy,
  parseNaccIndex,
} from "./integrity-sources.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")
const NACC = fixture("nacc-investigation-reports.html")
const MPC = fixture("mpc-case-studies.html")
const ADRP = fixture("adrp-past-reviews.html")
const MPC_CASE = fixture("mpc-case-study.html")

describe("parseNaccIndex — recorded investigation-reports page", () => {
  const operations = parseNaccIndex(NACC, "https://www.nacc.gov.au/investigation-reports-and-case-studies")

  it("returns one entry per operation heading", () => {
    expect(operations.length).toBeGreaterThanOrEqual(3)
    expect(operations.map((operation) => operation.anchor)).toContain("operation-wilson")
  })

  it("keeps the operation summary from the section, not the link list", () => {
    const wilson = operations.find((operation) => operation.anchor === "operation-wilson")
    expect(wilson?.name).toBe("Operation Wilson")
    expect(wilson?.summary).toContain("Australian Border Force")
    expect(wilson?.summary).not.toContain("Investigation Report (PDF")
  })

  it("collects the report PDF and case-study links for each operation", () => {
    const wilson = operations.find((operation) => operation.anchor === "operation-wilson")
    const urls = (wilson?.documents ?? []).map((document) => document.url)
    expect(urls.some((url) => url.endsWith(".pdf"))).toBe(true)
    expect(urls.some((url) => url.includes("case-study-operation-wilson"))).toBe(true)
  })

  it("does not leak a following operation's links into the previous section", () => {
    const roe = parseNaccIndex(NACC, "u").find((operation) => operation.anchor === "operation-roe-")
    expect((roe?.documents ?? []).every((document) => !document.url.includes("wilson"))).toBe(true)
  })
})

describe("buildMpcPath", () => {
  it("uses the view's exposed `keys` filter", () => {
    expect(buildMpcPath({ query: "conduct" })).toContain("keys=conduct")
  })

  it("emits facets with literal square brackets", () => {
    expect(buildMpcPath({ facets: ["filter_by_code_of_conduct:18"] })).toContain(
      "f[0]=filter_by_code_of_conduct%3A18",
    )
  })

  it("returns the bare path when nothing is filtered", () => {
    expect(buildMpcPath()).toBe("resources/case-studies-merits-review-outcomes")
  })
})

describe("parseMpcCaseStudies — recorded case-studies index", () => {
  const result = parseMpcCaseStudies(MPC, "https://www.mpc.gov.au/x")

  it("reads the case-study rows", () => {
    expect(result.hits.length).toBeGreaterThanOrEqual(2)
    expect(result.hits[0].title).toBe("Financial penalty too harsh")
    expect(result.hits[0].id).toBe("financial-penalty-too-harsh")
    expect(result.hits[0].url).toBe("https://www.mpc.gov.au/case-summaries/financial-penalty-too-harsh")
  })

  it("reads the view header count", () => {
    expect(result.total).toBe(58)
  })

  it("always says these are case studies, not tribunal decisions", () => {
    expect(result.totalNote).toMatch(/not tribunal decisions/i)
  })
})

describe("parseMpcCaseStudy — recorded case-study page", () => {
  const study = parseMpcCaseStudy(MPC_CASE, "evidence-inappropriate-conduct")

  it("reads the case study's own body, not the sitewide search form", () => {
    // The template renders the search form inside a `field--name-body` that
    // comes FIRST in document order; scoping to the article is what stops the
    // case study's text coming back as "Search Search".
    expect(study.text).not.toMatch(/^Search/)
    expect(study.text).toContain("employee")
    expect(study.text.length).toBeGreaterThan(200)
  })

  it("takes the title from the h1 and builds the canonical URL", () => {
    expect(study.title).toContain("Evidence of inappropriate conduct")
    expect(study.url).toBe("https://www.mpc.gov.au/case-summaries/evidence-inappropriate-conduct")
  })
})

describe("parseAdrpIndex — recorded past-reviews table", () => {
  const hits = parseAdrpIndex(ADRP, "https://www.industry.gov.au/x")

  it("reads reference number, title and date from each row", () => {
    expect(hits.length).toBeGreaterThanOrEqual(3)
    const first = hits[0]
    expect(first.source).toBe("Anti-Dumping Review Panel")
    expect(first.citation).toBe("2026/176")
    expect(first.date).toBe("31/03/2026")
    expect(first.title).toContain("Hot rolled deformed steel reinforcing bar")
  })

  it("builds an absolute case URL from the long official path", () => {
    expect(hits[0].url).toContain(
      "https://www.industry.gov.au/trade/anti-dumping-review-panel/past-anti-dumping-review-panel-reviews/",
    )
  })

  it("keeps the four official index paths (short guesses 404 upstream)", () => {
    expect(ADRP_PATHS.past).toBe(
      "trade/anti-dumping-review-panel/past-anti-dumping-review-panel-reviews",
    )
    expect(Object.values(ADRP_PATHS).every((path) => path.startsWith("trade/anti-dumping-review-panel"))).toBe(true)
  })
})

describe("shape failures", () => {
  it("labels each index's missing landmark as UPSTREAM_NO_DATA", () => {
    for (const parse of [parseNaccIndex, parseMpcCaseStudies, parseAdrpIndex]) {
      try {
        parse("<html><body>maintenance</body></html>", "u")
        throw new Error("should have thrown")
      } catch (error) {
        expect((error as { code?: string }).code).toBe("UPSTREAM_NO_DATA")
      }
    }
  })
})

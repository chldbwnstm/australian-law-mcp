import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { asideSearchPageMatches, asideSearchTotal, canonicalCaseCitation, judgmentText, readAsideJudgment, readAsideSearchHits } from "./aside-case-pages.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/aside/${name}.html`, import.meta.url), "utf8")
const citation = "[2020] FCAFC 130"
const searchUrl = "https://www.austlii.edu.au/cgi-bin/sinosrch.cgi?method=auto&query=prepayment&mask_path=au%2Fcases%2Fcth%2FFCAFC"

// Original Aside DOM captures from 2026-09-16; URLs and hashes in provenance.json.
const victorianPages = [
  { name: "austlii-vcat-199", citation: "[2024] VCAT 199", heading: "<p class=\"h1\"><b>REASONS</b></p>", lastParagraph: 43 },
  { name: "austlii-vsc-110", citation: "[1999] VSC 110", heading: "HIS HONOUR:<!--/normal--></p>", lastParagraph: 1918 },
]

describe.each(victorianPages)("recorded Victorian reasons: $citation", ({ name, citation, heading, lastParagraph }) => {
  it("reads the original reasons and preserves the first and final paragraph locators", () => {
    const result = readAsideJudgment(fixture(name), citation)
    expect(result).not.toHaveProperty("failure")
    if ("failure" in result) throw new Error(result.failure)
    expect(result.citation).toBe(citation)
    expect(result.text).toMatch(/(?:^|\n)1\. /)
    expect(result.text).toMatch(new RegExp(`(?:^|\\n)${lastParagraph}\\. `))
    expect(result.text).not.toContain("Search AustLII")
    expect(result.text).not.toContain("All Databases")
  })

  it("does not mistake the coversheet and numbered orders for missing reasons", () => {
    const html = fixture(name)
    const start = html.indexOf(heading)
    expect(start).toBeGreaterThan(0)
    expect(readAsideJudgment(html.slice(0, start + heading.length), citation)).toHaveProperty("failure")
  })

  it("does not use a short heading outside the publisher's document container", () => {
    const html = fixture(name).replace(/<article\b[^>]*class="the-document"[^>]*>/, "<main>").replace("</article>", "</main>")
    expect(readAsideJudgment(html, citation)).toHaveProperty("failure")
  })

  it("does not count a copy of the reasons inside navigation as the document body", () => {
    const html = fixture(name)
      .replace('<article class="the-document">', '<article class="the-document"><nav>')
      .replace("</article>", "</nav></article>")
    expect(readAsideJudgment(html, citation)).toHaveProperty("failure")
  })

  it("still refuses a different requested judgment", () => {
    expect(readAsideJudgment(fixture(name), citation.replace(/\d+$/, "99999"))).toHaveProperty("failure")
  })
})

it("recognises the corresponding HER HONOUR: speaker marker in the same document template", () => {
  const html = fixture("austlii-vsc-110").replace("HIS HONOUR:", "HER HONOUR:")
  expect(readAsideJudgment(html, "[1999] VSC 110")).not.toHaveProperty("failure")
})

describe("search redirect identity", () => {
  it("accepts the publisher's semicolon syntax and legal mirror host", () => {
    expect(asideSearchPageMatches(searchUrl, searchUrl.replaceAll("&", ";").replace("www.austlii", "classic.austlii"))).toBe(true)
  })
  it.each([searchUrl.replace("prepayment", "different"), searchUrl.replace("FCAFC", "FCA"), searchUrl + "&offset=10", searchUrl + "&query=other", "https://www.austlii.edu.au/", searchUrl.replace("www.austlii.edu.au", "www.accc.gov.au")])("rejects results redirected away from the requested search: %s", url => {
    expect(asideSearchPageMatches(searchUrl, url)).toBe(false)
  })
})

describe("recorded publisher pages captured with Aside", () => {
  it("reads the older WA judgment template with a named judgment anchor and numbered paragraphs", () => {
    const result = readAsideJudgment(fixture("austlii-wasca"), "[2012] WASCA 212")
    expect(result).not.toHaveProperty("failure")
    if ("failure" in result) throw new Error(result.failure)
    expect(result.text).toMatch(/(?:^|\n)1\s/)
    expect(result.text).toMatch(/(?:^|\n)304\s/)
  })

  it("does not accept a judgment anchor without its numbered original paragraphs", () => {
    const html = '<title>Example [2012] WASCA 212</title><article class="the-document"><a name="Judgment"></a><nav>' + "Navigation ".repeat(100) + '</nav></article>'
    expect(readAsideJudgment(html, "[2012] WASCA 212")).toHaveProperty("failure")
  })
  it("retains the original PDF when a real Victorian page is only a viewer", () => {
    const result = readAsideJudgment(fixture("austlii-vsc-pdf"), "[2023] VSC 637", "https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/vic/VSC/2023/637.html")
    expect(result).toMatchObject({ citation: "[2023] VSC 637", text: "", documents: [{ url: "https://www.austlii.edu.au/au/cases/vic/VSC/2023/637.pdf" }] })
  })

  it.each(["https://example.org/au/cases/vic/VSC/2023/637.pdf", "/au/cases/vic/VSC/2023/638.pdf", "/au/cases/wa/VSC/2023/637.pdf"])("does not assign an unrelated PDF to the requested citation: %s", url => {
    const html = fixture("austlii-vsc-pdf").replaceAll("/au/cases/vic/VSC/2023/637.pdf", url)
    expect(readAsideJudgment(html, "[2023] VSC 637", "https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/vic/VSC/2023/637.html")).toHaveProperty("failure")
  })
  it.each(["fedcourt-tpg", "austlii-tpg"])("extracts TPG reasons with locators from %s, excluding site navigation", name => {
    const result = readAsideJudgment(fixture(name), citation)
    expect(result).not.toHaveProperty("failure")
    if ("failure" in result) throw new Error(result.failure)
    expect(result.citation).toBe(citation)
    expect(result.text).toContain("REASONS FOR")
    expect(result.text).toMatch(/(?:^|\n)1[. ]/)
    expect(result.text).toMatch(/(?:^|\n)38[. ]/)
    expect(result.text).toMatch(/(?:^|\n)43[. ]/)
    expect(result.text).not.toContain("Skip to main navigation")
    expect(result.text).not.toContain("Am I eligible?")
    expect(result.text).not.toContain("Home Databases")
  })

  it("reads all ten judgment rows, excludes citator/database links, and preserves the publisher's total", () => {
    const html = fixture("austlii-search-ready")
    const hits = readAsideSearchHits(html, searchUrl, { court: "FCAFC" })
    expect(hits).toHaveLength(10)
    expect(hits[0].citation).toBe(citation)
    expect(hits[0].url).toContain("/FCAFC/2020/130.html")
    expect(hits.map(hit => hit.citation)).toContain("[2021] FCAFC 71")
    expect(hits.every(hit => !/LawCite|viewdb/.test(hit.url))).toBe(true)
    expect(asideSearchTotal(html)).toBe(30)
  })

  it("does not mistake the real search page for the first judgment on it", () => {
    expect(readAsideJudgment(fixture("austlii-search-ready"), citation)).toHaveProperty("failure")
  })
})

describe("citation and paragraph identity", () => {
  it.each(["[2020] F.C.A.F.C. 130", "[2020] fcafc 130", "TPG [2020] FCAFC 130", "[2020] FCAFC 130, [12]"])("canonicalises %s without treating a pinpoint as another case", value => {
    expect(canonicalCaseCitation(value)).toBe(citation)
  })

  it("preserves numeric paragraph starts, explicit values, and nested unordered lists", () => {
    const text = judgmentText('<ol start="12"><li>First paragraph<ul><li>Bullet</li></ul></li><li value="38">Express locator</li><li>Next paragraph</li></ol>')
    expect(text).toBe("12. First paragraph\nBullet\n38. Express locator\n39. Next paragraph")
  })

  it("accepts brief genuine numbered reasons instead of requiring a long page", () => {
    const html = `<title>Party v Party ${citation}</title><h1>Party v Party ${citation}</h1><h2>REASONS FOR JUDGMENT</h2><p>1. The parties agree that the appeal should be dismissed. Having considered their submissions, we make those orders.</p>`
    expect(readAsideJudgment(html, citation)).not.toHaveProperty("failure")
  })

  it("does not let a metadata date labelled judgment stand in for the reasons", () => {
    const html = `<title>Party v Party ${citation}</title><h1>Party v Party ${citation}</h1><p>Date of judgment</p><p>2020</p><p>${"Cover sheet only. ".repeat(100)}</p>`
    expect(readAsideJudgment(html, citation)).toHaveProperty("failure")
  })

  it("does not accept a PDF viewer shell as the extracted judgment", () => {
    const html = `<title>Party v Party ${citation}</title><body><embed type="application/pdf" src="case.pdf"><nav>${"Viewer control ".repeat(100)}</nav></body>`
    expect(readAsideJudgment(html, citation)).toHaveProperty("failure")
  })

  it.each(["[2020] FCAFC 13", "[2020] FCAFC 1300", "[2019] FCAFC 130", "[2020] FCA 130"])("rejects %s even when it cites the requested case", other => {
    const html = fixture("austlii-tpg").replaceAll(citation, other) + `<p>Cases cited: ${citation}</p>`
    expect(readAsideJudgment(html, citation)).toHaveProperty("failure")
  })
})

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { AuApiClient } from "../../lib/api-client.js"
import { parseCaseCitation, type MncCitation } from "../../lib/case-citation.js"
import { coveringSource, locateCase, renderCaseVerdict } from "./case-check.js"

/**
 * Recorded upstream responses (src/lib/sources/__fixtures__/provenance.txt,
 * captured 2026-09-04):
 *   hca-search-native-title.html — GET hcourt.gov.au …/judgments-1998-current?keywords=native+title
 *   nsw-mnc-lookup.html          — GET caselaw.nsw.gov.au/search/advanced?…mnc=[2010] NSWCCA 333…
 */
const HCA_LIST = readFileSync(
  new URL("../../lib/sources/__fixtures__/hca-search-native-title.html", import.meta.url),
  "utf8",
)
const NSW_MNC = readFileSync(
  new URL("../../lib/sources/__fixtures__/nsw-mnc-lookup.html", import.meta.url),
  "utf8",
)

function mnc(citation: string): MncCitation {
  const parsed = parseCaseCitation(citation)
  if (!parsed.ok || parsed.citation.kind !== "mnc") throw new Error(`not a medium-neutral citation: ${citation}`)
  return parsed.citation
}

/** Counts requests, so "was this source even asked?" is testable. */
function client(html: string): { client: AuApiClient; calls: () => number } {
  let calls = 0
  return {
    client: {
      fetchHtml: async () => {
        calls++
        return html
      },
    } as unknown as AuApiClient,
    calls: () => calls,
  }
}

describe("coveringSource — coverage is only claimed where a miss would be real", () => {
  it("covers the High Court's own judgments", () => {
    expect(coveringSource(mnc("[2020] HCA 41"))).toBe("hca")
  })

  it("does NOT claim the HCA listing covers HCASL or HCASJ", () => {
    // Special leave dispositions are AustLII-only; single justice judgments
    // (from Jan 2024) are a separate collection. Neither is in the
    // judgments-1998-current listing this server walks.
    expect(coveringSource(mnc("[2019] HCASL 123"))).toBeUndefined()
    expect(coveringSource(mnc("[2025] HCASJ 10"))).toBeUndefined()
  })

  it("covers a NSW court NSW Caselaw's advanced search has an id for", () => {
    expect(coveringSource(mnc("[2010] NSWCCA 333"))).toBe("nsw")
    expect(coveringSource(mnc("[2023] NSWCATAP 100"))).toBe("nsw")
  })

  it("does NOT claim NSW Caselaw covers a NSW body it holds no court id for", () => {
    expect(coveringSource(mnc("[2010] NSWADT 100"))).toBeUndefined()
  })

  it("covers the Queensland courts that are citation-addressable", () => {
    expect(coveringSource(mnc("[2020] QSC 100"))).toBe("qld")
  })
})

describe("locateCase — a real citation is never located out of existence", () => {
  it("does not walk the HCA listing for a special leave disposition", async () => {
    const { client: spy, calls } = client(HCA_LIST)
    const location = await locateCase(spy, mnc("[2019] HCASL 123"))
    expect(location.status).toBe("unsupported")
    expect(calls()).toBe(0)
    if (location.status !== "unsupported") throw new Error("unreachable")
    expect(location.reason).toContain("judgments-1998-current")
    expect(location.reason).toContain("NOT looked up")
    expect(location.links.some((link) => link.includes("austlii.edu.au"))).toBe(true)
    expect(location.links.some((link) => link.includes("lawcite"))).toBe(true)
  })

  it("points a single justice citation at the Court's own separate collection", async () => {
    const { client: spy, calls } = client(HCA_LIST)
    const location = await locateCase(spy, mnc("[2025] HCASJ 10"))
    expect(location.status).toBe("unsupported")
    expect(calls()).toBe(0)
    if (location.status !== "unsupported") throw new Error("unreachable")
    expect(location.links[0]).toBe(
      "https://www.hcourt.gov.au/cases-and-judgments/judgments/single-justice-judgments",
    )
  })

  it("does not read a NSW search that could not include the body as absence", async () => {
    const { client: spy } = client(NSW_MNC)
    const location = await locateCase(spy, mnc("[2010] NSWADT 100"))
    expect(location.status).toBe("unsupported")
  })

  it("still finds a High Court judgment in the Court's own list", async () => {
    const { client: spy } = client(HCA_LIST)
    const location = await locateCase(spy, mnc("[2026] HCA 25"))
    expect(location.status).toBe("found")
  })

  it("still reports a real absence once the complete year list was walked", async () => {
    const { client: spy } = client(HCA_LIST)
    const location = await locateCase(spy, mnc("[2026] HCA 9999"))
    expect(location.status).toBe("absent")
  })
})

describe("renderCaseVerdict — only a real absence may be a ✗", () => {
  it("marks a special leave disposition ⚠, never 'very likely invented'", async () => {
    const { client: spy } = client(HCA_LIST)
    const citation = mnc("[2019] HCASL 123")
    const verdict = renderCaseVerdict(citation, await locateCase(spy, citation))
    expect(verdict.mark).toBe("⚠")
    expect(verdict.impossible).toBeUndefined()
    expect(verdict.line).not.toContain("NOT_FOUND")
    expect(verdict.line).not.toContain("very likely invented")
    expect(verdict.line).toContain("NOT checked here")
  })

  it("keeps ✗ for the High Court judgment its own complete list does not hold", async () => {
    const { client: spy } = client(HCA_LIST)
    const citation = mnc("[2026] HCA 9999")
    const verdict = renderCaseVerdict(citation, await locateCase(spy, citation))
    expect(verdict.mark).toBe("✗")
    expect(verdict.impossible).toBe(true)
  })
})

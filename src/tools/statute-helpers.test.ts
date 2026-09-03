import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle } from "../lib/types.js"
import {
  collectionLabel,
  formatVersionLine,
  formerNames,
  isoDay,
  matchedFormerName,
  reasonLine,
  repealedBy,
  titleAnnotations,
} from "./statute-helpers/format.js"
import { cachedToc, isStructuralKind, sliceSubtree } from "./statute-helpers/toc.js"
import { looksLikeRegisterId, rankTitles, resolveTitle } from "./statute-helpers/title-lookup.js"

const SEARCH_CCA = JSON.parse(
  readFileSync(new URL("./__fixtures__/frl-search-cca.json", import.meta.url), "utf8"),
) as { "@odata.count": number; value: FrlTitle[] }
const TPA = (
  JSON.parse(readFileSync(new URL("./__fixtures__/frl-title-tpa-rename.json", import.meta.url), "utf8")) as { value: FrlTitle[] }
).value[0]
const ASIC89 = (
  JSON.parse(readFileSync(new URL("./__fixtures__/frl-title-asic1989-repealed.json", import.meta.url), "utf8")) as { value: FrlTitle[] }
).value[0]
const ENTRIES = parseNcx(readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))
const VOL4 = readFileSync(new URL("./__fixtures__/cca-vol4-schedule2.html", import.meta.url), "utf8")

beforeEach(() => lawCache.clear())

describe("title ranking", () => {
  it("prefers the principal Act over same-named instruments", () => {
    const ranked = rankTitles("competition and consumer act", SEARCH_CCA.value)
    expect(ranked[0].id).toBe("C2004A00109")
  })

  it("counts a historical-name match as a strong signal", () => {
    const ranked = rankTitles("Trade Practices Act 1974", [
      { id: "C9", name: "Trade Practices Amendment Act 1977", collection: "Act", isPrincipal: false },
      TPA,
    ])
    expect(ranked[0].id).toBe("C2004A00109")
  })

  it("is stable for equally-scored rows, keeping upstream relevance order", () => {
    const a: FrlTitle = { id: "A", name: "Zed Act 2000", collection: "Act", status: "InForce", isPrincipal: true }
    const b: FrlTitle = { id: "B", name: "Zed Act 2001", collection: "Act", status: "InForce", isPrincipal: true }
    expect(rankTitles("nothing in common", [a, b]).map((t) => t.id)).toEqual(["A", "B"])
  })

  it("recognises a register id without a network call", () => {
    expect(looksLikeRegisterId("C2004A00109")).toBe(true)
    expect(looksLikeRegisterId("F2011L00287")).toBe(true)
    expect(looksLikeRegisterId("Competition and Consumer Act")).toBe(false)
  })
})

describe("resolveTitle", () => {
  const client = (titles: FrlTitle[]) =>
    ({
      searchTitles: async () => ({ count: titles.length, titles }),
      getTitle: async () => titles[0],
    }) as unknown as AuApiClient

  it("refuses an ambiguous cross-jurisdiction alias rather than choosing", async () => {
    await expect(resolveTitle(client([]), { query: "Evidence Act" })).rejects.toThrow(/more than one jurisdiction/)
  })

  it("refuses a result set with no overlap instead of returning noise", async () => {
    const unrelated: FrlTitle[] = [{ id: "C1", name: "Aged Care Act 1997", collection: "Act" }]
    await expect(resolveTitle(client(unrelated), { query: "Competition and Consumer Act" })).rejects.toThrow(
      /none of which share a name/,
    )
  })

  it("records the alias expansion as a note so the change is visible", async () => {
    const lookup = await resolveTitle(client([TPA]), { query: "CCA" })
    expect(lookup.notes.join(" ")).toContain("Competition and Consumer Act 2010")
  })

  it("says nothing was found rather than inventing a title", async () => {
    await expect(resolveTitle(client([]), { query: "Zzzq Act 1899" })).rejects.toThrow(/no title matching/)
  })
})

describe("title annotations", () => {
  it("names the repealing act as the successor", () => {
    const by = repealedBy(ASIC89)
    expect(by?.name).toContain("Corporations (Repeals, Consequentials and Transitionals) Act 2001")
    expect(by?.titleId).toBe("C2004A00823")
    expect(titleAnnotations(ASIC89).join(" ")).toContain("successor")
  })

  it("de-duplicates former names and excludes the current one", () => {
    expect(formerNames(TPA)).toEqual(["Trade Practices Act 1974"])
  })

  it("explains a historical-name match only when the query is the old name", () => {
    expect(matchedFormerName("Trade Practices Act 1974", TPA)).toBe("Trade Practices Act 1974")
    expect(matchedFormerName("Competition and Consumer Act 2010", TPA)).toBeUndefined()
    expect(matchedFormerName("CCA", TPA)).toBeUndefined() // too short to be a safe match
  })

  it("never lets a rename read as a repeal", () => {
    const notes = titleAnnotations(TPA, "Trade Practices Act 1974").join(" ")
    expect(notes).toContain("NOT a repeal")
    expect(notes).not.toContain("REPEALED")
  })

  it("warns unconditionally about unincorporated amendments", () => {
    expect(titleAnnotations(TPA).join(" ")).toContain("NOT yet incorporated")
  })

  it("labels a not-yet-commenced title without calling it repealed", () => {
    const pending: FrlTitle = { id: "C1", name: "Future Act 2030", status: "InForce", isInForce: false }
    expect(titleAnnotations(pending).join(" ")).toContain("NOT YET IN FORCE")
  })

  it("spaces out camel-case collection names", () => {
    expect(collectionLabel({ collection: "LegislativeInstrument", subCollection: "Regulations" })).toBe(
      "Legislative Instrument (Regulations)",
    )
  })
})

describe("version and reason rendering", () => {
  it("keeps 'in force now' and 'latest registered' distinct", () => {
    const line = formatVersionLine({
      titleId: "C1",
      start: "2026-07-01T00:00:00",
      end: null,
      isCurrent: true,
      isLatest: false,
      registerId: null,
    })
    expect(line).toContain("in force now")
    expect(line).not.toContain("latest registered")
    expect(line).toContain("compilation pending")
  })

  it("renders a reason as amending act plus provisions plus id", () => {
    expect(
      reasonLine({
        affect: "Amend",
        affectedByTitle: { titleId: "C2025A00057", name: "Payday Superannuation Act 2025", provisions: "sch 1 (item 66)", year: 2025, number: 57, seriesType: "Act" },
      }),
    ).toBe("Amend: Payday Superannuation Act 2025 sch 1 (item 66) [C2025A00057]")
  })

  it("falls back to the markdown text, with links stripped, when no title is attached", () => {
    expect(reasonLine({ affect: "Repeal", markdown: "sch 1 of the [Some Act 2001](/C2004A00823)" })).toBe(
      "Repeal: sch 1 of the Some Act 2001",
    )
  })

  it("normalises dates to a plain day", () => {
    expect(isoDay("2015-06-30T00:00:00")).toBe("2015-06-30")
    expect(isoDay(null)).toBe("—")
  })
})

describe("toc helpers", () => {
  it("caches the table of contents per title and date", async () => {
    let calls = 0
    const client = {
      getToc: async () => {
        calls++
        return ENTRIES
      },
    } as unknown as AuApiClient
    await cachedToc(client, "C2004A00109")
    await cachedToc(client, "C2004A00109")
    await cachedToc(client, "C2004A00109", "2015-06-30")
    expect(calls).toBe(2)
  })

  it("slices a whole subtree, not just up to the first child", () => {
    const schedule2 = ENTRIES.find((entry) => entry.label.startsWith("Schedule 2"))!
    const text = sliceSubtree(VOL4, ENTRIES, schedule2)!
    expect(text).toContain("Misleading or deceptive conduct")
    expect(text).toContain("Application of this Schedule")
  })

  it("returns null — not a wider slice — when the anchor is absent", () => {
    const schedule2 = ENTRIES.find((entry) => entry.label.startsWith("Schedule 2"))!
    expect(sliceSubtree("<p>unrelated</p>", ENTRIES, schedule2)).toBeNull()
  })

  it("treats structural kinds as subtrees and sections as leaves", () => {
    expect(isStructuralKind("part")).toBe(true)
    expect(isStructuralKind("schedule")).toBe(true)
    expect(isStructuralKind("section")).toBe(false)
  })
})

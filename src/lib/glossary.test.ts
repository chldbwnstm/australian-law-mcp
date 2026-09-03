import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  GLOSSARY_PATH,
  clearGlossaryCache,
  decodeEntities,
  loadGlossary,
  parseGlossaryHtml,
  splitHeadwords,
} from "./glossary.js"

const FIXTURE = readFileSync(new URL("./__fixtures__/glossary-slice.html", import.meta.url), "utf-8")

describe("parseGlossaryHtml", () => {
  const entries = parseGlossaryHtml(FIXTURE)

  it("reads every recorded dt/dd pair", () => {
    expect(entries).toHaveLength(14)
  })

  it("keeps the headword and definition text, tags stripped", () => {
    const affidavit = entries.find((entry) => entry.term === "Affidavit")
    expect(affidavit?.definition).toBe("A signed and sworn statement prepared for a court.")
  })

  it("decodes HTML entities in both the term and the definition", () => {
    const terms = entries.map((entry) => entry.term)
    expect(terms).toContain("Summary & Indictable offences")
    expect(terms).toContain("Examination, Cross-examination & Re-examination")
    const defendant = entries.find((entry) => entry.term === "Defendant")
    expect(defendant?.definition).toBe("See 'Accused'.")
  })

  it("exposes both headwords of a comma- or slash-separated dt", () => {
    const accused = entries.find((entry) => entry.term === "Accused, Defendant")
    expect(accused?.aliases).toEqual(["Accused", "Defendant"])
    const callover = entries.find((entry) => entry.term === "Callover/Mention")
    expect(callover?.aliases).toEqual(["Callover", "Mention"])
  })

  it("leaves a single-headword term unsplit", () => {
    expect(entries.find((entry) => entry.term === "Bail")?.aliases).toEqual([])
    expect(entries.find((entry) => entry.term === "Common law")?.aliases).toEqual([])
  })

  it("returns nothing for markup with no definition list", () => {
    expect(parseGlossaryHtml("<html><body><p>Maintenance</p></body></html>")).toEqual([])
  })

  it("ignores dt/dd markup that only appears inside an HTML comment", () => {
    const commented = "<!-- pairs are <dt>Ghost</dt><dd>Not real</dd> -->\n<dl><dt>Bail</dt><dd>Real</dd></dl>"
    expect(parseGlossaryHtml(commented).map((entry) => entry.term)).toEqual(["Bail"])
  })

  it("does not duplicate a headword that appears twice", () => {
    const doubled = parseGlossaryHtml("<dl><dt>Bail</dt><dd>One</dd><dt>bail</dt><dd>Two</dd></dl>")
    expect(doubled).toHaveLength(1)
  })
})

describe("splitHeadwords", () => {
  it("splits on commas and slashes", () => {
    expect(splitHeadwords("Instructions, Brief")).toEqual(["Instructions", "Brief"])
    expect(splitHeadwords("Hearing/Trial")).toEqual(["Hearing", "Trial"])
  })

  it("refuses to split a phrase that is one headword", () => {
    expect(splitHeadwords("Hearsay rule")).toEqual([])
    expect(splitHeadwords("Summary & Indictable offences")).toEqual([])
    // A part carrying sentence punctuation is prose, not a second headword.
    expect(splitHeadwords("Brief, see Instructions.")).toEqual([])
  })
})

describe("decodeEntities", () => {
  it("handles named, decimal and hex forms", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b")
    expect(decodeEntities("don&#039;t")).toBe("don't")
    expect(decodeEntities("&#x2014;")).toBe("—")
  })

  it("leaves an unknown entity alone rather than dropping it", () => {
    expect(decodeEntities("&zzz; text")).toBe("&zzz; text")
  })
})

describe("loadGlossary", () => {
  beforeEach(() => clearGlossaryCache())

  it("fetches the short /glossary path and parses it", async () => {
    const fetchHtml = vi.fn().mockResolvedValue(FIXTURE)
    const load = await loadGlossary({ fetchHtml })
    expect(fetchHtml).toHaveBeenCalledWith("glossary", GLOSSARY_PATH)
    expect(load.unavailable).toBeUndefined()
    expect(load.entries).toHaveLength(14)
  })

  it("caches, so a second call makes no request", async () => {
    const fetchHtml = vi.fn().mockResolvedValue(FIXTURE)
    await loadGlossary({ fetchHtml })
    await loadGlossary({ fetchHtml })
    expect(fetchHtml).toHaveBeenCalledTimes(1)
  })

  it("reports a network failure as unavailable, never as an empty glossary", async () => {
    const fetchHtml = vi.fn().mockRejectedValue(new Error("upstream 503"))
    const load = await loadGlossary({ fetchHtml })
    expect(load.entries).toEqual([])
    expect(load.unavailable).toContain("upstream 503")
  })

  it("reports a markup change as unavailable and does not cache it", async () => {
    const fetchHtml = vi.fn().mockResolvedValue("<html><body>no list here</body></html>")
    const first = await loadGlossary({ fetchHtml })
    expect(first.unavailable).toContain("no <dt>/<dd> definition pairs")
    await loadGlossary({ fetchHtml })
    expect(fetchHtml).toHaveBeenCalledTimes(2)
  })
})

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ancestorsOf, decodeXmlEntities, parseNcx, volumeNumberOf } from "./ncx-parser.js"

const NCX = readFileSync(new URL("./__fixtures__/cca-document.ncx", import.meta.url), "utf-8")
const entries = parseNcx(NCX)

describe("parseNcx — recorded CCA table of contents", () => {
  it("parses every navPoint in the fixture (294 kept from the 2,603 upstream)", () => {
    expect(entries).toHaveLength(294)
  })

  it("keeps document order (playOrder ascending)", () => {
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].order).toBeGreaterThan(entries[i - 1].order)
    }
  })

  it("splits content src into volumeDoc and anchor", () => {
    const chapter1 = entries.find((e) => e.label === "Chapter 1—Preliminary")
    expect(chapter1).toBeDefined()
    expect(chapter1?.volumeDoc).toBe("document_1/document_1.html")
    expect(chapter1?.anchor).toBe("_Toc235540914")
  })

  it("leaves the anchor unset on a volume root", () => {
    const volume1 = entries.find((e) => e.label === "Volume 1")
    expect(volume1?.volumeDoc).toBe("document_1/document_1.html")
    expect(volume1?.anchor).toBeUndefined()
    expect(volume1?.depth).toBe(1)
  })

  // The upstream label is "18  Meetings of Commission". If the NBSP
  // survives, every downstream regex has to know about it; normalising here
  // is what lets section-ref's label patterns stay simple.
  it("normalises NBSPs and collapses whitespace in labels", () => {
    const bodyS18 = entries.find((e) => e.label === "18 Meetings of Commission")
    expect(bodyS18).toBeDefined()
    expect(bodyS18?.anchor).toBe("_Toc235540955")
    expect(bodyS18?.volumeDoc).toBe("document_1/document_1.html")
  })

  it("keeps both s 18 entries apart — the flagship CCA/ACL trap", () => {
    const eighteens = entries.filter((e) => /^18 /.test(e.label))
    expect(eighteens.map((e) => e.label).sort()).toEqual([
      "18 Meetings of Commission",
      "18 Misleading or deceptive conduct",
    ])
    const acl = eighteens.find((e) => e.label.includes("Misleading"))
    expect(acl?.volumeDoc).toBe("document_4/document_4.html")
    expect(acl?.anchor).toBe("_Toc235543096")
  })

  it("preserves the parent chain down to a schedule section", () => {
    const acl18 = entries.find((e) => e.label === "18 Misleading or deceptive conduct")!
    const chain = ancestorsOf(acl18).map((a) => a.label)
    expect(chain).toEqual([
      "Volume 4",
      "Schedule 2—The Australian Consumer Law",
      "Chapter 2—General protections",
      "Part 2-1—Misleading or deceptive conduct",
    ])
    expect(acl18.depth).toBe(5)
  })

  it("keeps the body s 18 outside any schedule subtree", () => {
    const body18 = entries.find((e) => e.label === "18 Meetings of Commission")!
    const chain = ancestorsOf(body18).map((a) => a.label)
    expect(chain[0]).toBe("Volume 1")
    expect(chain.some((label) => label.startsWith("Schedule"))).toBe(false)
  })

  it("survives junk input without throwing", () => {
    expect(parseNcx("")).toEqual([])
    expect(parseNcx("<html><body>maintenance page</body></html>")).toEqual([])
    // Unbalanced close tags are ignored, an unclosed navPoint still parses.
    expect(parseNcx('</navPoint><navPoint playOrder="1"><navLabel><text>X</text></navLabel><content src="a.html#f"/>')).toEqual([
      { label: "X", volumeDoc: "a.html", anchor: "f", order: 1, depth: 1 },
    ])
  })
})

describe("decodeXmlEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeXmlEntities("A &amp; B &#x2011; C&#160;D &lt;5&gt;")).toBe("A & B ‑ C D <5>")
  })
  it("drops invalid code points instead of throwing", () => {
    expect(decodeXmlEntities("&#x110000;")).toBe("")
  })
})

describe("volumeNumberOf", () => {
  it("reads the volume number out of the document name", () => {
    expect(volumeNumberOf("document_4/document_4.html")).toBe(4)
    expect(volumeNumberOf("cover.html")).toBeUndefined()
  })
})

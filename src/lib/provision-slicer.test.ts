import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseNcx } from "./ncx-parser.js"
import { findNavPoint, htmlToText, sliceProvision } from "./provision-slicer.js"
import { parseSectionRef } from "./section-ref.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")

const entries = parseNcx(fixture("cca-document.ncx"))
const vol1 = fixture("cca-vol1-slice.html")
const vol4 = fixture("cca-vol4-slice.html")

const ref = (input: string) => {
  const parsed = parseSectionRef(input)
  if (!parsed) throw new Error(`fixture ref did not parse: ${input}`)
  return parsed
}

describe("findNavPoint — the CCA s 18 / ACL sch 2 s 18 trap", () => {
  it("resolves a bare s 18 to the body section, not the schedule", () => {
    const entry = findNavPoint(ref("s 18"), entries)
    expect(entry?.label).toBe("18 Meetings of Commission")
    expect(entry?.volumeDoc).toBe("document_1/document_1.html")
    expect(entry?.anchor).toBe("_Toc235540955")
  })

  it("resolves sch 2 s 18 to the section inside the Schedule 2 subtree", () => {
    const entry = findNavPoint(ref("sch 2 s 18"), entries)
    expect(entry?.label).toBe("18 Misleading or deceptive conduct")
    expect(entry?.volumeDoc).toBe("document_4/document_4.html")
    expect(entry?.anchor).toBe("_Toc235543096")
  })

  it("accepts the spelled-out schedule form too", () => {
    const entry = findNavPoint(ref("Schedule 2, s 18"), entries)
    expect(entry?.label).toBe("18 Misleading or deceptive conduct")
  })

  it("does not fall back to the body section when the schedule lacks the number", () => {
    // Schedule 1 (Schedule version of Part IV) has no s 18 navPoint in the
    // fixture; answering with body s 18 would be the exact wrong-schedule bug.
    expect(findNavPoint(ref("sch 1 s 18"), entries)).toBeUndefined()
  })

  it("resolves a bare schedule reference to the schedule node itself", () => {
    const entry = findNavPoint(ref("sch 2"), entries)
    expect(entry?.label).toBe("Schedule 2—The Australian Consumer Law")
    expect(entry?.anchor).toBe("_Toc235543075")
  })

  it("matches worded structural labels (part, division) by word + number", () => {
    expect(findNavPoint(ref("pt IIA"), entries)?.label).toBe(
      "Part IIA—The National Competition Council",
    )
    expect(findNavPoint(ref("div 1A"), entries)?.label).toBe("Division 1A—Acquisitions")
  })

  it("does not let s 1 match section 18 or Part 1 labels", () => {
    const entry = findNavPoint(ref("s 1"), entries)
    // The only "1 …" section navPoint in the fixture is inside Schedule 2.
    expect(entry?.label).toBe("1 Application of this Schedule")
  })

  it("returns undefined for a provision the act does not have", () => {
    expect(findNavPoint(ref("s 9999"), entries)).toBeUndefined()
  })

  it("finds lettered sections without matching their unlettered neighbours", () => {
    const entry = findNavPoint(ref("s 17A"), entries)
    expect(entry?.label).toMatch(/^17A Disclosure of certain interests/)
  })
})

describe("sliceProvision — body s 18 (volume 1)", () => {
  const entry = findNavPoint(ref("s 18"), entries)!
  const text = sliceProvision(vol1, entry, entries)!

  it("starts at the section heading", () => {
    expect(text.startsWith("18 Meetings of Commission")).toBe(true)
  })

  it("keeps subsection numbering and indentation", () => {
    expect(text).toContain("    (1) Subject to this section, the Chairperson shall convene")
    expect(text).toContain("    (4) In the absence of the Chairperson")
    expect(text).toContain("        (a) if there are 2 Deputy Chairpersons")
  })

  it("stops before the next section even when the NCX end anchor was pruned", () => {
    // The fixture NCX has no navPoint for body s 19, so the slicer must fall
    // back to the next _Toc anchor in the HTML itself.
    expect(text).not.toContain("Chairperson may direct Commission to sit in Divisions")
    expect(text).not.toContain("17A")
  })

  it("contains no markup or raw entities", () => {
    expect(text).not.toMatch(/<[a-z]/i)
    expect(text).not.toContain("&#x")
    expect(text).not.toContain("\u00a0")
  })
})

describe("sliceProvision — ACL sch 2 s 18 (volume 4)", () => {
  const entry = findNavPoint(ref("sch 2 s 18"), entries)!
  const text = sliceProvision(vol4, entry, entries)!

  it("returns the misleading-or-deceptive-conduct text, not the body section", () => {
    expect(text.startsWith("18 Misleading or deceptive conduct")).toBe(true)
    expect(text).toContain("misleading or deceptive or is likely to mislead or deceive")
    expect(text).not.toContain("Meetings of Commission")
  })

  it("ends at the next NCX anchor (s 19)", () => {
    expect(text).not.toContain("information providers")
  })

  it("keeps the note line and maps the non-breaking hyphen to a plain one", () => {
    expect(text).toContain("    Note: For rules relating to representations")
    expect(text).toContain("Part 5-3")
    expect(text).toContain("Part 3-1 (which is about unfair practices)")
  })

  it("returns null when the anchor is missing from the HTML", () => {
    const wrongVolume = sliceProvision(vol1, entry, entries)
    expect(wrongVolume).toBeNull()
  })
})

describe("htmlToText", () => {
  it("drops spacing-only paragraphs and strips nested tags", () => {
    const out = htmlToText(
      '<p class="Header"><span>&#xa0;</span></p>' +
        '<p class="ActHead5"><a id="x"><span>18</span><span>&#xa0; </span><span>Heading</span></a></p>' +
        '<p class="subsection"><span>(1)</span><span>&#xa0;</span><span>Body text.</span></p>',
    )
    expect(out).toBe("18 Heading\n    (1) Body text.")
  })

  it("returns an empty string for markup with no paragraphs", () => {
    expect(htmlToText("<div>nothing</div>")).toBe("")
  })
})

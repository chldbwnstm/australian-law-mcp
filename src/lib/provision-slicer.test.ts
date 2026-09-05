import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, relative } from "node:path"
import { gunzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { sliceSubtree } from "../tools/statute-helpers/toc.js"
import { parseNcx } from "./ncx-parser.js"
import {
  duplicateNumberNote,
  findNavPoint,
  htmlToText,
  leadingNumber,
  resolveNavPoint,
  sliceProvision,
} from "./provision-slicer.js"
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

/*
 * ── The Constitution's twice-used section numbers ─────────────────────────
 *
 * A faithful miniature of the *Commonwealth of Australia Constitution Act*'s
 * table of contents (register id C2004Q00685). Labels, anchors and nesting are
 * verbatim from the live NCX at
 * https://www.legislation.gov.au/C2004Q00685/latest/latest/text/latest/epub/OEBPS/document.ncx
 * (157 navPoints, read 2026-09-04); only sections nobody needs here are cut.
 *
 * The shape is the point: the Imperial Act's **covering clauses** are ss 1–9
 * hanging directly off the document root, and the Constitution's own ss 1–9
 * sit under "Chapter I.—The Parliament.". Every number from 1 to 9 therefore
 * names two different provisions.
 */
const nav = (label: string, anchor: string | null, children = ""): string =>
  `<navPoint id="${anchor ?? "root"}" playOrder="0"><navLabel><text>${label}</text></navLabel>` +
  `<content src="document_1/document_1.html${anchor ? `#${anchor}` : ""}" />${children}</navPoint>`

const CONSTITUTION_NCX =
  '<?xml version="1.0" encoding="utf-8"?><ncx><docTitle><text>Commonwealth of Australia ' +
  "Constitution Act</text></docTitle><navMap>" +
  nav(
    "Commonwealth of Australia Constitution Act - [Other]",
    null,
    // The covering clauses of the 1900 Imperial Act.
    nav("1.&#xa0; Short title.", "_Toc29462582") +
      nav("2.&#xa0; Act to extend to the Queen&#8217;s successors.", "_Toc29462583") +
      nav("3.&#xa0; Proclamation of Commonwealth.", "_Toc29462584") +
      nav("4.&#xa0; Commencement of Act.", "_Toc29462585") +
      nav("5.&#xa0; Operation of the Constitution and laws.", "_Toc29462586") +
      nav("6.&#xa0; Definitions.", "_Toc29462587") +
      nav("7.&#xa0; Repeal of Federal Council Act.", "_Toc29462588") +
      nav("8.&#xa0; Application of Colonial Boundaries Act.", "_Toc29462589") +
      nav("9.&#xa0; Constitution.", "_Toc29462590") +
      // The Constitution proper.
      nav(
        "Chapter I.&#8212;The Parliament.",
        "_Toc29462592",
        nav("Part I.&#8212;General.", "_Toc29462593") +
          nav("1.&#xa0; Legislative Power.", "_Toc29462594") +
          nav("2.&#xa0; Governor-General.", "_Toc29462595") +
          nav("3.&#xa0; Salary of Governor-General.", "_Toc29462596") +
          nav("4.&#xa0; Provisions relating to Governor-General.", "_Toc29462597") +
          nav("5.&#xa0; Sessions of Parliament.", "_Toc29462598") +
          nav("6.&#xa0; Yearly session of Parliament.", "_Toc29462599") +
          nav("Part II.&#8212;The Senate.", "_Toc29462600") +
          nav("7.&#xa0; The Senate.", "_Toc29462601") +
          nav("8.&#xa0; Qualification of electors.", "_Toc29462602") +
          nav("9.&#xa0; Method of election of senators.", "_Toc29462603") +
          nav("10.&#xa0; Application of State laws.", "_Toc29462604") +
          nav("Part V.&#8212;Powers of the Parliament.", "_Toc29462647") +
          nav("51.&#xa0; Legislative powers of the Parliament.", "_Toc29462648"),
      ) +
      nav("SCHEDULE.", "_Toc29462733", nav("Endnotes", "_Toc29462734")),
  ) +
  "</navMap></ncx>"

const CONSTITUTION = parseNcx(CONSTITUTION_NCX)

/** The volume HTML, in NCX order, for the anchors the slicing tests reach. */
const CONSTITUTION_HTML =
  "<html><body>" +
  '<p class="ActHead5"><a id="_Toc29462582">1 Short title.</a></p>' +
  '<p class="subsection">This Act may be cited as the Commonwealth of Australia Constitution Act.</p>' +
  '<p class="ActHead5"><a id="_Toc29462588">7 Repeal of Federal Council Act.</a></p>' +
  '<p class="subsection">The Federal Council of Australasia Act 1885 is hereby repealed.</p>' +
  '<p class="ActHead5"><a id="_Toc29462601">7 The Senate.</a></p>' +
  '<p class="subsection">The Senate shall be composed of senators for each State, directly chosen by the people of the State.</p>' +
  '<p class="ActHead5"><a id="_Toc29462602">8 Qualification of electors.</a></p>' +
  '<p class="subsection">The qualification of electors of senators shall be&#8230;</p>' +
  "</body></html>"

const label = (input: string) => findNavPoint(ref(input), CONSTITUTION)?.label

describe("findNavPoint — the Constitution's two sets of ss 1-9", () => {
  it("serves Chapter I s 7, not the 1900 Act's covering clause", () => {
    // Before the fix this returned "7. Repeal of Federal Council Act." — the
    // provision behind Lange, Roach and Rowe was unreachable.
    expect(label("s 7")).toBe("7. The Senate.")
  })

  // Enumerated, because the bug was one rule mis-serving all nine numbers.
  const CHAPTER_I: ReadonlyArray<[string, string]> = [
    ["s 1", "1. Legislative Power."],
    ["s 2", "2. Governor-General."],
    ["s 3", "3. Salary of Governor-General."],
    ["s 4", "4. Provisions relating to Governor-General."],
    ["s 5", "5. Sessions of Parliament."],
    ["s 6", "6. Yearly session of Parliament."],
    ["s 7", "7. The Senate."],
    ["s 8", "8. Qualification of electors."],
    ["s 9", "9. Method of election of senators."],
  ]
  it.each(CHAPTER_I)("%s resolves to the Constitution's own section (%s)", (input, expected) => {
    expect(label(input)).toBe(expected)
  })

  const COVERING: ReadonlyArray<[string, string]> = [
    ["cl 1", "1. Short title."],
    ["cl 2", "2. Act to extend to the Queen’s successors."],
    ["cl 3", "3. Proclamation of Commonwealth."],
    ["cl 4", "4. Commencement of Act."],
    ["cl 5", "5. Operation of the Constitution and laws."],
    ["cl 6", "6. Definitions."],
    ["cl 7", "7. Repeal of Federal Council Act."],
    ["cl 8", "8. Application of Colonial Boundaries Act."],
    ["cl 9", "9. Constitution."],
  ]
  it.each(COVERING)("%s reaches the covering clause (%s)", (input, expected) => {
    expect(label(input)).toBe(expected)
  })

  it("accepts the spelled-out clause designation too", () => {
    expect(label("clause 5")).toBe("5. Operation of the Constitution and laws.")
  })

  it("leaves numbers that occur once alone", () => {
    expect(label("s 10")).toBe("10. Application of State laws.")
    expect(label("s 51")).toBe("51. Legislative powers of the Parliament.")
    expect(resolveNavPoint(ref("s 51"), CONSTITUTION).alternatives).toEqual([])
  })

  it("reports the rejected twin as an alternative rather than dropping it", () => {
    const both = resolveNavPoint(ref("s 7"), CONSTITUTION)
    expect(both.alternatives.map((entry) => entry.label)).toEqual(["7. Repeal of Federal Council Act."])
    expect(resolveNavPoint(ref("cl 7"), CONSTITUTION).alternatives.map((e) => e.label)).toEqual(["7. The Senate."])
  })

  it("does not treat a schedule twin as an unnameable ambiguity (sch 2 s 18 addresses it)", () => {
    expect(resolveNavPoint(ref("s 18"), entries).alternatives).toEqual([])
    expect(resolveNavPoint(ref("sch 2 s 18"), entries).alternatives).toEqual([])
  })
})

describe("duplicateNumberNote — the ambiguity is named, never silent", () => {
  it("says which s 7 was served, where the other is, and how to ask for it", () => {
    const note = duplicateNumberNote(findNavPoint(ref("s 7"), CONSTITUTION)!, CONSTITUTION)!
    expect(note).toContain('numbers "7" more than once')
    expect(note).toContain("served: 7. The Senate. — in Chapter I.—The Parliament.")
    expect(note).toContain("also numbered 7: 7. Repeal of Federal Council Act.")
    expect(note).toContain('Ask for it as "cl 7".')
  })

  it("points the other way when the covering clause is what was asked for", () => {
    const note = duplicateNumberNote(findNavPoint(ref("cl 7"), CONSTITUTION)!, CONSTITUTION)!
    expect(note).toContain("served: 7. Repeal of Federal Council Act.")
    expect(note).toContain('Ask for it as "s 7".')
  })

  it("stays quiet for unambiguous provisions and for schedule twins", () => {
    expect(duplicateNumberNote(findNavPoint(ref("s 51"), CONSTITUTION)!, CONSTITUTION)).toBeUndefined()
    expect(duplicateNumberNote(findNavPoint(ref("s 18"), entries)!, entries)).toBeUndefined()
    expect(duplicateNumberNote(findNavPoint(ref("sch 2 s 18"), entries)!, entries)).toBeUndefined()
    expect(duplicateNumberNote(findNavPoint(ref("pt IIA"), entries)!, entries)).toBeUndefined()
  })

  it("reads the number a navLabel leads with, and only that", () => {
    expect(leadingNumber("7. The Senate.")).toBe("7")
    expect(leadingNumber("18 Meetings of Commission")).toBe("18")
    expect(leadingNumber("105A. Agreements with respect to State debts.")).toBe("105A")
    expect(leadingNumber("86.")).toBe("86")
    expect(leadingNumber("Part IV—Restrictive trade practices")).toBeUndefined()
    expect(leadingNumber("Endnotes")).toBeUndefined()
  })
})

describe("duplicateNumberNote — a guide that restarts at 1 is not an ambiguity", () => {
  // The real Corporations Act 2001 NCX (see __fixtures__/PROVENANCE.txt):
  // Part 1.5's Small Business Guide numbers its paragraphs 1–12 between
  // ss 111J and 111K, so eleven real section numbers (ss 1–7, 9, 11, 12)
  // have a same-numbered twin there. "Corporations Act s 9" is unambiguous —
  // nobody cites a guide paragraph as `s 9` — and the warning that "no
  // reference form distinguishes it" was false on the second-most-cited Act
  // in the country.
  const corporations = parseNcx(
    gunzipSync(
      readFileSync(new URL("./__fixtures__/corporations-document.ncx.gz", import.meta.url)),
    ).toString("utf-8"),
  )

  it("serves the Dictionary for s 9 with no false warning", () => {
    const entry = findNavPoint(ref("s 9"), corporations)!
    expect(entry.label).toMatch(/^9\s+Dictionary/)
    expect(duplicateNumberNote(entry, corporations)).toBeUndefined()
  })

  it("stays quiet for every number the guide reuses", () => {
    for (const number of ["1", "2", "3", "4", "5", "6", "7", "11", "12"]) {
      const entry = findNavPoint(ref(`s ${number}`), corporations)!
      expect(duplicateNumberNote(entry, corporations), `s ${number}`).toBeUndefined()
    }
  })

  it("still names the Constitution's covering-clause twins in the real NCX", () => {
    // The restart rule must not eat the one duplication that is real: the
    // covering clauses open the rooted stream and the Constitution's own
    // sections open the contained stream, so neither restarts anything.
    // `constitution-toc.ncx` is the whole C2004Q00685 table of contents
    // (157 navPoints, captured 2026-09-05) — provenance in
    // `__fixtures__/PROVENANCE.txt`.
    const constitution = parseNcx(
      readFileSync(new URL("./__fixtures__/constitution-toc.ncx", import.meta.url), "utf-8"),
    )
    const body = findNavPoint(ref("s 7"), constitution)!
    expect(duplicateNumberNote(body, constitution)).toContain('Ask for it as "cl 7".')
    const covering = findNavPoint(ref("cl 7"), constitution)!
    expect(duplicateNumberNote(covering, constitution)).toContain('Ask for it as "s 7".')
  })
})

/*
 * ── Numbering that restarts inside a Part is not an ambiguity ──────────────
 *
 * A faithful miniature of the *Corporations Act 2001*'s Chapter 1 (register id
 * C2004A00818). Labels, anchors and nesting are verbatim from the live NCX at
 * https://www.legislation.gov.au/C2004A00818/latest/latest/text/latest/epub/OEBPS/document.ncx
 * (5,569 navPoints, read 2026-09-05); only the entries nobody needs here are cut.
 *
 * The shape is the point. "Part 1.5—Small business guide" is a non-operative
 * reader's aid whose paragraphs are numbered 1–12, so every one of them shares
 * a leading number with a real section of Part 1.1 or Part 1.2 — 22 entries
 * across 11 numbers in the live document. None of it makes "Corporations Act
 * s 9" ambiguous: only one of the two is a section.
 */
const CORPORATIONS_NCX =
  '<?xml version="1.0" encoding="utf-8"?><ncx><docTitle><text>Title</text></docTitle><navMap>' +
  nav(
    "Volume 1",
    null,
    nav(
      "Chapter&#xa0;1&#8212;Introductory",
      "_Toc236051746",
      nav(
        "Part&#xa0;1.1&#8212;Preliminary",
        "_Toc236051747",
        nav("1  Short title", "_Toc236051748") + nav("2  Commencement", "_Toc236051749"),
      ) +
        nav(
          "Part&#xa0;1.2&#8212;Interpretation",
          "_Toc236051762",
          nav(
            "Division&#xa0;1&#8212;General",
            "_Toc236051763",
            nav("6  Effect of this Part", "_Toc236051765") +
              nav("7  Identifying defined terms", "_Toc236051766") +
              nav("9  Dictionary", "_Toc236051767"),
          ),
        ) +
        nav(
          "Part&#xa0;1.5&#8212;Small business guide",
          "_Toc236051898",
          nav("1  What registration means", "_Toc236051899") +
            nav("2  The company structure for small business", "_Toc236051900") +
            nav("7  Signing company documents", "_Toc236051905") +
            nav("9  Returns to shareholders", "_Toc236051907"),
        ),
    ),
  ) +
  "</navMap></ncx>"

const CORPORATIONS = parseNcx(CORPORATIONS_NCX)

describe("duplicateNumberNote — a renumbered guide is not a rival reference", () => {
  const corporations = (input: string) => duplicateNumberNote(findNavPoint(ref(input), CORPORATIONS)!, CORPORATIONS)

  it("says nothing about s 9, which is the Dictionary and nothing else", () => {
    // Before the narrowing this served the Dictionary under 'Note: this
    // compilation numbers "9" more than once … also numbered 9: 9 Returns to
    // shareholders — in Part 1.5—Small business guide. No reference form
    // distinguishes it', an ambiguity warning over an unambiguous answer on
    // the second-most-cited Australian Act.
    expect(findNavPoint(ref("s 9"), CORPORATIONS)?.label).toBe("9 Dictionary")
    expect(corporations("s 9")).toBeUndefined()
  })

  // Enumerated, because one rule mis-warned on every number the guide reuses.
  it.each(["s 1", "s 2", "s 7", "s 9"])("%s is served without an ambiguity warning", (input) => {
    expect(corporations(input)).toBeUndefined()
  })

  it("stays silent when the guide's own paragraph is what was resolved", () => {
    // Symmetry: whichever of the two `resolveNavPoint` picks, neither is a
    // provision the caller could have addressed with the other's designation.
    const guideEntry = CORPORATIONS.find((entry) => entry.label === "9 Returns to shareholders")!
    expect(duplicateNumberNote(guideEntry, CORPORATIONS)).toBeUndefined()
  })

  it("still names the covering-clause collision it exists for", () => {
    // The narrowing must not cost the Constitution case — the two sit on
    // opposite sides of the root/structure line, and `cl 7` reaches the other.
    expect(duplicateNumberNote(findNavPoint(ref("s 7"), CONSTITUTION)!, CONSTITUTION)).toContain(
      'Ask for it as "cl 7".',
    )
  })

  it("never offers a designation that does not reach the other entry", () => {
    // The note's whole value is the follow-up call it prints, so every note any
    // of these two documents can produce must name a reachable twin.
    for (const [entries, doc] of [
      [CONSTITUTION, "Constitution"],
      [CORPORATIONS, "Corporations Act"],
    ] as const) {
      for (const entry of entries) {
        const note = duplicateNumberNote(entry, entries)
        if (note === undefined) continue
        const asked = /Ask for it as "(cl|s) (\S+?)"/.exec(note)
        expect(asked, `${doc}: ${entry.label} was warned about with no way to ask for the twin:\n${note}`).not.toBeNull()
        const twin = findNavPoint(ref(`${asked![1]} ${asked![2]}`), entries)
        expect(twin, `${doc}: '${asked![0]}' resolves to nothing`).toBeDefined()
        expect(twin).not.toBe(entry)
      }
    }
  })
})

/*
 * Every function that turns a navPoint into served text has to carry the note;
 * the table is the enumeration, so a third one cannot be added silently.
 */
describe("served text carries the ambiguity note — all slicers enumerated", () => {
  const SLICERS: ReadonlyArray<[string, (entry: (typeof CONSTITUTION)[number]) => string | null]> = [
    ["sliceProvision", (entry) => sliceProvision(CONSTITUTION_HTML, entry, CONSTITUTION)],
    ["sliceSubtree", (entry) => sliceSubtree(CONSTITUTION_HTML, CONSTITUTION, entry)],
  ]

  it.each(SLICERS)("%s prefixes Constitution s 7 with the note", (_name, slice) => {
    const text = slice(findNavPoint(ref("s 7"), CONSTITUTION)!)!
    expect(text.startsWith('Note: this compilation numbers "7" more than once')).toBe(true)
    expect(text).toContain('Ask for it as "cl 7".')
    expect(text).toContain("The Senate shall be composed of senators")
    expect(text).not.toContain("Federal Council of Australasia")
  })

  it.each(SLICERS)("%s leaves unambiguous CCA provisions untouched", (_name, _slice) => {
    // Guard against the note leaking into ordinary text: the CCA's only
    // repeated number is the schedule twin, which is addressable.
    const entry = findNavPoint(ref("s 18"), entries)!
    const text =
      _name === "sliceProvision" ? sliceProvision(vol1, entry, entries)! : sliceSubtree(vol1, entries, entry)!
    expect(text.startsWith("18 Meetings of Commission")).toBe(true)
    expect(text).not.toContain("more than once")
  })
})

/*
 * Consumers of the resolver, enumerated. `findNavPoint`/`resolveNavPoint` is
 * the single place a navPoint is chosen; a module that starts choosing one has
 * to be checked against the duplicate-number rule above, and this list is how
 * that gets noticed.
 */
describe("navPoint resolution has one owner", () => {
  const SRC = fileURLToPath(new URL("../", import.meta.url))

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      if (item.isDirectory()) out.push(...sourceFiles(path))
      else if (item.name.endsWith(".ts") && !item.name.endsWith(".test.ts")) out.push(path)
    }
    return out
  }

  it("is imported only by the modules that have been checked against it", () => {
    const importers = sourceFiles(SRC)
      .filter((path) => /import\s*{[^}]*\b(?:find|resolve)NavPoint\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).replaceAll("\\", "/"))
      .sort()
    expect(importers).toEqual([
      "lib/api-client.ts",
      "tools/analysis-helpers/statute-check.ts",
      "tools/impact-map.ts",
      "tools/statute-helpers/toc.ts",
    ])
  })
})

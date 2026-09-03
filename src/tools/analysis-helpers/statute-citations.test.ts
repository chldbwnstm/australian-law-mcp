import { describe, expect, it } from "vitest"
import {
  extractStatuteCitations,
  findFullCites,
  findShortForms,
  preferredStatuteName,
  statuteNameCandidates,
} from "./statute-citations.js"

describe("statuteNameCandidates", () => {
  it("keeps the full reading first so an Act that begins with an article survives", () => {
    const candidates = statuteNameCandidates("A New Tax System (Goods and Services Tax) Act")
    expect(candidates[0]).toBe("A New Tax System (Goods and Services Tax) Act")
  })

  it("offers progressively shorter readings when prose was swallowed", () => {
    expect(statuteNameCandidates("Under the Competition and Consumer Act")).toContain(
      "Competition and Consumer Act",
    )
  })

  it("orders longest first so the real title is tried before a fragment of it", () => {
    const candidates = statuteNameCandidates("Under the Competition and Consumer Act")
    expect(candidates.indexOf("Competition and Consumer Act")).toBeLessThan(candidates.indexOf("Consumer Act"))
  })
})

describe("preferredStatuteName", () => {
  it("picks the reading the alias table knows", () => {
    expect(preferredStatuteName("Under the Competition and Consumer Act")).toBe("Competition and Consumer Act")
  })

  it("falls back to trimming prose when no reading is a known alias", () => {
    expect(preferredStatuteName("Under the Widget Regulation Act")).toBe("Widget Regulation Act")
  })

  it("does not strip the leading article of a real short title", () => {
    const name = "A New Tax System (Goods and Services Tax) Act"
    expect(preferredStatuteName(name)).toBe(name)
  })
})

describe("extractStatuteCitations", () => {
  it("reads a canonical AGLC citation with its jurisdiction", () => {
    const [cite] = extractStatuteCitations("See Competition and Consumer Act 2010 (Cth) s 18 for the rule.", 5)
    expect(cite.lawName).toContain("Competition and Consumer Act")
    expect(cite.jurisdiction).toBe("Cth")
    expect(cite.year).toBe(2010)
    expect(cite.pinpoint).toBe("s 18")
    expect(cite.attachedBy).toBe("trailing-cite")
  })

  it("tolerates markdown italics around the short title", () => {
    const [cite] = extractStatuteCitations("Under the *Fair Work Act 2009* (Cth) s 394 an application lies.", 5)
    expect(cite.lawName).toBe("Fair Work Act")
    expect(cite.jurisdiction).toBe("Cth")
    expect(cite.pinpoint).toBe("s 394")
  })

  it("reads a pinpoint that precedes its Act", () => {
    const [cite] = extractStatuteCitations("s 18 of the Competition and Consumer Act 2010 (Cth) applies.", 5)
    expect(cite.attachedBy).toBe("leading-cite")
    expect(cite.lawName).toBe("Competition and Consumer Act")
    expect(cite.jurisdiction).toBe("Cth")
  })

  it("reads a bare abbreviation and keeps the citation as written", () => {
    const [cite] = extractStatuteCitations("CCA s 18 prohibits misleading or deceptive conduct.", 5)
    expect(cite.attachedBy).toBe("abbreviation")
    expect(cite.lawName).toBe("CCA")
    expect(cite.raw).toBe("CCA s 18")
    expect(cite.claim).toBe("misleading or deceptive conduct")
  })

  it("rewrites an ACL pinpoint into the schedule it actually lives in", () => {
    const [cite] = extractStatuteCitations("ACL s 18 prohibits misleading or deceptive conduct.", 5)
    expect(cite.pinpoint).toBe("sch 2 s 18")
    expect(cite.ref.schedule).toBe("2")
  })

  it("leaves the jurisdiction absent when the writer omitted it", () => {
    const [cite] = extractStatuteCitations("The accused was charged under the Crimes Act s 61.", 5)
    expect(cite.lawName).toBe("Crimes Act")
    expect(cite.jurisdiction).toBeUndefined()
    expect(cite.attachedBy).toBe("bare-name")
  })

  it("inherits the last full citation for 'the Act' inside one paragraph", () => {
    const text = "The Fair Work Act 2009 (Cth) s 382 defines dismissal. The Act s 394 sets the time limit."
    const cites = extractStatuteCitations(text, 5)
    const anaphoric = cites.find((cite) => cite.attachedBy === "anaphora")
    expect(anaphoric?.lawName).toBe("Fair Work Act")
    expect(anaphoric?.pinpoint).toBe("s 394")
    expect(anaphoric?.antecedent).toContain("Fair Work Act 2009 (Cth)")
  })

  it("NEVER inherits across a blank line", () => {
    const text =
      "The Fair Work Act 2009 (Cth) s 382 defines dismissal.\n\nA different topic entirely. That Act s 394 is cited."
    const anaphoric = extractStatuteCitations(text, 5).find((cite) => cite.attachedBy === "anaphora")
    expect(anaphoric).toBeDefined()
    expect(anaphoric?.lawName).toBeUndefined()
  })

  it("binds a short form defined in the text", () => {
    const text =
      "The Fair Work Act 2009 (Cth) ('FW Act') applies.\n\nIn a later paragraph the FW Act s 394 is the source."
    const bound = extractStatuteCitations(text, 5).find((cite) => cite.pinpoint === "s 394")
    expect(bound?.attachedBy).toBe("short-form")
    expect(bound?.lawName).toBe("Fair Work Act")
  })

  it("does not read the year of a titled instrument as a pinpoint", () => {
    const cites = extractStatuteCitations("See Migration Regulations 1994 (Cth) reg 2.01 for the criteria.", 5)
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["reg 2.01"])
  })

  it("keeps a pinpoint with no statute at all, rather than dropping it silently", () => {
    const [cite] = extractStatuteCitations("The tribunal considered s 1234567 at length.", 5)
    expect(cite?.attachedBy).toBe("none")
  })

  it("honours maxCitations", () => {
    const text = "Crimes Act 1900 (NSW) s 61, s 62, s 63, s 64, s 65."
    expect(extractStatuteCitations(text, 2)).toHaveLength(2)
  })

  it("de-duplicates the same citation written twice", () => {
    const text = "Competition and Consumer Act 2010 (Cth) s 18 and again Competition and Consumer Act 2010 (Cth) s 18."
    expect(extractStatuteCitations(text, 10)).toHaveLength(1)
  })
})

describe("findFullCites / findShortForms", () => {
  it("locates every complete citation", () => {
    const cites = findFullCites("Fair Work Act 2009 (Cth) and Crimes Act 1900 (NSW) both apply.")
    expect(cites.map((cite) => cite.jurisdiction)).toEqual(["Cth", "NSW"])
  })

  it("registers a parenthetical short-form definition", () => {
    const text = "Fair Work Act 2009 (Cth) ('FW Act')"
    const forms = findShortForms(text, findFullCites(text))
    expect([...forms.keys()]).toContain("fwact")
  })
})

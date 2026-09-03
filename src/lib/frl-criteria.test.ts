import { describe, expect, it } from "vitest"
import {
  affectedby,
  and,
  collection,
  encodeCriteria,
  id,
  or,
  pointintime,
  status,
  text,
  titlesSearchPath,
} from "./frl-criteria.js"

// The strings on the right are the ones that were sent to the live API on
// 2026-09-03 (after one decode of the curl URL) and returned the counts noted.
describe("criteria fragments reproduce the verified examples", () => {
  it("builds the name-only text search (311 hits live)", () => {
    expect(text("competition and consumer", "name", "contains")).toBe(
      'text("competition%20and%20consumer",name,contains)',
    )
  })

  it("defaults to nameAndText + contains", () => {
    expect(text("misleading or deceptive")).toBe(
      'text("misleading%20or%20deceptive",nameAndText,contains)',
    )
  })

  it("trims the phrase before encoding so a stray space is not searched for", () => {
    expect(text("  fair work  ", "name")).toBe('text("fair%20work",name,contains)')
  })

  it("encodes characters that would otherwise change the call's arity", () => {
    // A bare comma reads as the argument separator; a bare quote closes the string.
    expect(text("goods, services", "name")).toContain("goods%2C%20services")
    expect(text("A&B trading", "name")).toContain("A%26B%20trading")
  })

  it("refuses an empty phrase rather than searching for everything", () => {
    expect(() => text("   ")).toThrow(/non-empty/)
  })

  it("leaves enum arguments unquoted — the quoted form errors upstream", () => {
    expect(collection("Act")).toBe("collection(Act)")
    expect(status("InForce")).toBe("status(InForce)")
    expect(collection("Act", "LegislativeInstrument")).toBe("collection(Act,LegislativeInstrument)")
  })

  it("quotes a point-in-time date and leaves the keyword bare", () => {
    expect(pointintime("2015-06-30")).toBe('pointintime("2015-06-30")')
    expect(pointintime("Latest")).toBe("pointintime(Latest)")
  })

  it("quotes register ids", () => {
    expect(id("C2004A00109")).toBe('id("C2004A00109")')
    expect(() => id("C2004 A00109")).toThrow(/Invalid FRL title id/)
  })

  it("builds affectedby with a bracketed kind list (201 amenders live)", () => {
    expect(affectedby("C2004A00109", ["amending"])).toBe('affectedby("C2004A00109",[amending])')
    expect(affectedby("C2004A00109", ["amending", "repealing"])).toBe(
      'affectedby("C2004A00109",[amending,repealing])',
    )
  })

  it("defaults affectedby to amending", () => {
    expect(affectedby("C2009A00028")).toBe('affectedby("C2009A00028",[amending])')
  })
})

// Infix `A and B` parses and then silently drops B — a wrong answer that looks
// like a right one. The function form is the only safe way to combine.
describe("and()/or() use the function form", () => {
  it("reproduces the verified and(text,collection) query (53 hits live)", () => {
    expect(and(text("misleading or deceptive", "nameAndText", "contains"), collection("Act"))).toBe(
      'and(text("misleading%20or%20deceptive",nameAndText,contains),collection(Act))',
    )
  })

  it("reproduces the point-in-time combination (33 hits at 2015-06-30 live)", () => {
    expect(
      and(
        text("misleading or deceptive", "nameAndText", "contains"),
        collection("Act"),
        pointintime("2015-06-30"),
      ),
    ).toBe(
      'and(text("misleading%20or%20deceptive",nameAndText,contains),collection(Act),pointintime("2015-06-30"))',
    )
  })

  it("never emits an infix operator", () => {
    const built = and(collection("Act"), status("InForce"))
    expect(built).not.toMatch(/\band\b\s+\w/)
    expect(built.startsWith("and(")).toBe(true)
  })

  it("unwraps a single operand instead of emitting and(x)", () => {
    expect(and(collection("Act"))).toBe("collection(Act)")
    expect(or(status("Repealed"))).toBe("status(Repealed)")
  })

  it("drops empty operands so an optional filter does not leave a dangling comma", () => {
    expect(and(collection("Act"), "" as never, status("InForce"))).toBe(
      "and(collection(Act),status(InForce))",
    )
  })

  it("refuses to combine nothing", () => {
    expect(() => and()).toThrow(/at least one operand/)
    expect(() => or()).toThrow(/at least one operand/)
  })

  it("nests", () => {
    expect(and(collection("Act"), or(status("InForce"), status("Ceased")))).toBe(
      "and(collection(Act),or(status(InForce),status(Ceased)))",
    )
  })
})

// This is the gotcha the research doc leads with: the phrase is encoded once
// by text(), then the whole criteria is encoded again on the wire, so a space
// arrives as %2520.
describe("double encoding on the wire", () => {
  it("turns the inner %20 into %2520", () => {
    const criteria = text("competition and consumer", "name", "contains")
    expect(criteria).toContain("%20")
    expect(criteria).not.toContain("%2520")

    const wire = encodeCriteria(criteria)
    expect(wire).toContain("%2520")
    expect(wire).not.toContain("%252520")
  })

  it("produces exactly the verified wire string", () => {
    expect(encodeCriteria(text("competition and consumer", "name", "contains"))).toBe(
      "text(%22competition%2520and%2520consumer%22%2Cname%2Ccontains)",
    )
  })

  // An unescaped apostrophe closes the criteria='…' literal, and Australian
  // statute titles are full of them. Verified live: this exact wire form
  // returned 157 hits led by Governor-General's Residences Act 1906.
  it("escapes an apostrophe so it reaches the server as %2527", () => {
    const criteria = text("governor-general's", "nameAndText", "contains")
    expect(criteria).toBe(`text("governor-general%27s",nameAndText,contains)`)
    expect(encodeCriteria(criteria)).toContain("%2527")
  })

  it("escapes parentheses inside a phrase so they are not read as call syntax", () => {
    expect(text("goods (safety)", "name")).toBe('text("goods%20%28safety%29",name,contains)')
  })

  it("survives a decode/decode round trip back to the human phrase", () => {
    const wire = encodeCriteria(text("misleading or deceptive"))
    const once = decodeURIComponent(wire)
    expect(once).toBe('text("misleading%20or%20deceptive",nameAndText,contains)')
    const phrase = /text\("([^"]+)"/.exec(once)![1]
    expect(decodeURIComponent(phrase)).toBe("misleading or deceptive")
  })

  it("builds the search path relative to the frlApi base", () => {
    expect(titlesSearchPath(id("C2004A00109"))).toBe(
      "Titles/Search(criteria='id(%22C2004A00109%22)')",
    )
  })
})

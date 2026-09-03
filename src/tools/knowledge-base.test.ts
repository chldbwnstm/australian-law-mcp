import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearGlossaryCache } from "../lib/glossary.js"
import {
  getLegalTermDetail,
  getLegalTermKb,
  getLegalToPlain,
  getPlainTerm,
  getPlainToLegal,
  getRelatedLaws,
  getTermProvisions,
} from "./knowledge-base.js"

const GLOSSARY = readFileSync(new URL("../lib/__fixtures__/glossary-slice.html", import.meta.url), "utf-8")

/** Glossary-only client: every KB tool but get_term_provisions needs just this. */
const glossaryClient = () => ({ fetchHtml: vi.fn().mockResolvedValue(GLOSSARY) })
const deadGlossaryClient = () => ({ fetchHtml: vi.fn().mockRejectedValue(new Error("host unreachable")) })
const textOf = (response: { content: Array<{ text: string }> }) => response.content[0].text

beforeEach(() => clearGlossaryCache())

describe("get_legal_term_kb", () => {
  it("merges bundled entries and glossary entries for one query", async () => {
    const response = await getLegalTermKb(glossaryClient(), { query: "subpoena", limit: 10 })
    const text = textOf(response)
    expect(response.isError).toBeUndefined()
    expect(text).toContain("Bundled dictionary")
    expect(text).toContain("subpoena")
    expect(text).toContain("Uniform Civil Procedure Rules 2005 (NSW) pt 33")
    expect(text).toContain("State Library of NSW")
  })

  it("still answers from the bundle when the glossary is unreachable, and says so", async () => {
    const response = await getLegalTermKb(deadGlossaryClient(), { query: "genuine redundancy", limit: 10 })
    const text = textOf(response)
    expect(response.isError).toBeUndefined()
    expect(text).toContain("s 389")
    expect(text).toContain("not consulted")
    expect(text).toContain("host unreachable")
  })

  it("reports a total miss as a miss in the named sources", async () => {
    const response = await getLegalTermKb(glossaryClient(), { query: "quantum flux levy", limit: 10 })
    expect(response.isError).toBe(true)
    const text = textOf(response)
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("NOT evidence")
    expect(text).toContain("Consulted:")
  })
})

describe("get_legal_term_detail", () => {
  it("expands one entry with anchors and a Federal Register link", async () => {
    const response = await getLegalTermDetail(glossaryClient(), { term: "misleading or deceptive conduct" })
    const text = textOf(response)
    expect(text).toContain("sch 2 s 18")
    expect(text).toContain("https://www.legislation.gov.au/C2004A00109/latest/text")
    expect(text).toContain("Match: exact term match")
  })

  it("gives no register link for a state Act, because none is verified", async () => {
    const text = textOf(await getLegalTermDetail(glossaryClient(), { term: "caveat" }))
    expect(text).toContain("Real Property Act 1900 (NSW) s 74F")
    expect(text).not.toContain("legislation.gov.au")
  })

  it("falls back to the glossary and flags that it is not a statutory definition", async () => {
    const text = textOf(await getLegalTermDetail(glossaryClient(), { term: "voir dire" }))
    expect(text).toContain("Voir dire")
    expect(text).toContain("not a statutory definition")
  })
})

describe("get_plain_term and the two translation tools", () => {
  it("answers an everyday word from the glossary first", async () => {
    const text = textOf(await getPlainTerm(glossaryClient(), { query: "adjournment", limit: 10 }))
    expect(text).toContain("Adjournment")
    expect(text).toContain("suspension of a hearing")
  })

  it("maps a plain phrase to legal term candidates without asserting equivalence", async () => {
    const response = await getPlainToLegal(glossaryClient(), { phrase: "made redundant", limit: 10 })
    const text = textOf(response)
    expect(text).toContain("genuine redundancy")
    expect(text).toContain("candidates, not equivalences")
  })

  it("maps a legal term back to everyday wording", async () => {
    const text = textOf(await getLegalToPlain(glossaryClient(), { term: "unconscionable conduct" }))
    expect(text).toContain("unconscionable conduct")
    expect(text).toContain("Everyday phrasings:")
    expect(text).toContain("took advantage of me")
  })

  it("reports a miss for an unmapped phrase", async () => {
    const response = await getPlainToLegal(glossaryClient(), { phrase: "zzzzq wibble", limit: 10 })
    expect(response.isError).toBe(true)
    expect(textOf(response)).toContain("[NOT_FOUND]")
  })
})

describe("get_term_provisions", () => {
  const client = (impl?: () => Promise<unknown>) => ({
    getProvision: vi.fn().mockImplementation(impl ?? (() => Promise.reject(new Error("not called")))),
  })

  it("lists anchors and links without fetching when includeText is false", async () => {
    const api = client()
    const response = await getTermProvisions(api as never, { term: "genuine redundancy", includeText: false })
    expect(api.getProvision).not.toHaveBeenCalled()
    const text = textOf(response)
    expect(text).toContain("Fair Work Act 2009 (Cth) s 389")
    expect(text).toContain("https://www.legislation.gov.au/C2009A00028/latest/text")
    expect(text).toContain("includeText: true")
  })

  it("fetches the real text only for anchors with a verified register id", async () => {
    const api = client(async () => ({
      ref: "s 389",
      heading: "389 Meaning of genuine redundancy",
      text: "(1) A person's dismissal was a case of genuine redundancy if:",
      volumeDoc: "document_2/document_2.html",
      breadcrumb: [],
    }))
    const response = await getTermProvisions(api as never, { term: "genuine redundancy", includeText: true })
    expect(api.getProvision).toHaveBeenCalledWith("C2009A00028", "s 389", undefined)
    expect(textOf(response)).toContain("389 Meaning of genuine redundancy")
  })

  it("never fetches a state Act anchor, because no register id is recorded", async () => {
    const api = client()
    await getTermProvisions(api as never, { term: "caveat", includeText: true })
    expect(api.getProvision).not.toHaveBeenCalled()
  })

  it("reports a failed fetch as a retrieval failure, not as absence", async () => {
    const api = client(async () => {
      throw new Error("FRL returned 500")
    })
    const text = textOf(await getTermProvisions(api as never, { term: "officer", includeText: true }))
    expect(text).toContain("[text not retrieved] FRL returned 500")
    expect(text).toContain("not proof the provision is absent")
  })

  it("says so plainly when a term has no statutory anchor at all", async () => {
    const text = textOf(await getTermProvisions(client() as never, { term: "probation", includeText: false }))
    expect(text).toContain("No statutory anchor is recorded")
    expect(text).toContain("not about the law")
  })
})

describe("get_related_laws", () => {
  it("needs at least one of term or lawName", async () => {
    const response = await getRelatedLaws(null, { limit: 10 })
    expect(response.isError).toBe(true)
    expect(textOf(response)).toContain("[INVALID_PARAMETER]")
  })

  it("lists the Acts a term is anchored in", async () => {
    const text = textOf(await getRelatedLaws(null, { term: "input tax credit", limit: 10 }))
    expect(text).toContain("A New Tax System (Goods and Services Tax) Act 1999 (Cth)")
    expect(text).toContain("Related terms:")
  })

  it("expands an alias into its family, with the schedule trap spelled out", async () => {
    const text = textOf(await getRelatedLaws(null, { lawName: "ACL", limit: 10 }))
    expect(text).toContain("Competition and Consumer Act 2010")
    expect(text).toContain("schedule 2")
    expect(text).toContain("https://www.legislation.gov.au/C2004A00109/latest/text")
  })

  it("warns instead of choosing when an alias spans jurisdictions", async () => {
    const text = textOf(await getRelatedLaws(null, { lawName: "Evidence Act", limit: 20 }))
    expect(text).toContain("resolves in several jurisdictions")
  })

  it("treats an alias miss as a table miss, not as a missing Act", async () => {
    const response = await getRelatedLaws(null, { lawName: "Fictional Widgets Act 2099", limit: 10 })
    expect(response.isError).toBe(true)
    expect(textOf(response)).toContain("not evidence the Act does not exist")
  })
})

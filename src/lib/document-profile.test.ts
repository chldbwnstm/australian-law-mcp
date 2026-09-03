import { describe, expect, it } from "vitest"
import {
  DOC_LABELS,
  SEARCH_SUGGESTIONS,
  classifyDocument,
  detectConflicts,
  detectConflictsInText,
  extractClauses,
  type DocType,
} from "./document-profile.js"

describe("classifyDocument", () => {
  const cases: Array<[DocType, string]> = [
    [
      "employment",
      "EMPLOYMENT AGREEMENT. The Employee will report to the Employer. The Modern Award applies. Annual leave accrues under the National Employment Standards. Ordinary hours are 38 per week.",
    ],
    [
      "lease",
      "The Lessor leases the premises to the Lessee. Rent is payable monthly. The Tenant must pay outgoings and make good the premises. Quiet enjoyment is granted. This is a retail lease.",
    ],
    [
      "nda",
      "NON-DISCLOSURE AGREEMENT. The Discloser provides Confidential Information to the Recipient for the Permitted Purpose. Trade secrets are included.",
    ],
    [
      "terms_of_service",
      "TERMS OF SERVICE. By using the platform you accept these terms. Your account may be suspended. See our privacy policy. Acceptable use applies to user content.",
    ],
    [
      "letter_of_demand",
      "LETTER OF DEMAND. We act for the creditor. We hereby demand that you pay the sum of $8,400 within 14 days, failing which proceedings will be commenced without further notice.",
    ],
    [
      "statement_of_claim",
      "STATEMENT OF CLAIM filed in the District Court. The Plaintiff claims damages from the Defendant. Particulars of the cause of action follow. Prayer for relief.",
    ],
    [
      "contract",
      "This agreement is made between the Supplier and the Customer. In consideration of the fees, the Supplier will provide the services. The parties agree as follows.",
    ],
  ]

  it.each(cases)("recognises a %s", (expected, text) => {
    expect(classifyDocument(text)).toBe(expected)
  })

  it("returns unknown rather than guessing from a stray keyword", () => {
    expect(classifyDocument("Thanks for the services. Talk soon.")).toBe("unknown")
  })

  it("prefers the procedural type when a court document quotes contract language", () => {
    const text =
      "STATEMENT OF CLAIM. The Plaintiff claims that the Defendant breached this agreement. " +
      "The parties agree clause was in consideration of the services provided by the Supplier to the Customer. Particulars follow."
    expect(classifyDocument(text)).toBe("statement_of_claim")
  })

  it("labels and suggests searches for every type", () => {
    for (const type of Object.keys(DOC_LABELS) as DocType[]) {
      expect(DOC_LABELS[type].length).toBeGreaterThan(3)
      expect(SEARCH_SUGGESTIONS[type].length).toBeGreaterThan(0)
    }
  })
})

describe("extractClauses", () => {
  const doc = [
    "SERVICES AGREEMENT",
    "1. Definitions",
    "In this agreement, Services means the work described in the Schedule.",
    "2.1 The Supplier must provide the Services.",
    "2.2 The Customer must pay within 14 days.",
    "Clause 3 Termination",
    "The agreement may be terminated on 30 days notice.",
  ].join("\n")

  it("splits on decimal numbering and on a 'Clause N' heading", () => {
    const clauses = extractClauses(doc, 10)
    expect(clauses.map((clause) => clause.label)).toEqual(["1", "2.1", "2.2", "3"])
  })

  it("folds continuation lines into the clause they belong to", () => {
    const clauses = extractClauses(doc, 10)
    expect(clauses[0].body).toContain("Services means the work")
    expect(clauses[3].body).toContain("30 days notice")
  })

  it("honours the maximum", () => {
    expect(extractClauses(doc, 2)).toHaveLength(2)
  })

  it("returns nothing for an unnumbered document rather than inventing a clause 1", () => {
    expect(extractClauses("Dear Sir, we demand payment of $500. Yours faithfully.", 10)).toEqual([])
  })
})

describe("conflict detection", () => {
  it("flags a notice period sitting beside an immediate-termination right", () => {
    const clauses = [
      { label: "8.1", body: "Either party may terminate on 30 days written notice." },
      { label: "8.2", body: "The Company may terminate immediately if it considers it appropriate." },
    ]
    const conflicts = detectConflicts(clauses)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ clauseA: "8.1", clauseB: "8.2" })
    expect(conflicts[0].type).toContain("notice period")
  })

  it("does not flag two patterns found in the same clause", () => {
    const clauses = [
      { label: "8", body: "Either party may terminate on 30 days written notice, or terminate immediately for breach." },
      { label: "9", body: "Notices must be in writing." },
    ]
    expect(detectConflicts(clauses)).toEqual([])
  })

  it("flags an exclusion sitting beside an indemnity", () => {
    const clauses = [
      { label: "10", body: "The Supplier shall not be liable for any loss." },
      { label: "11", body: "The Supplier indemnifies the Customer against all claims." },
    ]
    expect(detectConflicts(clauses).map((conflict) => conflict.type)).toContain("liability exclusion vs indemnity")
  })

  it("falls back to whole-text detection with no clause labels", () => {
    const text =
      "All warranties are excluded. Nothing in this document limits rights under the Australian Consumer Law which cannot be excluded."
    const conflicts = detectConflictsInText(text)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].clauseA).toBeUndefined()
  })

  it("finds nothing in a document with fewer than two clauses", () => {
    expect(detectConflicts([{ label: "1", body: "The Supplier shall not be liable and indemnifies nobody." }])).toEqual([])
  })
})

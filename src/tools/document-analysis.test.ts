import { describe, expect, it } from "vitest"
import { analyzeDocument } from "./document-analysis.js"

const run = async (text: string, maxClauses = 30) =>
  analyzeDocument(null, { text, maxClauses })
const textOf = (response: { content: Array<{ text: string }> }) => response.content[0].text

const TERMS_OF_SERVICE = [
  "TERMS OF SERVICE",
  "1. Your account. By using the platform you accept these terms of service. User content remains yours.",
  "2. Changes. We may vary these terms at any time at our sole discretion without notice to you.",
  "3. Fees. The subscription is $49.95 per month plus GST and automatically renews for a further 12 months.",
  "4. Warranties. All warranties and conditions are excluded. No refunds under any circumstances.",
  "5. Liability. Our total liability is limited to the fees paid in the previous 3 months.",
  "6. Privacy. We may share your personal information with our marketing partners and store it offshore.",
  "7. Termination. We may terminate your account immediately without notice.",
  "8. Notice. Either party may terminate on 30 days written notice. Payment is due within 7 business days.",
  "9. Governing law. This agreement is governed by the laws of New South Wales.",
].join("\n")

describe("analyze_document", () => {
  it("rejects a fragment too short to analyse", async () => {
    const response = await run("too short")
    expect(response.isError).toBe(true)
    expect(textOf(response)).toContain("[INVALID_PARAMETER]")
  })

  it("classifies, scores and reports the structured sections", async () => {
    const text = textOf(await run(TERMS_OF_SERVICE))
    expect(text).toContain("=== Document risk triage ===")
    expect(text).toContain("Document type: Website or platform terms of service")
    expect(text).toContain("Numbered clauses found: 9")
    expect(text).toContain("Triage score:")
    expect(text).toContain("--- Key numbers ---")
    expect(text).toContain("--- Signals ---")
    expect(text).toContain("--- Suggested follow-up searches ---")
  })

  it("names the Australian signals and locates them by clause", async () => {
    const text = textOf(await run(TERMS_OF_SERVICE))
    expect(text).toContain("Unilateral variation right (clause 2)")
    expect(text).toContain("Attempt to exclude the consumer guarantees (clause 4)")
    expect(text).toContain("Liability cap or total exclusion (clause 5)")
    expect(text).toContain("Overseas disclosure of personal information (clause 6)")
    expect(text).toContain("GST-exclusive or component pricing (clause 3)")
    expect(text).toContain("Governing law or exclusive jurisdiction (clause 9)")
  })

  it("cites the provisions a reader should check", async () => {
    const text = textOf(await run(TERMS_OF_SERVICE))
    expect(text).toContain("Competition and Consumer Act 2010 (Cth) sch 2 (ACL) s 64")
    expect(text).toContain("Privacy Act 1988 (Cth) sch 1 (APP 8)")
  })

  it("extracts Australian amounts and periods", async () => {
    const text = textOf(await run(TERMS_OF_SERVICE))
    expect(text).toContain("$49.95")
    expect(text).toContain("7 business days")
    expect(text).toContain("30 days")
  })

  it("reports the internal conflict between the notice period and immediate termination", async () => {
    const text = textOf(await run(TERMS_OF_SERVICE))
    expect(text).toContain("--- Possible internal conflicts ---")
    expect(text).toContain("[CONFLICT] notice period vs immediate termination")
  })

  it("never presents a clean scan as a clearance", async () => {
    const text = textOf(
      await run("MEMORANDUM OF UNDERSTANDING. The parties will meet quarterly to discuss the joint research programme and will share findings in good faith."),
    )
    expect(text).toContain("No rule in the bundled set matched")
    expect(text).toContain("NOT a clearance")
  })

  it("closes with the not-advice statement on every answer", async () => {
    for (const doc of [TERMS_OF_SERVICE, "LETTER OF DEMAND. We hereby demand that you pay the sum of $2,500 within 14 days, failing which proceedings will be commenced."]) {
      expect(textOf(await run(doc))).toContain("not legal advice")
    }
  })

  it("scans the whole text when the document is not numbered", async () => {
    const text = textOf(
      await run("EMPLOYMENT OFFER. The Employee will work 38 ordinary hours. The first four weeks are an unpaid trial. The Employee must not be employed by any competing business for 12 months after termination. The Modern Award applies."),
    )
    expect(text).toContain("unnumbered — scanned as one block")
    expect(text).toContain("Unpaid work or trial period")
    expect(text).toContain("Non-compete or restraint of trade")
    expect(text).toContain("Document type: Employment agreement")
  })

  it("honours maxClauses", async () => {
    const text = textOf(await run(TERMS_OF_SERVICE, 3))
    expect(text).toContain("Numbered clauses found: 3")
  })
})

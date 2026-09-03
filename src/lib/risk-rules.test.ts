import { describe, expect, it } from "vitest"
import {
  RISK_RULES,
  computeRiskScore,
  extractAmounts,
  extractPeriods,
  matchRule,
} from "./risk-rules.js"

const byId = new Map(RISK_RULES.map((rule) => [rule.id, rule]))
const fire = (id: string, text: string): boolean => {
  const rule = byId.get(id)
  if (!rule) throw new Error(`no rule ${id}`)
  return matchRule(rule, text)
}

describe("rule table shape", () => {
  it("carries the full Australian rule set", () => {
    expect(RISK_RULES.length).toBeGreaterThanOrEqual(15)
    expect(byId.size).toBe(RISK_RULES.length)
  })

  it("gives every rule an explanation, a next step and at least one pattern", () => {
    for (const rule of RISK_RULES) {
      expect(rule.explanation.length, rule.id).toBeGreaterThan(40)
      expect(rule.suggestion.length, rule.id).toBeGreaterThan(20)
      expect((rule.requires?.length ?? 0) + (rule.anyOf?.length ?? 0), rule.id).toBeGreaterThan(0)
    }
  })

  it("never states a conclusion — explanations say 'signals' or 'mentions'", () => {
    for (const rule of RISK_RULES) {
      expect(rule.explanation, rule.id).toMatch(/\b(?:Signals|Mentions|Identifies)\b/)
    }
  })

  it("uses no global regex, which would carry lastIndex between documents", () => {
    for (const rule of RISK_RULES) {
      for (const pattern of [...(rule.requires ?? []), ...(rule.anyOf ?? [])]) {
        expect(pattern.global, `${rule.id}: ${pattern.source}`).toBe(false)
      }
    }
  })
})

describe("unfair contract term and pricing signals", () => {
  it("catches a unilateral variation right", () => {
    expect(fire("uct_unilateral_variation", "We may vary these terms at any time at our sole discretion.")).toBe(true)
    expect(fire("uct_unilateral_variation", "The parties may vary this agreement by written agreement.")).toBe(false)
  })

  it("catches a one-sided termination right and a termination for convenience", () => {
    expect(fire("uct_unilateral_termination", "The Company may terminate this agreement immediately without cause.")).toBe(true)
    expect(fire("uct_unilateral_termination", "5.2 Termination for convenience. Either party may end the contract.")).toBe(true)
  })

  it("catches penalty-style payments", () => {
    expect(fire("penalty_clause", "The Customer must pay liquidated damages of $500 per day.")).toBe(true)
    expect(fire("penalty_clause", "The deposit is forfeited if the buyer does not settle.")).toBe(true)
  })

  it("catches an automatic renewal and a unilateral price rise", () => {
    expect(fire("auto_renewal", "The subscription automatically renews for a further 12 months.")).toBe(true)
    expect(fire("unilateral_price_increase", "We reserve the right to increase the fees on notice.")).toBe(true)
  })

  it("catches GST-exclusive pricing", () => {
    expect(fire("gst_exclusive_pricing", "All prices are $99 plus GST.")).toBe(true)
    expect(fire("gst_exclusive_pricing", "The price is $99 including GST.")).toBe(false)
  })
})

describe("consumer guarantee and liability signals", () => {
  it("catches an attempted exclusion of the statutory guarantees", () => {
    expect(fire("guarantee_exclusion", "All warranties and conditions are excluded.")).toBe(true)
    expect(fire("guarantee_exclusion", "No refunds under any circumstances.")).toBe(true)
    expect(fire("guarantee_exclusion", "Goods are sold as is.")).toBe(true)
  })

  it("names ACL s 64 as the provision to read", () => {
    expect(byId.get("guarantee_exclusion")?.references.join(" ")).toContain("s 64")
  })

  it("catches liability caps and broad indemnities", () => {
    expect(fire("liability_cap", "Our total liability is limited to the fees paid.")).toBe(true)
    expect(fire("liability_cap", "We shall not be liable for any consequential loss.")).toBe(true)
    expect(fire("broad_indemnity", "The Supplier indemnifies the Customer against any and all claims.")).toBe(true)
    expect(fire("broad_indemnity", "The Supplier will hold harmless the Customer.")).toBe(true)
  })

  it("catches a perpetual confidentiality obligation only in a confidentiality context", () => {
    expect(fire("perpetual_confidentiality", "The confidentiality obligation continues in perpetuity.")).toBe(true)
    expect(fire("perpetual_confidentiality", "The licence continues in perpetuity.")).toBe(false)
  })
})

describe("employment, restraint and privacy signals", () => {
  it("catches a restraint of trade and names the NSW read-down power", () => {
    expect(fire("restraint_of_trade", "The Employee must not be employed by any competing business for 12 months.")).toBe(true)
    expect(fire("restraint_of_trade", "You must not solicit clients of the Company.")).toBe(true)
    expect(byId.get("restraint_of_trade")?.explanation).toContain("Restraints of Trade Act 1976 (NSW)")
  })

  it("catches contractor labelling with employee-like control", () => {
    const text = "The Contractor holds an ABN. The Contractor must work the hours rostered by the Company."
    expect(fire("sham_contracting", text)).toBe(true)
    expect(fire("sham_contracting", "The Contractor holds an ABN and may subcontract the work.")).toBe(false)
  })

  it("catches unpaid work", () => {
    expect(fire("unpaid_work", "The first four weeks are an unpaid trial.")).toBe(true)
    expect(fire("unpaid_work", "No payment is made during training.")).toBe(true)
  })

  it("catches an all-inclusive salary set-off", () => {
    expect(fire("employment_restraint_of_hours", "Your salary is inclusive of all overtime and penalty rates.")).toBe(true)
  })

  it("requires a privacy context before firing the personal information rules", () => {
    expect(fire("privacy_handling", "We may share personal information with our marketing partners.")).toBe(true)
    expect(fire("privacy_handling", "We may share inventory data with our marketing partners.")).toBe(false)
    expect(fire("offshore_data", "Your personal information may be stored offshore.")).toBe(true)
    expect(fire("offshore_data", "Our servers are offshore.")).toBe(false)
  })
})

describe("computeRiskScore", () => {
  it("grades by weighted severity, with notes carrying no weight", () => {
    expect(computeRiskScore([])).toMatchObject({ score: 0, grade: "low" })
    expect(computeRiskScore([{ severity: "low" }])).toMatchObject({ score: 0, grade: "low" })
    expect(computeRiskScore([{ severity: "medium" }])).toMatchObject({ score: 1, grade: "moderate" })
    expect(computeRiskScore([{ severity: "high" }, { severity: "medium" }])).toMatchObject({ score: 4, grade: "elevated" })
    expect(computeRiskScore(Array(4).fill({ severity: "high" }))).toMatchObject({ score: 12, grade: "high" })
  })
})

describe("extractAmounts", () => {
  it("reads the Australian money forms", () => {
    const values = extractAmounts("Pay $1,500 or A$2,000, being AUD 3,000 in total, or 1,500 dollars.").map((a) => a.value)
    expect(values).toContain("$1,500")
    expect(values).toContain("A$2,000")
    expect(values).toContain("AUD 3,000")
    expect(values).toContain("1,500 dollars")
  })

  it("reads scaled and decimal amounts", () => {
    const values = extractAmounts("A cap of $1.5 million and a fee of $99.95.").map((a) => a.value)
    expect(values).toContain("$1.5 million")
    expect(values).toContain("$99.95")
  })

  it("reads percentages separately from money", () => {
    const found = extractAmounts("Interest of 12% per annum, or 5 per cent of the price.")
    expect(found.filter((item) => item.label === "percentage").map((item) => item.value)).toEqual(["12%", "5 per cent"])
  })

  it("deduplicates a repeated headline figure", () => {
    expect(extractAmounts("$1,500 is payable. The $1,500 is non-refundable.")).toHaveLength(1)
  })

  it("finds nothing in text with no figures", () => {
    expect(extractAmounts("The parties agree to act reasonably.")).toEqual([])
  })
})

describe("extractPeriods", () => {
  it("labels a notice period and a deadline", () => {
    const found = extractPeriods("Either party may terminate on 30 days notice. Payment is due within 7 business days.")
    expect(found).toContainEqual({ label: "notice period", value: "30 days" })
    expect(found).toContainEqual({ label: "deadline", value: "7 business days" })
  })

  it("labels a contract term and a bare period", () => {
    const found = extractPeriods("The term is 12 months. A restraint of 6 months applies.")
    expect(found).toContainEqual({ label: "term", value: "12 months" })
    expect(found.map((item) => item.value)).toContain("6 months")
  })

  it("does not repeat one value under a second, weaker label", () => {
    const found = extractPeriods("Terminate on 14 days notice; the 14 days runs from receipt.")
    expect(found.filter((item) => item.value === "14 days")).toHaveLength(1)
  })

  it("reads Australian date forms", () => {
    const values = extractPeriods("This agreement ends on 30 June 2027, or 1/07/2027 if extended.").map((p) => p.value)
    expect(values).toContain("30 June 2027")
    expect(values).toContain("1/07/2027")
  })
})

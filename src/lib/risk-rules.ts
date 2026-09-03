/**
 * Document risk rules — the reference server's rule engine with Australian
 * content.
 *
 * The engine is deliberately dumb: regex signals over clause text, a severity
 * weight, and an explanation that names the statute a lawyer would check. It
 * is a **triage aid, not advice**, and two properties keep it honest:
 *
 *  - **A hit is a flag, not a finding.** "Matches an unfair-contract-term
 *    signal" is not "this term is void" — voidness under ACL s 24 depends on
 *    facts the text alone cannot supply (standard form, significant
 *    imbalance, detriment). Every explanation is written so it cannot be
 *    quoted as a conclusion.
 *  - **No rule claims a provision this server has not verified.** References
 *    reuse the pinpoints already carried by the seed dictionary and the alias
 *    table; where the governing law is state-by-state (restraint of trade,
 *    residential tenancy) the rule says so instead of picking one state.
 *
 * Amount and period extraction is Australian-shaped: `$1,500`, `AUD 2,000`,
 * `1,500 dollars`, `$1.5 million`, `14 days`, `within 7 business days`.
 */

export type RiskCategory =
  | "unfair_terms"
  | "consumer_guarantees"
  | "liability"
  | "employment"
  | "privacy"
  | "restraint"
  | "pricing"
  | "process"

export type Severity = "high" | "medium" | "low"

export interface RiskRule {
  id: string
  category: RiskCategory
  name: string
  /** Every pattern must match for the rule to fire. */
  requires?: RegExp[]
  /** At least one must match. A rule with neither `requires` nor `anyOf` never fires. */
  anyOf?: RegExp[]
  severity: Severity
  /** What the pattern indicates — phrased as a signal, never as a verdict. */
  explanation: string
  /** The concrete next step for the reader. */
  suggestion: string
  /** Statutory anchors to read; empty when the governing law varies by state. */
  references: string[]
}

const ACL_UCT = "Competition and Consumer Act 2010 (Cth) sch 2 (ACL) pt 2-3 (ss 23-28)"
const ACL_UNFAIR = "Competition and Consumer Act 2010 (Cth) sch 2 (ACL) s 24"
const ACL_GUARANTEES = "Competition and Consumer Act 2010 (Cth) sch 2 (ACL) ss 51-64"

export const RISK_RULES: readonly RiskRule[] = [
  {
    id: "uct_unilateral_variation",
    category: "unfair_terms",
    name: "Unilateral variation right",
    anyOf: [
      /\b(?:may|can|reserves? the right to|is entitled to)\b[^.]{0,80}\b(?:vary|amend|change|modify)\b[^.]{0,80}\b(?:at (?:its|our|his|her|their) (?:sole |absolute )?discretion|without notice|at any time|without (?:the )?consent)/i,
      /\b(?:vary|amend|change) these terms\b[^.]{0,60}\bat any time\b/i,
    ],
    severity: "high",
    explanation:
      "Signals a term letting one party change the contract unilaterally — the example of an unfair term given in ACL s 25(1)(d). Whether it is actually void depends on the contract being standard form and the s 24 limbs being satisfied.",
    suggestion:
      "Check whether the contract is a standard form consumer or small business contract, then read ACL ss 23-25. Negotiate a notice period plus a right to exit on variation.",
    references: [ACL_UCT, ACL_UNFAIR],
  },
  {
    id: "uct_unilateral_termination",
    category: "unfair_terms",
    name: "One-sided termination right",
    anyOf: [
      /\b(?:may|can) terminate\b[^.]{0,80}\b(?:immediately|without (?:cause|reason|notice)|for any reason|at (?:its|our) (?:sole |absolute )?discretion)/i,
      /\btermination for convenience\b/i,
    ],
    severity: "high",
    explanation:
      "Signals a termination right available to one party only, or without cause — the ACL s 25(1)(b) example. In a supply agreement it also raises the question of what happens to work already performed.",
    suggestion:
      "Look for a mirrored right and a notice period, and for payment of work in progress on termination. Read ACL ss 24-25.",
    references: [ACL_UCT],
  },
  {
    id: "penalty_clause",
    category: "unfair_terms",
    name: "Penalty-style payment on breach",
    anyOf: [
      /\bpenalt(?:y|ies)\b[^.]{0,60}\b(?:payable|of|amounting)/i,
      /\bliquidated damages\b/i,
      // Both orders: "forfeits the deposit" and "the deposit is forfeited".
      /\bforfeit(?:s|ed|ure)?\b[^.]{0,60}\b(?:deposit|payment|amount|instal?ments?)/i,
      /\b(?:deposit|payment|amount|instal?ments?)\b[^.]{0,60}\bforfeit(?:s|ed|ure)?\b/i,
      /\b(?:pay|payable)\b[^.]{0,40}\bas a genuine pre-?estimate\b/i,
    ],
    severity: "medium",
    explanation:
      "Signals a sum payable on breach. Australian law strikes down a stipulation that is out of all proportion to the interest it protects (the penalties doctrine restated in Andrews and Paciocco); ACL s 25(1)(f) also lists a one-sided penalty as an unfair-term example.",
    suggestion:
      "Compare the sum to the loss a breach would actually cause. A genuine pre-estimate survives; a deterrent figure is at risk.",
    references: [ACL_UNFAIR],
  },
  {
    id: "restraint_of_trade",
    category: "restraint",
    name: "Non-compete or restraint of trade",
    anyOf: [
      /\b(?:non-?compet(?:e|ition)|restraint of trade)\b/i,
      /\b(?:must|shall|will|may) not\b[^.]{0,40}\b(?:be )?(?:engaged?|employed|involved|work|carry on)\b[^.]{0,80}\b(?:compet|similar business|same industry)/i,
      /\b(?:must|shall|will) not\b[^.]{0,60}\b(?:solicit|poach|entice)\b[^.]{0,40}\b(?:clients?|customers?|employees?|staff)/i,
      /\bcascading\b[^.]{0,40}\brestraint/i,
    ],
    severity: "medium",
    explanation:
      "Signals a post-employment or post-sale restraint. Restraints are void at common law unless reasonable in duration, area and scope; New South Wales is the outlier — Restraints of Trade Act 1976 (NSW) s 4 lets a court read a too-wide restraint down instead of striking it out. Other states have no such power.",
    suggestion:
      "Identify the governing law first: the same clause can be severable in NSW and wholly void elsewhere. Then test duration, geography and the legitimate interest protected.",
    references: ["Restraints of Trade Act 1976 (NSW) s 4"],
  },
  {
    id: "guarantee_exclusion",
    category: "consumer_guarantees",
    name: "Attempt to exclude the consumer guarantees",
    anyOf: [
      /\b(?:all|any)\b[^.]{0,60}\b(?:warrant(?:y|ies)|guarantees?|conditions?)\b[^.]{0,60}\b(?:are|is)\b[^.]{0,30}\bexcluded\b/i,
      /\bto the (?:maximum|fullest) extent permitted by law\b[^.]{0,80}\b(?:exclude|disclaim)/i,
      /\bno (?:refunds?|returns?)\b/i,
      /\bsold as is\b/i,
    ],
    severity: "high",
    explanation:
      "Signals an attempted exclusion of statutory guarantees. ACL s 64 makes any term excluding, restricting or modifying the consumer guarantees void, and misrepresenting that they do not apply is itself a contravention. s 64A permits limitation to resupply or refund only for goods and services not ordinarily acquired for personal, domestic or household use.",
    suggestion:
      "Check whether the supply is to a consumer within ACL s 3. If it is, the exclusion does not work and the 'no refunds' wording is separately risky.",
    references: [ACL_GUARANTEES, "Competition and Consumer Act 2010 (Cth) sch 2 (ACL) s 64"],
  },
  {
    id: "liability_cap",
    category: "liability",
    name: "Liability cap or total exclusion",
    anyOf: [
      /\b(?:total|aggregate|maximum) liability\b[^.]{0,80}\b(?:limited|capped|shall not exceed)/i,
      /\b(?:excludes?|shall not be liable)\b[^.]{0,80}\b(?:consequential|indirect|economic loss|loss of profits?)/i,
      /\bunder no circumstances\b[^.]{0,60}\bliable\b/i,
    ],
    severity: "medium",
    explanation:
      "Signals a cap or exclusion of liability. Caps are ordinary commercial practice, but they cannot cut across the ACL consumer guarantees (s 64) and a cap far below foreseeable loss in a standard form contract is an unfair-term signal.",
    suggestion:
      "Check the cap against the realistic worst case, and confirm the carve-out for liability that cannot lawfully be limited (guarantees, personal injury, fraud).",
    references: ["Competition and Consumer Act 2010 (Cth) sch 2 (ACL) ss 64, 64A", ACL_UNFAIR],
  },
  {
    id: "broad_indemnity",
    category: "liability",
    name: "Broad or one-way indemnity",
    anyOf: [
      /\bindemnif(?:y|ies|ied)\b[^.]{0,120}\b(?:any and all|all)\b[^.]{0,60}\b(?:claims?|losses?|damages?|liabilit)/i,
      /\bhold harmless\b/i,
      /\bindemnify\b[^.]{0,80}\b(?:howsoever|whether or not)\b[^.]{0,60}\b(?:caused|negligen)/i,
    ],
    severity: "high",
    explanation:
      "Signals an indemnity broad enough to cover loss the indemnifying party did not cause, including the other side's own negligence. In a standard form contract a one-way indemnity is a listed unfair-term example (ACL s 25(1)(e)-(f)); it is also usually outside what insurance will respond to.",
    suggestion:
      "Check whether the indemnity is mutual, whether it is limited to loss caused by the indemnifier, and whether the insurer has been told about it.",
    references: [ACL_UCT],
  },
  {
    id: "privacy_handling",
    category: "privacy",
    name: "Personal information handling clause",
    requires: [/\b(?:personal information|personal data|privacy policy)\b/i],
    anyOf: [
      /\b(?:collect|use|disclose|share)\b[^.]{0,80}\b(?:third part(?:y|ies)|partners|affiliates|marketing)/i,
      /\bconsent\b[^.]{0,60}\b(?:by using|by continuing|deemed)/i,
      /\bwe may change (?:this|our) privacy policy\b/i,
    ],
    severity: "medium",
    explanation:
      "Signals collection, use or disclosure of personal information. APP 3 limits collection to what is reasonably necessary, APP 6 confines use and disclosure to the primary purpose or a related purpose the individual would expect, and bundled or deemed consent is generally not consent at all.",
    suggestion:
      "Check the APP 5 collection notice, whether consent is genuinely separable, and whether the entity is even an APP entity (Privacy Act s 6D small-business exemption).",
    references: ["Privacy Act 1988 (Cth) sch 1 (APPs 3, 5, 6)", "Privacy Act 1988 (Cth) s 6D"],
  },
  {
    id: "offshore_data",
    category: "privacy",
    name: "Overseas disclosure of personal information",
    requires: [/\b(?:personal information|personal data|your data)\b/i],
    anyOf: [
      /\b(?:overseas|offshore|outside australia|other countr(?:y|ies)|united states|singapore|ireland)\b/i,
      /\bcross-?border\b/i,
    ],
    severity: "medium",
    explanation:
      "Signals a cross-border disclosure. APP 8 requires reasonable steps to ensure the overseas recipient complies, and Privacy Act s 16C keeps the discloser accountable for the recipient's acts unless an exception applies — so naming the country is not by itself compliance.",
    suggestion:
      "Check which APP 8.2 exception is relied on, and whether the individual was told about the likely overseas recipients under APP 5.",
    references: ["Privacy Act 1988 (Cth) sch 1 (APP 8)", "Privacy Act 1988 (Cth) s 16C"],
  },
  {
    id: "sham_contracting",
    category: "employment",
    name: "Contractor label over employee-like control",
    requires: [/\b(?:independent contractor|contractor|abn)\b/i],
    anyOf: [
      /\b(?:must|shall|will)\b[^.]{0,60}\b(?:work|attend|be available)\b[^.]{0,60}\b(?:hours|roster|shift|premises)/i,
      /\bnot (?:an )?employee\b[^.]{0,80}\bno entitlement\b/i,
      /\b(?:no|not entitled to)\b[^.]{0,40}\b(?:leave|superannuation|annual leave|entitlements)/i,
    ],
    severity: "high",
    explanation:
      "Signals a contractor arrangement carrying employee-like control or a disclaimer of entitlements. FW Act s 357 prohibits misrepresenting employment as independent contracting, and s 15AA now directs attention to the real substance of the relationship rather than the label the contract uses.",
    suggestion:
      "Test control, integration, delegation and commercial risk against the contract's label. Superannuation can be payable under the extended definition even for a genuine contractor.",
    references: ["Fair Work Act 2009 (Cth) ss 357, 15AA"],
  },
  {
    id: "unpaid_work",
    category: "employment",
    name: "Unpaid work or trial period",
    anyOf: [
      /\b(?:unpaid)\b[^.]{0,40}\b(?:internship|placement|trial|work experience|probation)/i,
      /\b(?:no|without) (?:payment|remuneration|wages)\b[^.]{0,60}\b(?:during|for)\b[^.]{0,40}\b(?:trial|training|induction|probation)/i,
    ],
    severity: "high",
    explanation:
      "Signals unpaid work. It is lawful only as a vocational placement within FW Act s 12 (required by an education course and unpaid) or as a genuinely brief, supervised trial. Otherwise the person is an employee and the NES and any award apply from the first hour.",
    suggestion:
      "Check whether the arrangement is a course-required placement. If it is not, price the underpayment exposure, including accessorial liability for managers under FW Act s 550.",
    references: ["Fair Work Act 2009 (Cth) ss 12, 550"],
  },
  {
    id: "employment_restraint_of_hours",
    category: "employment",
    name: "Set-off or all-inclusive salary clause",
    anyOf: [
      /\b(?:salary|remuneration|rate)\b[^.]{0,80}\b(?:includes?|is inclusive of|compensates? for)\b[^.]{0,60}\b(?:overtime|penalt(?:y|ies)|allowances?|loading)/i,
      /\bset-?off\b[^.]{0,60}\b(?:award|entitlements?)/i,
    ],
    severity: "medium",
    explanation:
      "Signals an annualised or all-inclusive wage absorbing award entitlements. A set-off clause only works if it is clear about which entitlements the payment covers, and the employee must still be better off overall against the award in each pay period.",
    suggestion:
      "Reconcile actual hours against the applicable modern award. Annualised wage arrangements in many awards carry mandatory record-keeping and annual reconciliation.",
    references: ["Fair Work Act 2009 (Cth) pt 2-3 (modern awards)"],
  },
  {
    id: "gst_exclusive_pricing",
    category: "pricing",
    name: "GST-exclusive or component pricing",
    anyOf: [
      /\b(?:plus|ex(?:cluding|clusive of)?\.?)\s*gst\b/i,
      /\bgst\b[^.]{0,30}\b(?:not included|extra|additional)/i,
      /\bprices? (?:are|is) exclusive of\b/i,
    ],
    severity: "medium",
    explanation:
      "Signals a price quoted without GST. ACL s 48 requires a single total price to be stated prominently whenever part of a price is quoted to a consumer; between registered businesses GST-exclusive quoting is normal, so the risk turns on who the audience is.",
    suggestion:
      "Check whether the price is presented to consumers. If so, show the GST-inclusive total at least as prominently as the component.",
    references: ["Competition and Consumer Act 2010 (Cth) sch 2 (ACL) s 48"],
  },
  {
    id: "auto_renewal",
    category: "unfair_terms",
    name: "Automatic renewal or rollover",
    anyOf: [
      /\b(?:automatically|auto-?)\s*(?:renew|renews|renewed|renewal|roll(?:s|ed)? over|extend)/i,
      /\bunless (?:you|the customer|either party) (?:give|gives|provide|provides) (?:written )?notice\b[^.]{0,60}\b(?:renew|continue|extend)/i,
    ],
    severity: "medium",
    explanation:
      "Signals an evergreen term. ACL s 25(1)(g) lists a term permitting one party to renew or not renew as an unfair-term example, and a rollover combined with a short cancellation window is a recurring regulator concern.",
    suggestion:
      "Check the notice window, whether a reminder is given before rollover, and whether the price can change on renewal.",
    references: [ACL_UCT],
  },
  {
    id: "unilateral_price_increase",
    category: "pricing",
    name: "Unilateral price increase",
    anyOf: [
      /\b(?:may|can|reserves? the right to)\b[^.]{0,60}\b(?:increase|vary|adjust)\b[^.]{0,40}\b(?:the )?(?:price|fees?|charges?|rates?)/i,
      /\bprices? (?:are )?subject to change without notice\b/i,
    ],
    severity: "medium",
    explanation:
      "Signals a right to raise the price after the contract is on foot. ACL s 25(1)(i) lists a unilateral price variation without a right to terminate as an unfair-term example.",
    suggestion: "Look for a matching exit right, a cap, or an objective index the increase is tied to.",
    references: [ACL_UCT],
  },
  {
    id: "cooling_off",
    category: "process",
    name: "Cooling-off reference",
    anyOf: [/\bcooling[- ]off\b/i, /\bno cooling[- ]off (?:period|right)\b/i],
    severity: "low",
    explanation:
      "Mentions a cooling-off right. There is no general cooling-off period in Australian law: it exists where a statute creates one, such as ACL s 82 for unsolicited consumer agreements, or under state property, credit and insurance regimes. A contract asserting there is none may simply be describing the default.",
    suggestion:
      "Identify how the agreement was formed. If it followed an uninvited approach, ACL pt 3-2 div 2 applies whatever the contract says.",
    references: ["Competition and Consumer Act 2010 (Cth) sch 2 (ACL) s 82"],
  },
  {
    id: "jurisdiction_clause",
    category: "process",
    name: "Governing law or exclusive jurisdiction",
    anyOf: [
      /\bgoverned by the laws? of\b/i,
      /\b(?:exclusive|non-?exclusive) jurisdiction of the courts? of\b/i,
      /\bsubmit to the jurisdiction of\b/i,
      /\bvenue\b[^.]{0,40}\bcourts? of\b/i,
    ],
    severity: "low",
    explanation:
      "Identifies the governing law and forum. It matters more in Australia than it looks: restraint severance, civil liability caps, limitation periods and stamp duty all differ by state, and a foreign forum can make a small claim uneconomic to run.",
    suggestion:
      "Confirm the named jurisdiction matches where the parties and the work actually are, and note which state's Civil Liability, Limitation and restraint rules follow from it.",
    references: [],
  },
  {
    id: "ip_assignment",
    category: "liability",
    name: "Broad intellectual property assignment",
    anyOf: [
      /\b(?:assigns?|assigned|vests?)\b[^.]{0,80}\b(?:all|any)\b[^.]{0,60}\b(?:intellectual property|copyright|inventions?)/i,
      /\bmoral rights?\b[^.]{0,60}\b(?:consent|waive)/i,
      /\bpre-?existing (?:ip|intellectual property)\b[^.]{0,60}\bassign/i,
    ],
    severity: "medium",
    explanation:
      "Signals an assignment wider than the engagement. Moral rights cannot be assigned in Australia — only consented to — and background IP swept into the assignment is a common drafting overreach.",
    suggestion:
      "Carve out background IP and licence it instead, and check the moral-rights wording is a consent rather than a purported assignment.",
    references: [],
  },
  {
    id: "perpetual_confidentiality",
    category: "liability",
    name: "Perpetual or unbounded confidentiality",
    requires: [/\b(?:confidential|confidentiality|non-?disclosure)\b/i],
    anyOf: [
      /\b(?:in perpetuity|perpetual|indefinitely|without limit(?:ation)? (?:of|in) time|forever)\b/i,
      /\ball information\b[^.]{0,60}\b(?:disclosed|provided)\b/i,
    ],
    severity: "medium",
    explanation:
      "Signals a confidentiality obligation with no end date or no defined subject matter. Trade secrets can justify a perpetual obligation; ordinary commercial information usually cannot, and an undefined 'all information' definition is hard to comply with and hard to enforce.",
    suggestion:
      "Define the confidential information by category, add the standard carve-outs (public domain, independently developed, compelled by law) and set a term for non-trade-secret material.",
    references: [],
  },
]

export function matchRule(rule: RiskRule, text: string): boolean {
  if (rule.requires && !rule.requires.every((pattern) => pattern.test(text))) return false
  if (rule.anyOf && rule.anyOf.length > 0) return rule.anyOf.some((pattern) => pattern.test(text))
  return (rule.requires?.length ?? 0) > 0
}

export type RiskGrade = "low" | "moderate" | "elevated" | "high"

const GRADE_LABELS: Record<RiskGrade, string> = {
  low: "Low",
  moderate: "Moderate",
  elevated: "Elevated",
  high: "High",
}

const WEIGHTS: Record<Severity, number> = { high: 3, medium: 1, low: 0 }

export function computeRiskScore(findings: readonly { severity: Severity }[]): {
  score: number
  grade: RiskGrade
  gradeLabel: string
} {
  const score = findings.reduce((total, finding) => total + WEIGHTS[finding.severity], 0)
  const grade: RiskGrade = score === 0 ? "low" : score <= 3 ? "moderate" : score <= 8 ? "elevated" : "high"
  return { score, grade, gradeLabel: GRADE_LABELS[grade] }
}

// ── amount and period extraction ─────────────────────────────────────────

export interface Extracted {
  label: string
  value: string
}

// Longest scale word first: JavaScript alternation is leftmost-first, so
// `m|million` would capture "$1.5 m" out of "$1.5 million".
const SCALE = "(?:\\s*(?:billion|million|thousand|bn|k|m)\\b)?"
const AUD_NUMBER = `\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?${SCALE}`

const AMOUNT_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "AUD amount", re: new RegExp(`(?:A?\\$|AUD\\s*)(${AUD_NUMBER})`, "gi") },
  { label: "AUD amount", re: new RegExp(`\\b(${AUD_NUMBER})\\s*(?:australian )?dollars\\b`, "gi") },
  // No trailing \b after `%`: `%` and the following space are both non-word
  // characters, so a boundary there never matches and "12% per annum" is lost.
  { label: "percentage", re: /\b(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|\bper ?cent\b)/gi },
]

/**
 * Pull money and percentages out of a document. Deduplicated on the
 * normalised value, because a contract repeats its headline figure and a
 * reader scanning "key numbers" needs the set, not the frequency.
 */
export function extractAmounts(text: string): Extracted[] {
  const results: Extracted[] = []
  const seen = new Set<string>()
  for (const pattern of AMOUNT_PATTERNS) {
    const matches = text.matchAll(pattern.re)
    for (const match of matches) {
      const raw = match[0].trim().replace(/\s+/g, " ")
      const key = `${pattern.label}:${raw.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ label: pattern.label, value: raw })
    }
  }
  return results
}

const PERIOD_UNIT = "(?:business |working |calendar )?(?:day|week|month|year)s?"

const PERIOD_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "notice period", re: new RegExp(`\\b(?:notice|terminate|termination)\\b[^.]{0,60}?\\b(\\d{1,4}\\s*${PERIOD_UNIT})`, "gi") },
  { label: "deadline", re: new RegExp(`\\bwithin\\s+(\\d{1,4}\\s*${PERIOD_UNIT})`, "gi") },
  { label: "term", re: new RegExp(`\\b(?:term|period|duration)\\b[^.]{0,40}?\\b(\\d{1,4}\\s*${PERIOD_UNIT})`, "gi") },
  { label: "period", re: new RegExp(`\\b(\\d{1,4}\\s*${PERIOD_UNIT})\\b`, "gi") },
  {
    label: "date",
    re: /\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/gi,
  },
]

/**
 * Pull time periods and dates out of a document. The labelled patterns run
 * before the bare one, and a value already captured under a specific label is
 * not repeated as a generic "period" — otherwise every notice period appears
 * twice and the summary reads as if there were two of them.
 */
export function extractPeriods(text: string): Extracted[] {
  const results: Extracted[] = []
  const values = new Set<string>()
  for (const pattern of PERIOD_PATTERNS) {
    const matches = text.matchAll(pattern.re)
    for (const match of matches) {
      const raw = (match[1] ?? match[0]).trim().replace(/\s+/g, " ")
      const key = raw.toLowerCase()
      if (values.has(key)) continue
      values.add(key)
      results.push({ label: pattern.label, value: raw })
    }
  }
  return results
}

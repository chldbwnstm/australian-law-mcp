/**
 * Document-type classification, clause splitting and clause-conflict
 * heuristics — the non-rule half of the reference server's document analyser,
 * kept beside `risk-rules.ts` rather than inside it so neither file becomes a
 * grab bag.
 *
 * Two Australian specifics shape the vocabulary. Documents here are numbered
 * `1.`, `1.1`, `Clause 4` or `Schedule 2` rather than the Korean `제N조`, so
 * clause splitting keys off decimal numbering. And the type profiles include
 * the two documents an Australian self-represented litigant most often
 * arrives with — a letter of demand and a statement of claim — because
 * telling those apart from a contract changes every downstream suggestion.
 */

export type DocType =
  | "contract"
  | "employment"
  | "lease"
  | "nda"
  | "terms_of_service"
  | "letter_of_demand"
  | "statement_of_claim"
  | "unknown"

interface Signal {
  keyword: RegExp
  weight: number
}

const kw = (source: string, weight: number): Signal => ({ keyword: new RegExp(source, "i"), weight })

const DOC_SIGNALS: Record<DocType, Signal[]> = {
  employment: [
    kw("\\bemployment agreement\\b", 5), kw("\\bcontract of employment\\b", 5),
    kw("\\bthe employee\\b", 4), kw("\\bthe employer\\b", 4),
    kw("\\bmodern award\\b", 4), kw("\\bannual leave\\b", 3),
    kw("\\bpersonal/carer's leave\\b", 3), kw("\\bsuperannuation\\b", 2),
    kw("\\bposition description\\b", 2), kw("\\bprobation(?:ary)? period\\b", 2),
    kw("\\bnational employment standards\\b", 4), kw("\\bordinary hours\\b", 3),
  ],
  lease: [
    kw("\\bthe (?:lessor|landlord)\\b", 5), kw("\\bthe (?:lessee|tenant)\\b", 5),
    kw("\\bresidential tenancy\\b", 5), kw("\\brental bond\\b", 4),
    kw("\\bpremises\\b", 2), kw("\\brent\\b", 2),
    kw("\\bmake good\\b", 3), kw("\\boutgoings\\b", 4),
    kw("\\bretail lease\\b", 5), kw("\\bquiet enjoyment\\b", 3),
  ],
  nda: [
    kw("\\bnon-?disclosure agreement\\b", 5), kw("\\bconfidentiality (?:agreement|deed)\\b", 5),
    kw("\\bconfidential information\\b", 4), kw("\\bdiscloser\\b", 4),
    kw("\\brecipient\\b", 2), kw("\\btrade secrets?\\b", 3),
    kw("\\bpermitted purpose\\b", 3),
  ],
  terms_of_service: [
    kw("\\bterms (?:of service|and conditions|of use)\\b", 5), kw("\\bthe (?:website|platform|app|service)\\b", 3),
    kw("\\bprivacy policy\\b", 3), kw("\\byour account\\b", 3),
    kw("\\bacceptable use\\b", 3), kw("\\bsubscription\\b", 2),
    kw("\\bwe may (?:suspend|terminate) your account\\b", 4), kw("\\buser content\\b", 3),
  ],
  letter_of_demand: [
    kw("\\bletter of demand\\b", 6), kw("\\bwe (?:hereby )?demand\\b", 5),
    kw("\\bfailing which\\b[^.]{0,60}\\bproceedings\\b", 5), kw("\\bwithout prejudice\\b", 2),
    kw("\\bpay the sum of\\b", 4), kw("\\blegal proceedings will be commenced\\b", 5),
    kw("\\bconcerns notice\\b", 4),
  ],
  statement_of_claim: [
    kw("\\bstatement of claim\\b", 6), kw("\\bthe plaintiff\\b", 5),
    kw("\\bthe defendant\\b", 4), kw("\\bparticulars\\b", 3),
    kw("\\bthe plaintiff claims\\b", 5), kw("\\bfiled in the\\b[^.]{0,40}\\bcourt\\b", 4),
    kw("\\bcause of action\\b", 3), kw("\\bprayer for relief\\b", 4),
  ],
  contract: [
    kw("\\bthis agreement\\b", 3), kw("\\bthe parties agree\\b", 3),
    kw("\\bin consideration of\\b", 3), kw("\\bexecuted as an agreement\\b", 3),
    kw("\\bservices\\b", 1), kw("\\bthe supplier\\b", 2), kw("\\bthe customer\\b", 2),
  ],
  unknown: [],
}

export const DOC_LABELS: Record<DocType, string> = {
  contract: "General commercial contract",
  employment: "Employment agreement",
  lease: "Lease or tenancy agreement",
  nda: "Non-disclosure / confidentiality agreement",
  terms_of_service: "Website or platform terms of service",
  letter_of_demand: "Letter of demand",
  statement_of_claim: "Statement of claim (court document)",
  unknown: "Unclassified document",
}

/**
 * Best-scoring profile, or `unknown` when nothing clears the floor.
 *
 * The floor matters: a two-line note that happens to contain "services"
 * should come back unclassified rather than as a contract, because the
 * downstream suggestions are only useful when the type is actually right.
 */
export function classifyDocument(text: string): DocType {
  const scores = new Map<DocType, number>()
  for (const [type, signals] of Object.entries(DOC_SIGNALS) as [DocType, Signal[]][]) {
    let score = 0
    for (const signal of signals) if (signal.keyword.test(text)) score += signal.weight
    scores.set(type, score)
  }
  // A court document and a demand letter both quote contract language; the
  // procedural signals win because the reader's next step is different.
  const claim = scores.get("statement_of_claim") ?? 0
  const demand = scores.get("letter_of_demand") ?? 0
  if (claim >= 6 || demand >= 6) return claim >= demand ? "statement_of_claim" : "letter_of_demand"

  let best: DocType = "unknown"
  let bestScore = 4
  for (const [type, score] of scores) {
    if (score > bestScore) {
      best = type
      bestScore = score
    }
  }
  return best
}

export interface Clause {
  label: string
  body: string
}

/** `1.`, `1.1`, `12.3.4`, `Clause 7`, `Schedule 2` at the start of a line. */
const CLAUSE_HEAD = /^[ \t]*(?:(?:clause|schedule|annexure|item)\s+)?(\d{1,3}(?:\.\d{1,3}){0,3})\.?\s+(?=\S)/i

/**
 * Split a document into numbered clauses. Falls back to an empty list when
 * the document is not numbered (a demand letter, a plain-prose agreement) —
 * the caller then scans the whole text instead, which is why no synthetic
 * "Clause 1" is invented here.
 */
export function extractClauses(text: string, max: number): Clause[] {
  const clauses: Clause[] = []
  const lines = text.split(/\r?\n/)
  let current: Clause | null = null
  for (const line of lines) {
    const head = CLAUSE_HEAD.exec(line)
    if (head) {
      if (current) clauses.push(current)
      if (clauses.length >= max) return clauses
      current = { label: head[1], body: line.slice(head[0].length).trim() }
    } else if (current) {
      const trimmed = line.trim()
      if (trimmed) current.body = `${current.body} ${trimmed}`.slice(0, 1200)
    }
  }
  if (current && clauses.length < max) clauses.push(current)
  return clauses
}

export interface ConflictResult {
  type: string
  description: string
  clauseA?: string
  clauseB?: string
}

interface ConflictRule {
  type: string
  description: string
  patternA: RegExp
  patternB: RegExp
}

const CONFLICT_RULES: readonly ConflictRule[] = [
  {
    type: "notice period vs immediate termination",
    description:
      "The document sets a notice period for termination and also allows termination with immediate effect. Which prevails is unstated, and the difference is the whole value of the notice clause.",
    patternA: /\b(?:notice|terminate|termination)\b[^.]{0,60}\b\d{1,4}\s*(?:business |working |calendar )?(?:day|week|month)s?(?:'|’)?\s*(?:written\s+)?notice/i,
    patternB: /\bterminate\b[^.]{0,60}\b(?:immediately|with immediate effect|without notice)\b/i,
  },
  {
    type: "fixed term vs automatic renewal",
    description:
      "A fixed end date sits alongside an automatic renewal clause, so the actual end of the contract is ambiguous.",
    patternA: /\b(?:expires?|ends?|terminates?|until)\b[^.]{0,40}\b(?:\d{1,2}\s+\w+\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    patternB: /\b(?:automatically|auto-?)\s*(?:renew|renews|renewed|extend)/i,
  },
  {
    type: "liability exclusion vs indemnity",
    description:
      "A clause excludes liability while another requires an indemnity for the same kind of loss. Read together they can cancel out, or the indemnity can swallow the exclusion.",
    patternA: /\b(?:shall not be liable|excludes? (?:all )?liability|no liability)\b/i,
    patternB: /\bindemnif(?:y|ies|ied)\b/i,
  },
  {
    type: "consumer guarantee exclusion vs statutory savings clause",
    description:
      "The document both excludes all warranties and acknowledges rights that cannot be excluded. The ACL s 64 savings wording usually controls, but the two clauses need reconciling before anyone relies on the exclusion.",
    patternA: /\b(?:all|any)\b[^.]{0,60}\bwarrant(?:y|ies)\b[^.]{0,40}\bexcluded\b/i,
    patternB: /\b(?:australian consumer law|cannot be excluded|non-?excludable)\b/i,
  },
  {
    type: "exclusive supply vs reserved third-party rights",
    description:
      "An exclusivity promise coexists with a reservation of rights to supply or appoint others, leaving the scope of the exclusivity unclear.",
    patternA: /\bexclusive\b[^.]{0,60}\b(?:supply|distribut|licen[cs]e|appointment)/i,
    patternB: /\b(?:reserves? the right|may (?:appoint|supply|engage))\b[^.]{0,60}\b(?:third part(?:y|ies)|others?)/i,
  },
]

export function detectConflicts(clauses: readonly Clause[]): ConflictResult[] {
  const results: ConflictResult[] = []
  if (clauses.length < 2) return results
  for (const rule of CONFLICT_RULES) {
    const a = clauses.find((clause) => rule.patternA.test(clause.body))
    const b = clauses.find((clause) => rule.patternB.test(clause.body))
    if (a && b && a.label !== b.label) {
      results.push({ type: rule.type, description: rule.description, clauseA: a.label, clauseB: b.label })
    }
  }
  return results
}

/** Whole-text fallback for documents with no clause numbering. */
export function detectConflictsInText(text: string): ConflictResult[] {
  const results: ConflictResult[] = []
  for (const rule of CONFLICT_RULES) {
    if (rule.patternA.test(text) && rule.patternB.test(text)) {
      results.push({ type: rule.type, description: rule.description })
    }
  }
  return results
}

/** Follow-up searches worth running for each document type. */
export const SEARCH_SUGGESTIONS: Record<DocType, string[]> = {
  contract: [
    "Australian Consumer Law unfair contract terms (ACL pt 2-3)",
    "unconscionable conduct in business transactions (ACL s 21)",
    "penalties doctrine liquidated damages",
  ],
  employment: [
    "Fair Work Act 2009 (Cth) National Employment Standards",
    "applicable modern award coverage and classification",
    "unfair dismissal and general protections (FW Act ss 385, 340)",
    "restraint of trade reasonableness",
  ],
  lease: [
    "residential tenancy legislation for the relevant state",
    "retail leases legislation disclosure statement",
    "make good and outgoings disputes",
  ],
  nda: [
    "confidential information definition and carve-outs",
    "restraint of trade and non-solicitation",
    "breach of confidence remedies",
  ],
  terms_of_service: [
    "Australian Consumer Law consumer guarantees (ACL ss 51-64)",
    "unfair contract terms in standard form contracts (ACL s 24)",
    "Privacy Act 1988 (Cth) Australian Privacy Principles 5, 6, 8",
  ],
  letter_of_demand: [
    "limitation period for the underlying claim",
    "pre-action requirements and offers of compromise",
    "misleading representations about legal proceedings (ACL s 30)",
  ],
  statement_of_claim: [
    "pleading requirements in the relevant court rules",
    "time to file a defence and default judgment risk",
    "summary judgment and strike-out",
  ],
  unknown: [
    "Australian Consumer Law unfair contract terms",
    "the statute governing the subject matter of the document",
  ],
}

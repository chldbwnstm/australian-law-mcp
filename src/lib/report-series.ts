/**
 * Law report series (AGLC4 r 2.2) — the data half of `case-citation.ts`.
 *
 * Two facts per series drive everything downstream:
 *
 *  - **How the volume is organised**, which fixes the bracket. A series
 *    numbered by volume takes round brackets around the year — *Mabo v
 *    Queensland (No 2)* (1992) 175 CLR 1. A series where the year *is* the
 *    volume takes square brackets — *Nydam v The Queen* [1977] VR 430.
 *    Getting this wrong is the most common AGLC slip in generated text.
 *  - **Authorised status and rank** (r 2.2.2), which decides which of several
 *    parallel citations to prefer.
 *
 * A mismatched bracket is reported as a warning, never as "not found". The
 * citation still identifies a real case; only its formatting is wrong, and
 * conflating the two would let a formatting nit read as a hallucination.
 */

export type BracketStyle = "round" | "square"

export interface ReportSeries {
  /** Canonical abbreviation, spaced exactly as AGLC writes it (`A Crim R`). */
  abbrev: string
  name: string
  /** Which bracket the year takes. */
  bracket: BracketStyle
  /**
   * Preference rank from AGLC r 2.2.2:
   * 1 authorised · 2 general unauthorised · 3 subject-specific unauthorised.
   */
  rank: 1 | 2 | 3
  /** Court or jurisdiction whose decisions it reports. */
  scope: string
  /** True where older volumes used the other bracket style. */
  bracketVaries?: true
}

export const REPORT_SERIES: readonly ReportSeries[] = [
  // ── Rank 1: authorised ─────────────────────────────────────────────────
  { abbrev: "CLR", name: "Commonwealth Law Reports", bracket: "round", rank: 1, scope: "High Court of Australia" },
  { abbrev: "FCR", name: "Federal Court Reports", bracket: "round", rank: 1, scope: "Federal Court of Australia" },
  { abbrev: "NSWLR", name: "New South Wales Law Reports", bracket: "round", rank: 1, scope: "New South Wales" },
  { abbrev: "VR", name: "Victorian Reports", bracket: "square", rank: 1, scope: "Victoria" },
  { abbrev: "Qd R", name: "Queensland Reports", bracket: "square", rank: 1, scope: "Queensland" },
  { abbrev: "SASR", name: "South Australian State Reports", bracket: "round", rank: 1, scope: "South Australia" },
  { abbrev: "WAR", name: "Western Australian Reports", bracket: "round", rank: 1, scope: "Western Australia", bracketVaries: true },
  { abbrev: "Tas R", name: "Tasmanian Reports", bracket: "round", rank: 1, scope: "Tasmania", bracketVaries: true },
  { abbrev: "ACTR", name: "Australian Capital Territory Reports", bracket: "round", rank: 1, scope: "Australian Capital Territory" },
  { abbrev: "NTR", name: "Northern Territory Reports", bracket: "round", rank: 1, scope: "Northern Territory" },
  { abbrev: "Fam LR", name: "Family Law Reports", bracket: "round", rank: 1, scope: "Family law" },

  // ── Rank 2: general unauthorised ───────────────────────────────────────
  { abbrev: "ALR", name: "Australian Law Reports", bracket: "round", rank: 2, scope: "Australia (general)" },
  { abbrev: "ALJR", name: "Australian Law Journal Reports", bracket: "round", rank: 2, scope: "High Court of Australia" },
  { abbrev: "FLR", name: "Federal Law Reports", bracket: "round", rank: 2, scope: "Federal and territory courts" },
  { abbrev: "ACTLR", name: "Australian Capital Territory Law Reports", bracket: "round", rank: 2, scope: "Australian Capital Territory" },
  { abbrev: "NSWR", name: "New South Wales Reports", bracket: "round", rank: 2, scope: "New South Wales (historical)" },

  // ── Rank 3: subject-specific unauthorised ──────────────────────────────
  { abbrev: "A Crim R", name: "Australian Criminal Reports", bracket: "round", rank: 3, scope: "Criminal law" },
  { abbrev: "ACSR", name: "Australian Corporations and Securities Reports", bracket: "round", rank: 3, scope: "Corporations" },
  { abbrev: "ACLC", name: "Australian Company Law Cases", bracket: "round", rank: 3, scope: "Corporations" },
  { abbrev: "IR", name: "Industrial Reports", bracket: "round", rank: 3, scope: "Industrial law" },
  { abbrev: "AILR", name: "Australian Industrial Law Review", bracket: "round", rank: 3, scope: "Industrial law" },
  { abbrev: "IPR", name: "Intellectual Property Reports", bracket: "round", rank: 3, scope: "Intellectual property" },
  { abbrev: "ATD", name: "Australian Tax Decisions", bracket: "round", rank: 3, scope: "Taxation" },
  { abbrev: "ATR", name: "Australian Tax Reports", bracket: "round", rank: 3, scope: "Taxation" },
  { abbrev: "ATC", name: "Australian Tax Cases", bracket: "round", rank: 3, scope: "Taxation" },
  { abbrev: "LGERA", name: "Local Government and Environmental Reports of Australia", bracket: "round", rank: 3, scope: "Planning and environment" },
  { abbrev: "VLR", name: "Victorian Law Reports", bracket: "round", rank: 3, scope: "Victoria (historical)" },
]

/**
 * Lookup key: dots and internal spaces removed, upper-cased. `A Crim R`,
 * `A.Crim.R.` and `ACrimR` are the same series, and LawCite's own help page
 * says its parser is deliberately this forgiving — a citator that rejects
 * `All E.R` would send a real citation to "not found".
 */
export function normaliseSeriesToken(token: string): string {
  return token.replace(/[.\s]/g, "").toUpperCase()
}

const bySeries = new Map<string, ReportSeries>(
  REPORT_SERIES.map((entry) => [normaliseSeriesToken(entry.abbrev), entry]),
)

export function lookupSeries(token: string): ReportSeries | undefined {
  return bySeries.get(normaliseSeriesToken(token))
}

/** Authorised report series rank first, then general, then subject-specific. */
export function compareSeriesRank(a: ReportSeries, b: ReportSeries): number {
  return a.rank - b.rank
}

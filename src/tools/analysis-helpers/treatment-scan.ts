/**
 * Scanning a later judgment for the language that kills an earlier one.
 *
 * Australia has no equivalent of the formula a Korean en banc court uses when
 * it changes the law, so there is nothing to grep with high precision
 * (docs/research §6.1). Overruling here is discursive: "we decline to follow",
 * "should not be regarded as authority for", "*X* is overruled", and often the
 * High Court merely "explains" a case into irrelevance. Consequences:
 *
 *  - Signals are split into **overruling** and **doubting**. Only the first can
 *    produce an `overruled_candidate` verdict; "distinguished" and "doubted"
 *    are reported and change nothing, because distinguishing is what courts do
 *    to cases that are still good law.
 *  - A signal only counts **near a mention of the target case**. "Overruled"
 *    somewhere else in a 400-paragraph judgment is about some other authority.
 *  - Judgments define a short name once and then use it ("*Mabo (No 2)*"), so
 *    the alias is harvested and scanned too — a scan that only follows the full
 *    citation misses the paragraph that actually does the overruling.
 *  - The window is checked for **dissent** markers. A dissenting judge writing
 *    "should be overruled" has overruled nothing, and reporting that as a
 *    signal without the caveat is worse than missing it.
 *
 * Everything here is a heuristic and the output says so; the tool's job is to
 * put the paragraph in front of a human, not to grade it.
 */

import { escapeRegex } from "../../lib/escape-regex.js"

export type SignalKind = "overruling" | "doubting"

export interface TreatmentSignal {
  kind: SignalKind
  /** Short description of the phrase that matched. */
  label: string
  /** The matched words, verbatim. */
  phrase: string
  /** Sentence-ish window around the mention, for a human to read. */
  context: string
  /** True when dissent language sits in the same window. */
  nearDissent?: boolean
  /** True when joint/plurality language sits in the same window. */
  nearPlurality?: boolean
}

const OVERRULING: Array<{ re: RegExp; label: string }> = [
  { re: /\bis\s+overruled\b|\bare\s+overruled\b|\bwe\s+overrule\b|\boverrul(?:e|ed|ing)\b/i, label: "overruled" },
  { re: /\bno\s+longer\s+good\s+law\b/i, label: "no longer good law" },
  { re: /\bshould\s+(?:no\s+longer\s+)?(?:not\s+)?be\s+followed\b/i, label: "should not be followed" },
  { re: /\bought\s+not\s+(?:now\s+)?to\s+be\s+followed\b/i, label: "ought not to be followed" },
  { re: /\b(?:we|I|they)\s+decline\s+to\s+follow\b|\bdeclin(?:e|ed|ing)\s+to\s+follow\b/i, label: "declined to follow" },
  { re: /\bwrongly\s+decided\b/i, label: "wrongly decided" },
  { re: /\bshould\s+not\s+be\s+regarded\s+as\s+authority\b/i, label: "not authority" },
  { re: /\bis\s+no\s+longer\s+authority\b|\bceased\s+to\s+be\s+authority\b/i, label: "no longer authority" },
  { re: /\bdepart(?:s|ed|ing)?\s+from\s+(?:the\s+)?(?:decision|reasoning|holding)\b/i, label: "departed from" },
  { re: /\bcannot\s+stand\s+with\b/i, label: "cannot stand with" },
]

const DOUBTING: Array<{ re: RegExp; label: string }> = [
  { re: /\bdisapprov(?:e|ed|es|ing)\b/i, label: "disapproved" },
  { re: /\bdoubt(?:ed|s|ful)\b|\bwith\s+respect,?\s+(?:we|I)\s+doubt\b/i, label: "doubted" },
  { re: /\bnot\s+followed\b/i, label: "not followed" },
  { re: /\bdistinguish(?:ed|es|ing)\b/i, label: "distinguished" },
  { re: /\bper\s+incuriam\b/i, label: "per incuriam" },
  { re: /\bqualified\s+by\b|\bconfined\s+to\s+its\s+(?:own\s+)?facts\b/i, label: "confined to its facts" },
]

const DISSENT = /\b(?:dissent(?:ing|s|ed)?|in\s+dissent|I\s+respectfully\s+(?:disagree|dissent)|contrary\s+view)\b/i
const PLURALITY =
  /\b(?:joint\s+(?:judgment|reasons)|the\s+plurality|the\s+majority|we\s+would|in\s+our\s+(?:view|opinion)|the\s+Court\s+(?:held|concluded))\b/i

/** Characters either side of a mention that a signal must fall within. */
const WINDOW = 400
/** Mentions examined per document — enough for the passage that matters, bounded for cost. */
const MAX_MENTIONS = 12

/**
 * Short names a judgment defines for the target: `… (1992) 175 CLR 1 ('Mabo
 * (No 2)')`. Returned so the caller can scan for them as well as the citation.
 */
export function findCaseAliases(body: string, citation: string): string[] {
  const pattern = new RegExp(
    `${escapeRegex(citation)}[^(]{0,80}\\(\\s*["'‘“]([^"'’”)]{2,40})["'’”]?\\s*\\)`,
    "gi",
  )
  const out = new Set<string>()
  for (const match of body.matchAll(pattern)) {
    const alias = match[1].trim()
    if (alias.length >= 3) out.add(alias)
  }
  return [...out]
}

function mentionIndices(body: string, needles: readonly string[]): number[] {
  const indices: number[] = []
  for (const needle of needles) {
    if (!needle) continue
    const pattern = new RegExp(escapeRegex(needle).replace(/\\?\s+/g, "\\s+"), "gi")
    for (const match of body.matchAll(pattern)) {
      indices.push(match.index ?? 0)
      if (indices.length >= MAX_MENTIONS * needles.length) break
    }
  }
  return [...new Set(indices)].sort((a, b) => a - b).slice(0, MAX_MENTIONS)
}

export interface TreatmentScan {
  /** Number of times the target was mentioned (capped). */
  mentions: number
  signals: TreatmentSignal[]
  /** First context window, printed even when nothing fired — evidence the scan ran. */
  sample?: string
}

/**
 * Scan one judgment's text for treatment of `citation`.
 *
 * `extraNames` lets the caller add the party names it already knows; aliases
 * the judgment defines for itself are found here.
 */
export function scanTreatment(body: string, citation: string, extraNames: readonly string[] = []): TreatmentScan {
  const text = body.replace(/\s+/g, " ")
  const needles = [citation, ...findCaseAliases(text, citation), ...extraNames].filter(Boolean)
  const indices = mentionIndices(text, needles)
  if (indices.length === 0) return { mentions: 0, signals: [] }

  const signals: TreatmentSignal[] = []
  const seen = new Set<string>()
  let sample: string | undefined

  for (const index of indices) {
    const window = text.slice(Math.max(0, index - WINDOW), Math.min(text.length, index + WINDOW))
    if (!sample) sample = window.trim()
    const nearDissent = DISSENT.test(window)
    const nearPlurality = PLURALITY.test(window)

    for (const [kind, table] of [
      ["overruling", OVERRULING],
      ["doubting", DOUBTING],
    ] as const) {
      for (const { re, label } of table) {
        const match = re.exec(window)
        if (!match) continue
        const key = `${kind}:${label}`
        if (seen.has(key)) continue
        seen.add(key)
        signals.push({
          kind: kind as SignalKind,
          label,
          phrase: match[0],
          context: window.trim(),
          ...(nearDissent ? { nearDissent: true } : {}),
          ...(nearPlurality ? { nearPlurality: true } : {}),
        })
      }
    }
  }

  return { mentions: indices.length, signals, ...(sample ? { sample } : {}) }
}

/** True when any signal is strong enough to justify an `overruled_candidate` verdict. */
export function hasOverrulingSignal(scan: TreatmentScan): boolean {
  return scan.signals.some((signal) => signal.kind === "overruling")
}

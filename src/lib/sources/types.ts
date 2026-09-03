/**
 * Shapes every source scraper under `src/lib/sources/` returns, plus the two
 * shared judgements about a response body.
 *
 * The scrapers are deliberately split from the tools: parsing takes a string
 * and returns these structures, so the tests in `*.test.ts` run against the
 * recorded fixtures in `__fixtures__/` and `npm test` never touches the network.
 *
 * `totalIsUnreliable` exists because three of these upstreams lie about counts
 * in different ways — FWC's summary element reports the *facet* total
 * (186,201) no matter how narrow the query, NSW Caselaw caps at 10,000, and
 * Queensland Judgments reports a capped figure alongside a larger "judgments"
 * number. A tool that repeats those numbers as "N results" is wrong; carrying
 * the flag lets the renderer hedge instead of guessing.
 */

import { ErrorCodes, LawApiError } from "../errors.js"
import { isBlankBody } from "../body-shape.js"

/** Which upstream produced a hit — printed next to every merged result. */
export type SourceLabel =
  | "Federal Register of Legislation"
  | "NSW Caselaw"
  | "High Court of Australia"
  | "Queensland Judgments"
  | "ATO Legal Database"
  | "Fair Work Commission"
  | "OAIC"
  | "DFAT Treaties Database"
  | "NACC"
  | "Merit Protection Commissioner"
  | "Anti-Dumping Review Panel"
  | "QLD Legislation"
  | "TAS Legislation"
  | "WA Legislation"
  | "VIC Legislation"
  | "NT Legislation"
  | "ACT Legislation"

export interface SourceHit {
  source: SourceLabel
  /** Case/document name as the upstream prints it. */
  title: string
  /** Medium-neutral or report citation when the upstream carries one. */
  citation?: string
  /** Identifier to hand back to the matching `get*` function. */
  id: string
  /** Canonical human URL for the record. */
  url: string
  court?: string
  date?: string
  catchwords?: string
  snippet?: string
  /** Label/value pairs the upstream supplies that do not fit above. */
  extra?: Array<[string, string]>
}

export interface SourceSearchResult {
  hits: SourceHit[]
  /** The upstream's own count. Absent when it does not publish one. */
  total?: number
  /** True when `total` is capped, facet-wide, or otherwise not the hit count. */
  totalIsUnreliable?: boolean
  /** What `total` actually measures, for the renderer to quote honestly. */
  totalNote?: string
  page?: number
  /** The URL a human can open to see the same list. */
  sourceUrl: string
}

export interface SourceDocument {
  title: string
  citation?: string
  url: string
  /** Coversheet/metadata rows, in upstream order. */
  metadata: Array<[string, string]>
  /** Readable body text. Empty when the upstream only publishes a binary. */
  text: string
  /** Downloads and related pages (PDF, DOCX, AustLII, …). */
  documents?: Array<{ label: string; url: string }>
  /**
   * An honest statement of what this response does *not* contain — e.g. "full
   * text is a PDF; only the metadata block was parsed". Never a claim of
   * absence.
   */
  note?: string
}

/**
 * A 200 arrived but it is not the page the recipe describes.
 *
 * Every host here answers failures with 200 + HTML, so "HTML arrived" proves
 * nothing; the landmark does. This is reported as `[UPSTREAM_NO_DATA]` — an
 * observation that the upstream did not hand over parseable content — and
 * never as `[NOT_FOUND]`, which would assert the record does not exist.
 */
export function upstreamShapeError(p: {
  host: string
  url: string
  landmark: string
  what: string
}): LawApiError {
  return new LawApiError(
    `${p.host} returned a page without the expected ${p.landmark} landmark, so ${p.what} could not be read - ${p.url}`,
    ErrorCodes.UPSTREAM_NO_DATA,
    [
      "⚠️ This is a response-shape failure, not evidence the record is absent. Do not tell the user there is no such decision.",
      "Causes that look identical here: upstream maintenance, an anti-bot interstitial, or a page redesign that moved the landmark.",
      `Open the page in a browser to check: ${p.url}`,
    ],
  )
}

/**
 * Throw unless the body carries at least one of the recipe's landmarks.
 * Blank bodies are caught first because they read as "no landmark" too, and the
 * distinction matters to whoever reads the message.
 */
export function requireLandmark(
  html: string,
  landmarks: string[],
  context: { host: string; url: string; what: string },
): void {
  if (isBlankBody(html)) {
    throw upstreamShapeError({ ...context, landmark: "(any content — the body was empty)" })
  }
  if (landmarks.some((landmark) => html.includes(landmark))) return
  throw upstreamShapeError({ ...context, landmark: landmarks.map((l) => `\`${l}\``).join(" / ") })
}

/** Pull "Displaying 1 - 20 of 10000" style totals out of a listing page. */
export function parseDisplayingTotal(html: string): number | undefined {
  const match = /Displaying\s+[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+)/i.exec(html)
  if (!match) return undefined
  const value = Number(match[1].replace(/,/g, ""))
  return Number.isFinite(value) ? value : undefined
}

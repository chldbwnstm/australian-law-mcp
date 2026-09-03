/**
 * Splitting "case name + citation" strings, which is how every one of these
 * result lists prints a hit:
 *
 *   NSW Caselaw          Menzies v Wheatley [2014] NSWDC 147
 *   Queensland Judgments White v Patterson [2010] 2 Qd R 591
 *   Fair Work Commission Werner v BHPM Enterprises - [2014] FWC 3013
 *
 * The grammar is not re-invented here. `lib/case-citation.ts` is the single
 * source of Australian citation patterns, and this module anchors those exact
 * patterns to the end of a string. A bespoke regex per scraper is how
 * `[2010] 2 Qd R 591` ends up parsed as a medium-neutral citation with the
 * court token "2" — the volume number in a year-as-volume report citation sits
 * exactly where an MNC's court token does.
 */

import {
  MNC_PATTERN,
  REPORT_VOLUME_PATTERN,
  REPORT_YEAR_PATTERN,
} from "../case-citation.js"

const TRAILING = new RegExp(
  `\\s*(?:${MNC_PATTERN}|${REPORT_VOLUME_PATTERN}|${REPORT_YEAR_PATTERN})\\s*$`,
)

export interface TitleAndCitation {
  title: string
  citation?: string
}

/**
 * Split a trailing citation off a result title.
 *
 * Returns the whole string as `title` when there is no citation — a hit without
 * one is still a hit, and dropping it because the format was unfamiliar is how
 * a real decision disappears from a result list.
 */
export function splitTrailingCitation(text: string): TitleAndCitation {
  const value = text.replace(/\s+/g, " ").trim()
  const match = TRAILING.exec(value)
  if (!match) return { title: value }
  const citation = match[0].trim()
  const title = value.slice(0, match.index).replace(/[\s–—-]+$/, "").trim()
  // A citation with nothing in front of it is the whole title, not an anonymous case.
  return title ? { title, citation } : { title: value, citation }
}

/** Is this string a bare medium-neutral citation, e.g. `[2020] HCA 41`? */
export function isMediumNeutral(citation: string | undefined): boolean {
  return Boolean(citation && new RegExp(`^${MNC_PATTERN}$`).test(citation.trim()))
}

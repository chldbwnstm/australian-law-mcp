/**
 * Deep-link builders for sources this server cannot (or should not) fetch,
 * plus canonical human URLs for the ones it can.
 *
 * The AustLII/LawCite/Fed Court/NSW/SA/ACCC entries exist because those hosts
 * block server-side clients (docs/research/case-law-access.md §1,
 * tribunals-states-treaties.md): the links open fine in the USER'S browser, so
 * every `[UPSTREAM_BLOCKED]` answer ships one. Base URLs come from the
 * upstream-hosts table — the single source for host addresses — so a host
 * change cannot strand a stale link here.
 */

import { lookupCourt, type Jurisdiction } from "./court-codes.js"
import { getHostConfig } from "./upstream-hosts.js"

const base = (key: Parameters<typeof getHostConfig>[0]): string => getHostConfig(key).base

/** AGLC jurisdiction → AustLII path segment (`/au/cases/{segment}/…`). */
const AUSTLII_JURISDICTION_SEGMENT: Record<Jurisdiction, string> = {
  Cth: "cth",
  NSW: "nsw",
  Vic: "vic",
  Qld: "qld",
  SA: "sa",
  WA: "wa",
  Tas: "tas",
  ACT: "act",
  NT: "nt",
}

export interface CaseAddress {
  /** Canonical MNC court token, e.g. "HCA", "NSWCA", "FWC". */
  court: string
  year: number
  num: number
}

/**
 * `[2020] HCA 41` → https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/HCA/2020/41.html
 * (grammar confirmed via the Supreme Court of Victoria's own outbound links —
 * case-law-access.md §1). Returns null for a court token the code table does
 * not know: an unknown court is "unclear", never a fabricated URL.
 */
export function austliiCaseUrl({ court, year, num }: CaseAddress): string | null {
  const entry = lookupCourt(court)
  if (!entry) return null
  const segment = AUSTLII_JURISDICTION_SEGMENT[entry.jurisdiction]
  return `${base("austlii")}/cgi-bin/viewdoc/au/cases/${segment}/${entry.code}/${year}/${num}.html`
}

/**
 * AustLII consolidated-act section page. The slug is AustLII's own generated
 * name (e.g. `caca2010265` for the CCA) — it is NOT derivable from the title,
 * so callers must pass one they obtained from a real source. Never guess.
 */
export function austliiSectionUrl(slug: string, section: string | number, jurisdiction: Jurisdiction = "Cth"): string {
  const segment = AUSTLII_JURISDICTION_SEGMENT[jurisdiction]
  const cleaned = String(section).toLowerCase().replace(/[^0-9a-z.]/g, "")
  return `${base("austlii")}/cgi-bin/viewdoc/au/legis/${segment}/consol_act/${slug}/s${cleaned}.html`
}

/** SINO search deep link, database-restricted via repeatable mask_path. */
export function austliiSearchUrl(query: string, maskPaths: string[] = []): string {
  const params = new URLSearchParams({ method: "auto", query })
  for (const mask of maskPaths) params.append("mask_path", mask)
  return `${base("austlii")}/cgi-bin/sinosrch.cgi?${params.toString()}`
}

/** LawCite record for a citation — the free citator, browser-only. */
export function lawCiteUrl(citation: string): string {
  return `${base("lawcite")}/cgi-bin/LawCite?cit=${encodeURIComponent(citation)}`
}

/** Federal Court single-judgment page, e.g. [2020] FCA 1 (host is Cloudflare-blocked server-side). */
export function fedCourtJudgmentUrl(year: number, num: number, court: "fca" | "fcafc" = "fca"): string {
  const padded = String(num).padStart(4, "0")
  return `${base("fedcourt")}/judgments/Judgments/${court}/single/${year}/${year}${court}${padded}`
}

/** NSW legislation in-force view, act-YYYY-NNN addressing. */
export function nswLegislationUrl(year: number, number: number, kind: "act" | "sl" = "act"): string {
  return `${base("nswLegislation")}/view/html/inforce/current/${kind}-${year}-${String(number).padStart(3, "0")}`
}

/** SA legislation browse path (the register's own /lz addressing). */
export function saLegislationUrl(titleSlug: string): string {
  return `${base("saLegislation")}/lz?path=/C/A/${encodeURIComponent(titleSlug)}`
}

/** Commonwealth Ombudsman reports landing (blocked host, link-only). */
export function ombudsmanReportsUrl(): string {
  return `${base("ombudsman")}/publications-and-news/reports`
}

/** ACCC public registers landing (blocked host, link-only). */
export function acccRegistersUrl(): string {
  return `${base("accc")}/public-registers`
}

/** Australian Competition Tribunal decisions page (blocked host, link-only). */
export function competitionTribunalUrl(): string {
  return `${base("competitionTribunal")}/decisions`
}

/** Canonical human page for an FRL title — latest, or a compilation date. */
export function frlHumanUrl(titleId: string, date?: string): string {
  const host = "https://www.legislation.gov.au"
  return date ? `${host}/${titleId}/${date}/text` : `${host}/${titleId}/latest/text`
}

/** HCA judgments search (1998–current database). */
export function hcaJudgmentsUrl(p: { keywords?: string; year?: number } = {}): string {
  const url = `${base("hcourt")}/cases-and-judgments/judgments/judgments-1998-current`
  const params: string[] = []
  if (p.keywords) params.push(`keywords=${encodeURIComponent(p.keywords)}`)
  // f[0] literal brackets on purpose: the WAF 403s the percent-encoded form
  // (case-law-access.md §2).
  if (p.year) params.push(`f[0]=d:${p.year}`)
  return params.length > 0 ? `${url}?${params.join("&")}` : url
}

/** Queensland Judgments full text — citation-addressable (court code lowercased). */
export function qldCaseUrl({ court, year, num }: CaseAddress, pdf = false): string {
  const path = `${base("qldJudgments")}/caselaw/${court.toLowerCase()}/${year}/${num}`
  return pdf ? `${path}/pdf` : path
}

/** ATO Legal Database document view by DocID (grok-followup.md §3.5). */
export function atoDocUrl(docId: string): string {
  return `${base("ato")}/law/view/document?docid=${encodeURIComponent(docId)}`
}

/** ATO current point-in-time sentinel; historical PiT is `yyyyMMdd000001`. */
export const ATO_PIT_CURRENT = "99991231235958"

/** ATO PDF rendition of a document. */
export function atoPdfUrl(docId: string, pit: string = ATO_PIT_CURRENT): string {
  return `${base("ato")}/law/view/pdf?DocId=${encodeURIComponent(docId)}&PiT=${pit}`
}

/** NSW Caselaw decision page for a known 24-hex decision id. */
export function nswCaselawDecisionUrl(decisionId: string): string {
  return `${base("nswCaselaw")}/decision/${decisionId}`
}

/** Australian Treaties Database entry point (results carry their own ATS links). */
export function treatiesDatabaseUrl(): string {
  return "https://docs.dfat.gov.au/australian-treaties-database/home"
}

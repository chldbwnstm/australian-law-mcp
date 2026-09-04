/**
 * Locating a case citation in the sources this server can actually reach.
 *
 * Australian case law is a federation of websites, three of which answer
 * server-side: NSW Caselaw (exact medium-neutral lookup), Queensland Judgments
 * (citation-addressable URLs) and the High Court's own 1998–current list.
 * AustLII, LawCite and the Federal Court are on the blocked list, so for every
 * other court this server has **not looked** — and that is what it says. The
 * distinction is the whole point of this module:
 *
 *   `found`       — the source holds this citation.
 *   `absent`      — a source that authoritatively covers this court answered,
 *                   and does not hold it. Real evidence.
 *   `unreachable` — the source failed, or was never queried because it is
 *                   blocked. Evidence of nothing.
 *   `unsupported` — no lookup was run, because nothing this server reads covers
 *                   this court: the source is blocked, or the court's decisions
 *                   are not in the collection the reachable source exposes.
 *
 * Only `absent` may ever become a ✗. A verifier that collapses the other three
 * into "no such case" advises a real authority out of existence, which is the
 * exact failure the reference implementation was rebuilt around. `absent` is
 * therefore claimed only for the courts `coveringSource` names, and that list
 * is narrower than "the source has a page for this jurisdiction".
 */

import type { AuApiClient } from "../../lib/api-client.js"
import { formatCitation, type CaseCitation, type MncCitation } from "../../lib/case-citation.js"
import { austliiCaseUrl, lawCiteUrl, qldCaseUrl } from "../../lib/external-links-map.js"
import * as hcourt from "../../lib/sources/hcourt.js"
import * as nsw from "../../lib/sources/nsw-caselaw.js"
import * as qld from "../../lib/sources/qld-judgments.js"
import { ErrorCodes, LawApiError } from "../../lib/errors.js"

export type CaseLocation =
  | { status: "found"; source: string; title?: string; date?: string; url: string; decisionId?: string }
  | { status: "absent"; source: string; reason: string; url?: string }
  | { status: "unreachable"; source: string; reason: string; links: string[] }
  | { status: "unsupported"; reason: string; links: string[] }

/** Pages of the High Court's year listing one lookup may walk. */
const HCA_MAX_PAGES = 6
const HCA_PER_PAGE = 12

function deepLinks(citation: MncCitation): string[] {
  const links: string[] = []
  const austlii = austliiCaseUrl({ court: citation.court, year: citation.year, num: citation.number })
  if (austlii) links.push(austlii)
  links.push(lawCiteUrl(formatCitation({ ...citation, pinpoint: undefined })))
  return links
}

function normalise(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /\[((?:1[89]|20)\d{2})\]\s*([A-Za-z]{2,14})\s*(\d{1,5})/.exec(value)
  return match ? `[${match[1]}] ${match[2].toUpperCase()} ${Number(match[3])}` : undefined
}

/** The High Court list, walked far enough to know whether a miss is real. */
async function locateHca(client: AuApiClient, citation: MncCitation): Promise<CaseLocation> {
  const wanted = `[${citation.year}] ${citation.court} ${citation.number}`
  if (citation.year < 1998) {
    return {
      status: "unsupported",
      reason:
        `hcourt.gov.au publishes judgments from 1998 only, and ${citation.court} began allocating ` +
        `medium-neutral citations in 1998 — a ${citation.year} citation cannot be checked here.`,
      links: deepLinks(citation),
    }
  }

  let exhausted = false
  try {
    for (let page = 0; page < HCA_MAX_PAGES; page++) {
      const result = await hcourt.search(client, { year: citation.year, page })
      const hit = result.hits.find((entry) => normalise(entry.citation) === wanted)
      if (hit) {
        return {
          status: "found",
          source: "High Court of Australia",
          title: hit.title,
          ...(hit.date ? { date: hit.date } : {}),
          url: hit.url,
          decisionId: hit.id,
        }
      }
      if (result.hits.length === 0) {
        exhausted = true
        break
      }
      if (result.total !== undefined && (page + 1) * HCA_PER_PAGE >= result.total) {
        exhausted = true
        break
      }
    }
  } catch (error) {
    return {
      status: "unreachable",
      source: "High Court of Australia",
      reason: error instanceof Error ? error.message : String(error),
      links: deepLinks(citation),
    }
  }

  if (!exhausted) {
    return {
      status: "unreachable",
      source: "High Court of Australia",
      reason: `the ${citation.year} listing was longer than the ${HCA_MAX_PAGES} pages this lookup walks`,
      links: deepLinks(citation),
    }
  }
  return {
    status: "absent",
    source: "High Court of Australia",
    reason: `the Court's own complete ${citation.year} judgment list does not contain ${wanted}`,
    url: `https://www.hcourt.gov.au/cases-and-judgments/judgments/judgments-1998-current?f[0]=d:${citation.year}`,
  }
}

async function locateNsw(client: AuApiClient, citation: MncCitation): Promise<CaseLocation> {
  const wanted = `[${citation.year}] ${citation.court} ${citation.number}`
  try {
    const result = await nsw.lookupByCitation(client, wanted)
    const hit = result.hits.find((entry) => normalise(entry.citation) === wanted) ?? result.hits[0]
    if (hit && normalise(hit.citation) === wanted) {
      return {
        status: "found",
        source: "NSW Caselaw",
        title: hit.title,
        ...(hit.date ? { date: hit.date } : {}),
        url: hit.url,
        decisionId: hit.id,
      }
    }
    return {
      status: "absent",
      source: "NSW Caselaw",
      reason:
        `the official NSW repository's exact medium-neutral search returns nothing for ${wanted}` +
        (result.hits.length > 0 ? ` (it answered with ${result.hits.length} other decision(s))` : ""),
      url: result.sourceUrl,
    }
  } catch (error) {
    return {
      status: "unreachable",
      source: "NSW Caselaw",
      reason: error instanceof Error ? error.message : String(error),
      links: deepLinks(citation),
    }
  }
}

async function locateQld(client: AuApiClient, citation: MncCitation): Promise<CaseLocation> {
  const wanted = `[${citation.year}] ${citation.court} ${citation.number}`
  const url = qldCaseUrl({ court: citation.court, year: citation.year, num: citation.number })
  try {
    const document = await qld.getByCitation(client, wanted)
    return {
      status: "found",
      source: "Queensland Judgments",
      title: document.title,
      url: document.url,
    }
  } catch (error) {
    // The citation IS the address on this site, so a 404 is an observation
    // about the citation rather than a failed search.
    if (error instanceof LawApiError && error.code === ErrorCodes.NOT_FOUND) {
      return {
        status: "absent",
        source: "Queensland Judgments",
        reason: `${wanted} is citation-addressable on Queensland Judgments and that address returns 404`,
        url,
      }
    }
    return {
      status: "unreachable",
      source: "Queensland Judgments",
      reason: error instanceof Error ? error.message : String(error),
      links: deepLinks(citation),
    }
  }
}

/**
 * Which of the three reachable sources, if any, covers this court.
 *
 * A court is only listed here when the source can actually answer *for that
 * court*, because a covered miss becomes `absent`, and `absent` is printed as
 * "✗ … very likely invented". Two families look covered and are not:
 *
 *  - `HCASL` (special leave dispositions, from 2008) and `HCASJ` (single
 *    justice, from January 2024) are NOT in the judgments-1998-current listing
 *    `locateHca` walks. HCASL is published through AustLII; HCASJ has its own
 *    collection on the Court's site (grok-au-law-landscape.md §2.3, §4.4).
 *  - NSW Caselaw's advanced search must be handed the court's own id, so a NSW
 *    body with no entry in `NSW_COURT_IDS` (NSWADT, NSWADTAP, bare NSWCAT) is
 *    outside the search that can be run — its decisions could never appear in
 *    the result the miss would be read off.
 */
export function coveringSource(citation: MncCitation): "hca" | "nsw" | "qld" | undefined {
  if (citation.court === "HCA") return "hca"
  if (citation.court_info.jurisdiction === "NSW" && nsw.NSW_COURT_IDS[citation.court]) return "nsw"
  if ((qld.QLD_COURTS as readonly string[]).includes(citation.court)) return "qld"
  return undefined
}

/** The Court's separate single-justice collection (grok-au-law-landscape.md §2.3). */
const HCA_SINGLE_JUSTICE_URL =
  "https://www.hcourt.gov.au/cases-and-judgments/judgments/single-justice-judgments"

/**
 * Why no lookup was run. Every branch describes what this server did NOT do;
 * none of them is an observation about the citation.
 */
function uncovered(citation: MncCitation): CaseLocation {
  const links = deepLinks(citation)
  if (citation.court === "HCASL") {
    return {
      status: "unsupported",
      reason:
        `special leave dispositions (HCASL) are not published in the High Court's judgments-1998-current listing, ` +
        `the only High Court collection this server reads — they are held by AustLII and LawCite, which refuse ` +
        `automated clients, so this citation was NOT looked up.`,
      links,
    }
  }
  if (citation.court === "HCASJ") {
    return {
      status: "unsupported",
      reason:
        `single justice judgments (HCASJ, from January 2024) sit in the Court's separate single-justice collection, ` +
        `not the judgments-1998-current listing this server reads, so this citation was NOT looked up.`,
      links: [HCA_SINGLE_JUSTICE_URL, ...links],
    }
  }
  if (citation.court_info.jurisdiction === "NSW") {
    return {
      status: "unsupported",
      reason:
        `NSW Caselaw's exact medium-neutral search has to be given the deciding body's own court id, and this server ` +
        `holds none for ${citation.court_info.name}, so this citation was NOT looked up.`,
      links,
    }
  }
  return {
    status: "unsupported",
    reason:
      `no case-law source this server may fetch covers ${citation.court_info.name}. ` +
      `AustLII, LawCite and the Federal Court all refuse automated clients, so this citation was NOT looked up — ` +
      `nothing here says it is wrong.`,
    links,
  }
}

/** Locate a medium-neutral citation. Never throws. */
export async function locateCase(client: AuApiClient, citation: MncCitation): Promise<CaseLocation> {
  switch (coveringSource(citation)) {
    case "hca":
      return locateHca(client, citation)
    case "nsw":
      return locateNsw(client, citation)
    case "qld":
      return locateQld(client, citation)
    default:
      return uncovered(citation)
  }
}

export interface CaseVerdict {
  mark: "✓" | "✗" | "⚠"
  line: string
  impossible?: boolean
  location?: CaseLocation
}

/** Turn a parsed citation plus its location into one report line. */
export function renderCaseVerdict(citation: CaseCitation, location: CaseLocation | undefined): CaseVerdict {
  const shown = formatCitation(citation)
  const warnings = citation.warnings.length > 0 ? ` ${citation.warnings.join(" ")}` : ""

  if (citation.kind === "report") {
    return {
      mark: "⚠",
      line:
        `⚠ ${shown} — report-series citations resolve only through LawCite, which refuses automated clients, ` +
        `so this was NOT checked. Open ${lawCiteUrl(shown)}.${warnings}`,
    }
  }

  if (!location || location.status === "unsupported") {
    const links = location && location.status === "unsupported" ? location.links : []
    return {
      mark: "⚠",
      line:
        // Not "(source blocked)": some of these courts are not blocked at all,
        // they are simply outside the collections this server reads. Either way
        // the honest statement is that no lookup ran.
        `⚠ ${shown} — NOT checked here: ${location?.reason ?? "no reachable source covers this court"}` +
        `${links.length > 0 ? ` Open: ${links.join(" | ")}` : ""}${warnings}`,
      ...(location ? { location } : {}),
    }
  }

  if (location.status === "found") {
    return {
      mark: "✓",
      location,
      line: `✓ ${shown} — ${location.title ?? "found"}${location.date ? `, ${location.date}` : ""} (${location.source}) ${location.url}${warnings}`,
    }
  }

  if (location.status === "absent") {
    return {
      mark: "✗",
      impossible: true,
      location,
      line:
        `✗ NOT_FOUND: ${shown} — ${location.reason}. ${location.source} is the authoritative source for this court, ` +
        `so this citation is very likely invented or mistyped.${location.url ? ` Checked: ${location.url}` : ""}${warnings}`,
    }
  }

  return {
    mark: "⚠",
    location,
    line:
      `⚠ ${shown} — ${location.source} could not be reached (${location.reason}), so nothing was learned about this citation.` +
      `${location.links.length > 0 ? ` Open: ${location.links.join(" | ")}` : ""}${warnings}`,
  }
}

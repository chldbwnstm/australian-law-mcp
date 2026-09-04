/**
 * `get_external_links` — the human-browser links for a statute or a case.
 *
 * Half the sources an Australian lawyer actually uses refuse server-side
 * clients (AustLII, LawCite, the Federal Court judgments site, the NSW and SA
 * registers, the ACCC). Those links open perfectly in the user's browser, so
 * this tool exists to hand them over.
 *
 * The hard rule is **no fabricated addresses**. AustLII's consolidated-act
 * slug (`caca2010265`) is generated and is not derivable from a title, so a
 * section link is emitted only when the caller supplies a slug they already
 * have. Everything else is built from a verified grammar in
 * `external-links-map.ts`, or is a search URL — a query is honest about being
 * a query, a guessed document URL is not.
 *
 * The same rule applies to what the caller passes in: a register id or a
 * compilation date of the wrong shape addresses nothing, and interpolated into
 * `legislation.gov.au/{id}/{date}/text` it is indistinguishable from a real
 * page. Both are shape-checked here, and a bad one gets the correction the
 * fetching paths give rather than a confident dead link.
 */

import { z } from "zod"
import { parseCaseCitation } from "../lib/case-citation.js"
import { lookupCourt } from "../lib/court-codes.js"
import { formatToolError } from "../lib/errors.js"
import {
  acccRegistersUrl,
  atoDocUrl,
  austliiCaseUrl,
  austliiSearchUrl,
  austliiSectionUrl,
  competitionTribunalUrl,
  fedCourtJudgmentUrl,
  frlHumanUrl,
  hcaJudgmentsUrl,
  lawCiteUrl,
  nswCaselawDecisionUrl,
  qldCaseUrl,
  saLegislationUrl,
  treatiesDatabaseUrl,
} from "../lib/external-links-map.js"
import { resolveLawAlias } from "../lib/law-alias.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatRef, parseSectionRef } from "../lib/section-ref.js"
import { getHostConfig } from "../lib/upstream-hosts.js"
import type { LooseToolResponse } from "../lib/types.js"
import { looksLikeRegisterId } from "./statute-helpers/title-lookup.js"

/** Compilation dates address a point in time on the Register: `2015-06-30`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const getExternalLinksSchema = z.object({
  law: z.string().optional().describe("Act name or alias, e.g. 'Competition and Consumer Act 2010', 'CCA', 'ACL'"),
  titleId: z.string().optional().describe("Federal Register title id, e.g. 'C2004A00109'. Use one from a search result, never invented"),
  provision: z.string().optional().describe("Provision reference, e.g. 's 18', 'sch 2 s 18', 'pt 2-3'"),
  date: z.string().optional().describe("Compilation date for the register link: 'YYYY-MM-DD'. Omit for the latest compilation"),
  austliiSlug: z
    .string()
    .optional()
    .describe("AustLII consolidated-act slug you already have, e.g. 'caca2010265'. Never guess one — omit it and a search link is given instead"),
  citation: z.string().optional().describe("Case citation, e.g. '[2020] HCA 41' or '(1992) 175 CLR 1'"),
  nswDecisionId: z.string().optional().describe("24-character NSW Caselaw decision id, if known"),
  atoDocId: z.string().optional().describe("ATO Legal Database DocID, e.g. 'TXR/TR20065/NAT/ATO/00001'"),
  topic: z.enum(["treaties", "competition"]).optional().describe("Extra register landing pages for a topic area"),
})
export type GetExternalLinksInput = z.infer<typeof getExternalLinksSchema>

const BLOCKED_NOTE =
  "Links marked (browser only) are hosts this server refuses to fetch — Cloudflare/WAF gates, or the site asks automated clients to make contact first. Nothing about that refusal says the material is absent; open them yourself."

interface Section {
  title: string
  lines: string[]
}

function statuteLinks(input: GetExternalLinksInput): Section | null {
  if (!input.law && !input.titleId) return null
  const lines: string[] = []

  const resolution = input.law ? resolveLawAlias(input.law) : undefined
  const candidates = resolution?.candidates ?? []
  const ref = input.provision ? parseSectionRef(input.provision) : null
  const refText = ref ? formatRef(ref) : input.provision

  // Prefer the caller's id; otherwise take one only when the alias is
  // unambiguous. A jurisdiction-ambiguous alias must not silently become the
  // Commonwealth Act.
  const titleId = (input.titleId ?? (resolution && !resolution.needsJurisdiction ? candidates[0]?.titleId : undefined))?.trim()
  const officialName = candidates[0]?.official ?? input.law
  const date = input.date?.trim()

  if (titleId && !looksLikeRegisterId(titleId)) {
    // The one rule this tool has is that it does not make addresses up. An id
    // of the wrong shape cannot address anything on the Register, and printed
    // as a URL it is indistinguishable from a real one.
    lines.push(
      `[INVALID_PARAMETER] '${titleId}' is not a Federal Register title id, so no register link is built ` +
      "from it — they look like C2004A00109 (Act) or F2011L00287 (instrument): one letter, four digits, " +
      "one letter, then digits. Find the real id with search_law and pass that. This says nothing about " +
      "whether the Act exists.",
    )
  } else if (titleId && date && !ISO_DATE.test(date)) {
    lines.push(
      `[INVALID_PARAMETER] date '${input.date}' is not a compilation date (YYYY-MM-DD), so it is not put ` +
      `in a URL. The latest compilation is: ${frlHumanUrl(titleId)}`,
    )
  } else if (titleId) {
    lines.push(`Federal Register of Legislation (full text): ${frlHumanUrl(titleId, date)}`)
  } else if (input.law) {
    lines.push(`No verified Federal Register id for '${input.law}' — resolve one with search_law before deep-linking. An alias miss is not evidence the Act does not exist.`)
  }

  if (resolution?.needsJurisdiction) {
    lines.push(
      `⚠️ '${input.law}' resolves in ${new Set(candidates.map((c) => c.jurisdiction)).size} jurisdictions ` +
      `(${candidates.map((c) => `${c.official} (${c.jurisdiction})`).join(", ")}). Ask which one — the section numbering differs.`,
    )
  }
  const schedule = candidates.find((candidate) => candidate.sch)?.sch
  if (schedule && ref && !ref.schedule) {
    lines.push(`⚠️ '${input.law}' is schedule ${schedule} of that Act. A bare '${refText}' points at the body of the Act, which is a different provision — write 'sch ${schedule} ${refText}'.`)
  }

  if (input.austliiSlug && refText) {
    const section = ref?.number ?? String(input.provision)
    lines.push(`AustLII section page (browser only): ${austliiSectionUrl(input.austliiSlug, section)}`)
  } else if (refText) {
    lines.push(`AustLII section slug not supplied, so no section URL is given (it is generated, not derivable). Search instead (browser only): ${austliiSearchUrl(`${officialName ?? ""} ${refText}`.trim(), ["au/legis"])}`)
  } else if (officialName) {
    lines.push(`AustLII search (browser only): ${austliiSearchUrl(officialName, ["au/legis"])}`)
  }

  const jurisdictions = new Set(candidates.map((candidate) => candidate.jurisdiction))
  if (jurisdictions.has("NSW")) {
    // The register addresses Acts as act-YYYY-NNN, and neither the year nor
    // the number is in the alias table — so the base URL is given rather than
    // a fabricated deep link. `nswYear`/`nswNumber` would be the way to
    // deep-link once a caller has them from the register itself.
    lines.push(`NSW legislation register (browser only, search by title): ${getHostConfig("nswLegislation").base}`)
  }
  if (jurisdictions.has("SA") && input.law) {
    lines.push(`SA legislation register (browser only): ${saLegislationUrl(input.law)}`)
  }

  const title = officialName ? `Statute: ${officialName}${refText ? ` ${refText}` : ""}` : "Statute"
  return { title, lines }
}

function caseLinks(input: GetExternalLinksInput): Section | null {
  if (!input.citation) return null
  const lines: string[] = []
  const parsed = parseCaseCitation(input.citation)

  if (!parsed.ok) {
    lines.push(`Citation not parsed: ${parsed.reason}. No document link is guessed from an unparsed citation.`)
    lines.push(`LawCite lookup (browser only): ${lawCiteUrl(input.citation)}`)
    return { title: `Case: ${input.citation}`, lines }
  }

  const citation = parsed.citation
  lines.push(`LawCite citator (browser only): ${lawCiteUrl(input.citation)}`)

  if (citation.kind === "mnc") {
    const address = { court: citation.court, year: citation.year, num: citation.number }
    const austlii = austliiCaseUrl(address)
    if (austlii) lines.push(`AustLII judgment (browser only): ${austlii}`)
    else lines.push(`AustLII: court token '${citation.court}' is not in the code table, so no URL is built rather than a wrong one.`)

    const court = lookupCourt(citation.court)
    if (citation.court === "FCA" || citation.court === "FCAFC") {
      lines.push(`Federal Court judgment (browser only): ${fedCourtJudgmentUrl(citation.year, citation.number, citation.court === "FCA" ? "fca" : "fcafc")}`)
    }
    if (citation.court === "HCA") {
      lines.push(`High Court judgments search: ${hcaJudgmentsUrl({ year: citation.year })}`)
    }
    if (court?.jurisdiction === "Qld") {
      lines.push(`Queensland Judgments: ${qldCaseUrl(address)}`)
      lines.push(`Queensland Judgments PDF: ${qldCaseUrl(address, true)}`)
    }
    if (court?.jurisdiction === "NSW") {
      lines.push(
        input.nswDecisionId
          ? `NSW Caselaw decision: ${nswCaselawDecisionUrl(input.nswDecisionId)}`
          : "NSW Caselaw: decision pages are addressed by a 24-character id, not by citation. Find it with search_decisions, then pass nswDecisionId.",
      )
    }
    if (court?.until !== undefined) {
      lines.push(
        `Note: ${court.name} stopped allocating medium-neutral citations in ${court.until}` +
        `${court.successor ? ` (successor: ${court.successor})` : ""}. Its decisions remain citable and remain online.`,
      )
    }
    for (const warning of citation.warnings) lines.push(`Note: ${warning}`)
  } else {
    lines.push(`Reported citation (${citation.series}). Report series are not free-text addressable — use the citator link above, or find the medium-neutral citation and re-run this tool with it.`)
    lines.push(`AustLII search (browser only): ${austliiSearchUrl(input.citation, ["au/cases"])}`)
    for (const warning of citation.warnings) lines.push(`Note: ${warning}`)
  }
  return { title: `Case: ${input.citation}`, lines }
}

function extraLinks(input: GetExternalLinksInput): Section | null {
  const lines: string[] = []
  if (input.atoDocId) lines.push(`ATO Legal Database: ${atoDocUrl(input.atoDocId)}`)
  if (input.topic === "treaties") lines.push(`Australian Treaties Database: ${treatiesDatabaseUrl()}`)
  if (input.topic === "competition") {
    lines.push(`ACCC public registers (browser only): ${acccRegistersUrl()}`)
    lines.push(`Australian Competition Tribunal decisions (browser only): ${competitionTribunalUrl()}`)
  }
  return lines.length > 0 ? { title: "Registers and databases", lines } : null
}

export async function getExternalLinks(
  _apiClient: unknown,
  input: GetExternalLinksInput,
): Promise<LooseToolResponse> {
  try {
    const sections = [statuteLinks(input), caseLinks(input), extraLinks(input)].filter(
      (section): section is Section => section !== null,
    )

    if (sections.length === 0) {
      return {
        content: [{
          type: "text",
          text: "[INVALID_PARAMETER] get_external_links needs at least one of: law, titleId, citation, atoDocId or topic.",
        }],
        isError: true,
      }
    }

    const out: string[] = ["External links", ""]
    for (const section of sections) {
      out.push(section.title)
      for (const line of section.lines) out.push(`  - ${line}`)
      out.push("")
    }
    out.push(BLOCKED_NOTE)
    return { content: [{ type: "text", text: truncateResponse(out.join("\n")) }] }
  } catch (error) {
    return formatToolError(error, "get_external_links")
  }
}

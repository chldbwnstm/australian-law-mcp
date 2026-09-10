/**
 * `cite_check` — is this case still good law?
 *
 * There is no free Australian citator. CaseBase and FirstPoint are the
 * professional answer and scraping them is a licence breach, so what this tool
 * builds is the thing the free sources can actually support: a **citation
 * graph** plus a language scan, with verdicts calibrated in docs/research §6.3
 * so that nothing here reads as a Shepard's signal.
 *
 *   cited                — later cases cite it and nothing contrary was found
 *   overruled_candidate  — a later judgment's text overrules/declines to follow it
 *   legislative_override — the provision it turned on was amended after it
 *   not_found            — every reachable source answered, and none holds it
 *   unverified_treatment — the default, and the honest answer most of the time
 *
 * `not_found` is the dangerous one and is fenced accordingly: it requires that
 * the citation lookup returned a real absence *and* that every back-trace
 * source answered without failing or being blocked. A blocked AustLII is not
 * evidence, and a case this server cannot see is not a case that does not exist.
 *
 * Cost is bounded: one exact lookup, three back-trace searches, at most
 * `MAX_DEEP_SCANS` judgment fetches, and — only when a provision is in play —
 * one table-of-contents plus one volume read.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { extractCaseCitations, formatCitation, type MncCitation } from "../lib/case-citation.js"
import { ErrorCodes, formatToolError, notFoundResponse, type ErrorCode } from "../lib/errors.js"
import { lawCiteUrl } from "../lib/external-links-map.js"
import { parseSectionRef } from "../lib/section-ref.js"
import * as nsw from "../lib/sources/nsw-caselaw.js"
import * as qld from "../lib/sources/qld-judgments.js"
import type { SourceHit } from "../lib/sources/types.js"
import { truncateResponse } from "../lib/schemas.js"
import type { ToolResponse } from "../lib/types.js"
import { followupEnvelope, makeGap, type ResearchGap } from "../lib/research-followup.js"
import { amendedAfter, provisionHistory, type DatedEffect } from "./analysis-helpers/amendment-lookup.js"
import { backTrace, describeOutcomes, isCandidateOnly, type BackTrace } from "./analysis-helpers/citing-search.js"
import { locateCase, type CaseLocation } from "./analysis-helpers/case-check.js"
import { extractStatuteCitations } from "./analysis-helpers/statute-citations.js"
import { hasOverrulingSignal, scanTreatment, type TreatmentScan } from "./analysis-helpers/treatment-scan.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"

export const CiteCheckSchema = z.object({
  caseNumber: z
    .string()
    .min(3)
    .describe(
      "The citation, or a sentence containing one: '[2010] NSWCCA 333', " +
        "'Dela Cruz v R [2010] NSWCCA 333 on s 18 of the CCA'. A statute mentioned alongside it is used for the " +
        "legislative-override check.",
    ),
  display: z.number().int().min(1).max(50).optional().default(20).describe("Later citing cases to list (default 20)."),
  deepScan: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Fetch the top citing judgments and scan them for overruling language (default true). " +
        "Turning it off is faster but cannot produce an overruled_candidate verdict.",
    ),
})

export type CiteCheckInput = z.infer<typeof CiteCheckSchema>

export const citeCheckDescription =
  "Check whether a case is still good law, using the free Australian citation graph. Finds later judgments that " +
  "mention the citation across NSW Caselaw, Queensland Judgments and the High Court list, scans the top ones for " +
  "overruling language, and — when the query ties the case to a provision — checks whether that provision was " +
  "amended after the decision. Verdicts are cited / overruled_candidate / legislative_override / not_found / " +
  "unverified_treatment (the default). This is a citation graph, NOT a Shepard's-style citator: it never claims " +
  "editorial treatment, and it always lists the later cases so a human can finish the job.";

/** Judgments fetched and read in a deep scan. Each is one HTTP request. */
const MAX_DEEP_SCANS = 3

type Verdict = "cited" | "overruled_candidate" | "legislative_override" | "not_found" | "unverified_treatment"

interface ScanResult {
  hit: SourceHit
  scan: TreatmentScan
  error?: string
}

/** Later judgments most worth reading: appellate first, then most recent. */
function prioritise(hits: readonly SourceHit[]): SourceHit[] {
  const rank = (hit: SourceHit): number => {
    const citation = hit.citation ?? ""
    if (/\bHCA\b/.test(citation)) return 0
    if (/(?:CA|CCA|SCA|FC|AFC)\b/.test(citation)) return 1
    return 2
  }
  return [...hits].sort((a, b) => rank(a) - rank(b) || (b.date ?? "").localeCompare(a.date ?? ""))
}

async function readJudgment(client: AuApiClient, hit: SourceHit): Promise<string> {
  if (hit.source === "NSW Caselaw") return (await nsw.getDecision(client, hit.id)).text
  if (hit.source === "Queensland Judgments") {
    const document = hit.citation
      ? await qld.getByCitation(client, hit.citation)
      : await qld.getById(client, hit.id)
    return document.text
  }
  // hcourt.gov.au publishes catchwords as HTML and the reasons only as PDF, so
  // a scan there sees the catchwords. That is a real signal and a real limit.
  const { getDetail } = await import("../lib/sources/hcourt.js")
  const document = await getDetail(client, hit.id)
  return `${document.text}\n${document.metadata.map(([label, value]) => `${label}: ${value}`).join("\n")}`
}

/** The provision the query ties the case to, if any. */
function tiedProvision(query: string): { lawName: string; provision: string } | undefined {
  for (const citation of extractStatuteCitations(query, 3)) {
    if (citation.lawName) return { lawName: citation.lawName, provision: citation.pinpoint }
  }
  return undefined
}

/**
 * The override check's outcome — and, separately, whether it *ran*.
 *
 * `effects: []` is ambiguous on its own: it is what "the endnote table was read
 * and holds no later amending Act" looks like, and also what "the endnote table
 * was never read" looks like. `amendment-lookup` distinguishes the two
 * (`AmendmentHistory.available`), so this carries the distinction through to the
 * render instead of collapsing it into an absence.
 */
interface OverrideCheck {
  effects: DatedEffect[]
  /** False when the check never ran, and then `effects` is evidence of nothing. */
  available: boolean
  /** The bracket label for the gap, from `ErrorCodes`, when `available` is false. */
  gapCode?: ErrorCode
  title?: string
  titleId?: string
  note?: string
}

async function legislativeOverride(
  client: AuApiClient,
  tie: { lawName: string; provision: string },
  decisionYear: number,
): Promise<OverrideCheck> {
  const ref = parseSectionRef(tie.provision)
  if (!ref) {
    return {
      effects: [],
      available: false,
      gapCode: ErrorCodes.INVALID_PARAM,
      note: `"${tie.provision}" is not a provision reference`,
    }
  }
  try {
    const lookup = await resolveTitle(client, { query: tie.lawName })
    const history = await provisionHistory(client, lookup.title.id, ref)
    if (!history.available) {
      // The endnote table could not be read — a 503 on the volume, a spent
      // budget, or the TOC/volume anchor mismatch `amendment-lookup` reports.
      // Treating that as an empty table is how "never read" becomes "never
      // amended".
      return {
        effects: [],
        available: false,
        gapCode: ErrorCodes.UPSTREAM_NO_DATA,
        title: lookup.title.name,
        titleId: lookup.title.id,
        ...(history.note ? { note: history.note } : {}),
      }
    }
    return {
      effects: amendedAfter(history.rows, decisionYear),
      available: true,
      title: lookup.title.name,
      titleId: lookup.title.id,
    }
  } catch (error) {
    // `resolveTitle` did not answer, so the provision's history was never even
    // requested. The observation is about the lookup, never about the section.
    return {
      effects: [],
      available: false,
      gapCode: ErrorCodes.UPSTREAM_NO_DATA,
      note: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function citeCheck(apiClient: AuApiClient, input: CiteCheckInput): Promise<ToolResponse> {
  try {
    const parsed = extractCaseCitations(input.caseNumber)
    const usable = parsed.find((result) => result.ok && result.citation.kind === "mnc")
    const anyParsed = parsed.find((result) => result.ok)

    if (!usable) {
      if (anyParsed && anyParsed.ok) {
        const shown = formatCitation(anyParsed.citation)
        const sourceUrl = lawCiteUrl(shown)
        const gap = makeGap({
          kind: "reported_citation",
          originTool: "cite_check",
          originalErrorCode: ErrorCodes.UPSTREAM_BLOCKED,
          target: { citation: shown },
          reason: "The reported citation can only be resolved through a source this server does not fetch.",
          sourceUrls: [sourceUrl],
          sourceAccess: "requires_access",
          evidenceNeeded: ["Report-series record matching parties, court, year, volume and first page", "Any parallel medium-neutral citation"],
        })
        return {
          content: [
            {
              type: "text",
              text:
                `[UPSTREAM_BLOCKED] ${shown} is a reported citation. Reported series resolve only through LawCite, ` +
                `which refuses automated clients, so no citation graph can be built here.\n\n` +
                `Open the free citator directly: ${sourceUrl}\n` +
                `If you have the medium-neutral citation (e.g. "[2020] HCA 41"), re-run cite_check with that instead.`,
            },
          ],
          structuredContent: { followup: followupEnvelope([gap], { pending: true }) },
        }
      }
      return notFoundResponse(`No case citation could be read out of "${input.caseNumber}".`, [
        'Medium-neutral form: "[2010] NSWCCA 333", "[2020] HCA 41".',
        'A sentence works too: "Is Dela Cruz v R [2010] NSWCCA 333 still good law?"',
        "An unrecognised court identifier is reported as unclear, not as a missing case — check the court token.",
      ])
    }

    const citation = usable.ok ? (usable.citation as MncCitation) : undefined
    if (!citation) return notFoundResponse(`No medium-neutral citation in "${input.caseNumber}".`)
    const shown = formatCitation({ ...citation, pinpoint: undefined })

    const tie = tiedProvision(input.caseNumber)
    const [location, trace] = await Promise.all([
      locateCase(apiClient, citation),
      backTrace(apiClient, shown, { perSource: Math.max(input.display, 10), exclude: shown }),
    ])

    const decisionYear = citation.year
    const citing = prioritise(trace.hits)

    const scans: ScanResult[] = []
    if (input.deepScan && citing.length > 0) {
      for (const hit of citing.slice(0, MAX_DEEP_SCANS)) {
        try {
          const body = await readJudgment(apiClient, hit)
          scans.push({ hit, scan: scanTreatment(body, shown) })
        } catch (error) {
          scans.push({
            hit,
            scan: { mentions: 0, signals: [] },
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    const override = tie ? await legislativeOverride(apiClient, tie, decisionYear) : undefined
    const overruling = scans.filter((result) => hasOverrulingSignal(result.scan))
    const verdict = decide({ location, trace, citing, scans, overruling, override })

    const gaps: ResearchGap[] = []
    const uninspected = citing.slice(scans.length).map((hit) => hit.url).filter((url, index, urls) => url && urls.indexOf(url) === index)
    if (uninspected.length > 0) {
      gaps.push(makeGap({
        kind: "treatment",
        originTool: "cite_check",
        target: { citation: shown },
        jurisdiction: citation.court_info.jurisdiction,
        reason: `${uninspected.length} accessible candidate later case(s) were not opened within this tool's deep-scan bound.`,
        sourceUrls: uninspected,
        sourceAccess: "permitted",
        evidenceNeeded: ["Later citing decisions from the missing sources", "Exact passages showing how the authority was treated", "The sources, date range and inspected-result count"],
      }))
    }
    if (!trace.complete || verdict === "unverified_treatment") {
      gaps.push(makeGap({
        kind: "treatment", originTool: "cite_check", target: { citation: shown }, jurisdiction: citation.court_info.jurisdiction,
        reason: "Professional/report-series and unreachable-source treatment coverage remains incomplete.",
        sourceUrls: [lawCiteUrl(shown)], sourceAccess: "requires_access",
        evidenceNeeded: ["Treatment results from the restricted or missing sources", "Exact relevant passages", "Source and inspected-result coverage"],
      }))
    }
    if (override && !override.available) {
      gaps.push(makeGap({
        kind: "commencement",
        originTool: "cite_check",
        originalErrorCode: override.gapCode,
        target: { citation: shown, registerId: override.titleId, provision: tie?.provision },
        reason: override.note ?? "The amendment/commencement check did not complete.",
        sourceUrls: [],
        sourceAccess: "unknown",
        evidenceNeeded: ["Official amending text", "Commencement and application or saving provisions"],
      }))
    }
    return {
      content: [
        {
          type: "text",
          text: truncateResponse(
            render({ shown, citation, location, trace, citing, scans, overruling, override, tie, verdict, input }).join("\n"),
          ),
        },
      ],
      ...(gaps.length ? { structuredContent: { followup: followupEnvelope(gaps, { pending: true }) } } : {}),
    }
  } catch (error) {
    return formatToolError(error, "cite_check")
  }
}

/**
 * Rows that actually support "later judgments mention this case".
 *
 * A row from NSW Caselaw or Queensland Judgments does, because those searches
 * match the phrase. A row from the High Court's listing does not — its keyword
 * search matches any of the words (see `CANDIDATE_ONLY_SOURCES`) — unless the
 * deep scan opened it and found the citation in the text.
 */
function confirmedCitings(p: { citing: readonly SourceHit[]; scans: readonly ScanResult[] }): number {
  const fromSearch = p.citing.filter((hit) => !isCandidateOnly(hit.source)).length
  const fromScan = p.scans.filter((result) => !result.error && result.scan.mentions > 0).length
  return fromSearch + fromScan
}

function decide(p: {
  location: CaseLocation
  trace: BackTrace
  citing: readonly SourceHit[]
  scans: readonly ScanResult[]
  overruling: readonly ScanResult[]
  override?: { effects: DatedEffect[] }
}): Verdict {
  if (p.overruling.length > 0) return "overruled_candidate"
  if (p.override && p.override.effects.length > 0) return "legislative_override"
  // `not_found` requires a real absence AND a complete back-trace. Either a
  // blocked source or a failed one leaves the question open, and answering it
  // anyway is how a real authority gets advised out of existence.
  if (p.location.status === "absent" && p.trace.complete && p.citing.length === 0) return "not_found"
  // `cited` is a claim about the text of later judgments, so it needs a row
  // whose source matched the phrase, or a scan that read the citation. Taking
  // any row answered `[2019] HCA 99` — a citation the Court's own complete 2019
  // list does not contain, and which this tool had already marked ✗ two lines
  // above — with "Verdict: cited" over twelve real, unrelated judgments.
  if (confirmedCitings(p) > 0) return "cited"
  return "unverified_treatment"
}

const VERDICT_LINE: Record<Verdict, string> = {
  cited: "cited — later judgments mention this case and no contrary appellate language was found in what was scanned",
  overruled_candidate: "overruled_candidate — a later judgment's text overrules, doubts or declines to follow this case",
  legislative_override:
    "legislative_override — the provision this case turned on has been amended since it was decided, so the case may be good law and still not answer today's question",
  not_found:
    "not_found — every reachable source answered, and none of them holds this citation or any later mention of it",
  unverified_treatment:
    "unverified_treatment — the citation exists but its treatment could not be classified. This is the default and it is not a clean bill of health",
}

function render(p: {
  shown: string
  citation: MncCitation
  location: CaseLocation
  trace: BackTrace
  citing: readonly SourceHit[]
  scans: readonly ScanResult[]
  overruling: readonly ScanResult[]
  override?: OverrideCheck
  tie?: { lawName: string; provision: string }
  verdict: Verdict
  input: CiteCheckInput
}): string[] {
  const lines: string[] = []
  lines.push(`Citation check — ${p.shown} (${p.citation.court_info.name})`)
  lines.push("")

  lines.push("▶ The case itself")
  if (p.location.status === "found") {
    lines.push(`  ✓ ${p.location.title ?? p.shown}${p.location.date ? `, ${p.location.date}` : ""} — ${p.location.source}`)
    lines.push(`    ${p.location.url}`)
  } else if (p.location.status === "absent") {
    lines.push(`  ✗ ${p.location.reason}`)
  } else if (p.location.status === "unreachable") {
    lines.push(`  ⚠ ${p.location.source} could not be reached (${p.location.reason}) — nothing was learned either way.`)
  } else {
    lines.push(`  ⚠ ${p.location.reason}`)
  }
  if (p.location.status === "unsupported" || p.location.status === "unreachable") {
    for (const link of p.location.links) lines.push(`    ${link}`)
  }
  for (const warning of p.citation.warnings) lines.push(`  ⚠ ${warning}`)

  lines.push("")
  lines.push(`▶ Verdict: ${VERDICT_LINE[p.verdict]}`)

  lines.push("")
  // Not "mentioning": some of these rows come from a search that matched any
  // of the words. Which is which is on the per-source lines below.
  lines.push(`▶ Later cases that may cite ${p.shown} — ${p.citing.length} row(s) across the sources`)
  for (const line of describeOutcomes(p.trace)) lines.push(line)
  if (p.citing.length === 0) {
    lines.push(
      p.trace.complete
        ? "  No later mention in the sources searched. Those are three sites, not the whole corpus — Federal Court, " +
          "Victorian, SA, WA, Tasmanian, ACT and NT judgments are not searched here."
        : "  No later mention found, but at least one source did not answer — this is not evidence of no citation.",
    )
  } else {
    p.citing.slice(0, p.input.display).forEach((hit, index) => {
      lines.push(`  ${index + 1}. ${hit.citation ?? ""} ${hit.title}${hit.date ? ` (${hit.date})` : ""}`)
      lines.push(`     ${hit.url}`)
    })
    if (p.citing.length > p.input.display) lines.push(`  … ${p.citing.length - p.input.display} more not shown.`)
  }

  lines.push("")
  if (!p.input.deepScan) {
    lines.push("▶ Treatment scan: skipped (deepScan=false), so no overruling language was looked for.")
  } else if (p.scans.length === 0) {
    lines.push("▶ Treatment scan: no citing judgment was available to read.")
  } else {
    lines.push(`▶ Treatment scan (${p.scans.length} judgment(s) read)`)
    for (const result of p.scans) {
      if (result.error) {
        lines.push(`  ⚠ ${result.hit.citation ?? result.hit.title}: could not be read — ${result.error}`)
        continue
      }
      if (result.scan.signals.length === 0) {
        lines.push(
          `  • ${result.hit.citation ?? result.hit.title}: ${result.scan.mentions} mention(s), no overruling or doubting language nearby`,
        )
        continue
      }
      for (const signal of result.scan.signals) {
        const flags = [
          signal.kind === "overruling" ? "OVERRULING" : "doubting",
          signal.nearDissent ? "dissent language in the same passage — check who said it" : "",
          signal.nearPlurality ? "joint/plurality language nearby" : "",
        ].filter(Boolean)
        lines.push(`  ${signal.kind === "overruling" ? "🚨" : "•"} ${result.hit.citation ?? result.hit.title}: "${signal.phrase}" [${flags.join("; ")}]`)
        lines.push(`     …${signal.context.slice(0, 260)}…`)
      }
    }
  }

  lines.push("")
  if (!p.tie) {
    lines.push(
      "▶ Legislative override: not checked — no provision was named in the query. A case can be good law and still " +
        'be spent because its section changed; re-run with the provision, e.g. "[2010] NSWCCA 333 on s 18 of the CCA".',
    )
  } else if (p.override && p.override.effects.length > 0) {
    lines.push(`▶ Legislative override — ${p.tie.provision} of ${p.override.title ?? p.tie.lawName}`)
    for (const effect of p.override.effects.slice(0, 10)) {
      lines.push(`  ${effect.provision}: ${effect.code}${effect.meaning ? ` (${effect.meaning})` : ""} by ${effect.act.raw}`)
    }
    lines.push(
      `  ⚠️ The endnote cites amending Acts by year and number, never by commencement date, so "after ${p.citation.year}" ` +
        `here means "numbered in ${p.citation.year} or later". An Act numbered in ${p.citation.year} may have commenced before the judgment — check it.`,
    )
  } else if (!p.override || !p.override.available) {
    // The endnote table was never read, so it shows nothing — least of all an
    // absence of amending Acts. Saying "shows no amending Act" here is a
    // legislative_override clearance built on an upstream failure.
    lines.push(
      `▶ Legislative override: could not be checked for ${p.tie.provision} of ` +
        `${p.override?.title ?? p.tie.lawName}`,
    )
    lines.push(
      `  [${p.override?.gapCode ?? ErrorCodes.UPSTREAM_NO_DATA}] ` +
        `${p.override?.note ?? "the compilation's amendment-history endnote could not be read"}`,
    )
    lines.push(
      "  ⚠️ The check did not run, so nothing here says the provision was never amended. Do not read the verdict " +
        "above as covering the legislation — retry, or read the compilation endnotes yourself.",
    )
  } else {
    lines.push(
      `▶ Legislative override: ${p.tie.provision} of ${p.override.title ?? p.tie.lawName} shows no amending Act ` +
        `numbered ${p.citation.year} or later in the compilation endnotes.`,
    )
  }

  lines.push("")
  lines.push("▶ Finish the job")
  lines.push(`  LawCite (free citation graph, browser only): ${lawCiteUrl(p.shown)}`)
  lines.push(
    "  ⚠️ This is a free CITATION GRAPH, not a Shepard's-style citator. It shows which later judgments mention the " +
      "case, not how they treated it. Editorial treatment (applied / followed / distinguished / overruled) comes from " +
      "CaseBase (Lexis+) or FirstPoint (Westlaw AU); nothing here substitutes for them.",
  )
  lines.push(
    "  ⚠️ Overruling language is detected by heuristic and Australian courts overrule discursively — a case can be " +
      'gutted without any of these phrases appearing. "No signal" is not "still good law".',
  )
  return lines
}

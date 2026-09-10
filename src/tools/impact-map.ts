/**
 * `impact_map` — everything that hangs off one provision.
 *
 * Every other tool here runs forwards: name a law, get its text. This one runs
 * backwards from a single provision to the things that depend on it, which is
 * the shape of the question a lawyer actually has ("if s 18 changes, what
 * breaks?"). Four axes, each from a different kind of source:
 *
 *   (a) **Citing cases** — full-text mention search across NSW Caselaw,
 *       Queensland Judgments and the High Court list. Australian judgments
 *       write the same section a dozen ways, so several phrasings go out and
 *       the results are merged.
 *   (b) **Instruments made under the Act** — the Register's own `authorises`
 *       relation, with `$expand=authorisedBy` attaching the *enabling
 *       provision*. Instruments enabled by this very section are separated from
 *       the rest of the Act's instruments, because only the first group is a
 *       dependency of the provision rather than of the statute.
 *   (c) **State counterparts** — the curated applied/uniform/comparable
 *       families, which carry their own caution about whether section numbers
 *       correspond at all.
 *   (d) **Recent amendments** — the compilation endnotes for that provision.
 *
 * The counts are mention counts, not treatment counts: a judgment that cites
 * s 18 to distinguish it appears here exactly like one that applies it.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { austliiSearchUrl, frlHumanUrl } from "../lib/external-links-map.js"
import { aliasesFor } from "../lib/law-alias.js"
import { findNavPoint } from "../lib/provision-slicer.js"
import { truncateResponse } from "../lib/schemas.js"
import { mentionForTitle, primaryLawMention, provisionParam } from "../lib/query-extract.js"
import { formatRef, parseSectionRef, type SectionRef } from "../lib/section-ref.js"
import type { FrlTitle, ToolResponse } from "../lib/types.js"
import { followupEnvelope, makeGap } from "../lib/research-followup.js"
import { amendedAfter, provisionHistory } from "./analysis-helpers/amendment-lookup.js"
import { backTrace, describeOutcomes, mergeTraces } from "./analysis-helpers/citing-search.js"
import { headingTitle } from "../lib/citation-content-matcher.js"
import { enabledInstruments, enablingProvisionFor, type RelatedTitle } from "./statute-helpers/instruments.js"
import { findFamilies, type StatuteFamily } from "./statute-helpers/state-equivalents.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"
import { cachedToc } from "./statute-helpers/toc.js"

export const ImpactMapSchema = z.object({
  lawName: z.string().min(2).describe("Act name, alias or register id — 'Competition and Consumer Act', 'CCA', 'C2004A00109'."),
  provision: z.string().min(1).describe('The provision, e.g. "s 18", "sch 2 s 18" (the ACL), "pt IVA".'),
  includeInstruments: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include legislative instruments made under the Act (one extra Register call). Default true."),
  includeMermaid: z.boolean().optional().default(true).describe("Emit a mermaid graph of the result. Default true."),
})

export type ImpactMapInput = z.infer<typeof ImpactMapSchema>

export const impactMapDescription =
  "Reverse dependencies of a single provision: the later judgments that mention it, the legislative instruments made " +
  "under the Act (flagging the ones this section itself enables), the state counterparts of the Act, and the " +
  "amendments the provision has had. Answers 'if this section changed, what would be affected?'. Pass the schedule " +
  "prefix where it matters — 'sch 2 s 18' (ACL) and 's 18' (CCA) have entirely different impact maps.";

/** Citing-case hits shown per source. */
const HITS_SHOWN = 8
/** Instruments listed. */
const INSTRUMENTS_SHOWN = 10
/**
 * How many of the Act's in-force instruments are actually fetched and read for
 * their enabling provision. One Register page; the CCA has 146 in force, the
 * Corporations Act 410, so for a busy Act this is a **sample**, not a census —
 * which is why every number derived from it is labelled at the point it is
 * printed (`scanLabel` below).
 */
const INSTRUMENT_SCAN_TOP = 40
/** Hard ceiling on the mermaid node count, so a busy section cannot blow the response. */
const MERMAID_MAX_NODES = 18

/**
 * Search phrases for one provision.
 *
 * Judgments cite the same section as "Competition and Consumer Act 2010 (Cth)
 * s 18", "s 18 of the Competition and Consumer Act" and "CCA s 18" — one
 * phrasing finds a fraction of the mentions. The list is capped because each
 * phrase is a fan-out across three sites.
 */
export function searchPhrases(title: FrlTitle, ref: SectionRef): string[] {
  const pinpoint = formatRef(ref)
  const bare = title.name.replace(/\s+\d{4}$/, "")
  const phrases = new Set<string>([`${bare} ${pinpoint}`])
  for (const alias of aliasesFor(title.name).slice(0, 2)) {
    if (alias.length <= 6) phrases.add(`${alias} ${pinpoint}`)
  }
  return [...phrases].slice(0, 2)
}

export async function impactMap(apiClient: AuApiClient, input: ImpactMapInput): Promise<ToolResponse> {
  try {
    const asked = parseSectionRef(input.provision)
    if (!asked) {
      return {
        content: [
          {
            type: "text",
            text:
              `[INVALID_PARAMETER] "${input.provision}" is not a recognisable provision reference.\n` +
              'Use forms like "s 18", "sch 2 s 18", "pt IVA", "reg 2.01".',
          },
        ],
        isError: true,
      }
    }

    const lookup = await resolveTitle(apiClient, { query: input.lawName })
    const title = lookup.title

    // An alias can name a *schedule*, and this tool has no defence against
    // getting it wrong: it reports the citing judgments, instruments and
    // amendments of whatever provision it settled on, so a silent body-section
    // read produces a whole page about the wrong section. Live 2026-09-05,
    // `{lawName:"ACL", provision:"s 18"}` printed the alias note — which says in
    // terms that ACL s 18 is NOT CCA s 18 (meetings of Commission) — and then
    // `Provision: s 18 — "Meetings of Commission"` directly under it. Same
    // rewrite as get_law_text and get_provision_history, bounded to the Act the
    // alias actually names (`mentionForTitle`); an explicit `sch N` keeps its own.
    const mention = mentionForTitle(primaryLawMention(input.lawName), title.id)
    const scoped = provisionParam(asked, mention)
    const rewritten = scoped !== formatRef(asked)
    const ref = rewritten ? (parseSectionRef(scoped) ?? asked) : asked
    const pinpoint = formatRef(ref)

    // The provision's own heading, and proof it exists before anything is
    // reported as depending on it.
    let heading: string | undefined
    let tocError: string | undefined
    try {
      const toc = await cachedToc(apiClient, title.id)
      const entry = findNavPoint(ref, toc)
      heading = entry ? headingTitle(entry.label) : undefined
      if (!entry) tocError = `${pinpoint} is not in the current table of contents of ${title.name}`
    } catch (error) {
      tocError = error instanceof Error ? error.message : String(error)
    }

    const phrases = searchPhrases(title, ref)
    const [traces, instruments, history] = await Promise.all([
      Promise.all(phrases.map((phrase) => backTrace(apiClient, phrase, { perSource: HITS_SHOWN }))),
      input.includeInstruments
        ? enabledInstruments(apiClient, title.id, { top: INSTRUMENT_SCAN_TOP }).catch((error: unknown) => ({
            count: 0,
            titles: [] as RelatedTitle[],
            error: error instanceof Error ? error.message : String(error),
          }))
        : Promise.resolve({ count: 0, titles: [] as RelatedTitle[], skipped: true as const }),
      provisionHistory(apiClient, title.id, ref),
    ])

    const trace = mergeTraces(traces)
    const merged = trace.hits
    const families = findFamilies(input.lawName).concat(findFamilies(title.name)).filter(unique)

    const lines: string[] = []
    lines.push(`Impact map — ${title.name} ${pinpoint} [${title.id}]`)
    for (const note of lookup.notes) lines.push(note)
    // Never silently: the caller asked about one number and is being shown the
    // dependencies of another.
    if (rewritten) {
      lines.push(
        `Read "${input.provision}" as "${scoped}": "${input.lawName}" names sch ${mention?.sch ?? "?"} of this Act, ` +
          "so the bare reference would have mapped the body provision instead.",
      )
    }
    if (heading) lines.push(`Provision: ${pinpoint} — "${heading}"`)
    else lines.push(`⚠️ Provision heading unavailable: ${tocError ?? "unknown"}. The map below may be about a provision that does not exist under this reference.`)
    lines.push(`${frlHumanUrl(title.id)}`)
    lines.push("")

    // (a) citing cases
    // Not "mentioning": the High Court listing matches any of the words, so its
    // rows are candidates. `describeOutcomes` says which source is which.
    lines.push(`▶ Judgments that may cite this provision (searched: ${phrases.map((phrase) => `"${phrase}"`).join(", ")})`)
    for (const line of describeOutcomes(trace)) lines.push(line)
    if (merged.length === 0) {
      lines.push(
        trace.complete
          ? "  No mention found in the three searchable sites. That is NOT 'no cases': Federal Court, Victorian, SA, " +
            "WA, Tasmanian, ACT and NT judgments are not searched here, and neither is any reported series."
          : "  No mention found, but at least one source failed — this is not evidence of absence.",
      )
    } else {
      merged.slice(0, HITS_SHOWN * 2).forEach((hit, index) => {
        lines.push(`  ${index + 1}. ${hit.citation ?? ""} ${hit.title}${hit.date ? ` (${hit.date})` : ""}`)
        lines.push(`     ${hit.url}`)
      })
      if (merged.length > HITS_SHOWN * 2) lines.push(`  … ${merged.length - HITS_SHOWN * 2} more not shown.`)
    }
    lines.push(`  Wider free search (browser only): ${austliiSearchUrl(`${title.name} ${pinpoint}`)}`)

    // (b) instruments
    lines.push("")
    if ("skipped" in instruments) {
      lines.push("▶ Instruments made under the Act: skipped (includeInstruments=false).")
    } else if ("error" in instruments) {
      lines.push(`▶ Instruments made under the Act: [UPSTREAM_NO_DATA] ${instruments.error} — not a finding that there are none.`)
    } else {
      const scan = scanScope(instruments.count, instruments.titles.length)
      const enabledHere = instruments.titles.filter((instrument) =>
        provisionMatches(enablingProvisionFor(instrument.authorisedBy ?? [], title.id), ref),
      )
      lines.push(
        `▶ Legislative instruments in force under ${title.name}: ${instruments.count}` +
          `${
            enabledHere.length > 0
              ? `, of which ${enabledHere.length} of the ${scan.examined} ${scanLabel(scan)} name ${pinpoint} as ` +
                "the enabling provision"
              : ""
          }`,
      )
      if (scan.capped) {
        // The count above is the Register's; every number after it is this
        // window's. Without this line "2 of 146" is what a reader takes away.
        lines.push(
          `  ⚠️ Enabling-provision figures below cover only the ${scan.examined} instrument(s) this call read ` +
            `(alphabetical, of ${scan.total} in force); the other ${scan.total - scan.examined} were never fetched. ` +
            `Treat any tally of ${pinpoint} as a floor, not a total — use ` +
            `get_enabled_instruments({registerId:"${title.id}"}) to page through the rest.`,
        )
      }
      for (const instrument of (enabledHere.length > 0 ? enabledHere : instruments.titles).slice(0, INSTRUMENTS_SHOWN)) {
        const enabling = enablingProvisionFor(instrument.authorisedBy ?? [], title.id)
        lines.push(`  • ${instrument.name} [${instrument.id}]${enabling ? ` — made under ${enabling}` : ""}`)
      }
      if (enabledHere.length === 0 && instruments.titles.length > 0) {
        lines.push(
          `  ↳ None of the ${scan.examined} ${scanLabel(scan)} records ${pinpoint} as its enabling ` +
            "provision; those listed are made under the Act generally.",
        )
      }
    }

    // (c) state counterparts
    lines.push("")
    if (families.length === 0) {
      lines.push("▶ State and territory counterparts: none in the curated statute-family table for this Act.")
    } else {
      for (const family of families.slice(0, 2)) lines.push(...renderFamily(family, pinpoint))
    }

    // (d) amendments
    lines.push("")
    lines.push(`▶ Amendments to ${pinpoint}`)
    if (!history.available) {
      lines.push(`  [UPSTREAM_NO_DATA] ${history.note ?? "the amendment-history endnote could not be read"} — not a finding that it was never amended.`)
    } else if (history.rows.length === 0) {
      lines.push("  No row in the compilation's amendment-history endnote, which normally means it has never been amended.")
    } else {
      const recent = amendedAfter(history.rows, 1900).slice(-8)
      for (const effect of recent) {
        lines.push(`  ${effect.provision}: ${effect.code}${effect.meaning ? ` (${effect.meaning})` : ""} by ${effect.act.raw}`)
      }
    }

    // mermaid
    if (input.includeMermaid) {
      lines.push("")
      lines.push("▶ Graph")
      lines.push("```mermaid")
      lines.push(
        mermaid({
          root: `${shortName(title.name)} ${pinpoint}`,
          cases: merged.length,
          // `undefined`, never `0`: the graph node for a scan that was skipped
          // or failed upstream used to read "Instruments under the Act: 0",
          // which is the absence claim this server exists not to make.
          ...("skipped" in instruments || "error" in instruments
            ? {}
            : { instruments: scanScope(instruments.count, instruments.titles.length) }),
          families,
          amendments: history.rows.length,
        }),
      )
      lines.push("```")
    }

    lines.push("")
    lines.push(
      "⚠️ These are MENTION counts, not treatment counts: a judgment that distinguishes the provision looks exactly " +
        "like one that applies it. Use cite_check on an individual case, and get_provision_history for the full " +
        "amendment record.",
    )

    const interpretationGap = makeGap({
      kind: "legal_interpretation", originTool: "impact_map",
      target: { registerId: title.id, provision: pinpoint },
      reason: "Dependency counts and enabling-provision comparisons are signals only; they do not establish treatment, validity or the legal effect of an amendment.",
      sourceUrls: [frlHumanUrl(title.id)], sourceAccess: "permitted",
      evidenceNeeded: ["The enabling provision before and after the relevant date", "Commencement, application and saving material", "A host-model legal assessment distinguishing primary evidence from interpretation"],
    })
    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }], structuredContent: { followup: followupEnvelope([interpretationGap], { pending: true }) } }
  } catch (error) {
    return formatToolError(error, "impact_map")
  }
}

/**
 * What the enabling-provision figures were actually computed over.
 *
 * `enabledInstruments` returns the Register's whole `@odata.count` next to at
 * most `$top` rows, so `count` is a census and `titles.length` is a sample. One
 * derived tally printed beside the other reads as "2 of 146" when 106 titles
 * were never fetched — which is why this is built once and every site that
 * prints a derived number takes its wording from here.
 */
export interface ScanScope {
  /** The Register's own count of in-force instruments under the Act. */
  total: number
  /** How many were actually fetched and read for their enabling provision. */
  examined: number
  /** True when `examined < total`: every derived number is a floor. */
  capped: boolean
}

export function scanScope(total: number, examined: number): ScanScope {
  return { total, examined, capped: examined < total }
}

/** The noun phrase for `examined`, which must never read as the whole corpus. */
export function scanLabel(scan: ScanScope): string {
  return scan.capped
    ? `instrument(s) examined (of ${scan.total} in force — a capped scan)`
    : "instrument(s) examined (all of them)"
}

/** Does an `authorisedBy` enabling provision (`"s 172"`, `"s 134(1) of sch 2"`) name this reference? */
function provisionMatches(enabling: string | undefined, ref: SectionRef): boolean {
  if (!enabling) return false
  const parsed = parseSectionRef(enabling.replace(/\s+of\s+sch\s+(\S+)/i, ""))
  const scheduleInText = /of\s+sch(?:edule)?\s+(\S+)/i.exec(enabling)?.[1]
  if (!parsed) return false
  const sameNumber = parsed.number === ref.number && (parsed.letterSuffix ?? "") === (ref.letterSuffix ?? "")
  const schedule = ref.schedule ?? undefined
  const theirs = parsed.schedule ?? scheduleInText
  return sameNumber && (schedule ?? undefined) === (theirs ?? undefined)
}

function unique<T extends { key: string }>(family: T, index: number, all: readonly T[]): boolean {
  return all.findIndex((entry) => entry.key === family.key) === index
}

function renderFamily(family: StatuteFamily, pinpoint: string): string[] {
  const lines: string[] = [`▶ State and territory counterparts — ${family.label} (${family.relation})`]
  for (const member of family.members) {
    const flag = member.variant === "not-adopted" ? " ⚠️ NOT adopted" : member.variant === "modified" ? " (modified)" : ""
    lines.push(`  ${member.jurisdiction}: ${member.title}${member.pinpoint ? ` — ${member.pinpoint}` : ""}${flag}`)
    if (member.note) lines.push(`      ${member.note}`)
  }
  lines.push(`  ⚠️ ${family.caution}`)
  if (family.relation === "comparable") {
    lines.push(`  ⚠️ Do NOT translate ${pinpoint} into a section number in these Acts — they are independently drafted.`)
  }
  return lines
}

function shortName(name: string): string {
  return name.length <= 34 ? name : `${name.slice(0, 32)}…`
}

function sanitise(value: string): string {
  return value.replace(/["\n\r]/g, " ").replace(/\s+/g, " ").trim()
}

function mermaid(p: {
  root: string
  cases: number
  /** Absent when the scan was skipped or failed — which is not the same as none. */
  instruments?: ScanScope
  families: readonly StatuteFamily[]
  amendments: number
}): string {
  const lines = ["graph TD", `  P["${sanitise(p.root)}"]`]
  let nodes = 1
  const add = (id: string, labelText: string, note?: string): void => {
    if (nodes >= MERMAID_MAX_NODES) return
    nodes++
    lines.push(`  ${id}["${sanitise(labelText)}"]`)
    lines.push(`  P -->${note ? `|${sanitise(note)}|` : ""} ${id}`)
  }
  add("C", `Citing judgments: ${p.cases}`, "cited in")
  add(
    "I",
    p.instruments
      ? `Instruments under the Act: ${p.instruments.total}` +
        (p.instruments.capped ? ` (${p.instruments.examined} examined)` : "")
      : "Instruments under the Act: not read",
    "enables",
  )
  add("A", `Endnote amendment rows: ${p.amendments}`, "amended by")
  for (const [index, family] of p.families.slice(0, 2).entries()) {
    add(`F${index}`, `${family.label} (${family.members.length} jurisdictions)`, family.relation)
  }
  return lines.join("\n")
}

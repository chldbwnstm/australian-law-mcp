/**
 * Linkage tools: Act ⇄ instrument, and Commonwealth ⇄ State.
 *
 * The Act ⇄ instrument edge turned out to be a first-class relation on the
 * Register (`authorises` / `authorisedby` criteria plus `$expand=authorisedBy`
 * — see statute-helpers/instruments.ts for the live verification), so
 * `get_enabling_acts` reads it rather than guessing. The "made under …"
 * recital in the instrument's own text is kept only as a **labelled fallback**
 * for titles the Register has not linked, and it never silently overrides the
 * authoritative answer.
 *
 * The Commonwealth ⇄ State edge has no data source at all — the eight state
 * registers share no identifier scheme — so `get_state_equivalents` is a
 * curated table (statute-helpers/state-equivalents.ts) that says how each
 * family relates (applied / uniform / merely comparable) instead of implying
 * that section numbers translate.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import { frlHumanUrl } from "../lib/external-links-map.js"
import type { ToolResponse } from "../lib/types.js"
import { collectionLabel, titleAnnotations } from "./statute-helpers/format.js"
import { enabledInstruments, enablingActs, enablingProvisionFor, expandAuthorisedBy } from "./statute-helpers/instruments.js"
import { REGISTER_URLS, findFamilies, type StatuteFamily } from "./statute-helpers/state-equivalents.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"
import { cachedToc, locate, renderTree, requireRef, tocSummary } from "./statute-helpers/toc.js"

// ── 1. Act → instruments ───────────────────────────────────────────────────

export const GetEnabledInstrumentsSchema = z.object({
  registerId: z.string().optional().describe("Act register id, e.g. C2004A00109."),
  query: z.string().optional().describe("Act name or alias, if you have no registerId."),
  nameContains: z.string().optional().describe("Keep only instruments whose name contains this word (applied to the page returned)."),
  includeRepealed: z.boolean().optional().default(false).describe("Include instruments no longer in force."),
  includeGazetteNotices: z
    .boolean()
    .optional()
    .default(false)
    .describe("Also include notifiable instruments, gazette notices and appointments authorised by the Act (not legislation)."),
  limit: z.number().int().min(1).max(100).optional().default(40).describe("Instruments to return (max 100)."),
  skip: z.number().int().min(0).optional().describe("Offset, for paging."),
})

export type GetEnabledInstrumentsInput = z.infer<typeof GetEnabledInstrumentsSchema>

export const getEnabledInstrumentsDescription =
  "List every legislative instrument made under a Commonwealth Act, with the enabling provision of the Act for each. " +
  "Same relation as get_three_tier but flat and paged, for when you need the whole list rather than a grouped " +
  "overview. Filter with `nameContains` to find, say, the 'Information Standard' instruments under the CCA.";

export async function getEnabledInstruments(
  apiClient: AuApiClient,
  input: GetEnabledInstrumentsInput,
): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const act = lookup.title
    const found = await enabledInstruments(apiClient, act.id, {
      inForceOnly: !input.includeRepealed,
      ...(input.includeGazetteNotices ? { collections: [] } : {}),
      top: input.limit,
      ...(input.skip !== undefined ? { skip: input.skip } : {}),
    })

    const filtered = input.nameContains
      ? found.titles.filter((title) => title.name.toLowerCase().includes(input.nameContains!.toLowerCase()))
      : found.titles

    const lines: string[] = [`Instruments made under ${act.name} [${act.id}]`]
    for (const note of titleAnnotations(act)) lines.push(note)
    lines.push(
      `${found.count} on the Register${input.includeRepealed ? "" : " and in force"}; ` +
        `${filtered.length} shown${input.nameContains ? ` after the "${input.nameContains}" filter (applied to this page only)` : ""}.`,
    )
    lines.push("")

    if (filtered.length === 0) {
      lines.push(
        found.count === 0
          ? "[NOT_FOUND] The Register records no instrument authorised by this title."
          : `[NOT_FOUND] None of the ${found.titles.length} instruments on this page matches "${input.nameContains}".`,
      )
      lines.push("")
      lines.push(
        found.count === 0
          ? "Check that the id is the PRINCIPAL Act (amending Acts authorise nothing), or retry with includeRepealed:true."
          : `Page further with skip=${(input.skip ?? 0) + found.titles.length} — the filter only sees the current page.`,
      )
      return ok(lines.join("\n"))
    }

    for (const instrument of filtered) {
      const provision = enablingProvisionFor(instrument.authorisedBy ?? [], act.id)
      lines.push(`• ${instrument.name} [${instrument.id}]`)
      lines.push(
        `    ${collectionLabel(instrument)} | ${instrument.status ?? "status unknown"}` +
          `${provision ? ` | made under ${provision}` : ""}`,
      )
    }
    if (found.count > found.titles.length + (input.skip ?? 0)) {
      lines.push("")
      lines.push(`… page further with skip=${(input.skip ?? 0) + found.titles.length}.`)
    }
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_enabled_instruments")
  }
}

// ── 2. Instrument contents ─────────────────────────────────────────────────

export const GetInstrumentProvisionsSchema = z.object({
  registerId: z.string().optional().describe("Instrument register id, e.g. F1996B01420."),
  query: z.string().optional().describe("Instrument name, if you have no registerId."),
  provision: z.string().optional().describe('A provision to fetch, e.g. "reg 2.01", "s 7", "sch 1". Omit for the outline.'),
  date: z.string().optional().describe('Point in time: "YYYY-MM-DD" | "latest" | "asmade".'),
  depth: z.number().int().min(1).max(5).optional().default(3).describe("Outline depth when no provision is given."),
})

export type GetInstrumentProvisionsInput = z.infer<typeof GetInstrumentProvisionsSchema>

export const getInstrumentProvisionsDescription =
  "Open a legislative instrument (regulations, rules, standards, determinations): its outline, or the text of one " +
  'provision. Instruments number their provisions as regulations or sections — try "reg 2.01" then "s 7" if unsure. ' +
  "Find the instrument first with get_enabled_instruments or search_law(collection:'LegislativeInstrument').";

export async function getInstrumentProvisions(
  apiClient: AuApiClient,
  input: GetInstrumentProvisionsInput,
): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.registerId ? {} : { collection: "LegislativeInstrument" }),
    })
    const instrument = lookup.title
    const date = input.date && input.date !== "latest" ? input.date : undefined
    const entries = await cachedToc(apiClient, instrument.id, date)

    const lines: string[] = [`${instrument.name} [${instrument.id}] — ${collectionLabel(instrument)}`]
    for (const note of lookup.notes) lines.push(note)
    for (const note of titleAnnotations(instrument)) lines.push(note)
    lines.push("")

    if (!input.provision) {
      lines.push(...tocSummary(entries))
      lines.push("")
      const rendered = renderTree(entries, undefined, { maxDepth: input.depth, limit: 150 })
      lines.push(rendered.text || "(the table of contents has no entries at this depth)")
      if (rendered.total > rendered.shown) lines.push(`… ${rendered.total - rendered.shown} more entries.`)
      lines.push("")
      lines.push(`Next: get_instrument_provisions({registerId:"${instrument.id}", provision:"<label above>"}).`)
      lines.push(`Enabling Act: get_enabling_acts({registerId:"${instrument.id}"}).`)
      return ok(lines.join("\n"))
    }

    const ref = requireRef(input.provision)
    if (!locate(ref, entries)) {
      lines.push(`[NOT_FOUND] ${input.provision} is not in this instrument's table of contents.`)
      lines.push("")
      lines.push(
        "Instruments differ in how they number: regulations use 'reg', rules use 'r', standards often use 's'. " +
          "Call this tool without `provision` to see the actual labels before retrying.",
      )
      return ok(lines.join("\n"))
    }

    const provision = await apiClient.getProvision(instrument.id, input.provision, date)
    lines.push(`${provision.ref} — ${provision.heading}`)
    if (provision.breadcrumb.length > 0) lines.push(`In: ${provision.breadcrumb.join(" › ")}`)
    lines.push(`Source: ${frlHumanUrl(instrument.id, date)}`)
    lines.push("")
    lines.push(provision.text)
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_instrument_provisions")
  }
}

// ── 3. Instrument → enabling Act ───────────────────────────────────────────

export const GetEnablingActsSchema = z.object({
  registerId: z.string().optional().describe("Instrument register id, e.g. F1996B01420."),
  query: z.string().optional().describe("Instrument name, if you have no registerId."),
  allowTextFallback: z
    .boolean()
    .optional()
    .default(true)
    .describe("If the Register records no authorisation, read the instrument's 'made under' recital instead (labelled as heuristic)."),
})

export type GetEnablingActsInput = z.infer<typeof GetEnablingActsSchema>

export const getEnablingActsDescription =
  "Find the Act a legislative instrument was made under, and the exact enabling provision (e.g. Competition and " +
  "Consumer Act 2010 s 172). Read from the Register's own authorisation relation, so it is authoritative. Use " +
  "whenever you need to check that an instrument is within power, or to move up from a regulation to its Act.";

export async function getEnablingActs(apiClient: AuApiClient, input: GetEnablingActsInput): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const instrument = lookup.title

    const [{ acts }, rows] = await Promise.all([
      enablingActs(apiClient, instrument.id),
      expandAuthorisedBy(apiClient, instrument.id),
    ])

    const lines: string[] = [`Enabling Act(s) for ${instrument.name} [${instrument.id}]`]
    for (const note of titleAnnotations(instrument)) lines.push(note)
    lines.push("")

    if (acts.length > 0) {
      lines.push("From the Register's own authorisation relation (authoritative):")
      for (const act of acts) {
        const provision = enablingProvisionFor(rows, act.id)
        lines.push(`  • ${act.name} [${act.id}]${provision ? ` — made under ${provision}` : ""}`)
        lines.push(`      ${collectionLabel(act)} | ${act.status ?? "status unknown"}`)
      }
      lines.push("")
      lines.push(`Next: get_law_text({registerId:"${acts[0].id}", provision:"${enablingProvisionFor(rows, acts[0].id) ?? "s 1"}"}) for the power itself.`)
      lines.push(`      instrument_radar({registerId:"${instrument.id}"}) to check whether that Act has moved since.`)
      return ok(lines.join("\n"))
    }

    lines.push("[NOT_FOUND] The Register records no authorising title for this instrument.")
    lines.push("")
    if (!input.allowTextFallback) {
      lines.push("Text fallback was disabled. Instruments made before the current metadata scheme sometimes carry no link.")
      return ok(lines.join("\n"))
    }

    const recital = await readRecital(apiClient, instrument.id)
    if (!recital) {
      lines.push(
        "⚠️ The instrument's own opening text names no Act either. This is a gap in the record, not proof the " +
          "instrument is unauthorised — read the instrument itself with get_instrument_provisions.",
      )
      return ok(lines.join("\n"))
    }
    lines.push(`Heuristic fallback — the instrument's opening text says it was made under: "${recital}"`)
    lines.push("")
    lines.push(
      "⚠️ This is parsed from prose, NOT from the Register's authorisation data. Confirm it with " +
        `search_law({query:"${recital}"}) before relying on it.`,
    )
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_enabling_acts")
  }
}

/** `… make the following regulations under the Competition and Consumer Act 2010.` */
const MADE_UNDER = /\bunder\s+(?:the\s+)?([A-Z][A-Za-z'’(),\- ]{4,80}?\s+(?:Act|Ordinance)\s+\d{4})/

async function readRecital(apiClient: AuApiClient, instrumentId: string): Promise<string | undefined> {
  try {
    const entries = await cachedToc(apiClient, instrumentId)
    const first = entries.find((entry) => entry.volumeDoc)
    if (!first) return undefined
    const volume = /document_(\d+)/.exec(first.volumeDoc)
    const html = await apiClient.getVolumeHtml(instrumentId, volume ? Number(volume[1]) : 1)
    const match = MADE_UNDER.exec(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 20000))
    return match ? match[1].trim() : undefined
  } catch {
    return undefined
  }
}

// ── 4. Commonwealth ⇄ State ────────────────────────────────────────────────

export const GetStateEquivalentsSchema = z.object({
  query: z
    .string()
    .describe("Law or subject to map across jurisdictions, e.g. 'Australian Consumer Law', 'WHS Act', 'Evidence Act'."),
  jurisdiction: z
    .enum(["NSW", "Vic", "Qld", "SA", "WA", "Tas", "ACT", "NT", "Cth"])
    .optional()
    .describe("Show only this jurisdiction's counterpart."),
})

export type GetStateEquivalentsInput = z.infer<typeof GetStateEquivalentsSchema>

export const getStateEquivalentsDescription =
  "Map a law onto its counterparts in the other Australian jurisdictions — the ACL application Acts, the harmonised " +
  "WHS Acts, the uniform Evidence Acts, the criminal statutes, the uniform Defamation Acts. Says HOW each relates " +
  "(applied / uniform / merely comparable) and names the non-adopters (Victoria for WHS; Qld, SA, WA for evidence). " +
  "This is a curated table, not a search: state law is not on the Federal Register and is not fetched by this server.";

/** Signature matches every other tool so the registry needs no special case; no upstream is touched. */
export async function getStateEquivalents(_apiClient: AuApiClient, input: GetStateEquivalentsInput): Promise<ToolResponse> {
  try {
    const families = findFamilies(input.query)
    if (families.length === 0) {
      throw new LawApiError(
        `No curated statute family matches "${input.query}"`,
        ErrorCodes.NOT_FOUND,
        [
          `Families covered: ${STATUTE_FAMILY_LABELS.join("; ")}.`,
          "⚠️ A miss here means this server has no curated mapping — it is NOT a finding that no state equivalent exists. " +
            "Name similarity across jurisdictions is a weak signal and this tool will not guess from it.",
          "Search the relevant state register directly for anything outside these families.",
        ],
      )
    }

    const lines: string[] = []
    for (const family of families.slice(0, 3)) lines.push(...renderFamily(family, input.jurisdiction), "")
    lines.push("State and territory legislation is published on each jurisdiction's own register:")
    for (const [jurisdiction, url] of Object.entries(REGISTER_URLS)) {
      if (input.jurisdiction && jurisdiction !== input.jurisdiction) continue
      lines.push(`  ${jurisdiction.padEnd(4)} ${url}`)
    }
    lines.push("")
    lines.push("This server fetches Commonwealth law only — the state titles above are named, not retrieved.")
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_state_equivalents")
  }
}

const RELATION_TEXT: Record<StatuteFamily["relation"], string> = {
  applied: "APPLIED — the same Commonwealth text applies as a law of each jurisdiction",
  uniform: "UNIFORM — separately enacted from an agreed model; text near-identical",
  comparable: "COMPARABLE — same subject, independently drafted; numbering does NOT correspond",
}

function renderFamily(family: StatuteFamily, only?: string): string[] {
  const lines = [`${family.label}`, `Relationship: ${RELATION_TEXT[family.relation]}`]
  if (family.commonwealth) {
    lines.push(
      `  Cth   ${family.commonwealth.title}` +
        `${family.commonwealth.titleId ? ` [${family.commonwealth.titleId}]` : ""}` +
        `${family.commonwealth.pinpoint ? ` — ${family.commonwealth.pinpoint}` : ""}`,
    )
  }
  for (const member of family.members) {
    if (only && member.jurisdiction !== only) continue
    const flag = member.variant === "not-adopted" ? " ⚠️ DID NOT ADOPT" : member.variant === "modified" ? " (adopted with changes)" : ""
    lines.push(`  ${member.jurisdiction.padEnd(5)} ${member.title}${member.pinpoint ? ` — ${member.pinpoint}` : ""}${flag}`)
    if (member.note) lines.push(`        ${member.note}`)
  }
  lines.push(`  ⚠️ ${family.caution}`)
  return lines
}

const STATUTE_FAMILY_LABELS = [
  "Australian Consumer Law",
  "Work Health and Safety",
  "Uniform Evidence Acts",
  "Criminal statutes",
  "Uniform Defamation Acts",
]

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text) }] }
}

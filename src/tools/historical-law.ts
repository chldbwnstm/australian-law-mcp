/**
 * `search_historical_law` / `get_historical_law` — point-in-time legislation.
 *
 * "What did this section say when the conduct happened?" is the question that
 * makes or breaks legal advice, and the Federal Register answers it properly:
 * every compilation is addressable, and `Versions/Find(asAt=…)` names the one
 * in force on a given day.
 *
 * Two traps are handled rather than passed through:
 *
 *  - `isCurrent` and `isLatest` are different versions. The version in force
 *    now can have `registerId: null` (amendments commenced, compilation not yet
 *    registered), while `isLatest` is the newest registered compilation. Both
 *    are labelled; a caller that conflates them cites text that is not in force.
 *  - A version window is a *window*. `get_historical_law` addresses text by
 *    date, so any date inside the window returns that compilation — the tool
 *    says which window a requested date landed in.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { mentionForTitle, primaryLawMention, provisionParam } from "../lib/query-extract.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatRef } from "../lib/section-ref.js"
import { frlHumanUrl } from "../lib/external-links-map.js"
import type { FrlVersion, ToolResponse } from "../lib/types.js"
import { formatVersionLine, isoDay, reasonLine, titleAnnotations } from "./statute-helpers/format.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"
import { cachedToc, locate, renderTree, requireRef, tocSummary } from "./statute-helpers/toc.js"

const ISO = /^\d{4}-\d{2}-\d{2}$/

export const SearchHistoricalLawSchema = z.object({
  registerId: z.string().optional().describe("Title register id, e.g. C2004A00109 (from search_law)."),
  query: z.string().optional().describe("Law name or alias, if you have no registerId."),
  from: z.string().regex(ISO).optional().describe("Only compilations in force on or after this date (YYYY-MM-DD)."),
  to: z.string().regex(ISO).optional().describe("Only compilations that started on or before this date (YYYY-MM-DD)."),
  asAt: z
    .string()
    .regex(ISO)
    .optional()
    .describe("Single date: identify the one compilation in force then, and show its neighbours."),
  limit: z.number().int().min(1).max(100).optional().default(20).describe("Compilations to list (default 20, max 100)."),
  withReasons: z.boolean().optional().default(true).describe("Show the amending Acts recorded for each compilation."),
})

export type SearchHistoricalLawInput = z.infer<typeof SearchHistoricalLawSchema>

export const searchHistoricalLawDescription =
  "List the compilations (point-in-time versions) of a Commonwealth Act, newest first, with the amending Acts that " +
  "caused each one. Use `asAt` to find the single compilation in force on a date — the first step for any 'what did " +
  "the law say in <year>' question. Each row carries the compilation registerId and the date to pass to " +
  "get_historical_law / get_law_text.";

export async function searchHistoricalLaw(
  apiClient: AuApiClient,
  input: SearchHistoricalLawInput,
): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const title = lookup.title
    const versions = await apiClient.listVersions(title.id, { top: 100 })

    const lines: string[] = [`Compilations of ${title.name} [${title.id}]`]
    for (const note of lookup.notes) lines.push(note)
    for (const note of titleAnnotations(title)) lines.push(note)
    lines.push("")

    if (versions.length === 0) {
      lines.push("[UPSTREAM_NO_DATA] The Register returned no version rows for this title.")
      lines.push("")
      lines.push(
        "⚠️ This is a lookup result, not a finding that the Act was never compiled. Amending Acts often have a single " +
          "as-made text and no compilations — try get_law_text(date:'asmade').",
      )
      return ok(lines.join("\n"))
    }

    if (input.asAt) {
      const at = await apiClient.findVersion({ titleId: title.id, asAt: input.asAt })
      lines.push(`In force on ${input.asAt}:`)
      lines.push(`  ${formatVersionLine(at).replace(/^• /, "")}`)
      lines.push(
        `  Text: get_historical_law({registerId:"${title.id}", date:"${input.asAt}"}) — any date inside ` +
          `${isoDay(at.start)} → ${at.end ? isoDay(at.end) : "current"} returns this compilation.`,
      )
      lines.push("")
    }

    const filtered = versions.filter((version) => {
      if (input.from && (version.end ?? "9999") < input.from) return false
      if (input.to && (version.start ?? "") > input.to) return false
      return true
    })

    if (filtered.length === 0) {
      lines.push(`[NOT_FOUND] None of the ${versions.length} compilations falls in the requested window.`)
      lines.push(
        `Full range on the Register: ${isoDay(versions[versions.length - 1].start)} → ` +
          `${versions[0].end ? isoDay(versions[0].end) : "current"}.`,
      )
      return ok(lines.join("\n"))
    }

    lines.push(`${versions.length} compilation(s) on the Register; showing ${Math.min(filtered.length, input.limit)}.`)
    lines.push("")
    for (const [index, version] of filtered.slice(0, input.limit).entries()) {
      lines.push(formatVersionLine(version, index + 1))
      if (input.withReasons) {
        for (const reason of (version.reasons ?? []).slice(0, 4)) lines.push(`     ${reasonLine(reason)}`)
        const extra = (version.reasons ?? []).length - 4
        if (extra > 0) lines.push(`     … ${extra} more amendment reason(s)`)
      }
    }
    if (filtered.length > input.limit) lines.push(`… ${filtered.length - input.limit} more. Raise \`limit\` or narrow with from/to.`)
    lines.push("")
    lines.push(`Human page: ${frlHumanUrl(title.id)}`)

    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "search_historical_law")
  }
}

export const GetHistoricalLawSchema = z.object({
  registerId: z.string().optional().describe("Title register id, e.g. C2004A00109."),
  query: z.string().optional().describe("Law name or alias, if you have no registerId."),
  date: z
    .string()
    .optional()
    .describe('Date inside the wanted compilation window (YYYY-MM-DD), or "asmade" for the original enacted text.'),
  compilationId: z
    .string()
    .optional()
    .describe("Compilation register id, e.g. C2015C00019 — resolved to its date, which is how text is addressed."),
  provision: z
    .string()
    .optional()
    .describe('Provision to return from that compilation, e.g. "s 45". Omit for the compilation\'s structure only.'),
  maxChars: z.number().int().min(500).max(45000).optional().default(20000).describe("Cap on returned text."),
})

export type GetHistoricalLawInput = z.infer<typeof GetHistoricalLawSchema>

export const getHistoricalLawDescription =
  "Fetch a specific historical compilation of a Commonwealth Act: its metadata plus, with `provision`, the text of " +
  "one section AS IT STOOD THEN. Address it by `date` (any day inside the version window) or by `compilationId`. " +
  'Use date:"asmade" for the original enacted text. Pair with search_historical_law to pick the compilation.';

export async function getHistoricalLaw(apiClient: AuApiClient, input: GetHistoricalLawInput): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const title = lookup.title

    let version: FrlVersion | undefined
    let dateSegment: string
    if (input.compilationId) {
      version = await apiClient.findVersion({ registerId: input.compilationId })
      dateSegment = isoDay(version.start)
    } else if (input.date === "asmade") {
      dateSegment = "asmade"
    } else if (input.date) {
      if (!ISO.test(input.date)) {
        throw new LawApiError(`Invalid date: ${JSON.stringify(input.date)}`, ErrorCodes.INVALID_PARAM, [
          'Use "YYYY-MM-DD" or "asmade".',
        ])
      }
      version = await apiClient.findVersion({ titleId: title.id, asAt: input.date })
      dateSegment = input.date
    } else {
      throw new LawApiError("Give `date` or `compilationId`", ErrorCodes.INVALID_PARAM, [
        "search_historical_law lists the compilations and their date windows.",
      ])
    }

    const lines: string[] = [`${title.name} [${title.id}] — compilation addressed as ${dateSegment}`]
    for (const note of titleAnnotations(title)) lines.push(note)
    if (version) {
      lines.push(formatVersionLine(version).replace(/^• /, "Version: "))
      for (const reason of (version.reasons ?? []).slice(0, 6)) lines.push(`  ${reasonLine(reason)}`)
      if (version.hasUnincorporatedAmendments) {
        lines.push(
          "⚠️ This compilation itself carries unincorporated amendments — commenced changes are not in its text.",
        )
      }
    } else {
      lines.push("Version: as made (the text originally enacted, before any compilation).")
    }
    lines.push(`Human page: ${frlHumanUrl(title.id, dateSegment === "asmade" ? undefined : dateSegment)}`)
    lines.push("")

    const entries = await cachedToc(apiClient, title.id, dateSegment)

    if (!input.provision) {
      lines.push(...tocSummary(entries))
      lines.push("")
      const rendered = renderTree(entries, undefined, { maxDepth: 2, limit: 40 })
      lines.push(rendered.text)
      if (rendered.total > rendered.shown) lines.push(`… ${rendered.total - rendered.shown} more entries.`)
      lines.push("")
      lines.push(`Add \`provision\` (e.g. "s 45") for that section's text in this compilation.`)
      return ok(lines.join("\n"), input.maxChars)
    }

    const asked = requireRef(input.provision)
    // An alias can name a *schedule*, and a point-in-time read makes dropping
    // it worse than usual: "ACL" + "s 18" + a date returned the body's s 18
    // ("Meetings of Commission") AS IT STOOD THEN, under a title line the
    // caller reads as the Australian Consumer Law. Same rewrite as
    // get_law_text and get_provision_history (`query-extract.provisionParam`),
    // reused so the point-in-time path cannot drift from the latest-text path;
    // `mentionForTitle` bounds it to the Act the alias actually names, and an
    // explicit `sch N` from the caller keeps its own.
    const mention = mentionForTitle(input.query ? primaryLawMention(input.query) : undefined, title.id)
    const scoped = provisionParam(asked, mention)
    const rewritten = scoped !== formatRef(asked)
    const ref = rewritten ? requireRef(scoped) : asked
    if (rewritten) {
      lines.push(
        `Read "${input.provision}" as "${scoped}": "${input.query}" names sch ${mention?.sch ?? "?"} of this Act, ` +
          "so the bare reference would have returned the body provision as it stood then instead.",
      )
      lines.push("")
    }
    if (!locate(ref, entries)) {
      lines.push(`[NOT_FOUND] ${formatRef(ref)} is not in this compilation's table of contents.`)
      lines.push("")
      lines.push(
        "⚠️ For a historical compilation this is informative: the provision may not have existed yet, or may have " +
          "already been repealed. Use get_provision_history to see when it was inserted or removed — do not assume a " +
          "fetch failure.",
      )
      return ok(lines.join("\n"), input.maxChars)
    }

    const provision = await apiClient.getProvision(title.id, rewritten ? scoped : input.provision, dateSegment)
    lines.push(`${provision.ref} — ${provision.heading}`)
    if (provision.breadcrumb.length > 0) lines.push(`In: ${provision.breadcrumb.join(" › ")}`)
    lines.push("")
    lines.push(provision.text)
    return ok(lines.join("\n"), input.maxChars)
  } catch (error) {
    return formatToolError(error, "get_historical_law")
  }
}

function ok(text: string, maxChars?: number): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text, maxChars) }] }
}

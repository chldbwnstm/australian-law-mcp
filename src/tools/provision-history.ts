/**
 * `get_provision_history` — the amendment history of ONE provision.
 *
 * Built on the compilation's `Endnote 4—Amendment history` table rather than
 * on `Versions.reasons[]`, and the reason is a correctness one: `reasons[]`
 * records the **amending Act's** provisions (`sch 1 (item 66)` of that Act),
 * not the sections it amended. Grepping it for "s 18" matches the wrong side
 * of the relation and produces a plausible, wrong history. The endnote table
 * is the Register's own provision → amending-Act mapping.
 *
 * The Acts cited there are given as `No 103, 2010`, so each is resolved to a
 * register id — a history the caller cannot follow up is half an answer.
 * Resolution is capped and every unresolved citation is still printed.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ARTICLE_CACHE_TTL, lawCache } from "../lib/cache.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatRef } from "../lib/section-ref.js"
import type { FrlTitle, NcxEntry, ToolResponse } from "../lib/types.js"
import { titleAnnotations } from "./statute-helpers/format.js"
import {
  entriesForRef,
  findAmendmentHistoryNode,
  parseAmendmentHistory,
  type ActRef,
  type EndnoteEntry,
} from "./statute-helpers/endnotes.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"
import { cachedToc, requireRef, sliceSubtree } from "./statute-helpers/toc.js"

/** Upper bound on the year/number lookups one call will make. */
const MAX_ACT_LOOKUPS = 15

export const GetProvisionHistorySchema = z.object({
  registerId: z.string().optional().describe("Title register id, e.g. C2004A00109 (from search_law)."),
  query: z.string().optional().describe("Law name or alias, if you have no registerId."),
  provision: z
    .string()
    .describe('The provision, e.g. "s 18", "sch 2 s 18" (the ACL) or "pt IVA". The schedule prefix matters.'),
  date: z.string().optional().describe("Read the endnotes of a particular compilation (YYYY-MM-DD). Default: latest."),
  resolveActs: z
    .boolean()
    .optional()
    .default(true)
    .describe("Look each amending Act up to attach its register id and commencement (a few extra calls)."),
})

export type GetProvisionHistoryInput = z.infer<typeof GetProvisionHistorySchema>

export const getProvisionHistoryDescription =
  "The amendment history of a single provision: when it was inserted, every Act that amended it, and whether it was " +
  'repealed or substituted. Read from the Act\'s own compilation endnotes, so "sch 2 s 18" (ACL s 18, inserted 2010) ' +
  'and "s 18" (CCA s 18, amended 1986/1995/2007) give different answers — pass the schedule prefix. ' +
  "Use before quoting an older judgment's reading of a section, to check the wording has not moved since.";

export async function getProvisionHistory(
  apiClient: AuApiClient,
  input: GetProvisionHistoryInput,
): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const title = lookup.title
    const date = input.date && input.date !== "latest" ? input.date : undefined
    const ref = requireRef(input.provision)

    const lines: string[] = [`Amendment history of ${formatRef(ref)} — ${title.name} [${title.id}]`]
    for (const note of lookup.notes) lines.push(note)
    for (const note of titleAnnotations(title)) lines.push(note)
    lines.push("")

    const entries = await cachedToc(apiClient, title.id, date)
    const node = findAmendmentHistoryNode(entries)
    if (!node) {
      lines.push("[UPSTREAM_NO_DATA] This compilation has no 'Amendment history' endnote.")
      lines.push("")
      lines.push(
        "⚠️ Not a finding that the provision was never amended. Acts as made, and many legislative instruments, " +
          "carry no endnotes at all. Fall back to search_historical_law (compilation-level amendment reasons) or " +
          "compare_old_new with this provision.",
      )
      return ok(lines.join("\n"))
    }

    let table: EndnoteEntry[]
    try {
      table = await amendmentTable(apiClient, title.id, date, entries, node)
    } catch (error) {
      // Only the shape failure is answered here; a transport error keeps its
      // own label through `formatToolError`.
      if (!(error instanceof LawApiError) || error.code !== ErrorCodes.PARSE_ERROR) throw error
      lines.push(`[${ErrorCodes.PARSE_ERROR}] The amendment-history table could not be read: ${error.message}`)
      lines.push("")
      lines.push(
        "⚠️ Not a finding that the provision was never amended — the table was never read at all. Retry; if it " +
          "persists fall back to search_historical_law (compilation-level amendment reasons) or compare_old_new " +
          "with this provision.",
      )
      return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }], isError: true }
    }
    const rows = entriesForRef(table, ref)

    if (rows.length === 0) {
      lines.push(`[NOT_FOUND] The amendment-history table has no row for ${formatRef(ref)}.`)
      lines.push("")
      lines.push(
        ref.schedule
          ? `Rows for schedule ${ref.schedule} present in the table: ${sample(table.filter((row) => row.schedule === ref.schedule))}`
          : `Nearby body rows in the table: ${sample(table.filter((row) => row.schedule === undefined))}`,
      )
      lines.push("")
      lines.push(
        "A provision with no row has normally never been amended since the Act was made (the table lists only " +
          "changed provisions) — but confirm it exists at all with get_law_text before saying so.",
      )
      return ok(lines.join("\n"))
    }

    const actRefs = dedupeActs(rows.flatMap((row) => row.effects.flatMap((effect) => effect.acts)))
    const resolved = input.resolveActs ? await resolveActs(apiClient, actRefs) : new Map<string, FrlTitle>()

    for (const row of rows) {
      lines.push(`${row.provision}${row.schedule ? `  (Schedule ${row.schedule})` : ""}${row.scope ? `  — under ${row.scope}` : ""}`)
      for (const effect of row.effects) {
        const meaning = effect.meaning ? `${effect.code} (${effect.meaning})` : effect.code
        lines.push(`  ${meaning}:`)
        if (effect.acts.length === 0) {
          lines.push(`     ${effect.raw}`)
          continue
        }
        for (const act of effect.acts) {
          const hit = resolved.get(actKey(act))
          lines.push(
            hit
              ? `     ${act.raw} — ${hit.name} [${hit.id}]`
              : `     ${act.raw}${input.resolveActs ? " — register id not resolved" : ""}`,
          )
        }
      }
      lines.push("")
    }

    lines.push(`Amending Acts cited: ${actRefs.length}${input.resolveActs ? `, resolved: ${resolved.size}` : " (resolveActs was off)"}.`)
    lines.push(
      "Read the codes with the Act's own Endnote 2 abbreviation key: ad = added/inserted, am = amended, " +
        "rep = repealed, rs = repealed and substituted, ed = editorial change (no change of substance).",
    )
    lines.push("")
    lines.push(
      `Next: compare_old_new({registerId:"${title.id}", provision:"${input.provision}", fromDate:"..."}) to see the ` +
        "wording either side of one of these amendments.",
    )

    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_provision_history")
  }
}

async function amendmentTable(
  apiClient: AuApiClient,
  titleId: string,
  date: string | undefined,
  entries: NcxEntry[],
  node: NcxEntry,
): Promise<EndnoteEntry[]> {
  const key = `endnote4:${titleId}:${date ?? "latest"}`
  const cached = lawCache.get<EndnoteEntry[]>(key)
  if (cached) return cached
  const volume = /document_(\d+)/.exec(node.volumeDoc)
  const html = await apiClient.getVolumeHtml(titleId, volume ? Number(volume[1]) : 1, date)
  const slice = sliceSubtree(html, entries, node)
  if (slice === null) {
    // The endnote is in the table of contents but its anchor is not in the
    // volume the TOC points at — the same TOC/volume disagreement
    // `AuApiClient.getProvision` raises PARSE_ERROR for. An empty table here
    // would read as "this provision has never been amended", which is an
    // absence nothing established; and it must not be cached, or that wrong
    // answer is served for the whole TTL to every caller of this key.
    throw new LawApiError(
      `The NCX anchor for the amendment-history endnote (${node.anchor ?? "?"}) is missing from ` +
        `${node.volumeDoc} of ${titleId}`,
      ErrorCodes.PARSE_ERROR,
      ["TOC and volume disagree upstream — retry, and report the register id if it persists."],
    )
  }
  const parsed = parseAmendmentHistory(slice)
  lawCache.set(key, parsed, ARTICLE_CACHE_TTL)
  return parsed
}

function actKey(act: ActRef): string {
  return `${act.year}/${act.number}`
}

function dedupeActs(acts: ActRef[]): ActRef[] {
  const seen = new Set<string>()
  const out: ActRef[] = []
  for (const act of acts) {
    const key = actKey(act)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(act)
  }
  return out
}

/** `No 103, 2010` → the Act, via the year/number filter (reference §2a). */
async function resolveActs(apiClient: AuApiClient, acts: ActRef[]): Promise<Map<string, FrlTitle>> {
  const out = new Map<string, FrlTitle>()
  for (const act of acts.slice(0, MAX_ACT_LOOKUPS)) {
    const key = `actByNumber:${actKey(act)}`
    const cached = lawCache.get<FrlTitle | null>(key)
    if (cached !== null && cached !== undefined) {
      out.set(actKey(act), cached)
      continue
    }
    try {
      const found = await apiClient.searchTitles({
        filter: `year eq ${act.year} and number eq ${act.number} and seriesType eq 'Act'`,
        select: "id,name,year,number,status",
        top: 1,
      })
      const title = found.titles[0]
      if (title) {
        lawCache.set(key, title, ARTICLE_CACHE_TTL)
        out.set(actKey(act), title)
      }
    } catch {
      // A lookup failure must not lose the citation — the raw `No 103, 2010`
      // is still printed by the caller, unresolved and marked as such.
    }
  }
  return out
}

function sample(rows: readonly EndnoteEntry[]): string {
  if (rows.length === 0) return "(none)"
  return `${rows.slice(0, 12).map((row) => row.provision).join(", ")}${rows.length > 12 ? ` … (${rows.length} rows)` : ""}`
}

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text) }] }
}

/**
 * `get_law_history` — what changed, and when.
 *
 * Two modes from one question shape:
 *
 *  - **Across the Register.** `Versions?$filter=start ge … and start lt …`
 *    works globally, not just per title (verified live 2026-09-04: 522 version
 *    rows started in August 2026). That is the honest answer to "what changed
 *    on 1 July" — every commencement, amendment, repeal and cessation with the
 *    Act behind it.
 *  - **For one title.** The same rows filtered to that Act, which is the
 *    amendment timeline of a single statute.
 *
 * A version row is not always an amendment: `AsMade`, `Amend`, `Repeal`,
 * `Cease`, `ChangeDate` and `Disallow` are all changes and are all labelled,
 * because reading a repeal as an amendment is the kind of error that survives
 * into advice.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { normalizeFrlVersion } from "../lib/api-client.js"
import { truncateResponse } from "../lib/schemas.js"
import type { FrlVersion, ToolResponse } from "../lib/types.js"
import { isoDay, reasonLine } from "./statute-helpers/format.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"

const ISO = /^\d{4}-\d{2}-\d{2}$/

export const GetLawHistorySchema = z.object({
  date: z.string().regex(ISO).optional().describe("A single day (YYYY-MM-DD). Shorthand for from = to = that day."),
  from: z.string().regex(ISO).optional().describe("Window start (YYYY-MM-DD, inclusive)."),
  to: z.string().regex(ISO).optional().describe("Window end (YYYY-MM-DD, inclusive)."),
  registerId: z.string().optional().describe("Restrict to one title, e.g. C2004A00109. Omit to sweep the whole Register."),
  query: z.string().optional().describe("Restrict to one title by name or alias."),
  affect: z
    .enum(["AsMade", "Amend", "Repeal", "Cease", "ChangeDate", "Disallow"])
    .optional()
    .describe("Show only changes of this kind — e.g. 'Repeal' for what was repealed in the window."),
  limit: z.number().int().min(1).max(100).optional().default(25).describe("Rows to show (default 25, max 100)."),
})

export type GetLawHistoryInput = z.infer<typeof GetLawHistorySchema>

export const getLawHistoryDescription =
  "What changed in Commonwealth legislation in a date window: commencements, amendments, repeals and cessations, " +
  'each with the Act responsible. {date:"2026-07-01"} sweeps the whole Register for that day (the classic ' +
  "start-of-financial-year question); add registerId/query to get one Act's timeline instead. Filter with `affect` " +
  "(e.g. 'Repeal'). For one provision's history use get_provision_history.";

export async function getLawHistory(apiClient: AuApiClient, input: GetLawHistoryInput): Promise<ToolResponse> {
  try {
    const from = input.from ?? input.date
    const to = input.to ?? input.date ?? from
    if (!from || !to) {
      throw new LawApiError("Give `date`, or `from` and `to`", ErrorCodes.INVALID_PARAM, [
        'A single day: {"date":"2026-07-01"}. A window: {"from":"2026-07-01","to":"2026-07-31"}.',
      ])
    }
    if (from > to) {
      throw new LawApiError(`The window runs backwards: from ${from} to ${to}`, ErrorCodes.INVALID_PARAM, [
        "Swap `from` and `to`.",
      ])
    }

    const lines: string[] = []
    let versions: FrlVersion[]
    let total: number
    let scope: string

    if (input.registerId || input.query) {
      const lookup = await resolveTitle(apiClient, {
        ...(input.registerId ? { registerId: input.registerId } : {}),
        ...(input.query ? { query: input.query } : {}),
      })
      scope = `${lookup.title.name} [${lookup.title.id}]`
      const all = await apiClient.listVersions(lookup.title.id, { top: 100 })
      versions = all.filter((version) => inWindow(version.start, from, to))
      total = versions.length
      for (const note of lookup.notes) lines.push(note)
    } else {
      scope = "the whole Federal Register"
      const swept = await sweepRegister(apiClient, from, to, input.limit)
      versions = swept.versions
      total = swept.count
    }

    if (input.affect) {
      versions = versions.filter((version) =>
        (version.reasons ?? []).some((reason) => reason.affect === input.affect),
      )
    }

    const head = `Legislative changes in ${scope}: ${from}${from === to ? "" : ` → ${to}`}`
    lines.unshift(head)

    if (versions.length === 0) {
      lines.push("")
      lines.push(
        `[NOT_FOUND] No version rows${input.affect ? ` of kind ${input.affect}` : ""} start inside that window.`,
      )
      lines.push("")
      lines.push(
        "⚠️ Read this as 'nothing on the Register starts in this window', not as 'the law did not change'. " +
          "Commencement is often on the first of a month or a quarter — widen the window before concluding anything.",
      )
      return ok(lines.join("\n"))
    }

    lines.push(
      `${total} version row(s) in the window${input.affect ? `; ${versions.length} of kind ${input.affect}` : ""}; showing ${Math.min(versions.length, input.limit)}.`,
    )
    lines.push("")

    for (const version of versions.slice(0, input.limit)) {
      const kinds = [...new Set((version.reasons ?? []).map((reason) => reason.affect))]
      lines.push(
        `${isoDay(version.start)}  ${version.name ?? version.titleId} [${version.titleId}]` +
          `${kinds.length > 0 ? `  — ${kinds.join(", ")}` : ""}`,
      )
      if (version.registerId) lines.push(`   compilation ${version.compilationNumber ?? "?"} — registerId ${version.registerId}`)
      else lines.push("   no compilation registered for this version yet (text on the Register is the previous one)")
      for (const reason of (version.reasons ?? []).slice(0, 3)) lines.push(`   ${reasonLine(reason)}`)
      const extra = (version.reasons ?? []).length - 3
      if (extra > 0) lines.push(`   … ${extra} more reason(s)`)
      lines.push("")
    }

    if (versions.length > input.limit) {
      lines.push(`… ${versions.length - input.limit} more in the window. Raise \`limit\` (max 100) or narrow the dates.`)
    }
    lines.push("Next: get_law_text(registerId, date) for the text as it then stood; compare_old_new for what changed.")

    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_law_history")
  }
}

interface VersionList {
  "@odata.count"?: number
  value?: unknown[]
}

/**
 * Every version row starting in the window, Register-wide.
 *
 * `$top` is capped at 100 upstream and `@odata.nextLink` drops `$filter`, so
 * one page is fetched and the true total is reported from `@odata.count`
 * rather than being silently implied by the page size.
 */
async function sweepRegister(
  apiClient: AuApiClient,
  from: string,
  to: string,
  limit: number,
): Promise<{ versions: FrlVersion[]; count: number }> {
  const end = nextDay(to)
  const json = (await apiClient.fetchJson("frlApi", "Versions", {
    query: {
      $filter: `start ge ${from}T00:00:00 and start lt ${end}T00:00:00`,
      $orderby: "start desc",
      $count: "true",
      $top: Math.min(Math.max(limit, 1), 100),
    },
  })) as VersionList
  return {
    versions: (json.value ?? []).map(normalizeFrlVersion),
    count: json["@odata.count"] ?? (json.value ?? []).length,
  }
}

function inWindow(start: string | null | undefined, from: string, to: string): boolean {
  const day = isoDay(start)
  return day !== "—" && day >= from && day <= to
}

/** `to` is inclusive, so the upstream `lt` bound is the following day. */
function nextDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text) }] }
}

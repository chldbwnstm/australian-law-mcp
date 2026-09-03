/**
 * `get_schedules` — the schedules of an Act, and the text inside one.
 *
 * Australian drafting puts substantive law in schedules far more often than a
 * reader expects, and the flagship case is the reason this tool is separate
 * from `get_law_text`: the **Australian Consumer Law is schedule 2 of the
 * Competition and Consumer Act 2010**, not an Act of its own. "ACL s 18" is
 * `sch 2 s 18` (misleading or deceptive conduct); CCA `s 18` is meetings of
 * the Commission. Every listing here therefore prints the exact
 * `provision:"sch N s X"` form a follow-up call needs, so the schedule prefix
 * is never dropped on the way.
 *
 * Item counts come from the NCX subtree rather than a field — the Register
 * does not publish "how many provisions are in this schedule".
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import type { NcxEntry, ToolResponse } from "../lib/types.js"
import { titleAnnotations } from "./statute-helpers/format.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"
import {
  cachedToc,
  descendantsOf,
  provisionLeaves,
  renderTree,
  scheduleRoots,
  sliceSubtree,
} from "./statute-helpers/toc.js"

export const GetSchedulesSchema = z.object({
  registerId: z.string().optional().describe("FRL register id from search_law, e.g. C2004A00109."),
  query: z.string().optional().describe("Law name or alias, if you have no registerId (e.g. 'CCA')."),
  schedule: z
    .string()
    .optional()
    .describe("Schedule number to open, e.g. '2' for the Australian Consumer Law. Omit to list all schedules."),
  titleContains: z
    .string()
    .optional()
    .describe("Filter the list to schedules whose heading contains this word, e.g. 'consumer'."),
  date: z.string().optional().describe('Point in time: "YYYY-MM-DD", "latest" (default) or "asmade".'),
  includeText: z
    .boolean()
    .optional()
    .default(false)
    .describe("With `schedule`, return the schedule's full text instead of its outline. Schedules can be very long."),
  maxChars: z.number().int().min(500).max(45000).optional().default(20000).describe("Cap on returned text."),
})

export type GetSchedulesInput = z.infer<typeof GetSchedulesSchema>

export const getSchedulesDescription =
  "List the schedules of a Commonwealth Act, or open one. Schedules carry substantive law in Australia — the " +
  "Australian Consumer Law IS schedule 2 of the Competition and Consumer Act 2010 (registerId C2004A00109), so " +
  "'ACL s 18' must be requested as provision 'sch 2 s 18'. Use this before get_law_text whenever the user names a " +
  "body of law (ACL, a Criminal Code, a model law) rather than an Act.";

export async function getSchedules(apiClient: AuApiClient, input: GetSchedulesInput): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const title = lookup.title
    const date = input.date && input.date !== "latest" ? input.date : undefined
    const entries = await cachedToc(apiClient, title.id, date)
    const schedules = scheduleRoots(entries)

    const header = [`Schedules of ${title.name} [${title.id}]${date ? ` as at ${date}` : ""}`]
    for (const note of lookup.notes) header.push(note)
    for (const note of titleAnnotations(title)) header.push(note)

    if (schedules.length === 0) {
      return ok(
        [
          ...header,
          "",
          "[NOT_FOUND] This compilation's table of contents has no schedule.",
          "",
          "⚠️ That is an observation about this compilation, not a claim that the Act never had one — a schedule may " +
            "have been repealed, or may exist in an earlier version. Try an earlier `date`, or get_law_tree for the " +
            "structure that is present.",
        ].join("\n"),
        input.maxChars,
      )
    }

    if (input.schedule) {
      const body = await openSchedule(apiClient, title.id, date, entries, schedules, input)
      return ok([...header, "", body].join("\n"), input.maxChars)
    }

    const filtered = input.titleContains
      ? schedules.filter((entry) => entry.label.toLowerCase().includes(input.titleContains!.toLowerCase()))
      : schedules
    if (filtered.length === 0) {
      return ok(
        [
          ...header,
          "",
          `[NOT_FOUND] None of the ${schedules.length} schedule headings contains "${input.titleContains}".`,
          "",
          "Headings present:",
          ...schedules.map((entry) => `  • ${entry.label}`),
        ].join("\n"),
        input.maxChars,
      )
    }

    const lines = [...header, "", `${filtered.length} schedule(s)${input.titleContains ? " matching the filter" : ""}:`, ""]
    for (const entry of filtered) {
      const number = scheduleNumber(entry)
      const leaves = provisionLeaves(entries, entry)
      lines.push(entry.label)
      lines.push(
        `   ${descendantsOf(entries, entry).length} table-of-contents entries, ${leaves.length} numbered provisions` +
          (entry.volumeDoc ? ` | ${entry.volumeDoc}` : ""),
      )
      if (number) {
        lines.push(`   text: get_law_text({registerId:"${title.id}", provision:"sch ${number} s <n>"})`)
        lines.push(`   whole schedule: get_schedules({registerId:"${title.id}", schedule:"${number}", includeText:true})`)
      }
      if (title.id === "C2004A00109" && number === "2") {
        lines.push("   ⭐ This is the Australian Consumer Law. ACL s 18 = provision \"sch 2 s 18\", NOT \"s 18\".")
      }
      lines.push("")
    }
    return ok(lines.join("\n"), input.maxChars)
  } catch (error) {
    return formatToolError(error, "get_schedules")
  }
}

/** `Schedule 2—The Australian Consumer Law` → `2`. */
function scheduleNumber(entry: NcxEntry): string | undefined {
  const match = /^schedules?[\s ]+([0-9]+[A-Za-z]*|[IVXLCDM]+)/i.exec(entry.label)
  return match ? match[1] : undefined
}

function openSchedule(
  apiClient: AuApiClient,
  titleId: string,
  date: string | undefined,
  entries: NcxEntry[],
  schedules: NcxEntry[],
  input: GetSchedulesInput,
): Promise<string> {
  const wanted = String(input.schedule).trim().toLowerCase()
  const target = schedules.find((entry) => (scheduleNumber(entry) ?? "").toLowerCase() === wanted)
  if (!target) {
    throw new LawApiError(
      `This compilation has no schedule ${input.schedule}`,
      ErrorCodes.NOT_FOUND,
      [
        `Schedules present: ${schedules.map((entry) => scheduleNumber(entry) ?? entry.label).join(", ")}.`,
        "Call get_schedules without `schedule` for the full list.",
      ],
    )
  }
  return renderSchedule(apiClient, titleId, date, entries, target, input)
}

async function renderSchedule(
  apiClient: AuApiClient,
  titleId: string,
  date: string | undefined,
  entries: NcxEntry[],
  target: NcxEntry,
  input: GetSchedulesInput,
): Promise<string> {
  const number = scheduleNumber(target)
  const leaves = provisionLeaves(entries, target)
  const lines: string[] = []
  lines.push(`${target.label} — ${titleId}${date ? ` as at ${date}` : ""}`)
  lines.push(`${descendantsOf(entries, target).length} entries below it, ${leaves.length} numbered provisions.`)
  if (number) lines.push(`Cite provisions inside it as "sch ${number} s <n>".`)
  lines.push("")

  if (!input.includeText) {
    const rendered = renderTree(entries, target, { maxDepth: 3, limit: 120 })
    lines.push(rendered.text || "(no sub-entries in the table of contents)")
    if (rendered.total > rendered.shown) lines.push(`… ${rendered.total - rendered.shown} more entries not shown.`)
    lines.push("")
    lines.push("Add includeText:true for the schedule's text, or use get_law_text for one provision.")
    return lines.join("\n")
  }

  const volume = /document_(\d+)/.exec(target.volumeDoc)
  if (!volume) {
    throw new LawApiError(
      `Schedule ${number ?? "?"} has no volume document in the table of contents`,
      ErrorCodes.PARSE_ERROR,
      ["Upstream document problem — retry, then report the register id."],
    )
  }
  const html = await apiClient.getVolumeHtml(titleId, Number(volume[1]), date)
  const text = sliceSubtree(html, entries, target)
  if (text === null) {
    throw new LawApiError(
      `The anchor for "${target.label}" (${target.anchor ?? "?"}) is missing from ${target.volumeDoc}`,
      ErrorCodes.PARSE_ERROR,
      ["The table of contents and the volume disagree upstream — retry with includeText:false for the outline."],
    )
  }
  lines.push(text)
  return lines.join("\n")
}

function ok(text: string, maxChars: number): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text, maxChars) }] }
}

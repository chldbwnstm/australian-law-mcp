/**
 * `get_batch_provisions` — many provisions, one call.
 *
 * The cost model is the whole point. Every provision fetch needs the Act's
 * NCX (830 KB for the CCA) and then its volume HTML (up to 4.3 MB); fetching
 * thirty sections one at a time re-downloads the table of contents thirty
 * times. Here the TOC is fetched **once per title** (and cached across calls),
 * and volume HTML is fetched once per volume rather than once per provision.
 *
 * The caps are execution limits, not schema decoration: a valid request with
 * 20 titles × 50 provisions would be a hundred multi-megabyte reads. Missing
 * provisions are reported individually and never silently dropped — a caller
 * comparing "what I asked for" against "what I got" must be able to see the
 * gap.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { htmlToText } from "../lib/provision-slicer.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatRef, parseSectionRef } from "../lib/section-ref.js"
import { getRequestSignal } from "../lib/session-state.js"
import type { NcxEntry, ToolResponse } from "../lib/types.js"
import { cachedToc, locate } from "./statute-helpers/toc.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"

export const MAX_BATCH_LAWS = 20
export const MAX_PROVISIONS_PER_LAW = 50
export const MAX_BATCH_PROVISIONS = 100

const LawEntrySchema = z.object({
  registerId: z.string().optional().describe("FRL register id, e.g. C2004A00109."),
  query: z.string().optional().describe("Law name or alias, if you have no registerId."),
  provisions: z
    .array(z.string())
    .min(1)
    .max(MAX_PROVISIONS_PER_LAW)
    .describe('Provision references, e.g. ["s 45", "sch 2 s 18", "s 46"].'),
  date: z.string().optional().describe('Point in time for this title: "YYYY-MM-DD" | "latest" | "asmade".'),
})

export const GetBatchProvisionsSchema = z
  .object({
    registerId: z.string().optional().describe("Single-title form: the register id."),
    query: z.string().optional().describe("Single-title form: the law name or alias."),
    provisions: z
      .array(z.string())
      .max(MAX_PROVISIONS_PER_LAW)
      .optional()
      .describe('Single-title form: provision references, e.g. ["s 45", "s 46"].'),
    date: z.string().optional().describe('Single-title form: point in time ("YYYY-MM-DD" | "latest" | "asmade").'),
    laws: z
      .array(LawEntrySchema)
      .max(MAX_BATCH_LAWS)
      .optional()
      .describe(
        'Multi-title form, e.g. [{registerId:"C2004A00109", provisions:["s 45"]}, {query:"Privacy Act", provisions:["s 13"]}].',
      ),
    maxCharsPerProvision: z
      .number()
      .int()
      .min(200)
      .max(10000)
      .optional()
      .default(2500)
      .describe("Per-provision text cap (default 2500) so one long section cannot crowd out the rest."),
  })
  .refine((data) => data.laws !== undefined || data.registerId !== undefined || data.query !== undefined, {
    message: "Provide `laws`, or `registerId`/`query` with `provisions`",
  })
  .superRefine((data, ctx) => {
    const total = data.laws
      ? data.laws.reduce((sum, law) => sum + law.provisions.length, 0)
      : data.provisions?.length ?? 0
    if (total > MAX_BATCH_PROVISIONS) {
      ctx.addIssue({
        code: "custom",
        message: `At most ${MAX_BATCH_PROVISIONS} provisions per call (asked for ${total}). Split the request.`,
        path: data.laws ? ["laws"] : ["provisions"],
      })
    }
    if (!data.laws && (data.provisions === undefined || data.provisions.length === 0)) {
      ctx.addIssue({ code: "custom", message: "`provisions` is required in the single-title form", path: ["provisions"] })
    }
  })

export type GetBatchProvisionsInput = z.infer<typeof GetBatchProvisionsSchema>

export const getBatchProvisionsDescription =
  "Fetch many provisions at once, from one Act or several. Far cheaper than repeated get_law_text calls: the table of " +
  "contents and each volume are fetched once per title and reused. " +
  'Single title: {registerId:"C2004A00109", provisions:["s 45","sch 2 s 18"]}. ' +
  'Several: {laws:[{registerId:"...",provisions:[...]},...]}. ' +
  `Limits: ${MAX_BATCH_LAWS} titles, ${MAX_PROVISIONS_PER_LAW} provisions each, ${MAX_BATCH_PROVISIONS} total. ` +
  "Provisions that are not found are listed as misses, never omitted.";

interface Task {
  registerId?: string
  query?: string
  provisions: string[]
  date?: string
}

export async function getBatchProvisions(
  apiClient: AuApiClient,
  input: GetBatchProvisionsInput,
): Promise<ToolResponse> {
  try {
    const tasks: Task[] = input.laws
      ? input.laws.map((law) => ({
          ...(law.registerId ? { registerId: law.registerId } : {}),
          ...(law.query ? { query: law.query } : {}),
          provisions: law.provisions,
          ...(law.date ? { date: law.date } : {}),
        }))
      : [
          {
            ...(input.registerId ? { registerId: input.registerId } : {}),
            ...(input.query ? { query: input.query } : {}),
            provisions: input.provisions ?? [],
            ...(input.date ? { date: input.date } : {}),
          },
        ]

    const sections: string[] = []
    let found = 0
    let missed = 0

    for (const task of tasks) {
      const block = await runTask(apiClient, task, input.maxCharsPerProvision)
      found += block.found
      missed += block.missed
      sections.push(block.text)
    }

    const head =
      `Batch provisions: ${tasks.length} title(s), ${found + missed} requested, ${found} retrieved, ${missed} not found.` +
      (missed > 0 ? "\n⚠️ Some provisions were not retrieved — they are listed below. Do not fill the gaps from memory." : "")

    return { content: [{ type: "text", text: truncateResponse([head, "", ...sections].join("\n")) }] }
  } catch (error) {
    return formatToolError(error, "get_batch_provisions")
  }
}

async function runTask(
  apiClient: AuApiClient,
  task: Task,
  maxChars: number,
): Promise<{ text: string; found: number; missed: number }> {
  const label = task.registerId ?? task.query ?? "(unspecified title)"
  let titleId: string
  let titleName: string
  let entries: NcxEntry[]
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(task.registerId ? { registerId: task.registerId } : {}),
      ...(task.query ? { query: task.query } : {}),
    })
    titleId = lookup.title.id
    titleName = lookup.title.name
    entries = await cachedToc(apiClient, titleId, normDate(task.date))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      text: `▶ ${label}\n[UNRESOLVED] ${message}\n(${task.provisions.length} provision(s) skipped for this title.)`,
      found: 0,
      missed: task.provisions.length,
    }
  }

  const date = normDate(task.date)
  const lines: string[] = [`▶ ${titleName} [${titleId}]${date ? ` as at ${date}` : ""}`]
  const misses: string[] = []
  const volumes = new Map<string, string>()
  /** Volumes whose fetch failed, so thirty sections of one dead volume cost one attempt. */
  const volumeErrors = new Map<string, string>()
  let found = 0

  for (const provision of task.provisions) {
    const ref = parseSectionRef(provision)
    if (!ref) {
      misses.push(`${provision} — not a recognisable provision reference`)
      continue
    }
    const node = locate(ref, entries)
    if (!node) {
      misses.push(`${formatRef(ref)} — not in this compilation's table of contents`)
      continue
    }
    let html = volumes.get(node.volumeDoc)
    if (html === undefined) {
      const alreadyFailed = volumeErrors.get(node.volumeDoc)
      if (alreadyFailed !== undefined) {
        misses.push(`${formatRef(ref)} — ${node.volumeDoc} could not be read: ${alreadyFailed}`)
        continue
      }
      const volume = /document_(\d+)/.exec(node.volumeDoc)
      if (!volume) {
        misses.push(`${formatRef(ref)} — table of contents entry has no volume document`)
        continue
      }
      try {
        html = await apiClient.getVolumeHtml(titleId, Number(volume[1]), date)
      } catch (error) {
        // One volume that would not load is one provision's miss, not the
        // call's. Letting it escape discards every provision already retrieved
        // — and the upstream budget already spent on them — which is the
        // opposite of this tool's "misses are reported individually and never
        // silently dropped". Cancellation is the exception: an aborted request
        // has no consumer, so it is re-thrown rather than answered.
        if (getRequestSignal()?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        volumeErrors.set(node.volumeDoc, message)
        misses.push(`${formatRef(ref)} — ${node.volumeDoc} could not be read: ${message}`)
        continue
      }
      volumes.set(node.volumeDoc, html)
    }
    const text = sliceOne(html, entries, node)
    if (text === null) {
      misses.push(`${formatRef(ref)} — anchor ${node.anchor ?? "?"} missing from ${node.volumeDoc}`)
      continue
    }
    found++
    lines.push("")
    lines.push(`${formatRef(ref)} — ${node.label}`)
    lines.push(text.length > maxChars ? `${text.slice(0, maxChars)}\n… (provision shortened to ${maxChars} characters)` : text)
  }

  if (misses.length > 0) {
    lines.push("")
    lines.push(`Not retrieved (${misses.length}):`)
    for (const miss of misses) lines.push(`  ✗ ${miss}`)
    lines.push("  Try another `date`, or check the reference with get_law_tree / parse_section_ref.")
  }
  lines.push(`(volumes read for this title: ${volumes.size})`)
  return { text: lines.join("\n"), found, missed: misses.length }
}

/** Slice one provision: this anchor to the next anchor of the same volume. */
function sliceOne(html: string, entries: NcxEntry[], entry: NcxEntry): string | null {
  if (!entry.anchor) return htmlToText(html)
  const at = html.indexOf(`id="${entry.anchor}"`)
  if (at === -1) return null
  const start = Math.max(0, backToParagraph(html, at))
  let end = -1
  for (let i = entries.indexOf(entry) + 1; i < entries.length; i++) {
    const next = entries[i]
    if (next.volumeDoc !== entry.volumeDoc || !next.anchor) continue
    const nextAt = html.indexOf(`id="${next.anchor}"`, at + 1)
    if (nextAt !== -1) {
      end = backToParagraph(html, nextAt)
      break
    }
  }
  if (end === -1) {
    const bodyEnd = html.indexOf("</body>", at)
    end = bodyEnd === -1 ? html.length : bodyEnd
  }
  return htmlToText(html.slice(start, end))
}

function backToParagraph(html: string, position: number): number {
  const start = html.lastIndexOf("<p", position)
  return start === -1 ? position : start
}

function normDate(date?: string): string | undefined {
  return date && date !== "latest" ? date : undefined
}

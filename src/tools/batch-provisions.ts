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
 *
 * A provision lost to something the Register would not hand over — the title,
 * its table of contents, the volume text — is counted apart from one that is
 * simply not in the table of contents: the first is an upstream failure, is
 * labelled as one, and when *nothing* survived it makes the whole response an
 * error rather than a tidy list of absences.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { htmlToText } from "../lib/provision-slicer.js"
import { primaryLawMention, provisionParam } from "../lib/query-extract.js"
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
    let upstream = 0

    for (const task of tasks) {
      const block = await runTask(apiClient, task, input.maxCharsPerProvision)
      found += block.found
      missed += block.missed
      upstream += block.upstream
      sections.push(block.text)
    }

    const head =
      `Batch provisions: ${tasks.length} title(s), ${found + missed} requested, ${found} retrieved, ${missed} not found.` +
      (missed > 0 ? "\n⚠️ Some provisions were not retrieved — they are listed below. Do not fill the gaps from memory." : "") +
      // A volume the Register would not hand over is not a provision that does
      // not exist. Without this line the two are one number in the summary.
      (upstream > 0
        ? `\n[${ErrorCodes.UPSTREAM_NO_DATA}] ${upstream} of them failed because the Federal Register did not hand over ` +
          "the title, its table of contents or the volume text — an upstream failure, not evidence the provision is " +
          "absent. Retry before concluding anything."
        : "")

    return {
      content: [{ type: "text", text: truncateResponse([head, "", ...sections].join("\n")) }],
      // Nothing was retrieved and the reason was upstream: this is a failed
      // call, and the flag is what a chain reads (`chains.ts` secOrSkip) to
      // print [NOT RETRIEVED] instead of rendering the block as data. A batch
      // that kept some text stays a normal result — a partial answer is an
      // answer — and carries the label above instead.
      ...(upstream > 0 && found === 0 ? { isError: true } : {}),
    }
  } catch (error) {
    return formatToolError(error, "get_batch_provisions")
  }
}

async function runTask(
  apiClient: AuApiClient,
  task: Task,
  maxChars: number,
): Promise<{ text: string; found: number; missed: number; upstream: number }> {
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
    // A title the Register would not hand over is not a title that does not
    // exist, and the provisions under it are not absences. Hard-coding this
    // count to zero left an outage in the title or table-of-contents lookup
    // looking exactly like a tidy list of things that are not there: no
    // label, and no `isError` for a chain to read.
    const { label: code, upstream } = unresolvedLabel(error)
    const message = error instanceof Error ? error.message : String(error)
    return {
      text: `▶ ${label}\n[${code}] ${message}\n(${task.provisions.length} provision(s) skipped for this title.)`,
      found: 0,
      missed: task.provisions.length,
      upstream: upstream ? task.provisions.length : 0,
    }
  }

  const date = normDate(task.date)
  const lines: string[] = [`▶ ${titleName} [${titleId}]${date ? ` as at ${date}` : ""}`]
  const misses: string[] = []
  const volumes = new Map<string, string>()
  /** Volumes whose fetch failed, so thirty sections of one dead volume cost one attempt. */
  const volumeErrors = new Map<string, string>()
  let found = 0
  /** Provisions lost to a volume the Register would not hand over — not absences. */
  let upstream = 0
  /**
   * The alias may name a *schedule*: "ACL" **is** CCA sch 2, so a bare "s 18"
   * asked of it means sch 2 s 18, never the body's "Meetings of Commission".
   * Same rewrite as the CLI router (`query-extract.provisionParam`), so the
   * two paths cannot drift; an explicit `sch N` keeps its own.
   */
  const mention = task.query ? primaryLawMention(task.query) : undefined
  let aliasScoped = 0

  for (const provision of task.provisions) {
    const asked = parseSectionRef(provision)
    if (!asked) {
      misses.push(`${provision} — not a recognisable provision reference`)
      continue
    }
    const scoped = provisionParam(asked, mention)
    const ref = scoped === formatRef(asked) ? asked : parseSectionRef(scoped) ?? asked
    if (ref !== asked) aliasScoped++
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
        upstream++
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
        //
        // It is still counted apart from a table-of-contents miss: swallowing
        // the throw must not turn an outage into "this provision is not in
        // the Act". The caller reads that distinction off `upstream`.
        if (getRequestSignal()?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        volumeErrors.set(node.volumeDoc, message)
        misses.push(`${formatRef(ref)} — ${node.volumeDoc} could not be read: ${message}`)
        upstream++
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

  if (aliasScoped > 0) {
    // Directly under the title line: the rewrite has to be visible above the
    // text it produced, or the reader cannot tell which s 18 they are holding.
    lines.splice(
      1,
      0,
      `Alias "${task.query}" names sch ${mention?.sch ?? "?"} of this Act — ` +
        `${aliasScoped} bare reference(s) were read inside that schedule.`,
    )
  }
  if (misses.length > 0) {
    lines.push("")
    lines.push(`Not retrieved (${misses.length}):`)
    for (const miss of misses) lines.push(`  ✗ ${miss}`)
    lines.push("  Try another `date`, or check the reference with get_law_tree / parse_section_ref.")
  }
  lines.push(`(volumes read for this title: ${volumes.size})`)
  return { text: lines.join("\n"), found, missed: misses.length, upstream }
}

/**
 * Which of the taxonomy's labels a failed title lookup earns, and whether the
 * provisions under it are counted as upstream losses.
 *
 * Only the Register's own `NOT_FOUND` is authoritative absence: it answered,
 * and its `Titles` collection — which holds every Commonwealth register id —
 * had no such row. A 500, a timeout, a spent budget, a blocked host or an
 * unreadable table of contents is a lookup that never happened, so those
 * provisions are upstream losses and the summary has to say so. An ambiguous
 * or missing parameter is neither: nothing was asked of the Register at all,
 * and telling the caller to retry would be wrong.
 */
function unresolvedLabel(error: unknown): { label: string; upstream: boolean } {
  const code = error instanceof LawApiError ? error.code : undefined
  // The in-body spelling of the absence label is `[NOT_FOUND]` throughout the
  // tools (search_all keys off exactly that), not the `ErrorCodes` value.
  if (code === ErrorCodes.NOT_FOUND) return { label: "NOT_FOUND", upstream: false }
  if (code === ErrorCodes.INVALID_PARAM) return { label: ErrorCodes.INVALID_PARAM, upstream: false }
  return { label: ErrorCodes.UPSTREAM_NO_DATA, upstream: true }
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

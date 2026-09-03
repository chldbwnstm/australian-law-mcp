/**
 * `get_law_text` — the text of a provision, a whole Part, or (never) a whole Act.
 *
 * The Federal Register has no per-section endpoint: text arrives as complete
 * epub volumes, and the CCA's are 2.3 MB and 4.3 MB. So "no provision given"
 * cannot mean "send everything" — it means send the map and say which call
 * fetches which piece. That is a deliberate refusal, and the response says so
 * rather than looking like an empty result.
 *
 * `sch 2 s 18` vs `s 18` is handled by the lib (`findNavPoint`), but the
 * distinction is repeated in the output: ACL s 18 is misleading or deceptive
 * conduct, CCA s 18 is meetings of the Commission, and a reader who cannot see
 * which one they got has no way to catch the error.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatRef } from "../lib/section-ref.js"
import type { NcxEntry, ToolResponse } from "../lib/types.js"
import { frlHumanUrl } from "../lib/external-links-map.js"
import { titleAnnotations } from "./statute-helpers/format.js"
import {
  cachedToc,
  descendantsOf,
  isStructuralKind,
  locate,
  renderTree,
  requireRef,
  sliceSubtree,
  tocSummary,
  volumeRoots,
} from "./statute-helpers/toc.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"

export const GetLawTextSchema = z.object({
  registerId: z.string().optional().describe("FRL register id from search_law, e.g. C2004A00109. Preferred."),
  query: z.string().optional().describe("Law name or alias, if you have no registerId. Resolved the same way as search_law."),
  provision: z
    .string()
    .optional()
    .describe(
      'Provision reference: "s 18", "sch 2 s 18" (the ACL), "pt IVA", "div 2", "reg 2.01". ' +
        "A Part/Division/Chapter/Schedule reference returns that whole subtree. Omit to get the table of contents instead.",
    ),
  date: z
    .string()
    .optional()
    .describe('Point in time: "YYYY-MM-DD", "latest" (default) or "asmade" (the original as-enacted text).'),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(45000)
    .optional()
    .default(20000)
    .describe("Cap on returned text (default 20000). Whole Parts can be very long."),
})

export type GetLawTextInput = z.infer<typeof GetLawTextSchema>

export const getLawTextDescription =
  "Fetch the text of a Commonwealth Act or instrument: one provision, or a whole Part/Division/Schedule. " +
  "Give registerId (from search_law) plus provision, e.g. {registerId:'C2004A00109', provision:'sch 2 s 18'} for " +
  "Australian Consumer Law s 18. WITHOUT a provision this returns the table of contents and guidance, never the full " +
  "text — compiled Acts run to several megabytes. Use `date` for point-in-time text.";

export async function getLawText(apiClient: AuApiClient, input: GetLawTextInput): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const title = lookup.title
    const date = input.date && input.date !== "latest" ? input.date : undefined

    const header: string[] = [
      `${title.name} [${title.id}]${date ? ` — text as at ${date}` : " — latest compilation"}`,
    ]
    for (const note of lookup.notes) header.push(note)
    for (const note of titleAnnotations(title)) header.push(note)

    const entries = await cachedToc(apiClient, title.id, date)

    if (!input.provision) {
      return ok([...header, "", ...overview(entries, title.id, date)].join("\n"), input.maxChars)
    }

    const ref = requireRef(input.provision)
    const node = locate(ref, entries)
    if (!node) {
      throw new LawApiError(
        `${formatRef(ref)} is not in the ${date ?? "latest"} table of contents of ${title.name} [${title.id}]`,
        ErrorCodes.NOT_FOUND,
        [
          "The provision may exist in another compilation — try `date`, or list versions with search_historical_law.",
          ref.schedule
            ? "Schedule provisions only match inside their schedule; check the schedule number with get_schedules."
            : 'If you meant a schedule provision (e.g. the ACL), prefix it: "sch 2 s 18".',
          "Call this tool without `provision` to see the table of contents.",
        ],
      )
    }

    const structural = isStructuralKind(ref.kind) || descendantsOf(entries, node).length > 0
    const body = structural
      ? await subtreeText(apiClient, title.id, date, entries, node)
      : (await apiClient.getProvision(title.id, input.provision, date)).text

    const breadcrumb = ancestorLabels(node)
    const lines = [
      ...header,
      "",
      `Provision: ${formatRef(ref)} — ${node.label}`,
      breadcrumb.length > 0 ? `In: ${breadcrumb.join(" › ")}` : "",
      `Source: ${node.volumeDoc}${node.anchor ? `#${node.anchor}` : ""} | ${frlHumanUrl(title.id, date)}`,
      structural
        ? `(whole ${ref.kind} — ${descendantsOf(entries, node).length} table-of-contents entries below it)`
        : "",
      "",
      body,
    ].filter((line) => line !== "")

    return ok(lines.join("\n"), input.maxChars)
  } catch (error) {
    return formatToolError(error, "get_law_text")
  }
}

/** Fetch the volume once and cut the node's whole subtree out of it. */
async function subtreeText(
  apiClient: AuApiClient,
  titleId: string,
  date: string | undefined,
  entries: NcxEntry[],
  node: NcxEntry,
): Promise<string> {
  const volume = /document_(\d+)/.exec(node.volumeDoc)
  if (!volume) {
    throw new LawApiError(
      `The table of contents entry "${node.label}" has no volume document to read from`,
      ErrorCodes.PARSE_ERROR,
      ["This is an upstream document problem — retry, then report the register id."],
    )
  }
  const html = await apiClient.getVolumeHtml(titleId, Number(volume[1]), date)
  const text = sliceSubtree(html, entries, node)
  if (text === null) {
    throw new LawApiError(
      `The anchor for "${node.label}" (${node.anchor ?? "?"}) is missing from ${node.volumeDoc}`,
      ErrorCodes.PARSE_ERROR,
      ["The table of contents and the volume disagree upstream — retry, and report the register id if it persists."],
    )
  }
  return text
}

function ancestorLabels(node: NcxEntry): string[] {
  const out: string[] = []
  for (let current = node.parent; current; current = current.parent) out.unshift(current.label)
  return out
}

/** The "no provision" answer: a map plus the exact follow-up calls. */
function overview(entries: NcxEntry[], titleId: string, date?: string): string[] {
  const lines: string[] = []
  lines.push(...tocSummary(entries))
  lines.push("")
  lines.push(
    "No `provision` was given, so the text itself is not returned — a compiled Act is several megabytes across " +
      "multiple volumes. Outline of the top levels:",
  )
  lines.push("")
  const volumes = volumeRoots(entries)
  if (volumes.length > 1) {
    for (const volume of volumes) {
      lines.push(volume.label)
      const rendered = renderTree(entries, volume, { maxDepth: 1, limit: 15 })
      if (rendered.text) lines.push(rendered.text.replace(/^/gm, "  "))
      if (rendered.total > rendered.shown) lines.push(`  … ${rendered.total - rendered.shown} more`)
    }
  } else {
    const rendered = renderTree(entries, undefined, { maxDepth: 2, limit: 40 })
    lines.push(rendered.text)
    if (rendered.total > rendered.shown) lines.push(`… ${rendered.total - rendered.shown} more`)
  }
  lines.push("")
  lines.push("Next:")
  lines.push(`  • one provision — get_law_text({registerId:"${titleId}"${date ? `, date:"${date}"` : ""}, provision:"s 18"})`)
  lines.push(`  • whole Part   — get_law_text({registerId:"${titleId}", provision:"pt IV"})`)
  lines.push(`  • full outline — get_law_tree({registerId:"${titleId}"})`)
  lines.push(`  • schedules    — get_schedules({registerId:"${titleId}"})`)
  lines.push(`  • human page   — ${frlHumanUrl(titleId, date)}`)
  return lines
}

function ok(text: string, maxChars: number): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text, maxChars) }] }
}

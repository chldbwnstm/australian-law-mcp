/**
 * `get_law_tree` — the structure of an Act as an indented outline.
 *
 * The map an LLM needs before it asks for text. A compiled Act has thousands
 * of table-of-contents entries (2,603 for the CCA), so the outline is
 * depth-limited by default and every cut is stated: a truncated tree that
 * looks complete is worse than no tree, because the next step is "that Part
 * doesn't exist".
 *
 * `from` re-roots the tree at any node, which is how you go from "the Act has
 * a Schedule 2" to "here is Chapter 3 of the ACL" without downloading text.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatRef } from "../lib/section-ref.js"
import type { ToolResponse } from "../lib/types.js"
import { titleAnnotations } from "./statute-helpers/format.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"
import { cachedToc, descendantsOf, locate, renderTree, requireRef, scheduleRoots, volumeRoots } from "./statute-helpers/toc.js"

export const GetLawTreeSchema = z.object({
  registerId: z.string().optional().describe("Title register id, e.g. C2004A00109 (from search_law)."),
  query: z.string().optional().describe("Law name or alias, if you have no registerId."),
  from: z
    .string()
    .optional()
    .describe('Re-root the outline at a node, e.g. "sch 2" (the ACL), "pt IVA", "ch 3". Omit for the whole Act.'),
  depth: z.number().int().min(1).max(6).optional().default(2).describe("Levels below the root (default 2). 4+ reaches individual sections."),
  limit: z.number().int().min(10).max(500).optional().default(150).describe("Maximum lines (default 150)."),
  date: z.string().optional().describe('Point in time: "YYYY-MM-DD" | "latest" | "asmade".'),
})

export type GetLawTreeInput = z.infer<typeof GetLawTreeSchema>

export const getLawTreeDescription =
  "Show an Act's structure — chapters, parts, divisions, sections — as an indented outline built from the Register's " +
  "table of contents. Use it to find the right provision reference BEFORE fetching text. `from` re-roots the tree " +
  '(e.g. from:"sch 2" for the Australian Consumer Law inside the CCA); raise `depth` to reach section level.';

export async function getLawTree(apiClient: AuApiClient, input: GetLawTreeInput): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const title = lookup.title
    const date = input.date && input.date !== "latest" ? input.date : undefined
    const entries = await cachedToc(apiClient, title.id, date)

    const lines: string[] = [`Structure of ${title.name} [${title.id}]${date ? ` as at ${date}` : ""}`]
    for (const note of lookup.notes) lines.push(note)
    for (const note of titleAnnotations(title)) lines.push(note)

    let root: (typeof entries)[number] | undefined
    if (input.from) {
      const ref = requireRef(input.from)
      root = locate(ref, entries)
      if (!root) {
        throw new LawApiError(
          `${formatRef(ref)} is not in this compilation's table of contents`,
          ErrorCodes.NOT_FOUND,
          [
            `Top-level nodes present: ${volumeRoots(entries).map((entry) => entry.label).join(" | ") || "(none)"}.`,
            `Schedules present: ${scheduleRoots(entries).map((entry) => entry.label).join(" | ") || "(none)"}.`,
            "Call get_law_tree without `from` for the whole outline.",
          ],
        )
      }
      lines.push(`Rooted at: ${root.label}`)
    }

    const rendered = renderTree(entries, root, { maxDepth: input.depth, limit: input.limit })
    lines.push(
      `${entries.length} table-of-contents entries in total; ` +
        `${root ? descendantsOf(entries, root).length : entries.length} in this subtree, ` +
        `${rendered.shown} shown at depth ≤ ${input.depth}.`,
    )
    lines.push("")
    lines.push(rendered.text || "(no entries at this depth)")

    if (rendered.total > rendered.shown) {
      lines.push("")
      lines.push(
        `… ${rendered.total - rendered.shown} more entries at this depth are NOT shown. ` +
          "Raise `limit`, or re-root with `from` to look inside one branch.",
      )
    }
    if (root === undefined && volumeRoots(entries).length > 1) {
      lines.push("")
      lines.push(`This Act is published in ${volumeRoots(entries).length} volumes; the outline spans all of them.`)
    }
    lines.push("")
    lines.push(`Next: get_law_text({registerId:"${title.id}", provision:"<a label from above>"}).`)

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (error) {
    return formatToolError(error, "get_law_tree")
  }
}

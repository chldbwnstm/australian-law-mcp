/**
 * `compare_old_new` — two compilations of the same Act, side by side.
 *
 * The metadata half is the reliable half: `Versions.reasons[]` names the
 * amending Act and the exact items that caused each compilation, and that is
 * an authoritative statement of what changed. The text half is a diff this
 * module computes locally, so it is evidence of a wording change and nothing
 * more — a diff cannot tell you whether a change is substantive, and the
 * output says so instead of implying it.
 *
 * Point-in-time text is addressed by **date**, not by compilation id: the
 * document URL grammar takes `yyyy-mm-dd`, so each version's `start` is used
 * as the address of that compilation's text.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { scopeProvisionsToLaw } from "../lib/query-extract.js"
import { truncateResponse } from "../lib/schemas.js"
import type { FrlVersion, ToolResponse } from "../lib/types.js"
import { diffStats, unifiedDiff } from "./statute-helpers/diff.js"
import { formatVersionLine, isoDay, reasonLine } from "./statute-helpers/format.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"

export const CompareOldNewSchema = z.object({
  registerId: z.string().optional().describe("Title register id, e.g. C2004A00109 (from search_law)."),
  query: z.string().optional().describe("Law name or alias, if you have no registerId."),
  fromDate: z.string().optional().describe("Earlier point in time, YYYY-MM-DD. The compilation in force then is used."),
  toDate: z.string().optional().describe("Later point in time, YYYY-MM-DD. Defaults to the current compilation."),
  fromCompilationId: z.string().optional().describe("Earlier compilation register id, e.g. C2015C00019 (alternative to fromDate)."),
  toCompilationId: z.string().optional().describe("Later compilation register id (alternative to toDate)."),
  provision: z
    .string()
    .optional()
    .describe('Compare the text of one provision as well, e.g. "s 45" or "sch 2 s 18". Omit for a metadata-only comparison.'),
  context: z.number().int().min(0).max(8).optional().default(2).describe("Unchanged lines shown around each change."),
})

export type CompareOldNewInput = z.infer<typeof CompareOldNewSchema>

export const compareOldNewDescription =
  "Compare two compilations of the same Commonwealth Act: what changed between them and why. Returns the amending " +
  "Acts and provisions recorded for each intervening compilation, and — with `provision` — a text diff of that one " +
  'section. Address the two points either by date ({fromDate:"2015-06-30"}) or by compilation id ' +
  "({fromCompilationId:'C2015C00019'}). Defaults to the two most recent compilations.";

export async function compareOldNew(apiClient: AuApiClient, input: CompareOldNewInput): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const title = lookup.title
    const versions = await apiClient.listVersions(title.id, { top: 100 })
    if (versions.length < 2 && !input.fromDate && !input.fromCompilationId) {
      throw new LawApiError(
        `${title.name} [${title.id}] has ${versions.length} registered compilation(s) — there is nothing to compare`,
        ErrorCodes.NOT_FOUND,
        ["An Act amended only once has a single compilation; compare it with the as-made text via get_law_text(date:'asmade')."],
      )
    }

    // The default "new" side is the latest REGISTERED compilation, not
    // `versions[0]`: the newest row is often a future commencement with
    // `registerId: null`, whose text does not exist on the Register yet.
    const defaultLater =
      versions.find((version) => version.isLatest && version.registerId) ??
      versions.find((version) => version.isCurrent) ??
      versions[0]
    const later = await pick(apiClient, title.id, versions, input.toCompilationId, input.toDate, defaultLater)
    const earlier = await pick(
      apiClient,
      title.id,
      versions,
      input.fromCompilationId,
      input.fromDate,
      versions.find((version) => (version.start ?? "") < (later.start ?? "")) ?? versions[1] ?? versions[0],
    )

    if (earlier.start === later.start) {
      throw new LawApiError(
        `Both sides resolve to the same compilation (${isoDay(earlier.start)}, ${earlier.registerId ?? "no register id"})`,
        ErrorCodes.INVALID_PARAM,
        ["Give a `fromDate` inside an earlier version window — search_historical_law lists them."],
      )
    }

    const lines: string[] = []
    lines.push(`Compilation comparison — ${title.name} [${title.id}]`)
    lines.push("")
    lines.push("OLD  " + formatVersionLine(earlier).replace(/^• /, ""))
    lines.push("NEW  " + formatVersionLine(later).replace(/^• /, ""))
    lines.push("")

    const between = versions.filter(
      (version) => (version.start ?? "") > (earlier.start ?? "") && (version.start ?? "") <= (later.start ?? ""),
    )
    lines.push(`Compilations in between (inclusive of the new one): ${between.length}`)
    const reasons = between.flatMap((version) =>
      (version.reasons ?? []).map((reason) => `  ${isoDay(version.start)}  ${reasonLine(reason)}`),
    )
    if (reasons.length === 0) {
      lines.push("  The Register records no amending-act reasons for these compilations.")
      lines.push("  ⚠️ That is a gap in the metadata, not proof the text is identical — check the diff below.")
    } else {
      lines.push(...dedupe(reasons).slice(0, 40))
      if (reasons.length > 40) lines.push(`  … ${reasons.length - 40} more amendment reasons`)
    }

    // The words the caller used to name the law decide which schedule a bare
    // "s 18" belongs to: the ACL **is** sch 2 of the CCA, so a diff of "s 18"
    // asked of the ACL must be a diff of sch 2 s 18 — the Act's own s 18 is
    // "Meetings of Commission", and it has a different amendment history.
    // `chain_amendment_track` hands this tool `query` alongside `registerId`
    // for exactly that, and used to print get_provision_history's sch 2 s 18
    // beside this tool's body s 18 under one ACL heading. One call does the
    // whole rewrite (`query-extract.scopeProvisionsToLaw`), so this tool, the
    // history leg and the CLI router cannot drift apart again.
    const scope = scopeProvisionsToLaw({
      query: input.query,
      provisions: input.provision ? [input.provision] : [],
    })
    const scoped = scope.provisions[0]

    if (input.provision) {
      lines.push("")
      // Never silently: the caller asked about "s 18" and is being shown
      // another number, and the reason has to travel with the diff.
      if (scope.note) lines.push(scope.note)
      lines.push(
        ...(await provisionDiff(
          apiClient,
          title.id,
          scoped?.provision ?? input.provision,
          earlier,
          later,
          input.context,
        )),
      )
    } else {
      lines.push("")
      lines.push(
        `Add \`provision\` (e.g. "${scope.schedule ? `sch ${scope.schedule} s 18` : "s 45"}") to see the text of ` +
          "one section diffed between these compilations." +
          (scope.schedule
            ? ` "${scope.mention?.raw}" is sch ${scope.schedule} of this Act, so write the schedule in: a bare ` +
              "reference names the body of the Act, which is a different provision."
            : ""),
      )
    }

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (error) {
    return formatToolError(error, "compare_old_new")
  }
}

async function pick(
  apiClient: AuApiClient,
  titleId: string,
  versions: FrlVersion[],
  compilationId: string | undefined,
  date: string | undefined,
  fallback: FrlVersion,
): Promise<FrlVersion> {
  if (compilationId) {
    const local = versions.find((version) => version.registerId === compilationId)
    return local ?? (await apiClient.findVersion({ registerId: compilationId }))
  }
  if (date) return apiClient.findVersion({ titleId, asAt: date })
  if (!fallback) {
    throw new LawApiError("Could not choose a compilation to compare", ErrorCodes.NOT_FOUND, [
      "Give `fromDate`/`toDate` explicitly — search_historical_law lists the version windows.",
    ])
  }
  return fallback
}

async function provisionDiff(
  apiClient: AuApiClient,
  titleId: string,
  provision: string,
  earlier: FrlVersion,
  later: FrlVersion,
  context: number,
): Promise<string[]> {
  const oldDate = isoDay(earlier.start)
  const newDate = later.end === null || later.isCurrent ? undefined : isoDay(later.start)
  const lines: string[] = [`Text of ${provision}: ${oldDate} compilation vs ${newDate ?? "latest"}`]

  const [oldText, newText] = await Promise.all([
    safeProvision(apiClient, titleId, provision, oldDate),
    safeProvision(apiClient, titleId, provision, newDate),
  ])

  if (typeof oldText !== "string" || typeof newText !== "string") {
    lines.push("")
    if (typeof oldText !== "string") lines.push(`  OLD: ${oldText.error}`)
    if (typeof newText !== "string") lines.push(`  NEW: ${newText.error}`)
    // Two failures wear the same message otherwise, and they mean opposite
    // things: a missing *document* says nothing about the provision, while a
    // missing *provision* in a present document is itself evidence.
    const documentMissing =
      (typeof oldText !== "string" && isDocumentMissing(oldText.error)) ||
      (typeof newText !== "string" && isDocumentMissing(newText.error))
    lines.push(
      documentMissing
        ? "  ⚠️ The COMPILATION's text is not available in machine-readable form (older compilations are often PDF/Word " +
            "only on the Register). This says nothing about the provision — read the amendment reasons above, or pick a " +
            "later `fromDate` whose epub exists."
        : "  ⚠️ The compilation was readable but the provision was not in it — which usually means it was inserted or " +
            "repealed between these two compilations. Confirm against the amendment reasons above; do not read it as a " +
            "fetch failure.",
    )
    return lines
  }

  try {
    const stats = diffStats(oldText, newText)
    lines.push(`  ${stats.added} line(s) added, ${stats.removed} removed, ${stats.unchanged} unchanged.`)
    lines.push("")
    lines.push(unifiedDiff(oldText, newText, context))
    lines.push("")
    lines.push(
      "⚠️ This diff shows wording changes only. Renumbering and reformatting appear as changes; whether a change is " +
        "substantive is a legal judgement the diff cannot make.",
    )
  } catch (error) {
    lines.push(`  ${error instanceof Error ? error.message : String(error)}`)
  }
  return lines
}

async function safeProvision(
  apiClient: AuApiClient,
  titleId: string,
  provision: string,
  date: string | undefined,
): Promise<string | { error: string }> {
  try {
    const result = await apiClient.getProvision(titleId, provision, date)
    return result.text
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** A 404 on `document.ncx` is the whole compilation missing, not the provision. */
function isDocumentMissing(message: string): boolean {
  return /document\.ncx|table of contents/i.test(message) || /404/.test(message)
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

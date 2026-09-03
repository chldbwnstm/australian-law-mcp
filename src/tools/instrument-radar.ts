/**
 * `instrument_radar` — has the enabling Act moved since this instrument was
 * last compiled?
 *
 * A legislative instrument sits under a power in an Act. When the Act is
 * amended after the instrument's last compilation, the instrument may now
 * refer to a renumbered provision, or sit outside the power altogether. That
 * is a real and common maintenance problem, and nothing on the Register flags
 * it.
 *
 * The framing is deliberately narrow, because the cheap version of this tool
 * is a false-alarm generator. A date comparison can establish exactly one
 * thing: **that the Act changed after the instrument's text was last settled**.
 * It cannot establish that the change touched the enabling provision, and it
 * certainly cannot establish invalidity. So the output is a review prompt with
 * the register ids needed to check, never a finding — and an instrument whose
 * Act has not moved is reported as "no signal", not as "valid".
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import type { FrlTitle, FrlVersion, ToolResponse } from "../lib/types.js"
import { isoDay, reasonLine, titleAnnotations } from "./statute-helpers/format.js"
import { enablingActs, enablingProvisionFor, expandAuthorisedBy } from "./statute-helpers/instruments.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"

export const InstrumentRadarSchema = z.object({
  registerId: z.string().optional().describe("Instrument register id, e.g. F1996B01420."),
  query: z.string().optional().describe("Instrument name, if you have no registerId."),
  showActChanges: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .default(3)
    .describe("How many of the Act's post-instrument compilations to itemise (default 3)."),
})

export type InstrumentRadarInput = z.infer<typeof InstrumentRadarSchema>

export const instrumentRadarDescription =
  "Staleness check for a legislative instrument: compare when it was last compiled against when its enabling Act was " +
  "last amended, and flag instruments whose Act has moved since. Returns the intervening amendments with register " +
  "ids so the enabling provision can be checked. A flag is a prompt to review, NOT a finding that the instrument is " +
  "invalid or out of date.";

export async function instrumentRadar(apiClient: AuApiClient, input: InstrumentRadarInput): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const instrument = lookup.title

    const [instrumentVersions, { acts }, rows] = await Promise.all([
      apiClient.listVersions(instrument.id, { top: 100 }),
      enablingActs(apiClient, instrument.id),
      expandAuthorisedBy(apiClient, instrument.id),
    ])

    const lines: string[] = [`📡 Instrument radar — ${instrument.name} [${instrument.id}]`]
    for (const note of lookup.notes) lines.push(note)
    for (const note of titleAnnotations(instrument)) lines.push(note)

    const latest = newest(instrumentVersions)
    lines.push(
      latest
        ? `Last compiled: ${isoDay(latest.start)}` +
            `${latest.compilationNumber ? ` (compilation ${latest.compilationNumber})` : ""}` +
            `${latest.registerId ? ` — registerId ${latest.registerId}` : ""}`
        : "Last compiled: the Register lists no version rows for this instrument (as-made only).",
    )
    lines.push("")

    if (acts.length === 0) {
      lines.push("[NOT_FOUND] The Register records no enabling Act for this instrument, so there is nothing to compare.")
      lines.push("")
      lines.push(
        "⚠️ No comparison was possible — this says nothing about whether the instrument is current. " +
          "get_enabling_acts will try the instrument's own 'made under' recital as a fallback.",
      )
      return ok(lines.join("\n"))
    }

    const instrumentDate = latest ? isoDay(latest.start) : undefined
    let flagged = 0
    let compared = 0

    for (const act of acts) {
      const provision = enablingProvisionFor(rows, act.id)
      lines.push(`Enabling Act: ${act.name} [${act.id}]${provision ? ` — ${provision}` : ""}`)
      let actVersions: FrlVersion[]
      try {
        actVersions = await apiClient.listVersions(act.id, { top: 100 })
      } catch (error) {
        lines.push(`  ❓ Could not read the Act's compilations (${error instanceof Error ? error.message : String(error)}).`)
        lines.push("     No comparison for this Act — retry rather than treating it as unchanged.")
        lines.push("")
        continue
      }

      const actLatest = newest(actVersions)
      if (!actLatest || !instrumentDate) {
        lines.push("  ❓ One side has no dated compilation, so no comparison is possible.")
        lines.push("")
        continue
      }

      compared++
      const actDate = isoDay(actLatest.start)
      const after = actVersions.filter((version) => isoDay(version.start) > instrumentDate)

      if (after.length === 0) {
        lines.push(`  ✅ No signal — the Act's latest compilation (${actDate}) is not later than the instrument's (${instrumentDate}).`)
        lines.push("     That means only that no amendment postdates the instrument. It is not a validity check.")
      } else {
        flagged++
        lines.push(
          `  ⚠️ REVIEW — the enabling Act was amended ${after.length} time(s) after this instrument was last compiled ` +
            `(Act now at ${actDate}, instrument at ${instrumentDate}).`,
        )
        for (const version of after.slice(0, input.showActChanges)) {
          lines.push(`     ${isoDay(version.start)}${version.registerId ? ` [${version.registerId}]` : ""}`)
          for (const reason of (version.reasons ?? []).slice(0, 2)) lines.push(`        ${reasonLine(reason)}`)
        }
        if (after.length > input.showActChanges) {
          lines.push(`     … ${after.length - input.showActChanges} further compilation(s).`)
        }
        lines.push(
          `     Check whether any of these touched ${provision ? provision : "the enabling provision"}: ` +
            `get_provision_history({registerId:"${act.id}", provision:"${provision ?? "s 1"}"}).`,
        )
      }
      lines.push("")
    }

    lines.push("Summary:")
    if (compared === 0) {
      lines.push("  No date comparison could be made. Nothing here supports a conclusion either way.")
    } else if (flagged === 0) {
      lines.push(`  ${compared} enabling Act(s) checked; none has been amended since this instrument was last compiled.`)
    } else {
      lines.push(`  ${flagged} of ${compared} enabling Act(s) have been amended since this instrument was last compiled.`)
    }
    lines.push("")
    lines.push(
      "⚠️ A date comparison shows only that the Act changed after the instrument's text was settled. It does not show " +
        "that the change touched the enabling power, and it is not a finding that the instrument is invalid, out of " +
        "date, or in need of remaking. Report it as something to check, and check it.",
    )

    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "instrument_radar")
  }
}

/** The version with the greatest `start` — `isLatest` is about registration, not date. */
function newest(versions: readonly FrlVersion[]): FrlVersion | undefined {
  let best: FrlVersion | undefined
  for (const version of versions) {
    if (!version.start) continue
    if (!best || isoDay(version.start) > isoDay(best.start)) best = version
  }
  return best
}

/** Kept for the tests' benefit: the shape the radar reads off a title. */
export type RadarTitle = Pick<FrlTitle, "id" | "name" | "status">

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text) }] }
}

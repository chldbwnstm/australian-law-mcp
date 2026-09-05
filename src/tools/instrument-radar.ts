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
import { formatRef, parseSectionRef, type SectionRef } from "../lib/section-ref.js"
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

// ── the Register's enabling-provision strings are not section references ────

/**
 * What a follow-up call may say about an enabling provision.
 *
 * `authorisedBy.affectingProvisions` is prose the Register keeps for humans —
 * measured against the live API, 8 of the 18 distinct values returned for the
 * CCA, Fair Work Act, Corporations Act and Migration Act are rejected outright
 * by `parseSectionRef`: `s 134(1) of sch 2`, `s 109(1)(b) of sch 2`,
 * `s 95X(1) and (2)`, `sch 2 (s 134(1))`, `s 202(5), 205(3), 737(1),
 * 768BK(1A)`, `s 245J, 245K`, `s 140GBA(4), (5), (6A)`, `s 104(1) of sch 2`.
 * Interpolated straight into `get_provision_history({provision:"…"})` they
 * produce a suggestion that fails the moment the caller runs it, which is
 * worse than no suggestion at all.
 *
 * So the string is normalised into a reference **this project's own parser
 * accepts** — the suggestion is built from `formatRef`, never from the raw
 * value — and when a list has to be narrowed to its first member, or nothing
 * can be normalised, the output says so instead of pretending.
 *
 * "Accepts" means the whole round trip, not the first half of it. Parsing the
 * Register's string proves only that *this module* understood it; the caller
 * runs `requireRef` on the string that gets **printed**, which is `formatRef`'s
 * output, and the two are not the same string. Measured live, the Register's
 * paragraph forms are where they come apart: `para 1020F(1)(c)` parses and
 * formats to `para (1020F)`, which `parseSectionRef` then rejects outright, and
 * `para 184(a)` formats to `para (184)` — a reference that parses and means
 * something else. Both were printed as the canonical form of a power the
 * Register had recorded correctly.
 */
export interface EnablingProvisionCall {
  /**
   * Canonical reference that survives `formatRef` → `parseSectionRef` unchanged;
   * absent when none could be derived. Absent is a real answer — the caller
   * prints why instead of a call that fails or asks about something else.
   */
  provision?: string
  /** The Register's own string, whenever it differs from `provision`. */
  raw?: string
  /** Set when `provision` covers only part of what the Register recorded. */
  narrowed?: boolean
}

/** `s 134(1) of sch 2` — the Register writes the schedule as a trailing phrase. */
const SCHEDULE_TAIL = /\s+of\s+sch(?:edule)?\s+([A-Za-z0-9]+)\s*$/i
/** `sch 2 (s 134(1))` — and sometimes as a prefix with the section in brackets. */
const SCHEDULE_BRACKETED = /^(sch(?:edule)?\s+[A-Za-z0-9]+)\s*\((.+)\)$/i
/** `s 202(5), 205(3), 737(1)` / `s 95X(1) and (2)` — several provisions in one field. */
const LIST_SEPARATOR = /\s*,\s*|\s+and\s+/i

/**
 * Do these two references name the same provision?
 *
 * Everything that carries meaning, and nothing that does not: `raw` is whatever
 * text produced the ref, and `plural` is a property of the writer's spelling
 * that `formatRef` normalises on purpose (`ss 5–6` for a range). Comparing
 * either would reject references that are in fact identical.
 */
function sameProvision(left: SectionRef, right: SectionRef): boolean {
  return (
    left.kind === right.kind &&
    left.number === right.number &&
    (left.letterSuffix ?? "") === (right.letterSuffix ?? "") &&
    (left.schedule ?? "") === (right.schedule ?? "") &&
    (left.item ?? "") === (right.item ?? "") &&
    (left.rangeEnd ?? "") === (right.rangeEnd ?? "") &&
    left.subsections.join("|") === right.subsections.join("|")
  )
}

/**
 * The printable form of a candidate — or nothing, when printing it would change
 * what it says.
 *
 * The check is the **round trip**, because the round trip is what the caller
 * performs: this module parses the Register's string, prints `formatRef`'s
 * output into a `get_provision_history` call, and the caller's `requireRef`
 * parses that output again. A candidate is only usable when the third step
 * yields the second step's input — the same reference, not merely *a* reference.
 *
 * Nothing here knows or asserts what `formatRef` emits for any kind; that
 * grammar belongs to `section-ref.ts`. The day a kind that cannot survive the
 * trip today survives it, this starts suggesting it, with no edit here.
 */
function canonical(value: string): string | undefined {
  const ref = parseSectionRef(value.trim())
  if (!ref) return undefined
  const printed = formatRef(ref)
  const reread = parseSectionRef(printed)
  if (!reread || !sameProvision(ref, reread)) return undefined
  return printed
}

/**
 * Turn the Register's enabling-provision string into something callable.
 *
 * Every candidate is put through `parseSectionRef` → `formatRef` →
 * `parseSectionRef` before it is returned, so a suggestion this builds cannot
 * be rejected by `requireRef` on the other side, and cannot arrive there
 * meaning a different provision from the one the Register recorded.
 */
export function enablingProvisionCall(raw: string | undefined): EnablingProvisionCall {
  if (!raw) return {}
  const text = raw.replace(/\s+/g, " ").trim()
  if (!text) return {}

  const asGiven = canonical(text)
  if (asGiven) return { provision: asGiven, ...(asGiven === text ? {} : { raw: text }) }

  // `sch 2 (s 134(1))` → `sch 2 s 134(1)`
  const bracketed = SCHEDULE_BRACKETED.exec(text)
  if (bracketed) {
    const flattened = canonical(`${bracketed[1]} ${bracketed[2]}`)
    if (flattened) return { provision: flattened, raw: text }
  }

  // `s 134(1) of sch 2` → `sch 2 s 134(1)`
  const tail = SCHEDULE_TAIL.exec(text)
  const body = tail ? text.slice(0, tail.index).trim() : text
  const prefix = tail ? `sch ${tail[1]} ` : ""
  if (tail) {
    const moved = canonical(`${prefix}${body}`)
    if (moved) return { provision: moved, raw: text }
  }

  // A list: the first member is a real reference, and the narrowing is stated.
  const first = body.split(LIST_SEPARATOR)[0]?.trim()
  if (first && first !== body) {
    const narrowed = canonical(`${prefix}${first}`)
    if (narrowed) return { provision: narrowed, raw: text, narrowed: true }
  }

  return { raw: text }
}

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
        const call = enablingProvisionCall(provision)
        if (call.provision) {
          lines.push(
            `     Check whether any of these touched ${provision ?? "the enabling provision"}: ` +
              `get_provision_history({registerId:"${act.id}", provision:"${call.provision}"}).`,
          )
          if (call.raw && call.raw !== call.provision) {
            lines.push(
              `        (the Register records the power as "${call.raw}"; the call above asks for ` +
                `${call.provision}${call.narrowed ? " — the first of the provisions it names, so check the others too" : ""}.)`,
            )
          }
        } else if (provision) {
          // Never hand back a call that this server's own parser would reject.
          lines.push(
            `     The Register records the power as "${provision}", which is not a single provision reference, ` +
              "so no get_provision_history call is suggested for it. Read it as written and check the parts " +
              `individually, or start from get_law_text({registerId:"${act.id}"}).`,
          )
        } else {
          lines.push(
            "     The Register records no enabling provision for this Act, so there is nothing specific to check " +
              `against; get_law_text({registerId:"${act.id}"}) is the whole Act.`,
          )
        }
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

/**
 * `get_law_system_tree` — one Act with everything attached to it.
 *
 * Three relations that are usually asked for one at a time, assembled once:
 * what amended the Act (`affectedby`), what it authorises
 * (`authorises`, see statute-helpers/instruments.ts), and where it sits in its
 * own naming history. All three are the Register's own relations.
 *
 * The direction that does NOT exist is stated rather than faked: the API
 * exposes "what amended X" but not "what does X amend" (reference §6 —
 * `affects("id")` is invalid and the `Affect` set 404s). An amending Act
 * therefore gets an explicit note instead of an empty branch that reads like
 * "this Act amends nothing".
 *
 * Each branch is fetched independently, and a branch that fails is marked as
 * unavailable rather than rendered as empty — an empty tree and a failed fetch
 * mean opposite things.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import type { FrlTitle, ToolResponse } from "../lib/types.js"
import { formerNames, isoDay, repealedBy, titleAnnotations } from "./statute-helpers/format.js"
import { enabledInstruments, enablingProvisionFor, type RelatedTitle } from "./statute-helpers/instruments.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"
import { groupByKind } from "./three-tier.js"

export const GetLawSystemTreeSchema = z.object({
  registerId: z.string().optional().describe("Act register id, e.g. C2004A00109 (from search_law)."),
  query: z.string().optional().describe("Act name or alias, if you have no registerId."),
  instrumentLimit: z.number().int().min(0).max(100).optional().default(15).describe("Instruments to list (0 to skip that branch)."),
  amenderLimit: z.number().int().min(0).max(100).optional().default(15).describe("Amending Acts to list (0 to skip that branch)."),
  includeRepealedInstruments: z.boolean().optional().default(false).describe("Include instruments no longer in force."),
})

export type GetLawSystemTreeInput = z.infer<typeof GetLawSystemTreeSchema>

export const getLawSystemTreeDescription =
  "One view of an Act's whole legislative surroundings: its current status and former names, the Acts that have " +
  "amended it, and the delegated legislation made under it (with enabling provisions). Use as the orientation call " +
  "for an unfamiliar statute, before drilling into text with get_law_text or instruments with get_three_tier.";

export async function getLawSystemTree(
  apiClient: AuApiClient,
  input: GetLawSystemTreeInput,
): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const act = lookup.title

    const [amenders, instruments] = await Promise.all([
      input.amenderLimit > 0 ? attempt(() => apiClient.listAmenders(act.id, ["amending", "repealing"])) : skipped(),
      input.instrumentLimit > 0
        ? attempt(() =>
            enabledInstruments(apiClient, act.id, {
              inForceOnly: !input.includeRepealedInstruments,
              top: input.instrumentLimit,
            }),
          )
        : skipped(),
    ])

    const lines: string[] = []
    lines.push(`${act.name} [${act.id}]`)
    for (const note of lookup.notes) lines.push(note)
    lines.push(
      `├─ ${act.collection ?? "?"}${act.subCollection ? ` (${act.subCollection})` : ""} | ${act.status ?? "?"}` +
        `${act.isPrincipal ? " | principal" : " | amending/other"}` +
        `${act.year ? ` | No ${act.number ?? "?"} of ${act.year}` : ""}`,
    )
    for (const note of titleAnnotations(act)) lines.push(`├─ ${note}`)

    const previous = formerNames(act)
    if (previous.length > 0) {
      lines.push("│")
      lines.push("├─ Name history (renames, NOT repeals — the register id is unchanged):")
      // `nameHistory[].start` is when that NAME began, not when it ended.
      // Rendering it as "until" reverses the timeline, which reads as if the
      // Act lapsed on the date it was actually enacted.
      const seen = new Set<string>()
      for (const entry of act.nameHistory ?? []) {
        const key = `${entry.name}|${entry.start ?? ""}`
        if (seen.has(key)) continue
        seen.add(key)
        const current = entry.name === act.name ? " (current name)" : ""
        lines.push(
          `│    • ${entry.name}${entry.start ? ` from ${isoDay(entry.start)}` : ""}${current}` +
            `${entry.affecterName ? ` — renamed by ${entry.affecterName}${entry.affecterTitleId ? ` [${entry.affecterTitleId}]` : ""}` : ""}`,
        )
      }
    }
    const repeal = repealedBy(act)
    if (repeal) {
      lines.push("│")
      lines.push(`├─ Repealed by: ${repeal.name} [${repeal.titleId}]${repeal.provisions ? ` ${repeal.provisions}` : ""}`)
    }

    lines.push("│")
    lines.push("├─ Amended/repealed by:")
    if (input.amenderLimit === 0) {
      lines.push("│    (skipped — amenderLimit was 0)")
    } else if (!amenders.ok) {
      lines.push(`│    ⚠️ Not retrieved: ${amenders.error}. This is a fetch failure, not an absence of amendments.`)
    } else {
      const list = amenders.value.titles.slice(0, input.amenderLimit)
      if (list.length === 0) {
        lines.push("│    (the Register records none — normal for a recent or never-amended Act)")
      } else {
        for (const title of list) lines.push(`│    • ${title.name} [${title.id}]${title.year ? ` (${title.year})` : ""}`)
        if (amenders.value.count > list.length) {
          lines.push(`│    … ${amenders.value.count - list.length} more of ${amenders.value.count}`)
        }
      }
    }

    lines.push("│")
    lines.push(`└─ Delegated legislation made under it${input.includeRepealedInstruments ? "" : " (in force)"}:`)
    if (input.instrumentLimit === 0) {
      lines.push("     (skipped — instrumentLimit was 0)")
    } else if (!instruments.ok) {
      lines.push(`     ⚠️ Not retrieved: ${instruments.error}. This is a fetch failure, not an absence of instruments.`)
    } else if (instruments.value.count === 0) {
      lines.push("     (the Register records none authorised by this title)")
    } else {
      for (const [group, members] of groupByKind(instruments.value.titles)) {
        lines.push(`     ${group} (${members.length}):`)
        for (const instrument of members) {
          const provision = enablingProvisionFor((instrument as RelatedTitle).authorisedBy ?? [], act.id)
          lines.push(`       • ${instrument.name} [${instrument.id}]${provision ? ` — under ${provision}` : ""}`)
        }
      }
      if (instruments.value.count > instruments.value.titles.length) {
        lines.push(`     … ${instruments.value.count - instruments.value.titles.length} more of ${instruments.value.count} — get_three_tier pages through them.`)
      }
    }

    if (act.isPrincipal === false) {
      lines.push("")
      lines.push(
        "Note: this is an amending/other title, not a principal Act. The Register exposes 'what amended X' but NOT " +
          "'what does X amend' (that direction is confirmed absent), so this tree cannot show which Acts it amends. " +
          "Its own version reasons, via search_historical_law, are the closest available.",
      )
    }

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (error) {
    return formatToolError(error, "get_law_system_tree")
  }
}

type Branch<T> = { ok: true; value: T } | { ok: false; error: string }

async function attempt<T>(work: () => Promise<T>): Promise<Branch<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function skipped(): Promise<Branch<{ count: number; titles: FrlTitle[] }>> {
  return { ok: true, value: { count: 0, titles: [] } }
}

/**
 * `applicable_law` — which law applied on the day it happened?
 *
 * The most frequent practical question in legal work, and the one a language
 * model reliably gets wrong: it answers with the current text. Conduct on
 * 15 December 2010 was governed by the *Trade Practices Act 1974* — s 52, not
 * ACL s 18 — and the Register knows this exactly, because it keeps point-in-time
 * compilations and a name history (docs/research §1.4, §8.2).
 *
 * Four traps are handled explicitly, each because the naive answer is
 * confidently wrong rather than merely thin:
 *
 *  - **A rename is not a repeal.** `Versions/Find(asAt=…)` carries the name in
 *    force then. On that date the law was *called* something else; saying the
 *    Act "did not exist" is the failure this whole server is built against.
 *  - **A date before the first compilation is not a missing Act.** It is the
 *    as-made text, and that is what gets pointed at.
 *  - **Repealed later ≠ repealed then.** An Act repealed in 2020 still governed
 *    conduct in 2015, and the answer says so instead of refusing.
 *  - **`isCurrent` is not `isLatest`.** When commenced amendments are not yet
 *    incorporated, the text the Register serves is already behind the law.
 *
 * The transitional half is deliberately shallow: the amending Acts' own
 * application/saving/transitional headings are surfaced, never interpreted.
 * Whether a transitional provision saves the old law for this fact pattern is a
 * legal judgement, and a tool that made it would be wrong invisibly.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { toIsoDate } from "../lib/au-dates.js"
import { ErrorCodes, LawApiError, formatToolError, notFoundResponse } from "../lib/errors.js"
import { frlHumanUrl } from "../lib/external-links-map.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatRef, parseSectionRef } from "../lib/section-ref.js"
import type { FrlVersion, ToolResponse } from "../lib/types.js"
import {
  amendedAfter,
  distinctActs,
  provisionHistory,
  resolveActByNumber,
  type DatedEffect,
} from "./analysis-helpers/amendment-lookup.js"
import { diffStats, unifiedDiff } from "./statute-helpers/diff.js"
import { formerNames, isoDay, reasonLine, repealedBy } from "./statute-helpers/format.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"
import { cachedToc } from "./statute-helpers/toc.js"

export const ApplicableLawSchema = z.object({
  lawName: z
    .string()
    .min(2)
    .describe("Act name, alias or register id — 'Competition and Consumer Act', 'CCA', 'TPA', 'C2004A00109'."),
  date: z
    .string()
    .min(4)
    .describe(
      "The date the conduct, contract or decision happened. '2010-12-15', '15 December 2010', 'two years ago'.",
    ),
  provision: z
    .string()
    .optional()
    .describe('The provision in issue, e.g. "s 52", "sch 2 s 18". Adds the point-in-time text and a diff against today.'),
})

export type ApplicableLawInput = z.infer<typeof ApplicableLawSchema>

export const applicableLawDescription =
  "Work out which version of a Commonwealth Act applied on a given date, and how it differs from today. Returns the " +
  "compilation in force then (with the name it bore then — conduct in 2010 was under the Trade Practices Act 1974, " +
  "not the CCA), the provision's text as at that date diffed against the current text, every amendment since, and " +
  "the application/saving/transitional headings of the amending Acts. Use this before advising on anything that " +
  "happened in the past; never answer a historical question from the current text.";

/** Amending Acts whose transitional provisions are looked up. Each costs two requests. */
const MAX_TRANSITIONAL_ACTS = 3
const TRANSITIONAL_HEADING = /\b(application|saving|savings|transitional|transitionals?)\b/i

export async function applicableLaw(apiClient: AuApiClient, input: ApplicableLawInput): Promise<ToolResponse> {
  try {
    const date = toIsoDate(input.date)
    if (!date) {
      return notFoundResponse(`"${input.date}" could not be read as a date.`, [
        'Try "2010-12-15", "15 December 2010", "15/12/2010" or "two years ago".',
      ])
    }

    const lookup = await resolveTitle(apiClient, { query: input.lawName })
    const title = lookup.title
    const today = new Date().toISOString().slice(0, 10)

    const { versions, error: versionsError } = await safeVersions(apiClient, title.id)
    const found = await safeFindVersion(apiClient, title.id, date)
    const asAt = found.version

    const lines: string[] = []
    lines.push(`Applicable law — ${title.name} [${title.id}] as at ${date}`)
    for (const note of lookup.notes) lines.push(note)
    lines.push("")

    // ── which compilation, and under what name ───────────────────────────
    lines.push("▶ In force on that date")
    if (found.error) {
      // Not "no compilation covers that date" — the Register never said so.
      // Printing that sentence here, and the as-made pointer under it, hands
      // back the 1974 text as the law of 2015 on the strength of a timeout.
      lines.push(`  [${ErrorCodes.API_ERROR}] The point-in-time lookup for ${date} failed: ${found.error}`)
      lines.push(
        "  ⚠️ This is an upstream failure, NOT a finding that no compilation covers that date. Do NOT fall back to " +
          "the Act as made on the strength of it — for a renamed Act that is decades of the wrong wording. Retry, " +
          "and do not answer from the current text either.",
      )
      lines.push(
        versions.length > 0
          ? `  The version list did load (${versions.length} rows): get_law_history({registerId:"${title.id}"}) shows the ` +
            `compilation windows, and get_law_text({registerId:"${title.id}", date:"${date}"}) fetches the text for that ` +
            "date directly."
          : versionsError
            ? `  The version list could not be read either (${versionsError}), so nothing about this title's compilations was retrieved.`
            : "  The Register's version list came back empty as well, so nothing about this title's compilations was retrieved.",
      )
      lines.push(`  ${frlHumanUrl(title.id, date)}`)
    } else if (!asAt) {
      const earliest = versions.length > 0 ? versions[versions.length - 1] : undefined
      lines.push(
        earliest
          ? `  The Register has no compilation covering ${date}. Its earliest compilation window starts ${isoDay(earliest.start)}.`
          : versionsError
            ? `  The Register returned no compilation for ${date}, and its version list could not be read (${versionsError}).`
            : `  The Register returned no compilation for ${date}, and its version list came back empty.`,
      )
      lines.push(
        "  For a date before the first compilation the operative text is the Act **as made**: " +
          `get_law_text({registerId:"${title.id}", date:"asmade"}). That is a real answer, not a missing one — do not ` +
          "report the Act as non-existent on that date.",
      )
      lines.push(`  ${frlHumanUrl(title.id)}`)
    } else {
      const nameThen = asAt.name ?? title.name
      lines.push(
        `  ${nameThen} — compilation window ${isoDay(asAt.start)} → ${asAt.end ? isoDay(asAt.end) : "current"}` +
          `${asAt.compilationNumber ? `, compilation ${asAt.compilationNumber}` : ""}` +
          `${asAt.registerId ? `, registerId ${asAt.registerId}` : ", registerId none (compilation not registered)"}`,
      )
      if (nameThen !== title.name) {
        lines.push(
          `  ⚠️ On that date this law was titled "${nameThen}". It is now "${title.name}" — the SAME Act, renamed, ` +
            `NOT repealed and replaced. Cite it as "${nameThen}" for conduct on ${date}.`,
        )
      } else if (formerNames(title).length > 0) {
        lines.push(`  (Former names on the Register: ${formerNames(title).join("; ")} — renames, not repeals.)`)
      }
      lines.push(`  Text as at that date: get_law_text({registerId:"${title.id}", date:"${date}"})`)
      lines.push(`  ${frlHumanUrl(title.id, date)}`)
      for (const reason of (asAt.reasons ?? []).slice(0, 5)) lines.push(`  Why this compilation: ${reasonLine(reason)}`)
    }

    // ── repeal, and whether it had happened yet ──────────────────────────
    const repeal = repealedBy(title)
    if (title.status === "Repealed" && repeal) {
      const repealedOn = repeal.start
      if (repealedOn && repealedOn > date) {
        lines.push(
          `  ℹ️ This Act has since been repealed (on ${repealedOn}, by ${repeal.name} [${repeal.titleId}]) — but it was ` +
            `still in force on ${date}, so it is the applicable law for that date.`,
        )
      } else {
        lines.push(
          `  ⚠️ This Act was already repealed on ${date}${repealedOn ? ` (repealed ${repealedOn})` : ""}, by ` +
            `${repeal.name}${repeal.provisions ? ` ${repeal.provisions}` : ""} [${repeal.titleId}]. ` +
            `That title is the successor to look at — but check its transitional provisions, because repealed law often ` +
            "continues to govern events that happened before the repeal.",
        )
      }
    } else if (title.status === "Repealed") {
      lines.push("  ⚠️ The Register marks this title Repealed but names no repealing title on the record — check get_law_history.")
    }

    // ── current vs latest ────────────────────────────────────────────────
    const current = versions.find((version) => version.isCurrent)
    const latest = versions.find((version) => version.isLatest)
    if (current && latest && current.registerId !== latest.registerId) {
      lines.push("")
      lines.push("▶ Today's text")
      lines.push(
        `  ⚠️ The compilation in force now (from ${isoDay(current.start)}) is NOT the latest registered one ` +
          `(${latest.registerId ?? "unregistered"}, from ${isoDay(latest.start)}). Commenced amendments are not yet ` +
          "incorporated, so the current text on the Register is already behind the law in force.",
      )
    }
    if (current?.hasUnincorporatedAmendments || title.hasCommencedUnincorporatedAmendments) {
      lines.push(
        "  ⚠️ hasUnincorporatedAmendments is set: amendments have commenced that the compiled text does not yet show.",
      )
    }
    const between = versions.filter(
      (version) => (version.start ?? "") > (asAt?.start ?? `${date}T00:00:00`) && (version.start ?? "") <= `${today}T23:59:59`,
    )
    if (asAt) {
      lines.push("")
      // "No later compilation" is only sayable when the list was actually read.
      lines.push(
        versionsError
          ? `▶ Since ${date}: the version list could not be read (${versionsError}) — a lookup failure, not a finding ` +
            "that nothing has changed since. Retry, or use get_law_history."
          : between.length === 0
            ? `▶ Since ${date}: no later compilation in the ${versions.length} most recent version rows — the text may be unchanged.`
            : `▶ Since ${date}: ${between.length} later compilation(s) in the ${versions.length} most recent version rows.`,
      )
    }

    // ── the provision ────────────────────────────────────────────────────
    if (input.provision) {
      lines.push("")
      // Only a *confirmed* absence of a covering compilation justifies reading
      // the as-made text; a failed lookup must still ask for the date.
      lines.push(...(await provisionSection(apiClient, title.id, input.provision, date, !asAt && !found.error)))
      lines.push("")
      lines.push(...(await amendmentSection(apiClient, title.id, input.provision, date)))
    } else {
      lines.push("")
      lines.push(
        'Add `provision` (e.g. "s 52") for the text as at that date, a diff against today, and the amendment history of ' +
          "that section alone.",
      )
    }

    lines.push("")
    lines.push(
      "⚖️ This tool identifies the version and shows what changed. Whether the old or the new law governs your facts is " +
        "a legal question the amending Acts' application and transitional provisions decide — the headings are listed " +
        "above where they were found, and they are NOT interpreted here.",
    )

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (error) {
    return formatToolError(error, "applicable_law")
  }
}

/**
 * The version list, and the reason if it did not arrive.
 *
 * The error is carried rather than swallowed because an empty list and a failed
 * list read identically at every call site below, and they mean opposite
 * things: "the Register lists no other compilation" is evidence, "the request
 * failed" is not. Returning a bare `[]` printed "no later compilation in the 0
 * most recent version rows — the text may be unchanged" off a timeout.
 */
async function safeVersions(
  client: AuApiClient,
  titleId: string,
): Promise<{ versions: FrlVersion[]; error?: string }> {
  try {
    return { versions: await client.listVersions(titleId, { top: 100 }) }
  } catch (error) {
    return { versions: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The point-in-time lookup, with a miss and a failure kept apart.
 *
 * `{}` is "the Register answered, and no compilation covers that date" — the
 * date precedes the first compilation, and the as-made text is the real answer.
 * `{ error }` is "the Register did not answer", which proves nothing about any
 * date and must never be rendered as the first case: doing so points the caller
 * at the as-made text, i.e. at 1974 wording for a 2015 question.
 */
async function safeFindVersion(
  client: AuApiClient,
  titleId: string,
  date: string,
): Promise<{ version?: FrlVersion; error?: string }> {
  try {
    const version = await client.findVersion({ titleId, asAt: date })
    // An empty record is the API's own "no version here" shape.
    return version.titleId ? { version } : {}
  } catch (error) {
    // A 404 here is the honest "no compilation covered that date"; anything else
    // is an upstream problem and must not masquerade as one.
    if (error instanceof LawApiError && error.code === ErrorCodes.NOT_FOUND) return {}
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The provision's text then, the text now, and the difference.
 *
 * `asMade` is set only when the Register *confirmed* that no compilation covers
 * the date — the one case where the as-made text is the operative one.
 */
async function provisionSection(
  client: AuApiClient,
  titleId: string,
  provision: string,
  date: string,
  asMade: boolean,
): Promise<string[]> {
  const ref = parseSectionRef(provision)
  if (!ref) {
    return [`▶ Provision: "${provision}" is not a recognisable reference. Use forms like "s 52", "sch 2 s 18", "pt IVA".`]
  }
  const lines: string[] = [`▶ ${formatRef(ref)} as at ${date}`]

  const [then, now] = await Promise.all([
    safeProvision(client, titleId, provision, asMade ? "asmade" : date),
    safeProvision(client, titleId, provision, undefined),
  ])

  if (typeof then !== "string") {
    lines.push(`  [UPSTREAM_NO_DATA] The text as at ${date} could not be read: ${then.error}`)
    lines.push(
      "  ⚠️ That is a lookup failure or a provision that did not exist yet — the two look the same from here. " +
        "Do not guess the wording; check get_provision_history for when it was inserted.",
    )
  } else {
    lines.push(then.length > 2400 ? `${then.slice(0, 2400)}\n  …(truncated)` : then)
  }

  lines.push("")
  if (typeof then !== "string" || typeof now !== "string") {
    lines.push("▶ Compared with today: not possible — one side could not be read.")
    return lines
  }
  if (then.replace(/\s+/g, " ").trim() === now.replace(/\s+/g, " ").trim()) {
    lines.push(`▶ Compared with today: identical wording. The provision has not been re-worded since ${date}.`)
    return lines
  }
  const stats = diffStats(then, now)
  lines.push(`▶ Compared with today: CHANGED — ${stats.added} line(s) added, ${stats.removed} removed.`)
  lines.push(`  Cite the ${date} wording for conduct on that date, not the current text.`)
  lines.push("")
  try {
    lines.push(unifiedDiff(then, now, 2))
  } catch (error) {
    lines.push(`  (diff unavailable: ${error instanceof Error ? error.message : String(error)})`)
  }
  return lines
}

async function safeProvision(
  client: AuApiClient,
  titleId: string,
  provision: string,
  date: string | undefined,
): Promise<string | { error: string }> {
  try {
    return (await client.getProvision(titleId, provision, date)).text
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Amendments to the provision since the date, plus the amending Acts' transitional headings. */
async function amendmentSection(
  client: AuApiClient,
  titleId: string,
  provision: string,
  date: string,
): Promise<string[]> {
  const ref = parseSectionRef(provision)
  if (!ref) return []
  const year = Number(date.slice(0, 4))
  const history = await provisionHistory(client, titleId, ref)

  const lines: string[] = [`▶ Amendments to ${formatRef(ref)} since ${date}`]
  if (!history.available) {
    lines.push(`  [UPSTREAM_NO_DATA] The amendment-history endnote could not be read (${history.note ?? "unknown"}).`)
    lines.push("  ⚠️ Not a finding that the provision was never amended — the diff above is the better evidence.")
    return lines
  }
  if (history.rows.length === 0) {
    lines.push(
      `  The endnote table has no row for ${formatRef(ref)}. The table lists only provisions that changed, so this ` +
        "usually means the provision has never been amended — confirm it exists at all with get_law_text.",
    )
    return lines
  }

  const effects = amendedAfter(history.rows, year)
  if (effects.length === 0) {
    lines.push(`  No amending Act numbered ${year} or later appears against ${formatRef(ref)}.`)
    return lines
  }
  for (const effect of effects.slice(0, 12)) {
    lines.push(`  ${effect.provision}: ${effect.code}${effect.meaning ? ` (${effect.meaning})` : ""} by ${effect.act.raw}`)
  }
  if (effects.length > 12) lines.push(`  … ${effects.length - 12} more`)
  lines.push(
    `  ⚠️ The endnote cites amending Acts by year and number only, never by commencement date. "Since ${date}" here ` +
      `means "numbered ${year} or later"; an Act numbered ${year} may have commenced before your date.`,
  )

  lines.push("")
  lines.push(...(await transitionalSection(client, effects)))
  return lines
}

/**
 * Application, saving and transitional headings in the amending Acts.
 *
 * Read from each amending Act's own table of contents — a heading match, not a
 * reading of the provision. Bounded to the most recent few amenders because
 * each one costs a search and a TOC fetch.
 */
async function transitionalSection(client: AuApiClient, effects: readonly DatedEffect[]): Promise<string[]> {
  const acts = distinctActs(effects).slice(-MAX_TRANSITIONAL_ACTS).reverse()
  const lines: string[] = [
    `▶ Application / saving / transitional provisions in the ${acts.length} most recent amending Act(s)`,
  ]
  if (acts.length === 0) return lines

  for (const act of acts) {
    const title = await resolveActByNumber(client, act)
    if (!title) {
      lines.push(`  ${act.raw}: register id not resolved — look it up with search_law to read its transitional items.`)
      continue
    }
    try {
      const toc = await cachedToc(client, title.id)
      const hits = toc
        .filter((entry) => TRANSITIONAL_HEADING.test(entry.label))
        .slice(0, 6)
        .map((entry) => entry.label.replace(/\s+/g, " ").trim())
      lines.push(`  ${title.name} [${title.id}]`)
      if (hits.length === 0) {
        lines.push("    No heading matching application/saving/transitional in its table of contents.")
      } else {
        for (const hit of hits) lines.push(`    • ${hit}`)
        lines.push(
          `    ↳ Read them: get_law_text({registerId:"${title.id}", provision:"<the item above>"}). ` +
            "A heading match is a pointer, not a finding — these provisions decide which law governs your facts.",
        )
      }
    } catch (error) {
      lines.push(`  ${title.name} [${title.id}]: table of contents unavailable (${error instanceof Error ? error.message : String(error)}).`)
    }
  }
  return lines
}

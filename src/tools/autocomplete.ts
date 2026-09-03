/**
 * `suggest_law_names` — turn a partial name into real, citable titles.
 *
 * Two sources, and both are needed. The Register's `startswith(name,…)` filter
 * gives titles that actually exist; the local alias table gives the forms
 * lawyers type, which the Register has no field for at all — "CCA", "ACL" and
 * "FW Act" match nothing upstream (reference §7). A prefix tool built on only
 * the first would answer "CC" with nothing and invite the caller to invent
 * something.
 *
 * Alias suggestions are labelled as such and carry the official title, so the
 * caller never cites the abbreviation as if it were the name of an Act.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { LAW_ALIAS_ENTRIES, normaliseAliasKey } from "../lib/law-alias.js"
import { truncateResponse } from "../lib/schemas.js"
import type { FrlTitle, ToolResponse } from "../lib/types.js"
import { collectionLabel } from "./statute-helpers/format.js"

export const SuggestLawNamesSchema = z.object({
  partial: z.string().min(2).describe("Start of a law name or an abbreviation, e.g. 'Competition', 'Priv', 'FW'."),
  collection: z
    .enum(["Act", "LegislativeInstrument", "NotifiableInstrument"])
    .optional()
    .describe("Restrict the register results to one collection."),
  inForceOnly: z.boolean().optional().default(true).describe("Hide repealed/ceased titles (default true)."),
  limit: z.number().int().min(1).max(50).optional().default(15).describe("Suggestions to return (default 15)."),
})

export type SuggestLawNamesInput = z.infer<typeof SuggestLawNamesSchema>

export const suggestLawNamesDescription =
  "Autocomplete a Commonwealth law name from a prefix or abbreviation. Returns real titles from the Federal Register " +
  "(prefix match on the official name) PLUS matching entries from this server's abbreviation table — the Register " +
  "has no abbreviation field, so 'CCA' or 'ACL' only resolve through that table. Use when the user's wording is " +
  "partial or informal; use search_law once you have a full name.";

export async function suggestLawNames(apiClient: AuApiClient, input: SuggestLawNamesInput): Promise<ToolResponse> {
  try {
    const partial = input.partial.trim()
    const aliasHits = matchAliases(partial, input.limit)

    let titles: FrlTitle[] = []
    let count = 0
    try {
      const found = await apiClient.searchTitles({
        filter: buildFilter(partial, input.collection),
        select: "id,name,collection,subCollection,status,isPrincipal,year,number",
        top: 100,
      })
      // `status eq …` does not combine with `startswith(name,…)` upstream
      // (a 500, verified 2026-09-04), so in-force filtering happens here.
      titles = input.inForceOnly ? found.titles.filter((title) => title.status === "InForce") : found.titles
      count = input.inForceOnly ? titles.length : found.count
    } catch (error) {
      // A prefix query failing is not evidence about the alias hits, which are
      // local — report the failure and still return what is known.
      const message = error instanceof Error ? error.message : String(error)
      if (aliasHits.length === 0) throw error
      titles = []
      count = 0
      return ok(
        [
          `Name suggestions for "${partial}"`,
          `⚠️ The Federal Register prefix search failed (${message}); only local abbreviation matches are shown.`,
          "",
          ...aliasSection(aliasHits),
        ].join("\n"),
      )
    }

    if (titles.length === 0 && aliasHits.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `[NOT_FOUND] No Commonwealth title starts with "${partial}", and no abbreviation matches it.\n\n` +
              "⚠️ Do not invent a title. Things to try:\n" +
              "  - A shorter prefix (the match is on the START of the official name).\n" +
              "  - search_law with searchText:true, which searches inside the text of legislation.\n" +
              "  - State/territory Acts are not on this register — see get_state_equivalents.",
          },
        ],
        isError: true,
      }
    }

    const ranked = titles
      .slice()
      .sort((a, b) => Number(b.isPrincipal ?? false) - Number(a.isPrincipal ?? false) || a.name.localeCompare(b.name))
      .slice(0, input.limit)

    const lines: string[] = [`Name suggestions for "${partial}"`, ""]
    if (aliasHits.length > 0) lines.push(...aliasSection(aliasHits), "")
    if (ranked.length > 0) {
      lines.push(`Federal Register titles starting with "${partial}" (${count} total, ${ranked.length} shown):`)
      for (const title of ranked) {
        const facts = [collectionLabel(title), title.status ?? "status unknown"]
        if (title.isPrincipal) facts.push("principal")
        lines.push(`  • ${title.name} [${title.id}]`)
        lines.push(`      ${facts.join(" | ")}`)
      }
      if (count > ranked.length) lines.push(`  … ${count - ranked.length} more; raise \`limit\` or lengthen the prefix.`)
    } else {
      lines.push(`No Federal Register title starts with "${partial}" — the matches above are abbreviations only.`)
    }
    lines.push("")
    lines.push("Next: search_law with one of these names, then get_law_text with its registerId.")

    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "suggest_law_names")
  }
}

interface AliasHit {
  alias: string
  official: string
  jurisdiction: string
  titleId?: string
  sch?: string
  notes?: string
}

function matchAliases(partial: string, limit: number): AliasHit[] {
  const key = normaliseAliasKey(partial)
  if (!key) return []
  const out: AliasHit[] = []
  const seen = new Set<string>()
  for (const entry of LAW_ALIAS_ENTRIES) {
    const aliasKey = normaliseAliasKey(entry.alias)
    const officialKey = normaliseAliasKey(entry.official)
    if (!aliasKey.startsWith(key) && !officialKey.startsWith(key)) continue
    const dedupeKey = `${entry.alias}|${entry.official}|${entry.jurisdiction}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({
      alias: entry.alias,
      official: entry.official,
      jurisdiction: entry.jurisdiction,
      ...(entry.titleId ? { titleId: entry.titleId } : {}),
      ...(entry.sch ? { sch: entry.sch } : {}),
      ...(entry.notes ? { notes: entry.notes } : {}),
    })
    if (out.length >= limit) break
  }
  return out
}

function aliasSection(hits: readonly AliasHit[]): string[] {
  const lines = [`Abbreviations / known names (${hits.length}):`]
  for (const hit of hits) {
    lines.push(
      `  • "${hit.alias}" → ${hit.official} (${hit.jurisdiction})` +
        `${hit.sch ? `, sch ${hit.sch}` : ""}${hit.titleId ? ` [${hit.titleId}]` : ""}`,
    )
    if (hit.notes) lines.push(`      ${hit.notes}`)
  }
  return lines
}

/** OData string literals escape `'` by doubling it. */
function odataLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text) }] }
}

function buildFilter(partial: string, collection: string | undefined): string {
  const parts = [`startswith(name,'${odataLiteral(partial)}')`]
  if (collection) parts.push(`collection eq '${collection}'`)
  return parts.join(" and ")
}

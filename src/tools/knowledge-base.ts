/**
 * Knowledge-base tools (7) — the Australian stand-in for the reference
 * server's terminology API cluster.
 *
 * There is no Australian statutory-terminology API (research §7), so these tools read
 * two sources and never pretend to a third: the bundled seed dictionary in
 * `lib/legal-terms-data.ts` and the scraped State Library of NSW plain-language
 * glossary. Every answer names which of the two it came from, and every empty
 * answer says the sources missed rather than that the term does not exist.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { frlHumanUrl } from "../lib/external-links-map.js"
import { GLOSSARY_SOURCE, GLOSSARY_URL, loadGlossary } from "../lib/glossary.js"
import { aliasesFor, resolveLawAlias } from "../lib/law-alias.js"
import { LAW_ALIAS_ENTRIES } from "../lib/law-alias-data.js"
import { LEGAL_TERM_ENTRIES, type LegalTermEntry } from "../lib/legal-terms-data.js"
import { truncateResponse } from "../lib/schemas.js"
import type { LooseToolResponse } from "../lib/types.js"
import {
  findSeedTerm,
  formatGlossaryEntry,
  formatMatchNote,
  formatProvision,
  formatSeedEntry,
  glossaryNote,
  rankGlossary,
  rankPlainTerms,
  rankSeedTerms,
  termNotFound,
} from "./kb-utils.js"

const SEED_SOURCE = `bundled Australian legal-term dictionary (${LEGAL_TERM_ENTRIES.length} entries)`
const limitSchema = z.number().min(1).max(50).default(10).describe("Maximum results (default 10, max 50)")

const ok = (text: string): LooseToolResponse => ({ content: [{ type: "text", text: truncateResponse(text) }] })

/** Deep links for an entry's anchors — FRL human pages, only for verified ids. */
function provisionLinks(entry: LegalTermEntry): string[] {
  const links: string[] = []
  for (const provision of entry.provisions ?? []) {
    if (provision.titleId) links.push(`${provision.title} — ${frlHumanUrl(provision.titleId)}`)
  }
  return links
}

function nearbyTerms(query: string): string[] {
  return rankSeedTerms(query, LEGAL_TERM_ENTRIES, 5).map((hit) => hit.item.term)
}

// ── 1. get_legal_term_kb ──────────────────────────────────────────────────

export const getLegalTermKbSchema = z.object({
  query: z.string().min(1).describe("Legal term or phrase, e.g. 'unconscionable conduct', 'genuine redundancy'"),
  limit: limitSchema,
})
export type GetLegalTermKbInput = z.infer<typeof getLegalTermKbSchema>

export async function getLegalTermKb(
  apiClient: Pick<AuApiClient, "fetchHtml">,
  input: GetLegalTermKbInput,
): Promise<LooseToolResponse> {
  try {
    const seed = rankSeedTerms(input.query, LEGAL_TERM_ENTRIES, input.limit)
    const glossary = await loadGlossary(apiClient)
    const gloss = rankGlossary(input.query, glossary.entries, input.limit)

    if (seed.length === 0 && gloss.length === 0) {
      return termNotFound(input.query, [SEED_SOURCE, glossaryNote(glossary)], nearbyTerms(input.query))
    }

    const lines = [`Legal term knowledge base — '${input.query}'`, ""]
    if (seed.length > 0) {
      lines.push(`Bundled dictionary (${seed.length} of ${LEGAL_TERM_ENTRIES.length} entries matched):`)
      for (const hit of seed) {
        lines.push(`  ${hit.item.term}  [${formatMatchNote(hit.matchedBy)}]`)
        lines.push(`    ${hit.item.plain}`)
        if (hit.item.provisions?.length) {
          lines.push(`    Anchors: ${hit.item.provisions.map(formatProvision).join("; ")}`)
        }
      }
      lines.push("")
    }
    if (gloss.length > 0) {
      lines.push(`${GLOSSARY_SOURCE} (${GLOSSARY_URL}):`)
      for (const hit of gloss) lines.push(`  ${formatGlossaryEntry(hit.item)}`)
      lines.push("")
    }
    lines.push(glossaryNote(glossary))
    lines.push("Descriptions are summaries, not statutory text — fetch the provision itself before relying on wording.")
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_legal_term_kb")
  }
}

// ── 2. get_legal_term_detail ──────────────────────────────────────────────

export const getLegalTermDetailSchema = z.object({
  term: z.string().min(1).describe("One legal term to expand in full, e.g. 'insolvent trading'"),
})
export type GetLegalTermDetailInput = z.infer<typeof getLegalTermDetailSchema>

export async function getLegalTermDetail(
  apiClient: Pick<AuApiClient, "fetchHtml">,
  input: GetLegalTermDetailInput,
): Promise<LooseToolResponse> {
  try {
    const best = rankSeedTerms(input.term, LEGAL_TERM_ENTRIES, 1)[0]
    const glossary = await loadGlossary(apiClient)
    const gloss = rankGlossary(input.term, glossary.entries, 1)[0]

    if (!best && !gloss) {
      return termNotFound(input.term, [SEED_SOURCE, glossaryNote(glossary)], nearbyTerms(input.term))
    }

    const lines: string[] = []
    if (best) {
      lines.push(formatSeedEntry(best.item, provisionLinks(best.item)))
      lines.push("", `Match: ${formatMatchNote(best.matchedBy)} (score ${best.score}).`)
    }
    if (gloss) {
      lines.push("", `${GLOSSARY_SOURCE}:`, formatGlossaryEntry(gloss.item), `Source: ${GLOSSARY_URL}`)
    }
    if (!best) {
      lines.push("", `Not in the ${SEED_SOURCE} — the glossary entry above is a plain-language explanation, not a statutory definition.`)
    }
    lines.push("", glossaryNote(glossary))
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_legal_term_detail")
  }
}

// ── 3. get_plain_term ─────────────────────────────────────────────────────

export const getPlainTermSchema = z.object({
  query: z.string().min(1).describe("Everyday wording, e.g. 'sacked', 'ripped off', 'freeze the title'"),
  limit: limitSchema,
})
export type GetPlainTermInput = z.infer<typeof getPlainTermSchema>

export async function getPlainTerm(
  apiClient: Pick<AuApiClient, "fetchHtml">,
  input: GetPlainTermInput,
): Promise<LooseToolResponse> {
  try {
    const glossary = await loadGlossary(apiClient)
    const gloss = rankGlossary(input.query, glossary.entries, input.limit)
    const seed = rankPlainTerms(input.query, LEGAL_TERM_ENTRIES, input.limit)

    if (gloss.length === 0 && seed.length === 0) {
      return termNotFound(input.query, [glossaryNote(glossary), SEED_SOURCE], nearbyTerms(input.query))
    }

    const lines = [`Plain-language lookup — '${input.query}'`, ""]
    for (const hit of gloss) lines.push(formatGlossaryEntry(hit.item), "")
    if (seed.length > 0) {
      lines.push("Plain-English summaries from the bundled dictionary:")
      for (const hit of seed) lines.push(`  ${hit.item.term}: ${hit.item.plain}`)
      lines.push("")
    }
    lines.push(glossaryNote(glossary))
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_plain_term")
  }
}

// ── 4. get_plain_to_legal ─────────────────────────────────────────────────

export const getPlainToLegalSchema = z.object({
  phrase: z.string().min(1).describe("Everyday phrase to translate, e.g. 'made redundant', 'unfair clause'"),
  limit: limitSchema,
})
export type GetPlainToLegalInput = z.infer<typeof getPlainToLegalSchema>

export async function getPlainToLegal(
  apiClient: Pick<AuApiClient, "fetchHtml">,
  input: GetPlainToLegalInput,
): Promise<LooseToolResponse> {
  try {
    const candidates = rankPlainTerms(input.phrase, LEGAL_TERM_ENTRIES, input.limit)
    const glossary = await loadGlossary(apiClient)
    const gloss = rankGlossary(input.phrase, glossary.entries, 3)

    if (candidates.length === 0 && gloss.length === 0) {
      return termNotFound(input.phrase, [SEED_SOURCE, glossaryNote(glossary)], nearbyTerms(input.phrase))
    }

    const lines = [`Plain phrase → legal term candidates`, `Input: ${input.phrase}`, ""]
    for (const hit of candidates) {
      lines.push(`  ${hit.item.term}  [${formatMatchNote(hit.matchedBy)}]`)
      lines.push(`    ${hit.item.plain}`)
      if (hit.item.provisions?.length) lines.push(`    Anchors: ${hit.item.provisions.map(formatProvision).join("; ")}`)
    }
    if (gloss.length > 0) {
      lines.push("", `Glossary headwords using this wording: ${gloss.map((hit) => hit.item.term).join(", ")}`)
    }
    lines.push(
      "",
      "These are candidates, not equivalences — a plain phrase can map to several distinct causes of action. Confirm the term before building an argument on it.",
    )
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_plain_to_legal")
  }
}

// ── 5. get_legal_to_plain ─────────────────────────────────────────────────

export const getLegalToPlainSchema = z.object({
  term: z.string().min(1).describe("Legal term to render in everyday words, e.g. 'unconscionable conduct'"),
})
export type GetLegalToPlainInput = z.infer<typeof getLegalToPlainSchema>

export async function getLegalToPlain(
  apiClient: Pick<AuApiClient, "fetchHtml">,
  input: GetLegalToPlainInput,
): Promise<LooseToolResponse> {
  try {
    const best = rankSeedTerms(input.term, LEGAL_TERM_ENTRIES, 1)[0]
    const glossary = await loadGlossary(apiClient)
    const gloss = rankGlossary(input.term, glossary.entries, 1)[0]

    if (!best && !gloss) {
      return termNotFound(input.term, [SEED_SOURCE, glossaryNote(glossary)], nearbyTerms(input.term))
    }

    const lines = [`Legal term → plain English`, ""]
    if (best) {
      lines.push(`${best.item.term}`, `  ${best.item.plain}`)
      if (best.item.plainAliases?.length) {
        lines.push(`  Everyday phrasings: ${best.item.plainAliases.join(", ")}`)
      }
      if (best.item.seeAlso?.length) lines.push(`  See also: ${best.item.seeAlso.join(", ")}`)
      lines.push(`  Match: ${formatMatchNote(best.matchedBy)}`)
    }
    if (gloss) lines.push("", `${GLOSSARY_SOURCE}:`, `  ${formatGlossaryEntry(gloss.item)}`)
    lines.push("", glossaryNote(glossary))
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_legal_to_plain")
  }
}

// ── 6. get_term_provisions ────────────────────────────────────────────────

export const getTermProvisionsSchema = z.object({
  term: z.string().min(1).describe("Legal term whose statutory anchors are wanted, e.g. 'genuine redundancy'"),
  includeText: z
    .boolean()
    .default(false)
    .describe("Fetch the actual provision text from the Federal Register for anchors that have a verified title id (slower; one upstream call per anchor)"),
  date: z
    .string()
    .optional()
    .describe("Compilation date for the fetched text: 'YYYY-MM-DD', 'latest' or 'asmade'. Default latest."),
})
export type GetTermProvisionsInput = z.infer<typeof getTermProvisionsSchema>

export async function getTermProvisions(
  apiClient: Pick<AuApiClient, "getProvision">,
  input: GetTermProvisionsInput,
): Promise<LooseToolResponse> {
  try {
    const entry = findSeedTerm(input.term, LEGAL_TERM_ENTRIES)
    if (!entry) return termNotFound(input.term, [SEED_SOURCE], nearbyTerms(input.term))

    const provisions = entry.provisions ?? []
    if (provisions.length === 0) {
      return ok(
        `${entry.term}\n\n${entry.plain}\n\nNo statutory anchor is recorded for this term: it is a general-law or practice concept, or its home provision differs by jurisdiction. That is a statement about this dictionary, not about the law.`,
      )
    }

    const lines = [`Statutory anchors for '${entry.term}'`, ""]
    for (const provision of provisions) {
      lines.push(`  ${formatProvision(provision)}`)
      if (provision.titleId) lines.push(`    ${frlHumanUrl(provision.titleId)}`)
      if (!input.includeText || !provision.titleId) continue
      try {
        const text = await apiClient.getProvision(provision.titleId, provision.ref, input.date)
        lines.push(`    Heading: ${text.heading}`)
        lines.push(text.text.split("\n").map((line) => `    | ${line}`).join("\n"))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        lines.push(`    [text not retrieved] ${reason}`)
        lines.push("    This is a retrieval failure, not proof the provision is absent — open the link above.")
      }
    }
    if (!input.includeText) {
      lines.push("", "Call again with includeText: true to fetch the current text of the Commonwealth anchors.")
    }
    lines.push("", "Anchors move when Acts are amended. Treat the pinpoint as a starting point and read the current compilation.")
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_term_provisions")
  }
}

// ── 7. get_related_laws ───────────────────────────────────────────────────

export const getRelatedLawsSchema = z.object({
  term: z.string().optional().describe("Legal term whose related Acts are wanted, e.g. 'input tax credit'"),
  lawName: z.string().optional().describe("Act name or alias, e.g. 'CCA', 'Fair Work Act' — returns its alias family"),
  limit: limitSchema,
})
export type GetRelatedLawsInput = z.infer<typeof getRelatedLawsSchema>

export async function getRelatedLaws(
  _apiClient: unknown,
  input: GetRelatedLawsInput,
): Promise<LooseToolResponse> {
  try {
    if (!input.term && !input.lawName) {
      return {
        content: [{ type: "text", text: "[INVALID_PARAMETER] get_related_laws needs either `term` or `lawName`." }],
        isError: true,
      }
    }

    const lines: string[] = []
    let found = false

    if (input.term) {
      const entry = findSeedTerm(input.term, LEGAL_TERM_ENTRIES)
      if (entry) {
        found = true
        lines.push(`Acts related to '${entry.term}'`, "")
        const seen = new Set<string>()
        for (const provision of entry.provisions ?? []) {
          if (seen.has(provision.title)) continue
          seen.add(provision.title)
          const aliases = aliasesFor(provision.title.replace(/\s*\(.*$/, "").trim())
          lines.push(`  ${provision.title} — cited here at ${provision.ref}`)
          if (aliases.length > 0) lines.push(`    Also typed as: ${aliases.join(", ")}`)
        }
        if (seen.size === 0) lines.push("  (no statutory anchor recorded for this term)")
        if (entry.seeAlso?.length) lines.push("", `Related terms: ${entry.seeAlso.join(", ")}`)
        lines.push("")
      } else {
        lines.push(`No dictionary entry for '${input.term}' — closest: ${nearbyTerms(input.term).join(", ") || "none"}`, "")
      }
    }

    if (input.lawName) {
      const resolution = resolveLawAlias(input.lawName)
      if (resolution.candidates.length > 0) {
        found = true
        lines.push(`Alias family for '${input.lawName}'`, "")
        for (const candidate of resolution.candidates.slice(0, input.limit)) {
          const id = candidate.titleId ? ` [titleId ${candidate.titleId}]` : ""
          const sch = candidate.sch ? ` (schedule ${candidate.sch})` : ""
          lines.push(`  ${candidate.official} (${candidate.jurisdiction})${sch}${id}`)
          if (candidate.notes) lines.push(`    ${candidate.notes}`)
          if (candidate.titleId) lines.push(`    ${frlHumanUrl(candidate.titleId)}`)
        }
        if (resolution.needsJurisdiction) {
          lines.push("", "⚠️ This alias resolves in several jurisdictions. Ask which one before quoting a section — the numbering differs.")
        }
        const officials = new Set(resolution.candidates.map((c) => c.official))
        const siblings = LAW_ALIAS_ENTRIES.filter(
          (e) => officials.has(e.official) && e.body === true,
        ).map((e) => `${e.alias} (${e.notes ? e.notes.split(".")[0] : "body"})`)
        if (siblings.length > 0) lines.push("", `Bodies administering it: ${[...new Set(siblings)].join("; ")}`)
        lines.push("")
      } else {
        lines.push(`No alias-table entry for '${input.lawName}'. An alias miss is not evidence the Act does not exist — search the register with search_law.`, "")
      }
    }

    if (!found) return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }], isError: true }
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_related_laws")
  }
}

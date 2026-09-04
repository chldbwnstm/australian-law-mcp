/**
 * `search_ai_law` — ask in plain English, get legislation back.
 *
 * The counterpart of the reference server's semantic search, built on what the
 * Federal Register actually offers rather than on an embedding model this
 * server does not have. Three decisions carry it:
 *
 *  1. **`matchType: "all"`, not the DSL default.** `contains` is a *phrase*
 *     match: "unfair contract terms small business" finds nothing, because no
 *     title or body contains that exact string. `all` requires every word
 *     anywhere, which is what a natural-language question means. Measured
 *     2026-09-04 on the notifiable-instrument collection, "CSIRO determination"
 *     gives 0 hits under `contains` and 2 under `all`.
 *  2. **The alias table is consulted first.** "the ACL", "FW Act", "TPA" are
 *     how people actually write, and none of them is a title on the Register.
 *     A resolved alias becomes a *second* search rather than a replacement,
 *     because the question may be about the subject rather than that Act.
 *  3. **Ranking is labelled.** The Register orders by its own relevance and
 *     this tool then re-ranks to favour principal Acts (relevance puts three
 *     repealed price-notification instruments above the CCA). A caller that is
 *     not told which order it is reading cannot judge how much to trust hit #1,
 *     so the ordering is named in the output.
 *
 * What this tool does *not* do is answer the question. It returns titles and
 * the exact follow-up call for each — a pointer, not a conclusion.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { resolveLawAlias } from "../lib/law-alias.js"
import { scopeProvisionsToLaw } from "../lib/query-extract.js"
import { truncateResponse } from "../lib/schemas.js"
import { frlSearchUrl, searchTitlesMatching } from "../lib/sources/frl-search.js"
import type { FrlTitle, ToolResponse } from "../lib/types.js"
import { collectionLabel } from "./statute-helpers/format.js"
import { rankTitles } from "./statute-helpers/title-lookup.js"

/** Same ceiling as the chain queries — an unbounded string reaches the DSL encoder. */
const MAX_AI_QUERY = 2000

export const SearchAiLawSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(MAX_AI_QUERY)
    .describe(
      "A question or topic in plain English, e.g. 'when can an employer stand a worker down', " +
        "'unfair contract terms small business', 'misleading conduct in advertising'. " +
        "You do not need to know the name of the Act.",
    ),
  collection: z
    .enum(["Act", "LegislativeInstrument", "NotifiableInstrument", "Constitution", "Gazette"])
    .optional()
    .describe("Restrict to one collection. 'Act' for statutes only; omit to include instruments."),
  limit: z.number().int().min(1).max(25).optional().default(10).describe("Titles to return (default 10, max 25)."),
  provisionHints: z
    .boolean()
    .optional()
    .default(true)
    .describe("Print the exact get_law_text call for each hit, with a provision when the question named one."),
})

export type SearchAiLawInput = z.infer<typeof SearchAiLawSchema>

export const searchAiLawDescription =
  "Natural-language search over the full text of Commonwealth legislation. Ask a question the way a person would " +
  "('when can an employer stand a worker down') and get back the Acts and instruments whose text matches every " +
  "word, ranked with principal Acts first. Use this when you do NOT know the name of the law; if you do know the " +
  "name, search_law is more precise. Returns registerIds plus the exact get_law_text call for each hit — it points " +
  "at provisions, it does not answer the question.";

/** One title as a chain can consume it, without re-parsing the rendered text. */
export interface AiLawTitleSignal {
  registerId: string
  name: string
  collection?: string
  status?: string
  isPrincipal?: boolean
  /** Which of the two searches produced it — the label the output prints. */
  via: "query" | "alias"
}

export interface AiLawStructuredResult {
  response: ToolResponse
  /** Ranked titles. Chains use these to pick a base law without re-parsing text. */
  titleSignals: AiLawTitleSignal[]
  /** Provision references lifted out of the question itself, e.g. "s 18". */
  provisionRefs: string[]
}

/**
 * The structured form. `searchAiLaw` is the MCP surface; chains take this one
 * so a base-law lookup does not go through "render, then read back".
 */
export async function searchAiLawStructured(
  apiClient: AuApiClient,
  input: SearchAiLawInput,
): Promise<AiLawStructuredResult> {
  const query = input.query.trim()
  const limit = input.limit ?? 10
  const notes: string[] = []

  // Alias expansion. A hit here does not replace the question: "ACL unfair
  // terms" is both an alias and a topic, and searching only the expanded title
  // would drop every instrument that discusses it.
  const alias = resolveLawAlias(query)
  const aliasHit = alias.needsJurisdiction ? undefined : alias.candidates[0]
  if (alias.needsJurisdiction) {
    notes.push(
      `"${query}" contains an abbreviation used in more than one jurisdiction ` +
        `(${alias.candidates.map((candidate) => `${candidate.official} — ${candidate.jurisdiction}`).join("; ")}). ` +
        "Only Commonwealth law is searched here; name the jurisdiction for a state Act.",
    )
  } else if (aliasHit && alias.searchText && alias.searchText !== query) {
    notes.push(
      `Abbreviation recognised: "${query}" → ${aliasHit.official} (${aliasHit.jurisdiction})` +
        `${aliasHit.sch ? `, sch ${aliasHit.sch}` : ""}. Both the original wording and that title were searched.`,
    )
  }

  // What the question already told us: which statute, and which provisions of
  // it. One call, because the two answers have to agree — the schedule the
  // statute-name resolves to is what a bare "s 18" belongs to.
  //
  // The *guarded* extractor sits behind this, not the raw document scanner.
  // `section-ref`'s scanner is case-insensitive, so its roman-numeral branch
  // reads ordinary words as provisions — "small business" → s MA, "sections
  // mix" → ss MIX, "applies" → app LIE. Here that phantom would be printed
  // back as "the provision reference read out of your question" and handed on
  // as the next call. `scopeProvisionsToLaw` masks the statute's own title,
  // drops fragments and un-capitalised roman numbers, and then applies the
  // alias's schedule (`query-extract.ts`) — so this tool's follow-up call, the
  // router's, and `get_law_text`'s own reading cannot disagree.
  //
  // The schedule is the load-bearing half: "ACL s 18 misleading conduct" must
  // print `provision="sch 2 s 18"`, because the CCA's own s 18 is "Meetings of
  // Commission" and the follow-up call is the whole product of this tool.
  // `resolveLawAlias` above sees no alias in that sentence (it matches a whole
  // string), so this is also where the "sch 2" note comes from.
  const scope = scopeProvisionsToLaw({ query })
  const provisionRefs = scope.provisions.map((provision) => provision.provision)
  /** The same references without the alias's schedule — what they mean for any *other* title. */
  const askedRefs = scope.provisions.map((provision) => provision.asked)
  if (scope.note) notes.push(scope.note)

  const searches: Array<{ via: "query" | "alias"; text: string }> = [{ via: "query", text: query }]
  if (aliasHit && alias.searchText && alias.searchText !== query) {
    searches.push({ via: "alias", text: alias.searchText })
  } else if (scope.mention && scope.mention.name !== query && !scope.mention.body && !scope.mention.needsJurisdiction) {
    // `resolveLawAlias` matches a whole string, so it sees no alias in "ACL s 18
    // misleading conduct" — while `scopeProvisionsToLaw` (which reads mentions
    // anywhere in the sentence) resolves it to the CCA and prints
    // `provision="sch 2 s 18"` on every hint. Without this second pass the tool
    // pointed seven unrelated instruments at a schedule 2 they do not have and
    // left out the one Act that does: live 2026-09-05, that query returned the
    // National Environment Protection Measure 1999 first and the CCA not at all.
    searches.push({ via: "alias", text: scope.mention.name })
  }

  const results = await Promise.all(
    searches.map(async (search) => {
      try {
        const found = await searchTitlesMatching(apiClient, {
          query: search.text,
          ...(input.collection ? { collection: input.collection as never } : {}),
          searchType: "nameAndText",
          matchType: "all",
          top: Math.min(limit * 2, 50),
        })
        return { ...search, ...found, failed: false as const }
      } catch (error) {
        notes.push(
          `The "${search.text}" pass did not complete (${error instanceof Error ? error.message : String(error)}) — ` +
            "its results are missing, not empty.",
        )
        return { ...search, count: 0, titles: [] as FrlTitle[], failed: true as const }
      }
    }),
  )

  // De-duplicate across the two passes, keeping the first attribution: a title
  // the question itself named should not be relabelled as an alias hit.
  const via = new Map<string, "query" | "alias">()
  const merged: FrlTitle[] = []
  for (const result of results) {
    for (const title of result.titles) {
      if (via.has(title.id)) continue
      via.set(title.id, result.via)
      merged.push(title)
    }
  }

  const ranked = rankTitles(alias.searchText || query, merged).slice(0, limit)
  const titleSignals: AiLawTitleSignal[] = ranked.map((title) => ({
    registerId: title.id,
    name: title.name,
    ...(title.collection ? { collection: title.collection } : {}),
    ...(title.status ? { status: title.status } : {}),
    ...(title.isPrincipal !== undefined ? { isPrincipal: title.isPrincipal } : {}),
    via: via.get(title.id) ?? "query",
  }))

  // Not a sum. The two passes overlap by construction — the alias pass is the
  // same question asked with the expanded title — and the list above is
  // de-duplicated, so adding the counts reports a corpus no single upstream
  // query returned and contradicts what is shown.
  const passes = results
    .filter((result) => !result.failed)
    .map((result) => ({ text: result.text, count: result.count }))
  const everyPassFailed = results.every((result) => result.failed)

  return {
    response: {
      content: [
        {
          type: "text",
          text: truncateResponse(
            render({
              query,
              ranked,
              titleSignals,
              notes,
              passes,
              provisionRefs,
              askedRefs,
              ...(scope.mention?.titleId ? { scheduleTitleId: scope.mention.titleId } : {}),
              provisionsScoped: scope.rewritten,
              everyPassFailed,
              input,
            }),
          ),
        },
      ],
      // A search that returned nothing is a result; a search where every pass
      // failed is not — the difference is exactly the never-claim-absence rule.
      ...(everyPassFailed ? { isError: true } : {}),
    },
    titleSignals,
    provisionRefs,
  }
}

export async function searchAiLaw(apiClient: AuApiClient, input: SearchAiLawInput): Promise<ToolResponse> {
  try {
    return (await searchAiLawStructured(apiClient, input)).response
  } catch (error) {
    return formatToolError(error, "search_ai_law")
  }
}

interface RenderArgs {
  query: string
  ranked: FrlTitle[]
  titleSignals: AiLawTitleSignal[]
  notes: string[]
  /** One entry per search pass that answered, with the count that pass reported. */
  passes: Array<{ text: string; count: number }>
  provisionRefs: string[]
  /** `provisionRefs` without the alias's schedule — what they mean for any other title. */
  askedRefs: string[]
  /** The one title the alias's schedule is a fact about, when the alias table pinned it. */
  scheduleTitleId?: string
  /** A reference was moved into the schedule the named law *is* (ACL → sch 2). */
  provisionsScoped: boolean
  everyPassFailed: boolean
  input: SearchAiLawInput
}

function render(args: RenderArgs): string {
  const lines: string[] = []
  lines.push(`Natural-language search of Commonwealth legislation — "${args.query}"`)

  if (args.everyPassFailed) {
    lines.push("")
    lines.push(
      "[UPSTREAM_NO_DATA] Every search pass failed upstream. This says nothing about whether such a law exists — " +
        "do not report the topic as unregulated. Retry shortly, or browse the Register directly.",
    )
    for (const note of args.notes) lines.push(`note: ${note}`)
    lines.push(`Register search: ${frlSearchUrl(args.query)}`)
    return lines.join("\n")
  }

  // Naming the ordering is the point: a caller cannot weigh hit #1 without it.
  lines.push(
    "ranking: Federal Register full-text relevance (every word must appear — matchType 'all'), " +
      "then re-ranked locally so principal Acts outrank same-named instruments.",
  )
  lines.push(countLine(args))
  for (const note of args.notes) lines.push(`note: ${note}`)

  if (args.ranked.length === 0) {
    lines.push("")
    lines.push(
      "No Commonwealth title contains all of those words. That is a search result, not a finding that the topic " +
        "is unregulated: the subject may be governed by state law, by a differently worded provision, or by an " +
        "instrument whose text is not indexed.",
    )
    lines.push("")
    lines.push("Try next:")
    lines.push("  - fewer words, or the words a drafter would use ('stand down' rather than 'sent home unpaid');")
    lines.push("  - search_law if you know the name of the Act;")
    lines.push("  - search_state_law / get_state_equivalents — the Federal Register holds Commonwealth law only.")
    lines.push(`Register search: ${frlSearchUrl(args.query)}`)
    return lines.join("\n")
  }

  lines.push("")
  args.ranked.forEach((title, index) => {
    const signal = args.titleSignals[index]
    const facts = [`id: ${title.id}`, collectionLabel(title)]
    if (title.status) facts.push(title.status)
    if (title.isPrincipal) facts.push("principal")
    if (title.year) facts.push(`No ${title.number ?? "?"} of ${title.year}`)
    lines.push(`${index + 1}. ${title.name}`)
    lines.push(`   ${facts.join(" | ")}`)
    if (signal?.via === "alias") lines.push("   matched: via the abbreviation you used, not the words of the question")
    if (args.input.provisionHints !== false) lines.push(`   ${followUp(title.id, refsFor(args, title.id))}`)
    lines.push("")
  })

  if (args.provisionRefs.length > 0) {
    lines.push(
      `Provision reference(s) read out of your question${
        args.provisionsScoped ? ", inside the schedule the law you named is" : ""
      }: ${args.provisionRefs.join(", ")} — the hints above ask for those directly.`,
    )
    // The schedule is a fact about one Act. Printed against every hit it becomes
    // a false pointer — "sch 2 s 18" of an environment protection measure that
    // has no schedule 2 — so the other hits get the plain reference and are told
    // which title the schedule belonged to.
    if (args.provisionsScoped && args.scheduleTitleId && args.ranked.some((t) => t.id !== args.scheduleTitleId)) {
      lines.push(
        `That schedule belongs to ${args.scheduleTitleId} only; every other hit above is asked for ` +
          `${args.askedRefs.join(", ")} instead, because the schedule number is not theirs.`,
      )
    }
  }
  lines.push(
    "These are pointers, not an answer: open the provisions before relying on any of them. " +
      "search_decisions(domain='cases') finds how the courts have read them.",
  )
  lines.push(`Register search: ${frlSearchUrl(args.query)}`)
  return lines.join("\n")
}

/**
 * What the upstream reported, in a form the displayed list can be checked
 * against. Two overlapping passes have no combined total this server can know —
 * the Register never answered that question — so each pass is reported with the
 * words it was asked, and the de-duplicated list size is named separately.
 */
function countLine(args: RenderArgs): string {
  if (args.passes.length <= 1) {
    const count = args.passes[0]?.count ?? 0
    return `${count.toLocaleString()} matching title(s) upstream; showing ${args.ranked.length}.`
  }
  const each = args.passes.map((pass) => `${pass.count.toLocaleString()} for "${pass.text}"`).join(", ")
  return (
    `Matching titles upstream: ${each} — overlapping searches, so those counts do not add up to a ` +
    `corpus size. Showing ${args.ranked.length} after de-duplication.`
  )
}

/**
 * Which reading of the question's provisions this particular hit should be
 * asked for: the schedule-scoped one for the Act whose schedule it is, the
 * plain one for everybody else.
 */
function refsFor(args: RenderArgs, registerId: string): string[] {
  if (!args.provisionsScoped || !args.scheduleTitleId) return args.provisionRefs
  return registerId === args.scheduleTitleId ? args.provisionRefs : args.askedRefs
}

function followUp(registerId: string, provisionRefs: string[]): string {
  if (provisionRefs.length > 0) {
    return `next: get_law_text(registerId="${registerId}", provision="${provisionRefs[0]}")`
  }
  return `next: get_law_text(registerId="${registerId}") for the contents, then provision="s N" for the text`
}

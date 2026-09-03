/**
 * `search_explanatory` / `get_explanatory_text` — the `explanatory` decision
 * domain: explanatory statements for legislative instruments and explanatory
 * memoranda for Acts.
 *
 * The split is the whole story. A **legislative instrument** carries its
 * explanatory statement on the Federal Register as a `type='ES'` document, so
 * that half is a clean two-request fetch. An **Act** carries nothing: its
 * explanatory memorandum belongs to the bill that became it, lives on ParlInfo,
 * and is reached through the Register's `originatingBillUri` → the APH bill
 * page → a uuid-bearing download link that cannot be guessed.
 *
 * So a caller asking "the EM for the Privacy Act" gets a real answer for
 * instruments, and for Acts gets the bill page plus every memorandum link on it
 * — labelled as links, because ParlInfo is not a host this server fetches.
 *
 * Two names exist for this pair: `docs/ARCHITECTURE.md` calls the domain
 * `explanatory`, while `docs/TOOL-MAPPING.md` lists the standalone tools as
 * `search_explanatory_memoranda` / `get_em_text`. Both spellings are exported
 * at the bottom of this file — as aliases, so the registry can adopt either
 * without a second implementation drifting out of sync with this one.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { frlHumanUrl } from "../lib/external-links-map.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { LooseToolResponse } from "../lib/types.js"
import * as aph from "../lib/sources/aph-explanatory.js"
import { frlSearchUrl, searchTitlesMatching } from "../lib/sources/frl-search.js"
import { renderDocument, renderSearch } from "../lib/sources/render.js"
import type { SourceHit } from "../lib/sources/types.js"

/** How many titles get an explanatory-statement probe during a search. */
export const MAX_ES_PROBES = 5

export const SearchExplanatorySchema = z.object({
  query: z.string().min(1).describe(
    "Title words for the Act or instrument whose explanatory material you want, " +
    "e.g. 'Privacy Legislation Amendment Enforcement 2022' or 'airworthiness directive'.",
  ),
  collection: z.enum(["Act", "LegislativeInstrument", "NotifiableInstrument"]).optional().describe(
    "Restrict the register search. Instruments carry an explanatory statement on the Register; " +
    "Acts do not — their memorandum is on ParlInfo, reached through the originating bill.",
  ),
  limit: z.number().min(1).max(50).default(10).optional(),
  verifyEs: z.boolean().optional().describe(
    `true (default) probes the first ${MAX_ES_PROBES} instrument hits for a registered explanatory ` +
    "statement, so the list distinguishes 'has an ES' from 'not checked'.",
  ),
})

export type SearchExplanatoryInput = z.infer<typeof SearchExplanatorySchema>

export async function searchExplanatory(
  client: AuApiClient,
  input: SearchExplanatoryInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `explanatory:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const limit = input.limit ?? 10
    // Title search with `all` word matching: the criteria DSL's default is a
    // phrase match, which returns nothing for an ordinary multi-word query.
    const { count, titles } = await searchTitlesMatching(client, {
      query: input.query,
      searchType: "name",
      ...(input.collection ? { collection: input.collection } : {}),
      top: limit,
    })

    const verify = input.verifyEs ?? true
    const hits: SourceHit[] = []
    let probed = 0
    for (const title of titles) {
      const isInstrument = title.collection !== "Act" && title.collection !== "Constitution"
      const hit: SourceHit = {
        source: "Federal Register of Legislation",
        title: title.name,
        id: title.id,
        url: frlHumanUrl(title.id),
      }
      const extra: Array<[string, string]> = []
      if (title.collection) extra.push(["Collection", title.collection])
      if (title.status) extra.push(["Status", title.status])

      if (verify && isInstrument && probed < MAX_ES_PROBES) {
        probed += 1
        try {
          const documents = await aph.listExplanatoryStatements(client, title.id)
          extra.push([
            "Explanatory statement",
            documents.length > 0
              ? `registered (${documents.map((document) => document.format).join(", ")})`
              : "none registered for this title",
          ])
        } catch (error) {
          extra.push([
            "Explanatory statement",
            `probe failed (${error instanceof Error ? error.message : String(error)}) — not checked, not ruled out`,
          ])
        }
      } else if (!isInstrument) {
        extra.push([
          "Explanatory memorandum",
          "Acts carry none on the Register — get_explanatory_text follows the originating bill to ParlInfo",
        ])
      }
      hit.extra = extra
      hits.push(hit)
    }

    const text = renderSearch(
      { hits, total: count, sourceUrl: frlSearchUrl(input.query) },
      {
        heading: "Explanatory statements and memoranda",
        query: input.query,
        notes: [
          "Explanatory statements accompany legislative and notifiable instruments and are held on " +
          "the Federal Register. Explanatory memoranda accompany bills and are held on ParlInfo.",
          verify
            ? `The first ${MAX_ES_PROBES} instrument hits were probed for a registered statement; the rest were not checked.`
            : "No explanatory-statement probe was run (verifyEs=false).",
        ],
        followUp: 'get_explanatory_text(id="F2011L00287") or get_explanatory_text(id="C2022A00083")',
      },
    )
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_explanatory")
  }
}

export const GetExplanatoryTextSchema = z.object({
  id: z.string().min(1).describe(
    "Federal Register title id. Instruments ('F2011L00287') resolve to a registered explanatory " +
    "statement; Acts ('C2022A00083') resolve to the originating bill's explanatory memoranda.",
  ),
})

export type GetExplanatoryTextInput = z.infer<typeof GetExplanatoryTextSchema>

export async function getExplanatoryText(
  client: AuApiClient,
  input: GetExplanatoryTextInput,
): Promise<LooseToolResponse> {
  try {
    const title = await client.getTitle(input.id)
    const isAct = title.collection === "Act" || title.collection === "Constitution"

    if (!isAct) {
      const documents = await aph.listExplanatoryStatements(client, title.id)
      if (documents.length === 0) {
        throw new LawApiError(
          `The Federal Register lists no type='ES' document for ${title.id} (${title.name}).`,
          ErrorCodes.UPSTREAM_NO_DATA,
          [
            "⚠️ Not every instrument has a registered explanatory statement, and the Register is the " +
            "only place this server looks. This is not proof no explanatory material was ever written.",
            `Check the title's document list in a browser: ${frlHumanUrl(title.id)}`,
          ],
        )
      }
      const madeOn = documents.find((document) => document.start)?.start
      const metadata: Array<[string, string]> = [
        ["Register id", title.id],
        ["Collection", title.collection ?? "instrument"],
        ["Renditions", documents.map((document) => `${document.format}${document.isAuthorised ? " (authorised)" : ""}`).join(", ")],
      ]
      if (madeOn) metadata.push(["As made", madeOn])

      return {
        content: [
          {
            type: "text",
            text: renderDocument(
              {
                title: `Explanatory statement — ${title.name}`,
                url: frlHumanUrl(title.id),
                metadata,
                text: "",
                documents: (["pdf", "word", "epub"] as const)
                  .filter((format) =>
                    documents.some((document) => document.format.toLowerCase().startsWith(format.slice(0, 3))),
                  )
                  .map((format) => ({
                    label: format.toUpperCase(),
                    url: aph.esDownloadUrl(title.id, format, madeOn),
                  })),
                note:
                  "The explanatory statement is published as PDF/Word/EPUB bytes rather than as HTML; " +
                  "the links above are the Register's own authorised renditions.",
              },
              { bodyHeading: "Text" },
            ),
          },
        ],
      }
    }

    // `getTitle`'s $select does not carry originatingBillUri, so ask for it directly.
    const billUri = title.originatingBillUri ?? (await aph.getOriginatingBillUri(client, title.id))
    const billId = aph.billIdFromUri(billUri)
    if (!billId) {
      throw new LawApiError(
        `${title.id} (${title.name}) carries no originatingBillUri on the Register, so its explanatory memorandum cannot be located automatically.`,
        ErrorCodes.UPSTREAM_NO_DATA,
        [
          "⚠️ Older Acts often lack this field. The memorandum may still exist in Hansard or ParlInfo.",
          "Search ParlInfo in a browser: https://parlinfo.aph.gov.au/parlInfo/search/search.w3p",
        ],
      )
    }

    const emLinks = await aph.getBillEmLinks(client, billId)
    const metadata: Array<[string, string]> = [
      ["Register id", title.id],
      ["Originating bill", billId],
      ["Bill page", aph.billPageUrl(billId)],
    ]

    const documents = emLinks.flatMap((link) => [
      { label: `EM ${link.emId} — text (ParlInfo HTML)`, url: link.htmlUrl },
      ...link.downloads.map((download) => ({ label: `EM ${link.emId} — ${download.label}`, url: download.url })),
    ])

    if (documents.length === 0) {
      throw new LawApiError(
        `The APH bill page for ${billId} listed no explanatory-memorandum links.`,
        ErrorCodes.UPSTREAM_NO_DATA,
        [
          "⚠️ The page was reached but carried no `legislation/ems/…` hrefs — a page-layout change and a " +
          "bill without a memorandum look identical from here.",
          `Open the bill page: ${aph.billPageUrl(billId)}`,
        ],
      )
    }

    return {
      content: [
        {
          type: "text",
          text: renderDocument(
            {
              title: `Explanatory memorandum — ${title.name}`,
              url: aph.billPageUrl(billId),
              metadata,
              text: "",
              documents,
              note:
                "Acts have no explanatory statement on the Federal Register; the memorandum belongs to " +
                "the originating bill and lives on ParlInfo. The ParlInfo HTML link above carries the " +
                "memorandum's full text and opens in a browser — this server does not fetch that host, " +
                "so the text was not retrieved here. ParlInfo PDF downloads require an APH referer.",
            },
            { bodyHeading: "Text" },
          ),
        },
      ],
    }
  } catch (error) {
    return formatToolError(error, "get_explanatory_text")
  }
}

// ── TOOL-MAPPING.md aliases ───────────────────────────────────────────────
// Same functions, the other documented names. Aliases rather than wrappers:
// a wrapper would be a second place for the behaviour to change.

export const searchExplanatoryMemoranda = searchExplanatory
export const getEmText = getExplanatoryText
export const SearchExplanatoryMemorandaSchema = SearchExplanatorySchema
export const GetEmTextSchema = GetExplanatoryTextSchema

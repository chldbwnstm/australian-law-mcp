/**
 * search → detail auto-chain configuration.
 *
 * After a `search_*` tool runs, the caller almost always wants the first hit's
 * text. This table is what lets a chain (or the natural-language CLI) do that
 * without re-deriving, per tool, which detail tool takes which parameter and
 * where the identifier is printed.
 *
 * Two Australian facts shape the table:
 *
 *  - **The identifier is always on the `id:` line.** Every decision domain
 *    renders through `lib/sources/render.ts`, and the statute tools through
 *    `statute-helpers/format.ts`; both label the identifier `id:` and nothing
 *    else in a hit block. So one regex serves nearly every row, and the
 *    exceptions are exceptions for a stated reason.
 *  - **A detail tool that needs more than an id cannot be listed here.**
 *    `get_decision_text` needs `domain`, `get_state_law_text` needs
 *    `jurisdiction`, `get_treaty_text` wants the keyword that produced the id.
 *    A single `detailParam` cannot carry those, and guessing one would make the
 *    chain call the wrong record rather than skip a step. They are named in the
 *    comments below so the omission reads as a decision, not an oversight.
 */

import { ID_LINE, REGISTER_ID_LINE } from "../tools/search-hits.js"

export interface SearchDetailChain {
  /** Name of the detail tool */
  detailTool: string
  /** Name of the ID parameter on the detail tool */
  detailParam: string
  /** Regex that extracts the first ID from the search result text (group 1) */
  idRegex: RegExp
  /**
   * Does the detail tool accept `full` (unabridged output)?
   * Only some detail tools do — passing it to the others has Zod drop it
   * silently, so a "show me the full text" intent disappears without a trace.
   * Turn this on in the same change that adds `full` to the tool's schema.
   */
  supportsFull?: boolean
}

/** Most search tools render results as "   id: <identifier>". */
export const BRACKET_ID = ID_LINE

export const SEARCH_DETAIL_CHAINS: Record<string, SearchDetailChain> = {
  // ── Legislation ─────────────────────────────────────────────────────────
  search_law: {
    detailTool: "get_law_text",
    detailParam: "registerId",
    idRegex: ID_LINE,
  },
  search_historical_law: {
    detailTool: "get_historical_law",
    detailParam: "compilationId",
    // Compilations are listed by `formatVersionLine`, which labels the id
    // `registerId:` — a compilation id, not the title id on the `id:` line.
    idRegex: REGISTER_ID_LINE,
  },
  search_agency_rules: {
    detailTool: "get_registered_instrument_text",
    detailParam: "id",
    idRegex: ID_LINE,
  },
  search_gazettes: {
    detailTool: "get_registered_instrument_text",
    detailParam: "id",
    idRegex: ID_LINE,
  },
  search_explanatory: {
    detailTool: "get_explanatory_text",
    detailParam: "id",
    idRegex: ID_LINE,
  },

  // ── Case law and tribunals ──────────────────────────────────────────────
  search_cases: {
    detailTool: "get_case_text",
    detailParam: "id",
    idRegex: ID_LINE,
    supportsFull: true,
  },
  search_constitutional_decisions: {
    detailTool: "get_constitutional_decision_text",
    detailParam: "id",
    idRegex: ID_LINE,
  },
  search_admin_appeals: {
    detailTool: "get_admin_appeal_text",
    detailParam: "id",
    idRegex: ID_LINE,
    supportsFull: true,
  },
  search_tax_tribunal_decisions: {
    detailTool: "get_tax_tribunal_decision_text",
    detailParam: "id",
    idRegex: ID_LINE,
    supportsFull: true,
  },
  search_rulings: {
    detailTool: "get_ruling_text",
    detailParam: "id",
    idRegex: ID_LINE,
    supportsFull: true,
  },
  search_workplace_decisions: {
    detailTool: "get_workplace_decision_text",
    detailParam: "id",
    idRegex: ID_LINE,
    supportsFull: true,
  },
  search_privacy_decisions: {
    detailTool: "get_privacy_decision_text",
    detailParam: "id",
    idRegex: ID_LINE,
    supportsFull: true,
  },
  search_integrity_decisions: {
    detailTool: "get_integrity_decision_text",
    detailParam: "id",
    idRegex: ID_LINE,
    supportsFull: true,
  },
  search_public_service_decisions: {
    detailTool: "get_public_service_decision_text",
    detailParam: "id",
    idRegex: ID_LINE,
    supportsFull: true,
  },

  // ── Deliberately absent ─────────────────────────────────────────────────
  // search_decisions      → get_decision_text needs `domain` as well as `id`.
  // search_state_law      → get_state_law_text needs `jurisdiction`.
  // search_university_rules → same, it returns state-register ids.
  // search_treaties       → get_treaty_text wants the originating keyword, or
  //                         it has to scan page 1 of a fresh search.
  // search_competition_decisions → its ids are case ids from the fan-out, and
  //                         the domain is degraded to links; auto-fetching one
  //                         would present a link set as retrieved reasons.
}

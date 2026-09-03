/**
 * search → detail auto-chain configuration.
 *
 * Mapping table used by the natural-language CLI: after a `search_*` tool runs,
 * the first result's detail record is fetched automatically.
 */

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

/** Most search tools render results as "[ID] title" */
export const BRACKET_ID = /\[([^\]]+)\]/

/**
 * Registered search → detail pairs.
 *
 * Deliberately empty in the core library: the pairs name concrete tools, and
 * the tool layer that owns those names has not been built yet. Register entries
 * here as the Australian search/detail tools land, e.g.
 *
 * ```ts
 * search_legislation: {
 *   detailTool: "get_legislation_text",
 *   detailParam: "id",
 *   idRegex: BRACKET_ID,
 *   supportsFull: true,
 * }
 * ```
 */
export const SEARCH_DETAIL_CHAINS: Record<string, SearchDetailChain> = {}

/**
 * The MCP tool registry — every tool this server can run, and the ten it
 * advertises.
 *
 * Two lists, one file, on purpose:
 *
 *  - `allTools` is the complete set. `CallTool` dispatches any name in it, so
 *    a client that learned a tool name from `discover_tools` — or from an
 *    earlier version of this server — keeps working. Nothing is ever removed
 *    from here to reduce the advertised surface.
 *  - `exposedTools` is `allTools` filtered by `V3_EXPOSED`. Only these reach
 *    `ListTools`, because every advertised entry is context every client pays
 *    for on every request, and a model choosing between eighty near-synonymous
 *    names chooses badly.
 *
 * Everything else here is the request boundary, and each piece of it exists
 * because of a specific way an MCP server misbehaves without it:
 *
 *  - **One budget per request.** A JSON-RPC envelope can carry a batch, and a
 *    single chain fans out into a dozen upstream calls. The budget lives in
 *    AsyncLocalStorage so those inner calls share one allowance instead of
 *    each being granted a fresh one.
 *  - **`truncateResponse` on every result**, including error results. A tool
 *    that returns 400 KB of judgment does not get to blow the client's context
 *    just because it succeeded.
 *  - **`formatToolError` as the catch-all.** An exception that escapes to the
 *    transport is an opaque failure; formatted, it carries a bracket label the
 *    caller can act on.
 *  - **Cancellation is re-thrown, never formatted.** A cancelled item has no
 *    consumer, and turning its abort into a normal tool result makes the SDK
 *    answer a request that was withdrawn.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { AuApiClient } from "./lib/api-client.js"
import { formatToolError } from "./lib/errors.js"
import { RequestExecutionBudget, readExecutionLimits, type ExecutionLimits } from "./lib/execution-limits.js"
import { truncateResponse } from "./lib/schemas.js"
import {
  getRequestSignal,
  requestContext,
  runWithRequestContext,
  throwIfRequestCancelled,
} from "./lib/session-state.js"
import { V3_EXPOSED } from "./lib/tool-profiles.js"
import type { McpTool } from "./lib/types.js"

// ── Legislation (Federal Register) ────────────────────────────────────────
import { AdvancedSearchSchema, advancedSearch, advancedSearchDescription } from "./tools/advanced-search.js"
import { SuggestLawNamesSchema, suggestLawNames, suggestLawNamesDescription } from "./tools/autocomplete.js"
import { GetBatchProvisionsSchema, getBatchProvisions, getBatchProvisionsDescription } from "./tools/batch-provisions.js"
import { CompareOldNewSchema, compareOldNew, compareOldNewDescription } from "./tools/comparison.js"
import {
  GetHistoricalLawSchema,
  SearchHistoricalLawSchema,
  getHistoricalLaw,
  getHistoricalLawDescription,
  searchHistoricalLaw,
  searchHistoricalLawDescription,
} from "./tools/historical-law.js"
import { InstrumentRadarSchema, instrumentRadar, instrumentRadarDescription } from "./tools/instrument-radar.js"
import { GetLawHistorySchema, getLawHistory, getLawHistoryDescription } from "./tools/law-history.js"
import {
  GetEnabledInstrumentsSchema,
  GetEnablingActsSchema,
  GetInstrumentProvisionsSchema,
  GetStateEquivalentsSchema,
  getEnabledInstruments,
  getEnabledInstrumentsDescription,
  getEnablingActs,
  getEnablingActsDescription,
  getInstrumentProvisions,
  getInstrumentProvisionsDescription,
  getStateEquivalents,
  getStateEquivalentsDescription,
} from "./tools/law-linkage.js"
import { GetLawStatisticsSchema, getLawStatistics, getLawStatisticsDescription } from "./tools/law-statistics.js"
import { GetLawSystemTreeSchema, getLawSystemTree, getLawSystemTreeDescription } from "./tools/law-system-tree.js"
import { GetLawTextSchema, getLawText, getLawTextDescription } from "./tools/law-text.js"
import { GetLawTreeSchema, getLawTree, getLawTreeDescription } from "./tools/law-tree.js"
import { GetProvisionHistorySchema, getProvisionHistory, getProvisionHistoryDescription } from "./tools/provision-history.js"
import { GetSchedulesSchema, getSchedules, getSchedulesDescription } from "./tools/schedules.js"
import { SearchLawSchema, searchLaw, searchLawDescription } from "./tools/search.js"
import { GetThreeTierSchema, getThreeTier, getThreeTierDescription } from "./tools/three-tier.js"
import {
  GetLawAbbreviationsSchema,
  ParseSectionRefSchema,
  getLawAbbreviations,
  getLawAbbreviationsDescription,
  parseSectionRefDescription,
  parseSectionRefTool,
} from "./tools/utils.js"

// ── Decisions ─────────────────────────────────────────────────────────────
import { GetAdminAppealSchema, SearchAdminAppealsSchema, getAdminAppealText, searchAdminAppeals } from "./tools/admin-appeals.js"
import {
  GetCompetitionSchema,
  GetIntegritySchema,
  GetPrivacySchema,
  GetPublicServiceSchema,
  GetWorkplaceSchema,
  SearchCompetitionSchema,
  SearchIntegritySchema,
  SearchPrivacySchema,
  SearchPublicServiceSchema,
  SearchWorkplaceSchema,
  getCompetitionDecisionText,
  getIntegrityDecisionText,
  getPrivacyDecisionText,
  getPublicServiceDecisionText,
  getWorkplaceDecisionText,
  searchCompetitionDecisions,
  searchIntegrityDecisions,
  searchPrivacyDecisions,
  searchPublicServiceDecisions,
  searchWorkplaceDecisions,
} from "./tools/committee-decisions.js"
import {
  GetConstitutionalSchema,
  SearchConstitutionalSchema,
  getConstitutionalDecisionText,
  searchConstitutionalDecisions,
} from "./tools/constitutional-decisions.js"
import { GetExplanatoryTextSchema, SearchExplanatorySchema, getExplanatoryText, searchExplanatory } from "./tools/explanatory.js"
import {
  GetRegisteredInstrumentSchema,
  SearchAgencyRulesSchema,
  SearchGazettesSchema,
  SearchUniversityRulesSchema,
  getRegisteredInstrumentText,
  searchAgencyRules,
  searchGazettes,
  searchUniversityRules,
} from "./tools/institutional-rules.js"
import { GetCaseTextSchema, SearchCasesSchema, getCaseText, searchCases } from "./tools/precedents.js"
import { GetRulingTextSchema, SearchRulingsSchema, getRulingText, searchRulings } from "./tools/rulings.js"
import { GetStateLawTextSchema, SearchStateLawSchema, getStateLawText, searchStateLaw } from "./tools/state-law.js"
import {
  GetTaxTribunalSchema,
  SearchTaxTribunalSchema,
  getTaxTribunalDecisionText,
  searchTaxTribunalDecisions,
} from "./tools/tax-tribunal-decisions.js"
import { GetTreatyTextSchema, SearchTreatiesSchema, getTreatyText, searchTreaties } from "./tools/treaties.js"
import { GetDecisionTextSchema, SearchDecisionsSchema, getDecisionText, searchDecisions } from "./tools/unified-decisions.js"

// ── Knowledge base, documents, links ──────────────────────────────────────
import { analyzeDocumentSchema, analyzeDocument } from "./tools/document-analysis.js"
import { getExternalLinksSchema, getExternalLinks } from "./tools/external-links.js"
import {
  getLegalTermDetail,
  getLegalTermDetailSchema,
  getLegalTermKb,
  getLegalTermKbSchema,
  getLegalToPlain,
  getLegalToPlainSchema,
  getPlainTerm,
  getPlainTermSchema,
  getPlainToLegal,
  getPlainToLegalSchema,
  getRelatedLaws,
  getRelatedLawsSchema,
  getTermProvisions,
  getTermProvisionsSchema,
} from "./tools/knowledge-base.js"

// ── Orchestration ─────────────────────────────────────────────────────────
import { SearchAiLawSchema, searchAiLaw, searchAiLawDescription } from "./tools/ai-search.js"
import {
  chainActionBasis,
  chainActionBasisDescription,
  chainActionBasisSchema,
  chainAmendmentTrack,
  chainAmendmentTrackDescription,
  chainAmendmentTrackSchema,
  chainDisputePrep,
  chainDisputePrepDescription,
  chainDisputePrepSchema,
  chainDocumentReview,
  chainDocumentReviewDescription,
  chainDocumentReviewSchema,
  chainFullResearch,
  chainFullResearchDescription,
  chainFullResearchSchema,
  chainLawSystem,
  chainLawSystemDescription,
  chainLawSystemSchema,
  chainProcedureDetail,
  chainProcedureDetailDescription,
  chainProcedureDetailSchema,
  chainStateLawCompare,
  chainStateLawCompareDescription,
  chainStateLawCompareSchema,
} from "./tools/chains.js"
import { LegalResearchSchema, legalResearch, legalResearchDescription } from "./tools/legal-research.js"
import {
  DiscoverToolsSchema,
  ExecuteToolSchema,
  discoverTools,
  discoverToolsDescription,
  executeTool,
  executeToolDescription,
  setAllToolsRef,
} from "./tools/meta-tools.js"
import { SearchAllSchema, searchAll, searchAllDescription } from "./tools/search-all.js"

// ── Analysis (killer features) ────────────────────────────────────────────
import { ApplicableLawSchema, applicableLaw, applicableLawDescription } from "./tools/applicable-law.js"
import { CiteCheckSchema, citeCheck, citeCheckDescription } from "./tools/cite-check.js"
import { ImpactMapSchema, impactMap, impactMapDescription } from "./tools/impact-map.js"
import { LegalAnalysisSchema, legalAnalysis, legalAnalysisDescription } from "./tools/legal-analysis.js"
import { VerifyCitationsSchema, verifyCitations, verifyCitationsDescription } from "./tools/verify-citations.js"

type Tool = McpTool<AuApiClient>

/**
 * Every tool. Order is presentation order for anything that walks the list;
 * `discover_tools` re-groups by category, so the grouping here is for readers.
 */
export const allTools: Tool[] = [
  // ═══ Legislation ═══
  { name: "search_law", description: searchLawDescription, schema: SearchLawSchema, handler: searchLaw },
  { name: "get_law_text", description: getLawTextDescription, schema: GetLawTextSchema, handler: getLawText },
  { name: "get_schedules", description: getSchedulesDescription, schema: GetSchedulesSchema, handler: getSchedules },
  {
    name: "get_batch_provisions",
    description: getBatchProvisionsDescription,
    schema: GetBatchProvisionsSchema,
    handler: getBatchProvisions,
  },
  { name: "advanced_search", description: advancedSearchDescription, schema: AdvancedSearchSchema, handler: advancedSearch },
  {
    name: "suggest_law_names",
    description: suggestLawNamesDescription,
    schema: SuggestLawNamesSchema,
    handler: suggestLawNames,
  },
  {
    name: "search_ai_law",
    description: searchAiLawDescription,
    schema: SearchAiLawSchema,
    handler: searchAiLaw,
  },
  { name: "search_all", description: searchAllDescription, schema: SearchAllSchema, handler: searchAll },

  // ═══ Structure and delegated legislation ═══
  { name: "get_three_tier", description: getThreeTierDescription, schema: GetThreeTierSchema, handler: getThreeTier },
  { name: "get_law_tree", description: getLawTreeDescription, schema: GetLawTreeSchema, handler: getLawTree },
  {
    name: "get_law_system_tree",
    description: getLawSystemTreeDescription,
    schema: GetLawSystemTreeSchema,
    handler: getLawSystemTree,
  },
  {
    name: "get_enabled_instruments",
    description: getEnabledInstrumentsDescription,
    schema: GetEnabledInstrumentsSchema,
    handler: getEnabledInstruments,
  },
  {
    name: "get_instrument_provisions",
    description: getInstrumentProvisionsDescription,
    schema: GetInstrumentProvisionsSchema,
    handler: getInstrumentProvisions,
  },
  {
    name: "get_enabling_acts",
    description: getEnablingActsDescription,
    schema: GetEnablingActsSchema,
    handler: getEnablingActs,
  },
  {
    name: "instrument_radar",
    description: instrumentRadarDescription,
    schema: InstrumentRadarSchema,
    handler: instrumentRadar,
  },

  // ═══ History and point in time ═══
  { name: "get_law_history", description: getLawHistoryDescription, schema: GetLawHistorySchema, handler: getLawHistory },
  {
    name: "get_provision_history",
    description: getProvisionHistoryDescription,
    schema: GetProvisionHistorySchema,
    handler: getProvisionHistory,
  },
  { name: "compare_old_new", description: compareOldNewDescription, schema: CompareOldNewSchema, handler: compareOldNew },
  {
    name: "search_historical_law",
    description: searchHistoricalLawDescription,
    schema: SearchHistoricalLawSchema,
    handler: searchHistoricalLaw,
  },
  {
    name: "get_historical_law",
    description: getHistoricalLawDescription,
    schema: GetHistoricalLawSchema,
    handler: getHistoricalLaw,
  },
  {
    name: "get_law_statistics",
    description: getLawStatisticsDescription,
    schema: GetLawStatisticsSchema,
    handler: getLawStatistics,
  },

  // ═══ State and territory ═══
  {
    name: "search_state_law",
    description:
      "Search a State or Territory legislation register: QLD and TAS by full text, WA/NT/VIC/ACT by title or register " +
      "number. NSW and SA are not fetched (their registers refuse automated access) and come back as deep links — " +
      "which is not evidence that they have no such Act. Most Australian law that touches a person directly — " +
      "tenancy, crime, land, licensing — lives here rather than on the Commonwealth register.",
    schema: SearchStateLawSchema,
    handler: searchStateLaw,
  },
  {
    name: "get_state_law_text",
    description:
      "Fetch one State or Territory Act by the id printed by search_state_law. What comes back depends on the " +
      "register: QLD/TAS/WA return text, VIC and NT return the authorised PDF/DOCX links because that is the only " +
      "authorised form, and ACT is addressed by register number.",
    schema: GetStateLawTextSchema,
    handler: getStateLawText,
  },
  {
    name: "get_state_equivalents",
    description: getStateEquivalentsDescription,
    schema: GetStateEquivalentsSchema,
    handler: getStateEquivalents,
  },

  // ═══ Decisions — unified ═══
  {
    name: "search_decisions",
    description:
      "Search any of the 18 Australian decision domains from one tool, chosen with `domain`: cases (NSW Caselaw + " +
      "High Court + Queensland Judgments), constitutional, admin_appeals (NCAT/QCAT/ART), tax_tribunal, tax_rulings, " +
      "interpretations, customs, competition, workplace (Fair Work), privacy (OAIC), integrity (NACC), " +
      "public_service, university_rules, agency_rules, gazettes, treaties, explanatory, state_law. " +
      "Sources that are blocked to automated clients return deep links with [UPSTREAM_BLOCKED] — never a claim that " +
      "the decision does not exist. Use get_decision_text with the same domain and the id printed here.",
    schema: SearchDecisionsSchema,
    handler: searchDecisions,
  },
  {
    name: "get_decision_text",
    description:
      "Fetch the full text of one decision from any of the 18 domains: pass the same `domain` you searched and the " +
      "`id` printed in the results — never an invented one. Long reasons are shortened from the middle with the " +
      "exact number of omitted characters marked; pass full=true for the whole thing.",
    schema: GetDecisionTextSchema,
    handler: getDecisionText,
  },

  // ═══ Decisions — per source ═══
  {
    name: "search_cases",
    description:
      "Search Australian case law directly across the three reachable sources at once — NSW Caselaw, the High Court " +
      "and Queensland Judgments. A medium-neutral citation ('[2010] NSWCCA 333') is routed to an exact lookup. " +
      "Courts that are Cloudflare-gated (the Federal Court, AustLII) come back as deep links, not as absence.",
    schema: SearchCasesSchema,
    handler: searchCases,
  },
  {
    name: "get_case_text",
    description:
      "Fetch one judgment by medium-neutral citation ('[2020] HCA 41') or by the prefixed id from search_cases " +
      "('nsw:…', 'hca:…', 'qld:…'). Long reasons are shortened from the middle with the gap marked.",
    schema: GetCaseTextSchema,
    handler: getCaseText,
  },
  {
    name: "search_constitutional_decisions",
    description:
      "Search High Court judgments whose catchwords are constitutional — the closest Australian analogue of a " +
      "constitutional court docket. Optionally verifies the catchwords on each hit rather than trusting the facet.",
    schema: SearchConstitutionalSchema,
    handler: searchConstitutionalDecisions,
  },
  {
    name: "get_constitutional_decision_text",
    description: "Fetch one High Court judgment by the slug printed by search_constitutional_decisions.",
    schema: GetConstitutionalSchema,
    handler: getConstitutionalDecisionText,
  },
  {
    name: "search_admin_appeals",
    description:
      "Search merits-review tribunal decisions: NCAT (through NSW Caselaw, by division) and QCAT (through Queensland " +
      "Judgments). The federal ART publishes through AustLII, which is blocked, so it comes back as deep links.",
    schema: SearchAdminAppealsSchema,
    handler: searchAdminAppeals,
  },
  {
    name: "get_admin_appeal_text",
    description: "Fetch one tribunal decision by the id from search_admin_appeals ('ncat:…', 'qcat:…') or a QCAT citation.",
    schema: GetAdminAppealSchema,
    handler: getAdminAppealText,
  },
  {
    name: "search_tax_tribunal_decisions",
    description:
      "Search the ATO Legal Database for decision impact statements — the Commissioner's published response to a " +
      "court or tribunal decision, which is where the ATO says whether it will follow it. ARTA decisions themselves " +
      "are only on AustLII (blocked) and come back as deep links.",
    schema: SearchTaxTribunalSchema,
    handler: searchTaxTribunalDecisions,
  },
  {
    name: "get_tax_tribunal_decision_text",
    description: "Fetch one decision impact statement by the DocID printed by search_tax_tribunal_decisions.",
    schema: GetTaxTribunalSchema,
    handler: getTaxTribunalDecisionText,
  },
  {
    name: "search_rulings",
    description:
      "Search ATO public rulings and interpretative material: TR/TD/GSTR/PCG public rulings, ATO IDs and practice " +
      "statements, and customs/excise material plus the Anti-Dumping Review Panel indexes. An exact product code " +
      "('TR 2024/1', 'PS LA 2009/9') is resolved by exact search rather than guessed.",
    schema: SearchRulingsSchema,
    handler: searchRulings,
  },
  {
    name: "get_ruling_text",
    description:
      "Fetch one ATO ruling by product code ('TR 2024/1') or DocID. `asAt` reaches the ATO's own point-in-time " +
      "index, which is separate from the Federal Register's compilation series.",
    schema: GetRulingTextSchema,
    handler: getRulingText,
  },
  {
    name: "search_workplace_decisions",
    description:
      "Search Fair Work Commission decisions — unfair dismissal, general protections, agreements, awards, stand-down " +
      "disputes. The site's facet total disagrees with the result list, so the count reported is the rows actually returned.",
    schema: SearchWorkplaceSchema,
    handler: searchWorkplaceDecisions,
  },
  {
    name: "get_workplace_decision_text",
    description: "Fetch one Fair Work Commission decision by the slug printed by search_workplace_decisions.",
    schema: GetWorkplaceSchema,
    handler: getWorkplaceDecisionText,
  },
  {
    name: "search_privacy_decisions",
    description:
      "Search the OAIC's index of privacy determinations (the AICmr series) — the Commissioner's binding decisions " +
      "on interference with privacy. The determinations themselves are PDFs.",
    schema: SearchPrivacySchema,
    handler: searchPrivacyDecisions,
  },
  {
    name: "get_privacy_decision_text",
    description: "Fetch one privacy determination by its AICmr citation, e.g. '[2026] AICmr 40'.",
    schema: GetPrivacySchema,
    handler: getPrivacyDecisionText,
  },
  {
    name: "search_competition_decisions",
    description:
      "Competition and consumer enforcement matters. The ACCC and the Competition Tribunal both return 403 to " +
      "non-browser clients, so this reports [UPSTREAM_BLOCKED] with deep links and falls back to a case-law search — " +
      "it never reports the absence of a proceeding.",
    schema: SearchCompetitionSchema,
    handler: searchCompetitionDecisions,
  },
  {
    name: "get_competition_decision_text",
    description: "Fetch a competition matter through the case-law sources; ACCC-hosted documents are link-only.",
    schema: GetCompetitionSchema,
    handler: getCompetitionDecisionText,
  },
  {
    name: "search_integrity_decisions",
    description:
      "Search the NACC's investigation reports and case studies. The Commonwealth Ombudsman is Cloudflare-gated and " +
      "comes back as deep links with [UPSTREAM_BLOCKED].",
    schema: SearchIntegritySchema,
    handler: searchIntegrityDecisions,
  },
  {
    name: "get_integrity_decision_text",
    description: "Fetch one NACC investigation report by its operation anchor, e.g. 'operation-wilson'.",
    schema: GetIntegritySchema,
    handler: getIntegrityDecisionText,
  },
  {
    name: "search_public_service_decisions",
    description:
      "Search the Merit Protection Commissioner's published case studies on APS review outcomes — promotion review, " +
      "code-of-conduct decisions, review of actions.",
    schema: SearchPublicServiceSchema,
    handler: searchPublicServiceDecisions,
  },
  {
    name: "get_public_service_decision_text",
    description: "Fetch one MPC case study by the slug printed by search_public_service_decisions.",
    schema: GetPublicServiceSchema,
    handler: getPublicServiceDecisionText,
  },
  {
    name: "search_agency_rules",
    description:
      "Search the Federal Register's notifiable-instrument collection — agency determinations, delegations and " +
      "appointments that are authorised by an Act but are not legislative instruments.",
    schema: SearchAgencyRulesSchema,
    handler: searchAgencyRules,
  },
  {
    name: "search_gazettes",
    description: "Search the Commonwealth Gazette collection on the Federal Register — notices, proclamations and appointments.",
    schema: SearchGazettesSchema,
    handler: searchGazettes,
  },
  {
    name: "get_registered_instrument_text",
    description: "Fetch a notifiable instrument or gazette notice by its Federal Register id, e.g. 'F2024N00123'.",
    schema: GetRegisteredInstrumentSchema,
    handler: getRegisteredInstrumentText,
  },
  {
    name: "search_university_rules",
    description:
      "Search the Acts that establish and govern Australian universities, across the State registers that answer a " +
      "query. Universities are creatures of State statute, so there is no Commonwealth list to search.",
    schema: SearchUniversityRulesSchema,
    handler: searchUniversityRules,
  },
  {
    name: "search_explanatory",
    description:
      "Search explanatory statements and memoranda — the version written for humans. An instrument's explanatory " +
      "statement is registered with it; an Act's explanatory memorandum belongs to the originating bill. Under s 15AB " +
      "of the Acts Interpretation Act these are extrinsic material a court may use, so they are evidence, not commentary.",
    schema: SearchExplanatorySchema,
    handler: searchExplanatory,
  },
  {
    name: "get_explanatory_text",
    description:
      "Fetch the explanatory material for one title by its Federal Register id: an instrument ('F2011L00287') " +
      "resolves to its registered explanatory statement, an Act ('C2022A00083') to the bill's explanatory memoranda.",
    schema: GetExplanatoryTextSchema,
    handler: getExplanatoryText,
  },
  {
    name: "search_treaties",
    description:
      "Search the DFAT Australian Treaties Database — bilateral and multilateral treaties with their status, entry " +
      "into force and treaty-series numbers. A treaty binds Australia internationally without being part of domestic " +
      "law until legislation implements it; the results say which is which where the database records it.",
    schema: SearchTreatiesSchema,
    handler: searchTreaties,
  },
  {
    name: "get_treaty_text",
    description:
      "Fetch one treaty record by its database id. The database has no single-record endpoint, so passing the " +
      "keyword that produced the id makes the lookup exact instead of a scan.",
    schema: GetTreatyTextSchema,
    handler: getTreatyText,
  },

  // ═══ Terminology ═══
  {
    name: "get_legal_term_kb",
    description:
      "Look a legal term up across the bundled Australian glossary and the definition sections of Commonwealth Acts. " +
      "Start here when a word in a document might be a defined term rather than an ordinary one.",
    schema: getLegalTermKbSchema,
    handler: getLegalTermKb,
  },
  {
    name: "get_legal_term_detail",
    description: "The full entry for one legal term: definition, the provisions that define it, and related terms.",
    schema: getLegalTermDetailSchema,
    handler: getLegalTermDetail,
  },
  {
    name: "get_plain_term",
    description: "Find the legal term behind an everyday word — 'sacked', 'ripped off', 'bond' — so the right Act can be searched.",
    schema: getPlainTermSchema,
    handler: getPlainTerm,
  },
  {
    name: "get_plain_to_legal",
    description: "Map everyday wording to the legal vocabulary that will actually match legislation and judgments.",
    schema: getPlainToLegalSchema,
    handler: getPlainToLegal,
  },
  {
    name: "get_legal_to_plain",
    description: "Explain a legal term in ordinary English, for reporting an answer back to a non-lawyer.",
    schema: getLegalToPlainSchema,
    handler: getLegalToPlain,
  },
  {
    name: "get_term_provisions",
    description:
      "Find the provisions that define a term. A term defined in one Act's dictionary can mean something different " +
      "in another, so the defining provision matters more than the definition.",
    schema: getTermProvisionsSchema,
    handler: getTermProvisions,
  },
  {
    name: "get_related_laws",
    description: "The Acts and instruments that use a given term, as a way into an unfamiliar area.",
    schema: getRelatedLawsSchema,
    handler: getRelatedLaws,
  },

  // ═══ Documents and links ═══
  {
    name: "analyze_document",
    description:
      "Triage a contract, terms of service, letter or notice: numbered clauses, risk signals with severity, key " +
      "amounts and periods, and internal conflicts. Pattern matching, not advice — a quiet result is never a " +
      "clearance, and nothing here establishes that a clause is void or enforceable.",
    schema: analyzeDocumentSchema,
    handler: analyzeDocument,
  },
  {
    name: "get_external_links",
    description:
      "Build deep links for sources this server will not fetch — AustLII, LawCite, the Federal Court, and the NSW " +
      "and SA registers. Use it to hand a user a URL for material that is blocked rather than absent.",
    schema: getExternalLinksSchema,
    handler: getExternalLinks,
  },

  // ═══ Utilities ═══
  {
    name: "parse_section_ref",
    description: parseSectionRefDescription,
    schema: ParseSectionRefSchema,
    handler: parseSectionRefTool,
  },
  {
    name: "get_law_abbreviations",
    description: getLawAbbreviationsDescription,
    schema: GetLawAbbreviationsSchema,
    handler: getLawAbbreviations,
  },

  // ═══ Aggregate entry points ═══
  // The chains and the four analysis features stay registered under their own
  // names below; these two are what ListTools advertises.
  { name: "legal_research", description: legalResearchDescription, schema: LegalResearchSchema, handler: legalResearch },
  { name: "legal_analysis", description: legalAnalysisDescription, schema: LegalAnalysisSchema, handler: legalAnalysis },

  // ═══ Chains ═══
  { name: "chain_law_system", description: chainLawSystemDescription, schema: chainLawSystemSchema, handler: chainLawSystem },
  {
    name: "chain_action_basis",
    description: chainActionBasisDescription,
    schema: chainActionBasisSchema,
    handler: chainActionBasis,
  },
  {
    name: "chain_dispute_prep",
    description: chainDisputePrepDescription,
    schema: chainDisputePrepSchema,
    handler: chainDisputePrep,
  },
  {
    name: "chain_amendment_track",
    description: chainAmendmentTrackDescription,
    schema: chainAmendmentTrackSchema,
    handler: chainAmendmentTrack,
  },
  {
    name: "chain_state_law_compare",
    description: chainStateLawCompareDescription,
    schema: chainStateLawCompareSchema,
    handler: chainStateLawCompare,
  },
  {
    name: "chain_full_research",
    description: chainFullResearchDescription,
    schema: chainFullResearchSchema,
    handler: chainFullResearch,
  },
  {
    name: "chain_procedure_detail",
    description: chainProcedureDetailDescription,
    schema: chainProcedureDetailSchema,
    handler: chainProcedureDetail,
  },
  {
    name: "chain_document_review",
    description: chainDocumentReviewDescription,
    schema: chainDocumentReviewSchema,
    handler: chainDocumentReview,
  },

  // ═══ Analysis ═══
  {
    name: "verify_citations",
    description: verifyCitationsDescription,
    schema: VerifyCitationsSchema,
    handler: verifyCitations,
  },
  { name: "cite_check", description: citeCheckDescription, schema: CiteCheckSchema, handler: citeCheck },
  {
    name: "applicable_law",
    description: applicableLawDescription,
    schema: ApplicableLawSchema,
    handler: applicableLaw,
  },
  { name: "impact_map", description: impactMapDescription, schema: ImpactMapSchema, handler: impactMap },

  // ═══ Meta ═══
  { name: "discover_tools", description: discoverToolsDescription, schema: DiscoverToolsSchema, handler: discoverTools },
  { name: "execute_tool", description: executeToolDescription, schema: ExecuteToolSchema, handler: executeTool },
]

/**
 * Peel a wrapper off a schema to reach the object underneath.
 *
 * `legal_research` wraps its object in `z.preprocess` (the step that absorbs a
 * mislabelled `task`) and `get_batch_provisions` carries a `.refine()` and a
 * `.superRefine()`. Zod v4 resolves both when asked for the *input* view, so
 * this is a fallback rather than an unconditional peel — but it is a fallback
 * worth having, because the failure mode it guards is silent: a wrapper the
 * converter does not understand yields `{}`, and the tool is then advertised
 * as taking no parameters at all while still requiring them.
 *
 * For a `pipe` the object is on the **out** side: `z.preprocess(fn, obj)` is
 * `pipe(transform(fn), obj)`, so following `in` would land on the transform.
 */
export function unwrapZodEffects(schema: unknown): unknown {
  let current = schema as { _def?: { schema?: unknown; innerType?: unknown; out?: unknown; type?: string } }
  // Bounded: a hand-written schema nests a handful of wrappers at most, and an
  // unbounded walk over a cyclic `_def` would hang the ListTools handler.
  for (let depth = 0; depth < 10; depth++) {
    const definition = current?._def
    if (!definition) break
    const inner = definition.schema ?? definition.innerType ?? (definition.type === "pipe" ? definition.out : undefined)
    if (!inner) break
    current = inner as typeof current
  }
  return current
}

/**
 * Cap on one advertised parameter description.
 *
 * The tool list is sent to every client on every session and is pure overhead
 * against the caller's context, so the projection is not obliged to carry
 * every word of a 900-character enum gloss. The full text stays on the schema
 * itself — validation, `execute_tool` and `discover_tools` all read the
 * original — and the clipping is announced once per schema so nobody reads a
 * shortened sentence as the whole rule.
 *
 * 240 characters, measured rather than guessed: it removes ~900 bytes of enum
 * catalogue from `search_decisions.domain` and leaves every other parameter
 * intact. Tightening it further makes the payload *larger*, because the
 * per-schema notice then applies to more tools than the clipping saves.
 */
export const MAX_ADVERTISED_DESCRIPTION = 240

const CLIP_NOTICE =
  "Some parameter notes are shortened in this listing; each tool still accepts its full documented range."

function clipDescriptions(properties: Record<string, unknown>): {
  properties: Record<string, unknown>
  clipped: boolean
} {
  const out: Record<string, unknown> = {}
  let clipped = false
  for (const [key, value] of Object.entries(properties)) {
    if (!value || typeof value !== "object") {
      out[key] = value
      continue
    }
    const property = value as Record<string, unknown>
    const description = property.description
    if (typeof description !== "string" || description.length <= MAX_ADVERTISED_DESCRIPTION) {
      out[key] = property
      continue
    }
    clipped = true
    out[key] = { ...property, description: `${description.slice(0, MAX_ADVERTISED_DESCRIPTION).trimEnd()}…` }
  }
  return { properties: out, clipped }
}

/**
 * Zod → the JSON Schema advertised over MCP.
 *
 * `io: "input"` is required. The default ("output") serialises a field with a
 * `.default()` as *required*, so `legal_research.task` and `search_law.limit`
 * would be advertised as mandatory even though the whole point of the default
 * is that the caller can omit them.
 */
export function toMcpInputSchema(schema: unknown): Record<string, unknown> {
  const raw = convert(schema)
  // Only fall back to unwrapping when the direct conversion lost the
  // properties — peeling unconditionally would risk picking the wrong side of
  // a schema the converter already understood.
  const usable = hasProperties(raw) ? raw : (hasProperties(convert(unwrapZodEffects(schema))) ? convert(unwrapZodEffects(schema)) : raw)

  if (usable?.type === "object" && usable.properties) {
    const properties = { ...(usable.properties as Record<string, unknown>) }
    // Internal plumbing, never a caller's parameter: `__taskWas` is set by
    // legal_research's own preprocess step to explain a correction it made.
    delete properties.__taskWas
    delete properties.apiKey
    const required = Array.isArray(usable.required)
      ? (usable.required as string[]).filter((key) => key !== "apiKey" && key !== "__taskWas")
      : []
    const clipped = clipDescriptions(properties)
    return {
      type: "object",
      properties: clipped.properties,
      required,
      additionalProperties: usable.additionalProperties ?? false,
      ...(clipped.clipped ? { description: CLIP_NOTICE } : {}),
    }
  }
  return usable
}

function convert(schema: unknown): Record<string, unknown> {
  try {
    const raw = z.toJSONSchema(schema as z.ZodType, { io: "input" }) as Record<string, unknown>
    // The `$schema` key is 60 bytes per tool of pure protocol noise: MCP
    // already says what dialect an inputSchema is.
    delete raw.$schema
    return raw
  } catch {
    // A schema that cannot be serialised must not take the tool list down with
    // it: one unadvertisable tool is a bug, a dead ListTools is an outage.
    return { type: "object", properties: {}, additionalProperties: true }
  }
}

function hasProperties(schema: Record<string, unknown>): boolean {
  const properties = schema?.properties
  return !!properties && Object.keys(properties as Record<string, unknown>).length > 0
}

/** Marketplace-facing service name, injected only at advertisement time. */
const SERVICE_NAME = "Australian-law-mcp"

/**
 * Built once at module load. `allTools` is static, and rebuilding this per
 * request would repeat the work on every call in HTTP mode.
 */
const toolMap = new Map<string, Tool>(allTools.map((tool) => [tool.name, tool]))

// The meta tools need the whole list; injected rather than imported, because
// `meta-tools` is imported from here and the reverse import would be a cycle.
setAllToolsRef(allTools)

const exposedTools = allTools.filter((tool) => V3_EXPOSED.has(tool.name))

/** Derived, never hard-coded — health checks and docs read these. */
export const TOOL_COUNTS = { exposed: exposedTools.length, total: allTools.length }

/** The exact payload `ListTools` answers with. Exported so a test can size it. */
export function listToolsPayload(): { tools: Array<Record<string, unknown>> } {
  return {
    tools: exposedTools.map((tool) => ({
      name: tool.name,
      description: `${SERVICE_NAME} — ${tool.description}`,
      inputSchema: toMcpInputSchema(tool.schema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    })),
  }
}

export function registerTools(
  server: Server,
  apiClient: AuApiClient,
  executionLimits: ExecutionLimits = readExecutionLimits(),
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => listToolsPayload())

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // The HTTP entry point puts one budget in AsyncLocalStorage for the whole
    // JSON-RPC envelope; a stdio request has no outer context, so one is made
    // here. `extra.signal` is item-specific — cancelling one batch item must
    // not cancel siblings that merely share the budget.
    const budget = requestContext.getStore()?.budget ?? new RequestExecutionBudget(executionLimits)
    return runWithRequestContext({ budget, signal: extra.signal }, async () => {
      const { name, arguments: args } = request.params
      const tool = toolMap.get(name)
      if (!tool) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Unknown tool: ${name}\n` +
                "Run discover_tools to find the right one — this server has many tools that ListTools does not " +
                "advertise. Do not answer as if the capability were missing.",
            },
          ],
          isError: true,
        }
      }

      try {
        throwIfRequestCancelled()
        // `arguments` is optional in the MCP CallTool schema, and a
        // spec-compliant client omits it for a tool it was advertised with
        // `required: []` — `discover_tools`, `legal_research`, every all-optional
        // tool. Parsing `undefined` rejects all of them with
        // [INVALID_PARAMETER] for a call that was in fact well formed.
        const input = tool.schema.parse(args ?? {})
        const result = await tool.handler(apiClient, input)
        throwIfRequestCancelled()
        const text = truncateResponse(
          result.content.map((content) => content.text).join("\n"),
          executionLimits.maxToolResponseChars,
        )
        return { content: [{ type: "text" as const, text }], isError: result.isError }
      } catch (error) {
        // Cancellation is not a tool result. The SDK suppresses the response
        // for a cancelled item, and re-throwing keeps upstream cancellation
        // visible to the transport instead of answering a withdrawn request.
        if (getRequestSignal()?.aborted) throw error
        const formatted = formatToolError(error, name)
        return {
          content: [
            {
              type: "text" as const,
              text: truncateResponse(
                formatted.content.map((content) => content.text).join("\n"),
                executionLimits.maxToolResponseChars,
              ),
            },
          ],
          isError: true,
        }
      }
    })
  })
}

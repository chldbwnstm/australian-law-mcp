/**
 * Which tools are advertised, and what vocabulary reaches the rest.
 *
 * Two things live here that could be split apart, deliberately kept together:
 * the exposure list (`V3_EXPOSED`) and the category taxonomy that
 * `discover_tools` searches. Split, they drift — the taxonomy starts putting a
 * two-hop tool at the head of a category whose closing advice says "call it
 * directly", and the caller is told to reach a tool by a path that does not
 * apply to it.
 *
 * The exposure policy: a server with sixty tools cannot advertise sixty. Each
 * ListTools entry costs every client context on every request, forever, and a
 * model choosing between sixty near-synonyms chooses badly. So ten are
 * advertised and the rest are reached through `discover_tools` →
 * `execute_tool`. The ten are not "the best ten" — they are the ones where the
 * two-hop round trip is not worth its latency: the two aggregate entry points,
 * and the eight leaf tools those entry points most often tell a caller to run
 * next.
 */

/**
 * Advertised through ListTools. Everything else is reachable — by name through
 * CallTool, and by discovery through `execute_tool` — but not advertised.
 *
 * `tool-registry` filters on this set and `discover_tools` reads the same set
 * to decide what advice to print. One list, so the two can never disagree.
 */
export const V3_EXPOSED: ReadonlySet<string> = new Set([
  "legal_research", // the eight chains, behind `task`
  "legal_analysis", // the four killer features, behind `mode`
  "search_law",
  "get_law_text",
  "get_schedules", // Australian fees, forms and tables live in schedules, not sections
  "instrument_radar", // "has the enabling Act moved under this instrument?" — no cheap substitute
  "search_decisions",
  "get_decision_text",
  "discover_tools",
  "execute_tool",
])

/**
 * The closing line of a `discover_tools` answer, which depends on what it
 * returned. Telling a caller to route an advertised tool through
 * `execute_tool` adds a hop for nothing and contradicts the tool list it is
 * already holding.
 */
export function describeCallPath(listed: ReadonlySet<string>): string {
  const exposed = [...listed].filter((name) => V3_EXPOSED.has(name))
  if (exposed.length === 0) return "Run any of these with execute_tool(tool_name, params)."
  const direct = `${exposed.join(", ")} — call directly.`
  return exposed.length === listed.size ? direct : `${direct} The rest go through execute_tool(tool_name, params).`
}

/**
 * How people say things versus what the tools are called.
 *
 * Every key must be a real category in `TOOL_CATEGORIES` — an alias that
 * resolves to a category that does not exist is a silent nil result, which is
 * indistinguishable from "there is no such tool". A test pins the invariant.
 *
 * The values are Australian practitioner vocabulary, not synonyms in general:
 * "catchwords", "AGLC", "penalty units", "medium neutral citation", "EM" are
 * what someone actually types, and none of them appears in a tool name.
 */
export const TOOL_ALIASES: Record<string, readonly string[]> = {
  // ── categories ──────────────────────────────────────────────────────────
  legislation: ["act", "acts", "statute", "statutes", "legislation", "commonwealth law", "federal law", "frl", "register"],
  instruments: ["regulation", "regulations", "rules", "delegated legislation", "legislative instrument", "subordinate", "made under"],
  "state law": ["state", "states", "territory", "nsw", "victoria", "queensland", "qld", "wa", "sa", "tasmania", "act law", "nt", "jurisdiction"],
  "case law": ["case", "cases", "judgment", "judgement", "court", "hca", "high court", "precedent", "authority", "medium neutral citation", "catchwords"],
  tribunals: ["tribunal", "art", "aat", "ncat", "qcat", "merits review", "administrative review", "appeal"],
  "tax and rulings": ["ato", "tax", "taxation", "gst", "ruling", "rulings", "public ruling", "private ruling", "ps la", "ato id", "excise", "customs"],
  workplace: ["fair work", "fwc", "employment", "unfair dismissal", "award", "enterprise agreement", "industrial"],
  privacy: ["oaic", "privacy", "aicmr", "personal information", "data breach", "determination"],
  competition: ["accc", "competition", "cartel", "misuse of market power", "consumer law", "acl"],
  integrity: ["nacc", "corruption", "integrity", "whistleblower", "public interest disclosure", "ombudsman"],
  "public service": ["aps", "public service", "merit protection", "mpc", "code of conduct"],
  treaties: ["treaty", "treaties", "international", "dfat", "convention", "atd"],
  explanatory: ["explanatory memorandum", "em", "explanatory statement", "es", "second reading", "extrinsic material"],
  "history and versions": ["compilation", "point in time", "as at", "historical", "repealed", "amendment", "amendments", "consolidation"],
  schedules: ["schedule", "schedules", "form", "forms", "fee", "fees", "penalty units", "table", "rates"],
  terminology: ["definition", "definitions", "glossary", "term", "meaning", "plain english", "jargon"],
  // Tool names sit alongside the plain-English aliases on purpose: a caller
  // that types `cite_check` is naming a tool, not a topic, and should get that
  // tool's group at the top rather than a description match somewhere down the
  // list. `tool-discovery` decides which of these values are real tools by
  // asking the registry, so a name that is retired here simply stops matching.
  "citations and verification": ["aglc", "citation", "citations", "verify", "hallucination", "check the cite", "citator", "shepardise", "noting up", "verify_citations", "cite_check", "applicable_law", "impact_map"],
  "documents and links": ["contract", "document review", "austlii", "lawcite", "deep link", "external link", "analyze_document", "get_external_links"],
  research: ["research", "chain", "multi-step", "where do i start", "overview", "legal_research", "search_all", "browser follow-up", "aside", "evidence", "plan_research_followup", "check_research_evidence"],
  utilities: ["section reference", "pinpoint", "abbreviation", "shorthand", "parse_section_ref", "get_law_abbreviations"],
}

/**
 * Category → tools. Order inside a category is presentation order, so the
 * advertised entry point goes first wherever one exists: the cheapest path is
 * the one the caller sees first.
 */
export const TOOL_CATEGORIES: Record<string, readonly string[]> = {
  legislation: ["search_law", "get_law_text", "search_ai_law", "search_all", "advanced_search", "suggest_law_names", "get_batch_provisions", "get_law_tree", "get_law_system_tree", "get_law_statistics"],
  instruments: ["get_three_tier", "get_enabled_instruments", "get_enabling_acts", "get_instrument_provisions", "instrument_radar", "search_agency_rules", "search_gazettes", "get_registered_instrument_text"],
  "state law": ["search_state_law", "get_state_law_text", "get_state_equivalents", "search_university_rules", "chain_state_law_compare"],
  "case law": ["search_decisions", "get_decision_text", "search_cases", "get_case_text", "search_constitutional_decisions", "get_constitutional_decision_text"],
  tribunals: ["search_decisions", "search_admin_appeals", "get_admin_appeal_text", "search_tax_tribunal_decisions", "get_tax_tribunal_decision_text", "search_public_service_decisions", "get_public_service_decision_text"],
  "tax and rulings": ["search_rulings", "get_ruling_text", "search_tax_tribunal_decisions", "get_tax_tribunal_decision_text"],
  workplace: ["search_workplace_decisions", "get_workplace_decision_text"],
  privacy: ["search_privacy_decisions", "get_privacy_decision_text"],
  competition: ["search_competition_decisions", "get_competition_decision_text"],
  integrity: ["search_integrity_decisions", "get_integrity_decision_text"],
  "public service": ["search_public_service_decisions", "get_public_service_decision_text"],
  treaties: ["search_treaties", "get_treaty_text"],
  explanatory: ["search_explanatory", "get_explanatory_text"],
  "history and versions": ["get_law_history", "get_provision_history", "compare_old_new", "search_historical_law", "get_historical_law", "chain_amendment_track"],
  schedules: ["get_schedules", "chain_procedure_detail"],
  terminology: ["get_legal_term_kb", "get_legal_term_detail", "get_plain_term", "get_plain_to_legal", "get_legal_to_plain", "get_term_provisions", "get_related_laws"],
  // The four killer features are reached through legal_analysis (one hop);
  // their own names stay listed for direct callers and back-compatibility.
  "citations and verification": ["legal_analysis", "verify_citations", "cite_check", "applicable_law", "impact_map"],
  "documents and links": ["legal_research", "analyze_document", "chain_document_review", "get_external_links"],
  research: ["legal_research", "plan_research_followup", "check_research_evidence", "chain_full_research", "chain_law_system", "chain_action_basis", "chain_dispute_prep", "chain_procedure_detail", "search_all"],
  utilities: ["parse_section_ref", "get_law_abbreviations"],
}

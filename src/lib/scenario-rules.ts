/**
 * Scenario detection — the single source of the "what kind of question is
 * this" vocabulary.
 *
 * The same judgement is made on two surfaces: the CLI router (which turns a
 * scenario into a `legal_research` task) and the chains themselves (which
 * label their own output). Two copies of the vocabulary means the same
 * sentence gets a different scenario depending on which door it came in — so
 * **the words and their precedence exist only here**, and both surfaces read
 * them from this file.
 *
 * Two lists per rule, and the split is deliberate:
 *
 *  - `patterns` is the *labelling* vocabulary. It may be broad, because by the
 *    time it runs the destination is already chosen and the only question is
 *    what to call the answer.
 *  - `routeTriggers` is the *routing* vocabulary, and it is a narrowing of
 *    `patterns`, never a second copy. Routing on the labelling words is how
 *    "drink driving penalty NSW" — a plain research question — gets dragged
 *    into a penalty analysis by the bare word "penalty". A scenario that must
 *    never pick a tool sets `routeTriggers: null`.
 *
 * Regex safety, inherited from the reference implementation: every quantifier
 * is bounded, no pattern starts with a lazy `(.+?)`, and multi-word co-
 * occurrence uses an explicit `[^]{0,N}?` gap in both word orders rather than
 * an unbounded `.*`.
 */

/** `legal_research` tasks, mirrored as a type-only import so this file stays free of the tool graph. */
import type { ResearchTask } from "../tools/legal-research.js"

export type ScenarioName =
  | "penalty"
  | "eligibility"
  | "procedure"
  | "time_travel"
  | "impact"
  | "delegation"
  | "customs"
  | "compliance"
  | "law_system"
  | "document_review"
  | "dispute"
  | "action_plan"

/**
 * Task → the chain tool that runs it.
 *
 * `legal_research(task)` and `chain_*` are the same code reached by two names:
 * the advertised entry point and the direct one. Callers and tests need to
 * know they are equivalent, and deriving one from the other here means a
 * renamed chain cannot leave a scenario pointing at a tool that is gone.
 */
export const TASK_TO_CHAIN: Record<ResearchTask, string> = {
  full_research: "chain_full_research",
  law_system: "chain_law_system",
  action_basis: "chain_action_basis",
  dispute_prep: "chain_dispute_prep",
  amendment_track: "chain_amendment_track",
  state_law_compare: "chain_state_law_compare",
  procedure_detail: "chain_procedure_detail",
  document_review: "chain_document_review",
}

export interface ScenarioRule {
  scenario: ScenarioName
  /** The `legal_research` task this scenario runs as. */
  task: ResearchTask
  /** Lower runs first. Shared by the router (tool choice) and the labeller. */
  precedence: number
  /** Labelling vocabulary (OR). May be broad. */
  patterns: RegExp[]
  /** Routing vocabulary — a narrowing of `patterns`. `null` = never picks a tool. */
  routeTriggers: RegExp[] | null
}

// ── Shared word fragments ────────────────────────────────────────────────
// Assembled from strings rather than written twice: the moment a labelling
// pattern and its routing narrowing are typed out separately they drift, and
// the drift is invisible until a query routes one way and is labelled another.

/** Jurisdiction tokens as they appear in a comparison. Short forms stay case-sensitive. */
const JURIS_TOKEN = "NSW|VIC|QLD|WA|SA|TAS|NT|ACT|Cth|Vic|Qld|Tas"
const JURIS_WORD =
  "New South Wales|Victoria|Victorian|Queensland|Western Australia|South Australia|Tasmania|Northern Territory|Commonwealth|federal"

/** `NSW vs Cth`, `Queensland compared with the Commonwealth`. Both orders, bounded gap. */
const JURISDICTION_VS = new RegExp(
  `\\b(?:${JURIS_TOKEN}|${JURIS_WORD})\\b[^]{0,20}?\\b(?:vs\\.?|versus|and|compared\\s+(?:to|with))\\b[^]{0,20}?\\b(?:${JURIS_TOKEN}|${JURIS_WORD})\\b`,
)

/** Penalty *words*. Broad enough to label, far too broad to route on — see PENALTY_ROUTE. */
const PENALTY_ACTION = "penalt(?:y|ies)|fine|fines|infringement|sanction|pecuniary\\s+penalty|civil\\s+penalty"

/**
 * Routing needs a penalty word **and** a quantum question.
 *
 * The reference implementation learned this the hard way: routing on the bare
 * word sent every "X penalty <state>" research question into a penalty
 * analysis, losing the cases and the procedure the asker actually wanted.
 */
const PENALTY_ROUTE = [
  new RegExp(`\\b(?:maximum|max|highest)\\s+(?:${PENALTY_ACTION})\\b`, "i"),
  // `units?` is deliberately absent from the quantum list: "penalty unit" is
  // the name of the statutory concept, not a question about how big a fine is,
  // and swallowing it here takes the definition lookup away from terminology.
  new RegExp(`\\b(?:${PENALTY_ACTION})\\b[^]{0,25}?\\b(?:how\\s+much|amount|range|scale|quantum)\\b`, "i"),
  new RegExp(`\\bhow\\s+much\\b[^]{0,25}?\\b(?:${PENALTY_ACTION})\\b`, "i"),
  new RegExp(`\\bwhat\\s+(?:is|are)\\s+the\\s+(?:${PENALTY_ACTION})\\b`, "i"),
  /\bpenalty\s+units?\b[^]{0,25}?\b(?:worth|value|equal|dollars?|\$)/i,
]

/** Customs *area* words. Alone they hijack procedure and dispute questions, so routing narrows. */
const CUSTOMS_AREA = "customs|import|imports|importing|export|exports|exporting|tariff|excise|duty\\s+rate"
const CUSTOMS_ROUTE = [
  new RegExp(`\\b(?:${CUSTOMS_AREA})\\b[^]{0,30}?\\b(?:requirement|requirements|obligation|clearance|declaration|classification|concession)\\b`, "i"),
  /\bHS\s+code\b/i,
  /\btariff\s+classification\b/i,
]

/** Procedure words. `routeTriggers` demands a "how do I actually do it" shape. */
const PROCEDURE_ROUTE = [
  /\bhow\s+(?:do|can|would)\s+(?:i|we|you)\b[^]{0,40}?\b(?:apply|applies|lodge|file|register|object|appeal|claim|challenge|serve|renew)\b/i,
  /\b(?:application|lodgement|lodgment|filing|registration)\s+(?:process|procedure|fee|fees|steps?|requirements?)\b/i,
  /\b(?:fee|fees)\s+(?:schedule|payable|for\s+(?:filing|lodging|applying))\b/i,
  /\bwhat\s+forms?\b/i,
  /\bform\s+of\s+an?\b/i,
  /\bsteps?\s+to\s+(?:apply|lodge|file|register)\b/i,
]

/**
 * "Am I covered / do I qualify" — the eligibility gate, which is an
 * `action_basis` question even though no penalty word appears in it.
 */
const ELIGIBILITY_ROUTE = [
  /\bunfair\s+dismissal\b/i,
  /\b(?:am|are)\s+(?:i|we|they)\s+(?:eligible|entitled|covered|protected)\b/i,
  /\b(?:eligibility|entitlement)\s+(?:for|to|criteria)\b/i,
  /\bminimum\s+employment\s+period\b/i,
  /\bdo\s+(?:i|we|they)\s+(?:qualify|have\s+a\s+claim)\b/i,
]

const TIME_TRAVEL_TWO_POINTS = [
  // "2015 vs 2020", "the 2018 and 2024 versions"
  /\b(?:1[89]|20)\d{2}\b\s*(?:vs\.?|versus|↔|~|and|to)\s*\b(?:1[89]|20)\d{2}\b[^]{0,30}?\b(?:version|versions|compilation|compilations|compare|comparison|difference|differences|changed)\b/i,
  /\b(?:compare|comparison\s+of)\b[^]{0,40}?\bversions?\b/i,
  /\btime\s+travel\b/i,
  /\bbetween\s+(?:the\s+)?(?:1[89]|20)\d{2}\s+and\s+(?:the\s+)?(?:1[89]|20)\d{2}\s+(?:versions?|compilations?)\b/i,
]

/**
 * Declaration order is the tie-break inside a precedence band, so it is part
 * of the specification: `compliance` before `time_travel` at 4, `law_system`
 * before `document_review` before `dispute` at 6.
 */
const DECLARED_RULES: ScenarioRule[] = [
  {
    scenario: "compliance",
    task: "state_law_compare",
    precedence: 4,
    patterns: [
      JURISDICTION_VS,
      /\b(?:inconsistent|inconsistency|covering\s+the\s+field|harmonised|harmonized|model\s+law|uniform\s+legislation)\b/i,
      /\bsame\s+in\s+(?:every|each|another|other)\s+(?:state|territory|jurisdiction)\b/i,
    ],
    // The labelling words alone ("harmonised", "uniform") describe half of
    // Australian regulatory law; routing needs two jurisdictions in view.
    routeTriggers: [
      JURISDICTION_VS,
      /\binconsistent\s+with\s+(?:the\s+)?(?:Commonwealth|Cth|federal)\b/i,
      /\bcovering\s+the\s+field\b/i,
      /\bsame\s+in\s+(?:every|each|another|other)\s+(?:state|territory|jurisdiction)\b/i,
    ],
  },
  {
    scenario: "time_travel",
    task: "amendment_track",
    precedence: 4,
    patterns: [
      ...TIME_TRAVEL_TWO_POINTS,
      /\bbefore\s+and\s+after\b/i,
      /\bwhat\s+changed\b/i,
    ],
    routeTriggers: TIME_TRAVEL_TWO_POINTS,
  },
  {
    scenario: "law_system",
    task: "law_system",
    precedence: 6,
    patterns: [
      /\blaw\s+system\b/i,
      /\blegislative\s+(?:scheme|hierarchy|structure|framework)\b/i,
      /\bstatutory\s+(?:scheme|framework)\b/i,
      /\bhow\s+(?:does|do)\b[^]{0,40}?\bfit\s+together\b/i,
      /\bstructure\s+of\s+the\b/i,
    ],
    routeTriggers: [
      /\blaw\s+system\b/i,
      /\blegislative\s+(?:scheme|hierarchy|structure|framework)\b/i,
      /\bstatutory\s+(?:scheme|framework)\b/i,
      /\bhow\s+(?:does|do)\b[^]{0,40}?\bfit\s+together\b/i,
    ],
  },
  {
    scenario: "document_review",
    task: "document_review",
    precedence: 6,
    patterns: [
      /\breview\s+(?:this|my|the\s+following|these)\b[^]{0,40}?\b(?:contract|agreement|clause|clauses|deed|lease|letter|advice|draft|terms)\b/i,
      /\b(?:contract|agreement|document)\s+review\b/i,
      /\bunfair\s+terms?\s+in\s+(?:this|my|our)\b/i,
      /\bcheck\s+(?:this|my)\s+(?:contract|agreement|lease|deed)\b/i,
    ],
    routeTriggers: [
      /\breview\s+(?:this|my|the\s+following|these)\b[^]{0,40}?\b(?:contract|agreement|clause|clauses|deed|lease|letter|advice|draft|terms)\b/i,
      /\b(?:contract|agreement|document)\s+review\b/i,
      /\bcheck\s+(?:this|my)\s+(?:contract|agreement|lease|deed)\b/i,
    ],
  },
  {
    scenario: "dispute",
    task: "dispute_prep",
    precedence: 6,
    patterns: [
      /\bdispute\s+prep(?:aration)?\b/i,
      /\blitigation\s+(?:strategy|risk|prospects)\b/i,
      /\bprepare\s+(?:for\s+)?(?:a\s+)?(?:dispute|hearing|case|proceeding)\b/i,
      /\bwho\s+(?:else\s+)?hears\b/i,
      /\bcause\s+of\s+action\b/i,
    ],
    routeTriggers: [
      /\bdispute\s+prep(?:aration)?\b/i,
      /\blitigation\s+(?:strategy|risk|prospects)\b/i,
      /\bprepare\s+(?:for\s+)?(?:a\s+)?(?:dispute|hearing|case|proceeding)\b/i,
      /\bcause\s+of\s+action\b/i,
    ],
  },
  {
    scenario: "delegation",
    task: "law_system",
    precedence: 7,
    patterns: [
      /\bdelegated\s+legislation\b/i,
      /\bregulation[- ]making\s+power\b/i,
      /\benabling\s+provision\b/i,
      /\bhenry\s+viii\s+clause\b/i,
      /\bsubordinate\s+legislation\b/i,
    ],
    routeTriggers: [
      /\bdelegated\s+legislation\b/i,
      /\bregulation[- ]making\s+power\b/i,
      /\benabling\s+provision\b/i,
      /\bsubordinate\s+legislation\b/i,
    ],
  },
  {
    scenario: "impact",
    task: "law_system",
    // Same band as delegation; declared after it, so a query naming both is
    // labelled `delegation` — the more specific of the two.
    precedence: 7,
    patterns: [
      /\bconsequential\s+amendments?\b/i,
      /\bflow[- ]on\s+effects?\b/i,
      /\bknock[- ]on\b/i,
      /\bimpact\s+(?:analysis|of\s+the\s+amendments?)\b/i,
      /\bripple\s+effects?\b/i,
    ],
    routeTriggers: [
      /\bconsequential\s+amendments?\b/i,
      /\bflow[- ]on\s+effects?\b/i,
      /\bimpact\s+(?:analysis|of\s+the\s+amendments?)\b/i,
    ],
  },
  {
    scenario: "customs",
    task: "full_research",
    precedence: 8,
    patterns: [
      new RegExp(`\\b(?:${CUSTOMS_AREA})\\b`, "i"),
      /\bHS\s+code\b|\btariff\s+classification\b|\bfree\s+trade\s+agreement\b|\brules?\s+of\s+origin\b/i,
    ],
    routeTriggers: CUSTOMS_ROUTE,
  },
  {
    scenario: "procedure",
    task: "procedure_detail",
    precedence: 10,
    patterns: [
      /\bprocedure|\bprocess\b|\bhow\s+do\s+i\b|\bfees?\b|\bforms?\b|\blodge|\btime\s+limits?\b|\bdeadlines?\b/i,
    ],
    routeTriggers: PROCEDURE_ROUTE,
  },
  {
    scenario: "penalty",
    task: "action_basis",
    precedence: 11,
    patterns: [new RegExp(`\\b(?:${PENALTY_ACTION})\\b|\\benforcement\\s+action\\b|\\bcontravention\\b`, "i")],
    routeTriggers: PENALTY_ROUTE,
  },
  {
    scenario: "eligibility",
    task: "action_basis",
    // Same band as penalty, declared after it: a query with both a quantum
    // question and an eligibility gate is about the penalty.
    precedence: 11,
    patterns: [
      ...ELIGIBILITY_ROUTE,
      /\bgrounds?\s+for\b/i,
      /\bwhat\s+(?:power|authority)\b/i,
    ],
    routeTriggers: ELIGIBILITY_ROUTE,
  },
  {
    scenario: "action_plan",
    task: "full_research",
    precedence: 12,
    patterns: [
      /\bcan\s+(?:i|we|they)\b/i,
      /\bwhat\s+(?:can|should)\s+(?:i|we|they)\s+do\b/i,
      /\bmy\s+rights\b/i,
      /\bwhat\s+are\s+my\s+options\b/i,
      /\bam\s+i\s+allowed\b/i,
    ],
    routeTriggers: [
      /\bcan\s+(?:i|we|they)\b/i,
      /\bwhat\s+(?:can|should)\s+(?:i|we|they)\s+do\b/i,
      /\bmy\s+rights\b/i,
      /\bwhat\s+are\s+my\s+options\b/i,
    ],
  },
]

/** Precedence order. `Array.prototype.sort` is stable, so declaration order survives ties. */
export const SCENARIO_RULES: readonly ScenarioRule[] = [...DECLARED_RULES].sort(
  (a, b) => a.precedence - b.precedence,
)

/** The rules the router may use to choose a tool, in precedence order. */
export const ROUTABLE_SCENARIO_RULES: readonly ScenarioRule[] = SCENARIO_RULES.filter(
  (rule) => rule.routeTriggers !== null,
)

/** Every task a scenario can run as, deduplicated — a test pins these to real tools. */
export const SCENARIO_TASKS: readonly ResearchTask[] = [...new Set(SCENARIO_RULES.map((r) => r.task))]

/** Every chain a scenario can reach, deduplicated. */
export const SCENARIO_HOST_CHAINS: readonly string[] = [
  ...new Set(SCENARIO_RULES.map((r) => TASK_TO_CHAIN[r.task])),
]

/**
 * Which scenario is this query, given the task that is about to run?
 *
 * The task argument is what keeps the answer stable across surfaces: the same
 * `(query, task)` pair always produces the same scenario, so the CLI's label
 * and the chain's own label cannot diverge.
 */
export function detectScenarioName(query: string, task: ResearchTask): ScenarioName | null {
  for (const rule of SCENARIO_RULES) {
    if (rule.task !== task) continue
    if (rule.patterns.some((pattern) => pattern.test(query))) return rule.scenario
  }
  return null
}

/**
 * Does this query fire a named scenario's *routing* vocabulary?
 *
 * Exposed so a pattern that must defer to a scenario ("the ART" in "how do I
 * apply to the ART") can ask the scenario itself rather than keeping a second
 * copy of its words.
 */
export function scenarioRoutes(query: string, scenario: ScenarioName): boolean {
  return SCENARIO_RULES.some(
    (rule) => rule.scenario === scenario && (rule.routeTriggers ?? []).some((p) => p.test(query)),
  )
}

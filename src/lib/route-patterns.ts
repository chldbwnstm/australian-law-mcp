/**
 * The routing table — which English sentence reaches which tool.
 *
 * This file is *data*. The matching engine is `query-router.ts`, the value
 * extractors are `query-extract.ts`, and the scenario vocabulary is
 * `scenario-rules.ts`. Keeping the three apart is what lets a routing decision
 * be reviewed as a decision instead of as control flow.
 *
 * Two mechanisms carry most of the weight:
 *
 *  - **`priority`** orders the table. Lower runs first; ties break on
 *    declaration order, which is therefore part of the specification.
 *  - **`yieldsTo`** is how a high-priority pattern steps aside for a trailing
 *    intent. "CCA s 46" is a provision lookup; "CCA s 46 cases" is a citation
 *    graph, and if the provision pattern simply wins, the word "cases" is lost
 *    with no trace. The guard names the *receiving pattern* and the engine
 *    evaluates that pattern's own regexes — the guard vocabulary is never
 *    copied here, because a copy goes stale the first time the receiver
 *    learns a new word and nobody remembers there was a second list.
 *
 * Regex safety, inherited from the reference implementation and paid for
 * there:
 *
 *  - Every quantifier is bounded. These patterns run over pasted documents.
 *  - No pattern begins with a lazy `(.+?)`. Against a trailing anchor that
 *    backtracks quadratically, and the capture is never read — names and
 *    provisions are extracted separately.
 *  - Two-word co-occurrence uses an explicit `[^]{0,N}?` gap, declared in both
 *    word orders, rather than `.*`.
 *  - Word-boundary guards (or explicit character lookarounds where `\b` is
 *    wrong at a `)` edge) on everything, so a trigger word cannot be found
 *    inside a longer word.
 */

import { REPORT_SERIES } from "./report-series.js"
import { escapeRegex } from "./escape-regex.js"
import {
  ACT_NAME_DETECT,
  FRL_TITLE_ID_RE,
  LONG_ALIAS_DETECT,
  PROVISION_HINT_RE,
  SHORT_ALIAS_DETECT,
  extractDates,
  extractDomainHint,
  extractJurisdictions,
  extractProvisions,
  firstProvision,
  firstMnc,
  extractCitations,
  isBareTermQuery,
  pointInTimeDate,
  primaryLawMention,
  provisionParam,
  searchExtract,
  statePreference,
  stateRegisterToken,
  stripQuestionNoise,
  type LawMention,
} from "./query-extract.js"
import { ROUTABLE_SCENARIO_RULES, TASK_TO_CHAIN } from "./scenario-rules.js"

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** A tool the caller might have meant instead — offered, never run. */
export interface RouteAlternate {
  tool: string
  params: Record<string, unknown>
  why: string
}

/** A follow-up call. `standalone` steps have complete parameters already. */
export interface PipelineStep {
  tool: string
  params: Record<string, unknown>
  /** Run even when no identifier could be lifted from the first result. */
  standalone?: boolean
}

/**
 * What an extractor returns: the tool's parameters, plus control flags the
 * engine strips before anything is called.
 */
export interface ExtractResult extends Record<string, unknown> {
  /** This pattern matched but the query is not its case — try the next one. */
  _skip?: boolean
  /** The intent is right but a required value is missing — fall back to research. */
  _fallback?: boolean
  /** Same intent, different tool. */
  _reroute?: string
  /** A question to put to the caller before trusting the answer. */
  _clarify?: string
  _alternates?: RouteAlternate[]
  _pipeline?: PipelineStep[]
}

export interface Pattern {
  name: string
  /** OR-ed. The first to match wins; the match object goes to `extract`. */
  patterns: RegExp[]
  tool: string
  extract: (query: string, match: RegExpMatchArray) => ExtractResult
  reason: string
  /** Lower runs first. Ties break on declaration order. */
  priority: number
  /** Patterns this one defers to when they would take the query. */
  yieldsTo?: string[]
}

// ──────────────────────────────────────────────────────────────────────────
// Shared pattern fragments
// ──────────────────────────────────────────────────────────────────────────

/**
 * Report-series citations without a bracketed year: `175 CLR 1`.
 *
 * Built from the series table so a new series becomes routable where it is
 * defined. Longest-first, because `Qd R`, `A Crim R` and `Tas R` contain
 * spaces and a shorter alternative would match their tail.
 */
const SERIES_ALTERNATION = [...new Set(REPORT_SERIES.map((s) => s.abbrev))]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegex)
  .join("|")

const BARE_REPORT_CITATION = new RegExp(
  `(?<![\\w\\[(])\\d{1,4}\\s{1,3}(?:${SERIES_ALTERNATION})\\s{1,3}\\d{1,5}(?!\\d)`,
)

/**
 * ATO product codes. The year/number tail is required — without it `TR`, `CR`
 * and `IT` are ordinary words and every sentence containing "it" becomes a
 * ruling lookup.
 */
const RULING_CODE_RE =
  /(?<![A-Za-z])(?:ATO\s?ID|PS\s?LA|GSTR|GSTD|GSTB|WETR|LCR|PCG|SGR|SGD|FTR|TR|TD|MT|CR|PR|IT|TA)\s?\d{4}\/\d{1,4}(?!\d)/i

/** `s 51(xx)` — a head of Commonwealth legislative power, and never a section of an Act called "xx". */
const CONSTITUTIONAL_POWER_RE = /(?<![A-Za-z])s(?:ection)?\s?51\s?\(\s?[ivxlcdm]{1,6}\s?\)/i

const CONSTITUTION_RE = /(?<![A-Za-z])constitution(?![a-z])/i

const CTH_CONSTITUTION = "Commonwealth of Australia Constitution Act"

// ──────────────────────────────────────────────────────────────────────────
// Extractor helpers
// ──────────────────────────────────────────────────────────────────────────

/** `search_law` and the chains want at least two characters. */
function nonEmpty(text: string, fallback: string): string {
  const trimmed = text.trim()
  return trimmed.length >= 2 ? trimmed : fallback.trim()
}

/** Attach the first provision, canonicalised against the named statute. */
function withProvision(
  params: Record<string, unknown>,
  query: string,
  mention: LawMention | undefined,
  key = "provision",
): Record<string, unknown> {
  const refs = extractProvisions(query)
  if (refs[0]) params[key] = provisionParam(refs[0], mention)
  return params
}

/** Several jurisdictions answer to this name and the query did not say which. */
function jurisdictionClarify(mention: LawMention): string | undefined {
  if (!mention.needsJurisdiction || mention.otherJurisdictions.length === 0) return undefined
  return (
    `"${mention.raw}" exists in more than one jurisdiction. Read as ${mention.jurisdiction ?? "the first"} ` +
    `— also enacted in ${mention.otherJurisdictions.join(", ")}. Say which if that is wrong.`
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Decision domains
// ──────────────────────────────────────────────────────────────────────────

/**
 * `search_decisions` domains as a table rather than eighteen near-identical
 * pattern entries.
 *
 * Order is the specification: `privacy` before `agency_rules` so an OAIC
 * *determination* is not read as an agency one, `gazettes` before
 * `competition` so "gazette notice appointing the ACCC chair" is a gazette
 * notice, `constitutional` before `cases`.
 */
interface DomainTrigger {
  domain: string
  patterns: RegExp[]
  /** Words to remove before the rest becomes the search term. */
  strip: RegExp
}

const DOMAIN_TRIGGERS: DomainTrigger[] = [
  {
    domain: "tax_tribunal",
    patterns: [
      /\bdecision\s+impact\s+statements?\b/i,
      /(?<![A-Za-z])DIS(?![A-Za-z])/,
      /(?<![A-Za-z])(?:AAT|ART)(?![A-Za-z])[^]{0,30}?\btax\b/i,
    ],
    strip: /\b(?:decision\s+impact\s+statements?|ATO)\b/gi,
  },
  {
    domain: "privacy",
    patterns: [
      /(?<![A-Za-z])OAIC(?![A-Za-z])/,
      /\bprivacy\s+(?:determinations?|decisions?|complaints?)\b/i,
      /\bnotifiable\s+data\s+breach(?:es)?\b/i,
      /\bAustralian\s+Privacy\s+Principles?\b/i,
    ],
    strip: /\b(?:OAIC|determinations?)\b/gi,
  },
  {
    domain: "workplace",
    patterns: [
      /(?<![A-Za-z])FWC(?![A-Za-z])/,
      /\bFair\s+Work\s+Commission\b/i,
      /\bunfair\s+dismissal\b[^]{0,40}?\bdecisions?\b/i,
      /\bdecisions?\b[^]{0,40}?\bunfair\s+dismissal\b/i,
      /\benterprise\s+agreement\s+approval\b/i,
    ],
    strip: /\b(?:FWC|Fair\s+Work\s+Commission|decisions?)\b/gi,
  },
  {
    domain: "integrity",
    patterns: [
      /(?<![A-Za-z])NACC(?![A-Za-z])/,
      /\bombudsman\b/i,
      /\bcorruption\b/i,
      /\bwhistleblow\w{0,6}\b/i,
      /\bpublic\s+interest\s+disclosures?\b/i,
    ],
    strip: /\b(?:reports?\s+on|reports?)\b/gi,
  },
  {
    domain: "public_service",
    patterns: [
      /\bMerit\s+Protection\b/i,
      /(?<![A-Za-z])MPC(?![A-Za-z])/,
      /(?<![A-Za-z])APS(?![A-Za-z])[^]{0,30}?\bcode\s+of\s+conduct\b/i,
      /\bcode\s+of\s+conduct\b[^]{0,40}?\bcase\s+stud(?:y|ies)\b/i,
      /\bcase\s+stud(?:y|ies)\b[^]{0,40}?\bcode\s+of\s+conduct\b/i,
    ],
    strip: /\b(?:Merit\s+Protection\s+Commissioner|Merit\s+Protection|case\s+stud(?:y|ies))\b/gi,
  },
  {
    domain: "customs",
    patterns: [
      /\banti[- ]?dumping\b/i,
      /\bdumping\s+(?:review|duty|duties|inquiry|investigation)\b/i,
      /\bcountervailing\b/i,
      /(?<![A-Za-z])ADRP(?![A-Za-z])/,
      /\btariff\s+concession\b/i,
      /\bcustoms\s+(?:ruling|decision|tariff)\b/i,
    ],
    strip: /\b(?:review|reviews)\b/gi,
  },
  {
    domain: "gazettes",
    patterns: [/\bgazettes?\b/i, /\bgazettal\b/i],
    strip: /\b(?:gazette|gazettes|gazettal|notices?)\b/gi,
  },
  {
    domain: "competition",
    patterns: [
      /(?<![A-Za-z])ACCC(?![A-Za-z])[^]{0,30}?\b(?:decisions?|determinations?|authorisations?)\b/i,
      /\bCompetition\s+Tribunal\b/i,
      /\bcartel\s+(?:cases?|decisions?|proceedings?)\b/i,
    ],
    strip: /\b(?:decisions?|determinations?)\b/gi,
  },
  {
    domain: "agency_rules",
    patterns: [
      /\bnotifiable\s+instruments?\b/i,
      /\b(?:staff|agency|remuneration)\s+determinations?\b/i,
      /(?<![A-Za-z])(?:CSIRO|APRA|ASIC|ATO|APS)(?![A-Za-z])[^]{0,25}?\bdeterminations?\b/i,
    ],
    strip: /\b(?:notifiable\s+instruments?)\b/gi,
  },
  {
    domain: "university_rules",
    patterns: [
      /\bunivers\w{0,4}\b[^]{0,40}?\b(?:by-?laws?|rules?|statutes?)\b/i,
      /\b(?:by-?laws?|rules?|statutes?)\b[^]{0,30}?\bunivers\w{0,4}\b/i,
    ],
    strip: /\b(?:by-?laws?)\b/gi,
  },
  {
    domain: "admin_appeals",
    patterns: [
      /(?<![A-Za-z])(?:NCAT|QCAT|VCAT|SACAT|SAT|ART|AAT)(?![A-Za-z])/,
      /\btribunal\s+decisions?\b/i,
      /\bmerits\s+review\b/i,
      /\badministrative\s+review\s+tribunal\b/i,
    ],
    strip: /\b(?:decisions?|decision\s+about)\b/gi,
  },
  {
    domain: "constitutional",
    patterns: [
      /\bconstitutional\b/i,
      /\bimplied\s+freedom\b/i,
      /\bhigh\s+court\b[^]{0,40}?\bconstitutional\b/i,
    ],
    strip: /\b(?:cases?|judgments?)\b/gi,
  },
  {
    domain: "cases",
    patterns: [
      /\bhigh\s+court\b/i,
      /\bjudgments?\b/i,
      /\bcase\s+law\b/i,
      /\blatest\b[^]{0,30}?\b(?:judgment|judgement|decision)\b/i,
    ],
    strip: /\b(?:judgments?|judgements?|case\s+law)\b/gi,
  },
]

/**
 * Every domain pattern defers to the procedure scenario.
 *
 * "how do I apply to the ART for a tax review" names a tribunal, but the
 * question is how to lodge, not what the tribunal has decided. The guard names
 * the scenario and the engine evaluates that scenario's own triggers, so
 * widening the procedure vocabulary widens this guard with it.
 */
const domainPatterns: Pattern[] = DOMAIN_TRIGGERS.map((trigger) => ({
  name: `decision_${trigger.domain}`,
  patterns: trigger.patterns,
  tool: "search_decisions",
  extract: (query: string): ExtractResult => ({
    domain: trigger.domain,
    query: nonEmpty(stripQuestionNoise(searchExtract(trigger.strip)(query)), query),
  }),
  reason: `decision-body vocabulary → search_decisions(domain="${trigger.domain}")`,
  priority: 5,
  yieldsTo: ["scenario_procedure"],
}))

// ──────────────────────────────────────────────────────────────────────────
// The table
// ──────────────────────────────────────────────────────────────────────────

/**
 * Patterns a provision lookup must step aside for.
 *
 * Named, not described: every one of these is a pattern that legitimately
 * takes a query containing a section number, and without the guard the
 * provision lookup at priority 1 would swallow all of them.
 */
const PROVISION_YIELDS_TO = [
  "ruling_code",
  "register_id",
  "instrument_id",
  "explanatory",
  "cite_check",
  "verify_citations",
  "abbreviation",
  "discover_tools_request",
  "constitutional_power",
  "constitution_provision",
  "three_tier",
  "instrument_radar",
  "enabling_acts",
  "enabled_instruments",
  "state_equivalents",
  "applicable_law",
  "compare_old_new",
  "provision_history",
  "impact_map",
  "schedules",
  "treaty",
  "report_citation",
  "amendment_track",
  "state_law",
  "case_search",
  "term_detail",
  "term_kb",
  "scenario_document_review",
  "scenario_compliance",
  "scenario_time_travel",
]

/**
 * Patterns a bare Act-name lookup must step aside for.
 *
 * Nearly every query below names an Act as well: "law system around the EPBC
 * Act" would be a title search if this list were missing, and the question
 * would go unanswered while a plausible-looking result came back.
 */
const EXPLICIT_LAW_YIELDS_TO = [
  "amendment_track",
  "law_history",
  "provision_history",
  "compare_old_new",
  "applicable_law",
  "impact_map",
  "schedules",
  "three_tier",
  "instrument_radar",
  "enabling_acts",
  "enabled_instruments",
  "state_equivalents",
  "explanatory",
  "term_kb",
  "term_detail",
  "state_law",
  "aao",
  "law_search_request",
  "scenario_law_system",
  "scenario_document_review",
  "scenario_dispute",
  "scenario_compliance",
  "scenario_procedure",
  "scenario_delegation",
  "scenario_impact",
  "scenario_eligibility",
  "scenario_penalty",
  "scenario_customs",
  "scenario_action_plan",
]

const routePatterns: Pattern[] = [
  // ── priority 1 — the three things that must be seen before anything else ──

  {
    name: "discover_tools_request",
    patterns: [
      /\bwhat\s+tools?\b/i,
      /\bwhich\s+tools?\b/i,
      /\bwhat\s+(?:should|can|do)\s+i\s+use\b/i,
      /\bhow\s+do\s+i\s+(?:use|find)\b[^]{0,30}?\btools?\b/i,
    ],
    tool: "discover_tools",
    extract: (query) => ({ intent: nonEmpty(stripQuestionNoise(query), query) }),
    reason: "asking about the toolset itself → discover_tools",
    priority: 1,
  },

  {
    // Declared before `specific_provision`, at the same priority, so a title
    // the Act no longer carries is caught before the section is looked up
    // under today's numbering. "TPA s 52" is not CCA s 52.
    name: "superseded_law",
    patterns: [
      // The alternation comes from the alias table's own notes — see
      // query-extract. A hand-kept list here would miss the next rename.
      /(?<![A-Za-z0-9])(?:TPA|Trade\s+Practices\s+Act)(?![A-Za-z0-9])/i,
    ],
    tool: "search_law",
    extract: (query) => {
      const mention = primaryLawMention(query)
      if (!mention?.superseded) return { _skip: true }
      const date = pointInTimeDate(query)
      const alternates: RouteAlternate[] = [
        {
          tool: "applicable_law",
          params: {
            lawName: mention.raw,
            date: date ?? "the date the conduct happened",
            ...withProvision({}, query, mention),
          },
          why: `"${mention.raw}" is a former name of ${mention.name}. A provision cited under the old name usually belongs to the old text — check it as at the relevant date rather than reading today's section of the same number.`,
        },
      ]
      return {
        query: mention.raw,
        _alternates: alternates,
        _clarify:
          `"${mention.raw}" is the former name of ${mention.name} (same Register title, renamed — not repealed). ` +
          `Section numbers moved: check the point-in-time text before quoting one.`,
      }
    },
    reason: "former statute name → search_law, with a point-in-time alternate",
    priority: 1,
    yieldsTo: [
      "applicable_law",
      "cite_check",
      "verify_citations",
      "amendment_track",
      "provision_history",
      "compare_old_new",
      "impact_map",
      "schedules",
      "explanatory",
      "term_kb",
      "term_detail",
      "scenario_time_travel",
    ],
  },

  {
    name: "specific_provision",
    // A cheap prefilter, not the grammar: `extract` runs the real reference
    // parser and skips when it finds nothing.
    patterns: [PROVISION_HINT_RE],
    tool: "get_law_text",
    extract: (query) => {
      const refs = extractProvisions(query)
      if (refs.length === 0) return { _skip: true }
      const mention = primaryLawMention(query)
      // No Act named. Guessing one is how a pasted letter's "s 18" becomes a
      // confident answer about whichever statute the table happened to return.
      if (!mention || mention.body) return { _skip: true }

      const provision = provisionParam(refs[0], mention)
      // A regulation number belongs to an instrument, not to an Act: FRL keeps
      // instrument text under a different endpoint, and asking get_law_text for
      // "reg 1.07" of the Fair Work Regulations returns nothing at all.
      if (refs[0].kind === "regulation") {
        return { _reroute: "get_instrument_provisions", query: mention.name, provision }
      }

      const params: Record<string, unknown> = { query: mention.name, provision }
      const clarify = jurisdictionClarify(mention)
      const alternates: RouteAlternate[] = []
      if (mention.sch) {
        alternates.push({
          tool: "get_law_text",
          params: { query: mention.name, provision: provisionParam(refs[0], undefined) },
          why: `${mention.raw} is schedule ${mention.sch} of ${mention.name}, so the reference was read as "${provision}". The body of the Act has its own section of that number, and it is a different provision.`,
        })
      }
      // "ss 18 and 29 of the ACL" is two calls. Deduplicated, because the same
      // number written twice ("s 18 of the ACL vs CCA s 18") is one provision
      // once the schedule prefix has been applied to both.
      const extra = [...new Set(refs.slice(1).map((ref) => provisionParam(ref, mention)))].filter(
        (value) => value !== provision,
      )
      if (extra.length > 0) params._extraProvisions = extra
      return {
        ...params,
        ...(clarify ? { _clarify: clarify } : {}),
        ...(alternates.length ? { _alternates: alternates } : {}),
      }
    },
    reason: "statute name + provision reference → get_law_text",
    priority: 1,
    yieldsTo: PROVISION_YIELDS_TO,
  },

  // ── priority 2 — identifiers and citation work ──

  {
    name: "ruling_code",
    patterns: [RULING_CODE_RE],
    tool: "get_ruling_text",
    extract: (query, match) => {
      const code = match[0].replace(/\s+/g, " ").trim()
      // The code carries a year of its own — `TR 2024/1` is not a question
      // about 2024 — so it is blanked before the date is read. Without this
      // every ruling lookup acquires a point-in-time it was never given.
      const withoutCode = query.replace(match[0], " ".repeat(match[0].length))
      const params: Record<string, unknown> = { id: code }
      // The ATO keeps its own point-in-time index, separate from the Register's
      // compilation series — "as at" on a ruling is `asAt`, never applicable_law.
      const date = pointInTimeDate(withoutCode)
      if (date) params.asAt = date
      return params
    },
    reason: "ATO product code → get_ruling_text",
    priority: 2,
  },

  {
    name: "register_id",
    patterns: [/(?<![A-Za-z0-9])(C\d{4}[A-Z]\d{5})(?![A-Za-z0-9])/],
    tool: "get_law_text",
    extract: (query, match) => withProvision({ registerId: match[1] }, query, primaryLawMention(query)),
    reason: "Federal Register Act id → get_law_text",
    priority: 2,
  },

  {
    name: "explanatory",
    patterns: [
      /\bexplanatory\s+(?:memorand(?:um|a)|statements?|materials?)\b/i,
      /(?<![A-Za-z])EM\s+for\b/,
      /(?<![A-Za-z])(?:EM|ES)(?![A-Za-z])[^]{0,20}?\bfor\s+the\b/,
      /\bsecond\s+reading\s+speech\b/i,
      /\bextrinsic\s+materials?\b/i,
    ],
    tool: "search_explanatory",
    extract: (query) => {
      const id = FRL_TITLE_ID_RE.exec(query)
      // A Register id addresses the explanatory document directly; searching
      // for it by title words would go through a title match that may not exist.
      if (id) return { _reroute: "get_explanatory_text", id: id[1] }
      const stripped = searchExtract(
        /\b(?:explanatory\s+(?:memorand(?:um|a)|statements?|materials?)|second\s+reading\s+speech|extrinsic\s+materials?|EM|ES)\b/gi,
      )(query)
      return { query: nonEmpty(stripQuestionNoise(stripped), query) }
    },
    reason: "explanatory material → search_explanatory / get_explanatory_text",
    priority: 2,
  },

  {
    name: "cite_check",
    patterns: [
      /\bstill\s+(?:good\s+law|cited|authority|binding)\b/i,
      /\bgood\s+law\b/i,
      /\b(?:overruled|overturned|disapproved|doubted|distinguished)\b/i,
      /\bno\s+longer\s+(?:good\s+law|authority)\b/i,
      /\bwho\s+(?:has\s+)?cited\b/i,
      /\b(?:citator|noting\s+up|shepardi[sz]e)\b/i,
      /\bhas\b[^]{0,40}?\bbeen\s+(?:overruled|followed|applied)\b/i,
    ],
    tool: "cite_check",
    extract: (query) => {
      const mnc = firstMnc(query)
      if (mnc) return { caseNumber: mnc.raw }
      const parsed = extractCitations(query).find((result) => result.ok)
      if (parsed?.ok) return { caseNumber: parsed.citation.raw }
      // No parseable citation. The tool takes "a sentence containing one", so
      // a case named only by party ("has Mabo been overruled") still works —
      // and refusing it here would answer a citator question with a title search.
      const text = query.trim()
      return text.length >= 3 ? { caseNumber: text } : { _fallback: true }
    },
    reason: "citator vocabulary → cite_check",
    priority: 2,
  },

  {
    name: "verify_citations",
    patterns: [
      /\bverify\b[^]{0,25}?\b(?:citations?|cites?|references?)\b/i,
      /\bcheck\b[^]{0,25}?\b(?:citations?|cites?|references?)\b/i,
      /\b(?:citations?|cites?)\b[^]{0,25}?\b(?:verify|check|correct|accurate|real|genuine)\b/i,
      /\bdoes\b[^]{0,60}?\bexist\b/i,
      /\bhallucinat\w{0,4}\b/i,
      /\bmade\s+up\b/i,
      /\bare\s+these\s+(?:citations?|cites?|references?)\b/i,
      /\bis\s+this\s+(?:citation|cite|reference)\b/i,
    ],
    tool: "verify_citations",
    extract: (query) => ({ text: query }),
    reason: "citation-verification request → verify_citations",
    priority: 2,
  },

  {
    name: "abbreviation",
    patterns: [
      /\babbreviations?\b/i,
      /\bwhat\s+does\b[^]{0,25}?\bstand\s+for\b/i,
      /\bshort\s+for\b/i,
    ],
    tool: "get_law_abbreviations",
    extract: (query) => {
      const token = /(?<![A-Za-z])([A-Z]{2,8}(?:\s+Act)?)(?![A-Za-z])/.exec(query)
      return token ? { resolve: token[1] } : { filter: nonEmpty(stripQuestionNoise(query), query) }
    },
    reason: "abbreviation lookup → get_law_abbreviations",
    priority: 2,
  },

  // ── priority 3 — structural relationships and named identifiers ──

  {
    name: "constitutional_power",
    patterns: [CONSTITUTIONAL_POWER_RE],
    tool: "get_law_text",
    extract: (query, match) => ({
      query: CTH_CONSTITUTION,
      // Canonicalised through the reference parser rather than by hand: the
      // roman placitum is a subsection, and only the grammar knows how AGLC
      // writes it back out.
      provision: firstProvision(match[0], undefined) ?? match[0].replace(/\s+/g, " ").trim(),
      _clarify:
        "Read as a head of power in s 51 of the Australian Constitution. A roman numeral in brackets after s 51 " +
        "is a placitum, not a subsection of an Act called by that numeral.",
    }),
    reason: "s 51 placitum → the Australian Constitution",
    priority: 3,
  },

  {
    name: "constitution_provision",
    patterns: [CONSTITUTION_RE],
    tool: "get_law_text",
    extract: (query) => {
      const refs = extractProvisions(query)
      if (refs.length === 0) return { _skip: true }
      return {
        query: CTH_CONSTITUTION,
        provision: provisionParam(refs[0], undefined),
        _alternates: [
          {
            tool: "search_decisions",
            params: { domain: "constitutional", query: stripQuestionNoise(query) },
            why: "Constitutional provisions are usually asked about through the cases that construe them; the High Court's constitutional judgments are a separate search.",
          },
        ],
        _clarify:
          "The covering clauses of the Commonwealth of Australia Constitution Act are numbered separately from the " +
          "Constitution itself: covering clause 9 is not s 9, and s 109 is inside the Constitution.",
      }
    },
    reason: "the Constitution + a provision → get_law_text on the Constitution",
    priority: 3,
  },

  {
    name: "instrument_id",
    patterns: [/(?<![A-Za-z0-9])(F\d{4}[A-Z]\d{5})(?![A-Za-z0-9])/],
    tool: "get_instrument_provisions",
    extract: (query, match) =>
      withProvision(
        {
          registerId: match[1],
          _alternates: [
            {
              tool: "search_law",
              params: { query: match[1] },
              why: "An F-prefixed identifier is a Federal Register title id for a legislative instrument, not a case citation. Search the Register if the outline is not what was wanted.",
            },
          ],
        },
        query,
        undefined,
      ),
    reason: "Federal Register instrument id → get_instrument_provisions",
    priority: 3,
  },

  {
    name: "three_tier",
    patterns: [/\bthree[- ]tiers?\b/i, /\bact\s*(?:→|->|>)\s*regulations?\b/i],
    tool: "get_three_tier",
    extract: (query) => {
      const mention = primaryLawMention(query)
      if (!mention) return { _fallback: true }
      return { query: mention.name }
    },
    reason: "Act → instruments → rules → get_three_tier",
    priority: 3,
  },

  {
    name: "instrument_radar",
    patterns: [
      /\bstale\b/i,
      /\bout\s+of\s+date\s+relative\b/i,
      /\bparent\s+act\b/i,
      /\bkept\s+(?:up\s+)?(?:pace\s+)?with\s+the\s+act\b/i,
    ],
    tool: "instrument_radar",
    extract: (query) => {
      const id = FRL_TITLE_ID_RE.exec(query)
      if (id) return { registerId: id[1] }
      const mention = primaryLawMention(query)
      if (mention) return { query: mention.name }
      const stripped = searchExtract(
        /\b(?:stale|out\s+of\s+date|relative\s+to|parent\s+act|this|check|whether)\b/gi,
      )(query)
      return {
        query: nonEmpty(stripQuestionNoise(stripped), query),
        _clarify:
          "Name the instrument to check — instrument_radar compares one instrument's last compilation against its " +
          "enabling Act, so it needs the instrument, not the Act.",
      }
    },
    reason: "instrument staleness vocabulary → instrument_radar",
    priority: 3,
  },

  {
    // Declared before `enabled_instruments`: "what Act authorises the Migration
    // Regulations" contains "under", and the other direction of the same
    // relationship would take it.
    name: "enabling_acts",
    patterns: [
      /\bwhat\s+act\b[^]{0,30}?\bauthoris\w{0,3}\b/i,
      /\bwhich\s+act\b[^]{0,30}?\b(?:authoris\w{0,3}|empowers?|enables?|makes?)\b/i,
      /\benabling\s+acts?\b/i,
      /\bmade\s+under\s+what\s+act\b/i,
    ],
    tool: "get_enabling_acts",
    extract: (query) => {
      const mention = primaryLawMention(query)
      if (!mention) return { _fallback: true }
      return { query: mention.name }
    },
    reason: "instrument → its enabling Act → get_enabling_acts",
    priority: 3,
  },

  {
    name: "enabled_instruments",
    patterns: [
      /\b(?:enabling|enabled)\s+instruments?\b/i,
      /\binstruments?\s+(?:made\s+)?under\b/i,
      /\bregulations?\s+made\s+under\b/i,
      /\bwhat\s+(?:instruments?|regulations?)\b[^]{0,30}?\bunder\b/i,
    ],
    tool: "get_enabled_instruments",
    extract: (query) => {
      const mention = primaryLawMention(query)
      if (!mention) return { _fallback: true }
      return { query: mention.name }
    },
    reason: "Act → the instruments made under it → get_enabled_instruments",
    priority: 3,
  },

  {
    name: "state_equivalents",
    patterns: [
      /(?<![A-Za-z])(?:NSW|VIC|QLD|WA|SA|TAS|NT|ACT|Vic|Qld|Tas)(?![A-Za-z])\s+equivalent\b/,
      /\bequivalents?\s+(?:of|to|in)\b/i,
      /\bstate\s+equivalents?\b/i,
      /\bcounterparts?\s+in\s+(?:the\s+)?(?:states|other\s+jurisdictions)\b/i,
    ],
    tool: "get_state_equivalents",
    extract: (query) => {
      const mention = primaryLawMention(query)
      if (!mention) return { _fallback: true }
      const jurisdiction = statePreference(query)
      return { query: mention.name, ...(jurisdiction ? { jurisdiction } : {}) }
    },
    reason: "cross-jurisdiction counterpart → get_state_equivalents",
    priority: 3,
  },

  {
    name: "aao",
    patterns: [/\badministrative\s+arrangements?\s+orders?\b/i],
    tool: "search_law",
    extract: () => ({
      query: "Administrative Arrangements Order",
      _clarify:
        "Administrative Arrangements Orders are made by the Governor-General and registered outside the Act and " +
        "LegislativeInstrument collections, so no collection filter is applied — the most recent hit is the current one.",
    }),
    reason: "Administrative Arrangements Order → search_law",
    priority: 3,
  },

  // ── priority 4 — time, comparison and the citation graph ──

  {
    name: "applicable_law",
    patterns: [
      /\bpoint[- ]in[- ]time\b/i,
      /\bas\s+at\b/i,
      /\bas\s+it\s+stood\b/i,
      /\bwhat\s+did\b[^]{0,60}?\bsay\s+in\b/i,
      /\bwhich\s+version\b/i,
      /\bin\s+force\s+(?:at|on|when)\b/i,
      /\bapplied\s+(?:on|at|when)\b/i,
      /\bapplicable\s+(?:law|version)\b/i,
      /\bversion\s+(?:of|that)\b[^]{0,40}?\bapplied\b/i,
    ],
    tool: "applicable_law",
    extract: (query) => {
      const mention = primaryLawMention(query)
      const date = pointInTimeDate(query)
      if (!mention || mention.body || !date) return { _fallback: true }
      return withProvision({ lawName: mention.name, date }, query, mention)
    },
    reason: "a date + a statute → applicable_law (the compilation in force then)",
    priority: 4,
  },

  {
    name: "compare_old_new",
    patterns: [
      /\bold\s+(?:and|vs\.?|versus)\s+new\b/i,
      /\bcompare\b[^]{0,30}?\bold\b[^]{0,25}?\bnew\b/i,
      /\bbefore\s+and\s+after\b[^]{0,40}?\bamendments?\b/i,
    ],
    tool: "compare_old_new",
    extract: (query) => {
      const mention = primaryLawMention(query)
      if (!mention || mention.body) return { _fallback: true }
      const params = withProvision({ query: mention.name }, query, mention)
      const dates = extractDates(query)
      if (dates.range) {
        params.fromDate = dates.range.range.from
        params.toDate = dates.range.range.to
      }
      return params
    },
    reason: "two compilations of one Act → compare_old_new",
    priority: 4,
  },

  {
    // Declared before `impact_map`: "history of CCA s 46" is an amendment
    // trail, not a citation graph, and both contain an Act and a provision.
    name: "provision_history",
    patterns: [
      /\bhistory\s+of\b/i,
      /\bwhen\s+was\b[^]{0,40}?\b(?:inserted|repealed|amended|substituted)\b/i,
      /\bprovision\s+history\b/i,
      /\bamendment\s+trail\b/i,
    ],
    tool: "get_provision_history",
    extract: (query) => {
      const mention = primaryLawMention(query)
      const refs = extractProvisions(query)
      if (!mention || mention.body || refs.length === 0) return { _skip: true }
      return { query: mention.name, provision: provisionParam(refs[0], mention) }
    },
    reason: "one provision's amendment trail → get_provision_history",
    priority: 4,
  },

  {
    name: "impact_map",
    patterns: [
      /\bcases?\b/i,
      /\bcase\s+law\b/i,
      /\bjudgments?\b/i,
      /\bauthorit(?:y|ies)\b/i,
      /\bwhat\s+cites\b/i,
      /\bwho\s+has\s+cited\b/i,
      /\b(?:considered|interpreted|construed)\b/i,
    ],
    tool: "impact_map",
    extract: (query) => {
      const mention = primaryLawMention(query)
      const refs = extractProvisions(query)
      // The broad trigger above is a prefilter. Without both an Act and a
      // provision there is no graph to draw, and every sentence containing the
      // word "cases" would be dragged here.
      if (!mention || mention.body || refs.length === 0) return { _skip: true }
      return {
        lawName: mention.name,
        provision: provisionParam(refs[0], mention),
        _alternates: [
          {
            tool: "search_cases",
            params: { query: `${mention.raw} ${provisionParam(refs[0], mention)}` },
            why: "impact_map walks citations to the provision. A free-text case search finds judgments that discuss it without citing it in a way the graph picks up.",
          },
        ],
      }
    },
    reason: "cases on a provision → impact_map (reverse citation graph)",
    priority: 4,
  },

  {
    name: "schedules",
    patterns: [
      /(?<![A-Za-z])(?:schedules?|schs?)(?![A-Za-z])/i,
      /\bfee\s+schedule\b/i,
      /\bforms?\b/i,
      /\bprescribed\s+(?:form|table|rates?)\b/i,
    ],
    tool: "get_schedules",
    extract: (query) => {
      const mention = primaryLawMention(query)
      const refs = extractProvisions(query)
      const scheduleRef = refs.find((ref) => ref.kind === "schedule" || ref.schedule)
      if (!mention && !scheduleRef) return { _skip: true }
      if (!mention) return { _fallback: true }
      const number = scheduleRef?.kind === "schedule" ? scheduleRef.number : scheduleRef?.schedule
      const schedule = number ?? mention.sch
      return { query: mention.name, ...(schedule ? { schedule } : {}) }
    },
    reason: "schedule, form or fee table → get_schedules",
    priority: 4,
  },

  {
    name: "treaty",
    patterns: [
      /\btreat(?:y|ies)\b/i,
      /(?<![A-Za-z])FTA(?![A-Za-z])/,
      /\bfree\s+trade\s+agreements?\b/i,
      /(?<![A-Za-z])(?:ICCPR|ICESCR|UNCLOS|CEDAW|ICERD|CRPD)(?![A-Za-z])/,
      /\bconventions?\s+on\b/i,
      /\bbilateral\s+agreements?\b/i,
    ],
    tool: "search_treaties",
    extract: (query) => {
      const stripped = searchExtract(/\b(?:the\s+)?(?:text|in\s+force|treaty|treaties)\b/gi)(query)
      const search = nonEmpty(stripQuestionNoise(stripped), query)
      return {
        query: search,
        _alternates: [
          {
            tool: "get_treaty_text",
            params: { id: "<id from search_treaties>", keyword: search },
            why: "The treaties database has no single-record endpoint, so the text is fetched with an id that only a search can supply — run the search first.",
          },
        ],
      }
    },
    reason: "treaty vocabulary → search_treaties",
    priority: 4,
  },

  {
    name: "report_citation",
    patterns: [BARE_REPORT_CITATION],
    tool: "search_cases",
    extract: (query, match) => ({
      query: match[0].trim(),
      _alternates: [
        {
          tool: "cite_check",
          params: { caseNumber: match[0].trim() },
          why: "A report-series citation identifies a judgment. If the question is whether it is still good law rather than what it says, that is the citator.",
        },
      ],
      _clarify:
        `"${match[0].trim()}" is a law-report citation — volume, series, first page — not an Act. Read as a case.`,
    }),
    reason: "bare report-series citation → search_cases",
    priority: 4,
  },

  {
    name: "rulings_search",
    patterns: [
      /(?<![A-Za-z])ATO(?![A-Za-z])[^]{0,25}?(?<![A-Za-z])(?:TR|TD|GSTR|GSTD|PCG|rulings?|determinations?)(?![A-Za-z])/i,
      /\btax\s+rulings?\b/i,
      /\bpublic\s+rulings?\b/i,
      /\bprivate\s+rulings?\b/i,
      /\bpractice\s+statements?\b/i,
    ],
    tool: "search_rulings",
    extract: (query) => {
      const stripped = searchExtract(
        /(?<![A-Za-z])(?:ATO|TR|TD|GSTR|GSTD|PCG)(?![A-Za-z])|\b(?:rulings?|public|private)\b/gi,
      )(query)
      const domain = /\b(?:practice\s+statement|ATO\s?ID)\b/i.test(query) ? "interpretations" : "tax_rulings"
      return { query: nonEmpty(stripQuestionNoise(stripped), query), domain }
    },
    reason: "ATO ruling vocabulary → search_rulings",
    priority: 4,
  },

  // ── priority 5 — searches ──

  {
    name: "amendment_track",
    patterns: [
      /\bwhat\s+(?:has\s+)?changed\b/i,
      /\bamendments?\s+to\b/i,
      /\bamendment\s+(?:history|track|tracking)\b/i,
      /\bhow\s+has\b[^]{0,40}?\bchanged\b/i,
      /\bchanges?\s+since\b/i,
    ],
    tool: "legal_research",
    extract: (query) => {
      const mention = primaryLawMention(query)
      const params: Record<string, unknown> = {
        task: "amendment_track",
        query: mention ? mention.name : nonEmpty(stripQuestionNoise(query), query),
      }
      const dates = extractDates(query)
      if (dates.range) {
        params.fromDate = dates.range.range.from
        params.toDate = dates.range.range.to
      } else if (dates.date) {
        params.fromDate = dates.date.iso
      }
      return withProvision(params, query, mention)
    },
    reason: "what changed in an Act → legal_research(task=\"amendment_track\")",
    priority: 5,
  },

  {
    name: "law_history",
    patterns: [
      /\bhistory\s+of\b/i,
      /\bwhat\s+was\s+repealed\b/i,
      /\bcommenced\s+on\b/i,
      /\bregister\s+changes\b/i,
    ],
    tool: "get_law_history",
    extract: (query) => {
      const dates = extractDates(query)
      const mention = primaryLawMention(query)
      // get_law_history is a *window* query and its schema requires ISO dates.
      // Without one it would be called with nothing to sweep, so the same
      // intent goes to the amendment chain instead of failing validation.
      if (!dates.range && !dates.date) {
        return {
          _reroute: "legal_research",
          task: "amendment_track",
          query: mention ? mention.name : nonEmpty(stripQuestionNoise(query), query),
        }
      }
      const params: Record<string, unknown> = mention ? { query: mention.name } : {}
      if (dates.range) {
        params.from = dates.range.range.from
        params.to = dates.range.range.to
      } else if (dates.date) {
        params.date = dates.date.iso
      }
      return params
    },
    reason: "changes to the Register in a window → get_law_history",
    priority: 5,
  },

  ...domainPatterns,

  {
    name: "law_search_request",
    patterns: [
      /\bsearch\s+for\b/i,
      /\bis\s+there\s+(?:a|an|any)\b[^]{0,40}?\b(?:act|law|legislation|statute)\b/i,
      /\bfind\s+(?:the|an?|any)\b[^]{0,25}?\b(?:act|law|legislation|statute)\b/i,
      /\blook\s+up\s+the\b/i,
    ],
    tool: "search_law",
    extract: (query) => {
      const mention = primaryLawMention(query)
      if (mention && !mention.body) return { query: mention.name }
      const stripped = searchExtract(/\b(?:search\s+for|look\s+up|find)\b/gi)(query)
      return { query: nonEmpty(stripQuestionNoise(stripped), query) }
    },
    reason: "an explicit request to search legislation → search_law",
    priority: 5,
  },

  {
    name: "bare_alphanumeric",
    patterns: [/^\s*\d{1,4}[A-Za-z]{1,3}\s*$/],
    tool: "search_law",
    extract: (query) => ({
      query: query.trim(),
      _clarify:
        `"${query.trim()}" is a section number with no Act. Several Commonwealth Acts have a provision of that ` +
        "number and they say different things — name the Act, or search for the one you mean first.",
    }),
    reason: "bare provision number with no Act → search_law, with a disambiguation prompt",
    priority: 5,
  },

  // ── priority 6 — case law, state law, terminology ──

  {
    name: "case_search",
    patterns: [
      // A medium-neutral citation, recognised by the citation grammar in
      // `extract`; this is only the cheap shape test.
      /\[(?:1[89]|20)\d{2}\]\s{0,3}[A-Za-z][A-Za-z0-9.]{1,15}\s{1,3}\d{1,5}/,
      // `Party v Party`. The spaces around `v` are required: "NSW vs Cth" is a
      // jurisdiction comparison and "vs" is not the case-name connector.
      /(?<![A-Za-z])[A-Z][A-Za-z'’-]{1,20}(?:\s+[A-Z][A-Za-z'’-]{1,20}){0,3}\s+v\s+[A-Z][A-Za-z'’-]{0,20}/,
      /\bparty\s+search\b/i,
    ],
    tool: "search_cases",
    extract: (query) => {
      const mnc = firstMnc(query)
      const params: Record<string, unknown> = { query: mnc ? mnc.raw : query.trim() }
      if (mnc) params.court = mnc.court
      return {
        ...params,
        _pipeline: [{ tool: "get_case_text", params: {} }],
      }
    },
    reason: "citation or party names → search_cases",
    priority: 6,
  },

  {
    name: "state_law",
    patterns: [
      /(?<![A-Za-z])(?:NSW|VIC|QLD|WA|SA|TAS|NT)(?![A-Za-z])/,
      /(?<![A-Za-z])(?:Vic|Qld|Tas)(?![A-Za-z])/,
      /\b(?:New\s+South\s+Wales|Victoria|Victorian|Queensland|Western\s+Australia|South\s+Australia|Tasmania|Northern\s+Territory)\b/i,
      // An Act with a year but no jurisdiction word: `extract` asks the alias
      // table whether that year belongs to a State Act.
      /\bAct\s+(?:1[89]|20)\d{2}\b/,
    ],
    tool: "search_state_law",
    extract: (query) => {
      const mention = primaryLawMention(query)
      if (!mention || mention.body) return { _skip: true }
      const explicit = statePreference(query)
      const fromTable = mention.jurisdiction && mention.jurisdiction !== "Cth" ? mention.jurisdiction : undefined
      const jurisdiction = explicit ?? fromTable
      // A Commonwealth Act with no State token in the query is not state law,
      // and searching a State register for it returns a confident nothing.
      if (!jurisdiction) return { _skip: true }

      const token = stateRegisterToken(jurisdiction)
      const refs = extractProvisions(query)
      const params: Record<string, unknown> = { jurisdiction: token, query: mention.name }
      // The alias table resolved this title to a different jurisdiction than
      // the one the query named. Harmonised titles ("Work Health and Safety
      // Act 2011") exist in several registers, but many do not — Victoria has
      // no Civil Liability Act — and a silent empty result reads as "no such
      // law" rather than "wrong register".
      const mismatch =
        mention.jurisdiction && mention.jurisdiction !== jurisdiction
          ? `The abbreviation table resolves "${mention.raw}" to ${mention.name} (${mention.jurisdiction}); ` +
            `the ${token} register is being searched because the query named ${jurisdiction}. If ${jurisdiction} ` +
            "has no Act of that name, the counterpart will have a different title — get_state_equivalents maps them."
          : undefined
      const clarify = jurisdictionClarify(mention) ?? mismatch
      // Only chase the text when a provision was named: without one the search
      // hit list is the answer, and a detail call would pick an arbitrary Act.
      const pipeline: PipelineStep[] = refs.length
        ? [{ tool: "get_state_law_text", params: { jurisdiction: token } }]
        : []
      return {
        ...params,
        ...(clarify ? { _clarify: clarify } : {}),
        ...(pipeline.length ? { _pipeline: pipeline } : {}),
      }
    },
    reason: "a State or Territory statute → search_state_law",
    priority: 6,
  },

  {
    // Declared before `term_kb`: "definition of X" is a request for one term's
    // detail, while "meaning of X" opens the glossary.
    name: "term_detail",
    patterns: [
      /\bdefinitions?\s+of\b/i,
      /\bwhat\s+is\s+(?:an?\s+)?[^]{0,40}?\bunder\s+the\b/i,
      /^\s*[a-z][a-z\s'’-]{2,40}\s+under\s+the\b/i,
    ],
    tool: "get_legal_term_detail",
    extract: (query) => {
      const term = termFromQuery(query)
      if (!term) return { _skip: true }
      const mention = primaryLawMention(query)
      return {
        term,
        ...(mention
          ? {
              _alternates: [
                {
                  tool: "get_law_text",
                  params: { query: mention.name },
                  why: `The same English word is defined differently by different Acts. This answer is the general one; ${mention.name} has its own definition provision.`,
                },
              ],
              _clarify: `Read as the meaning of "${term}" under ${mention.name}. Definitions are Act-specific — the same word means something else in another statute.`,
            }
          : {}),
      }
    },
    reason: "a defined term → get_legal_term_detail",
    priority: 6,
  },

  {
    name: "term_kb",
    patterns: [
      /\bmeaning\s+of\b/i,
      /\bwhat\s+does\b[^]{0,40}?\bmean\b/i,
      /\bdefined\s+in\b/i,
      /\bplain\s+english\b/i,
    ],
    tool: "get_legal_term_kb",
    extract: (query) => {
      const term = termFromQuery(query)
      if (!term) return { _skip: true }
      const mention = primaryLawMention(query)
      return {
        query: term,
        ...(mention
          ? {
              _pipeline: [{ tool: "get_law_text", params: { query: mention.name }, standalone: true }],
              _alternates: [
                {
                  tool: "get_law_text",
                  params: { query: mention.name },
                  why: `The glossary gives the general meaning; ${mention.name} carries the statutory definition that governs.`,
                },
              ],
            }
          : {}),
      }
    },
    reason: "terminology lookup → get_legal_term_kb",
    priority: 6,
  },

  // ── priority 8 — a provision with nothing to anchor it ──

  {
    name: "orphan_provision",
    patterns: [PROVISION_HINT_RE],
    tool: "verify_citations",
    extract: (query) => {
      const refs = extractProvisions(query)
      if (refs.length === 0) return { _skip: true }
      const mention = primaryLawMention(query)
      // Only reached when nothing above claimed the query, which means no Act
      // was identified. Answering with a guessed Act is the failure mode this
      // pattern exists to prevent, so the citation checker reports the gap.
      if (mention && !mention.body) return { _skip: true }
      return {
        text: query,
        _clarify:
          "No Act is named alongside this provision reference, so it cannot be looked up — the same section number " +
          "means different things in different statutes. Verifying the citation reports what is missing rather than " +
          "guessing which Act was meant.",
      }
    },
    reason: "a provision with no Act named → verify_citations (reports the gap)",
    priority: 8,
  },

  // ── priority 9 — an Act name and nothing else ──

  {
    name: "explicit_law",
    patterns: [ACT_NAME_DETECT, SHORT_ALIAS_DETECT, LONG_ALIAS_DETECT],
    tool: "search_law",
    extract: (query) => {
      const mention = primaryLawMention(query)
      // An agency name is not a statute name. "ACCC chair" is not a request
      // for the Competition and Consumer Act.
      if (!mention || mention.body) return { _skip: true }
      const clarify = jurisdictionClarify(mention)
      return {
        query: mention.name,
        ...(clarify ? { _clarify: clarify } : {}),
        _alternates: [
          {
            tool: "get_law_text",
            params: { query: mention.name },
            why: "Name a provision to go straight to its text instead of the title record.",
          },
        ],
      }
    },
    reason: "a statute name on its own → search_law",
    priority: 9,
    yieldsTo: EXPLICIT_LAW_YIELDS_TO,
  },

  // ── priority 15 — a bare legal concept ──

  {
    name: "bare_term",
    patterns: [/^[A-Za-z][A-Za-z\s'’-]{2,60}$/],
    tool: "get_legal_term_kb",
    extract: (query) => {
      if (!isBareTermQuery(query)) return { _skip: true }
      return {
        query: query.trim(),
        _alternates: [
          {
            tool: "search_law",
            params: { query: query.trim() },
            why: "If this names an Act rather than a concept, search the Register instead.",
          },
        ],
      }
    },
    reason: "a bare legal concept → get_legal_term_kb",
    priority: 15,
  },
]

// ──────────────────────────────────────────────────────────────────────────
// Terminology extraction
// ──────────────────────────────────────────────────────────────────────────

/**
 * The term out of a definition question.
 *
 * Three shapes, tried in order of how much they pin down: after "definition
 * of"/"meaning of", between "what is a" and "under the", or the whole leading
 * noun phrase before "under the". Bounded everywhere — these run against
 * pasted text.
 */
const TERM_AFTER_LEAD = /\b(?:definitions?|meaning)\s+of\s+(?:an?\s+|the\s+)?([A-Za-z][A-Za-z\s'’-]{1,40}?)(?=\s+(?:in|under|for|as)\b|[,.?;]|$)/i
const TERM_WHAT_IS = /\bwhat\s+is\s+(?:an?\s+|the\s+)?([A-Za-z][A-Za-z\s'’-]{1,40}?)\s+under\s+the\b/i
const TERM_LEADING = /^\s*([a-z][a-z\s'’-]{2,40}?)\s+under\s+the\b/i

function termFromQuery(query: string): string | undefined {
  for (const pattern of [TERM_AFTER_LEAD, TERM_WHAT_IS, TERM_LEADING]) {
    const match = pattern.exec(query)
    if (match) {
      const term = match[1].trim()
      if (term.length >= 2) return term
    }
  }
  return undefined
}

// ──────────────────────────────────────────────────────────────────────────
// Scenario-derived patterns
// ──────────────────────────────────────────────────────────────────────────

/**
 * Routing patterns derived from the scenario table.
 *
 * The vocabulary is not repeated here — `scenario-rules.ts` is the only place
 * it exists, and this turns each routable rule into a pattern that runs
 * `legal_research` with that rule's task. A scenario that gains a trigger word
 * gains it on both surfaces at once.
 */
const scenarioPatterns: Pattern[] = ROUTABLE_SCENARIO_RULES.map((rule) => ({
  name: `scenario_${rule.scenario}`,
  patterns: rule.routeTriggers as RegExp[],
  tool: "legal_research",
  extract: (query: string): ExtractResult => {
    const mention = primaryLawMention(query)
    const params: Record<string, unknown> = {
      task: rule.task,
      query: nonEmpty(mention && !mention.body ? mention.name : stripQuestionNoise(query), query),
    }
    if (rule.task === "document_review") {
      params.text = query
      params.query = undefined
      delete params.query
    }
    if (rule.task === "dispute_prep") {
      const domain = extractDomainHint(query)
      if (domain) params.domain = domain
    }
    if (rule.task === "state_law_compare") {
      const jurisdictions = extractJurisdictions(query).filter((value) => value !== "Cth")
      if (jurisdictions.length) params.jurisdictions = jurisdictions.slice(0, 2).map(stateRegisterToken)
      // The subject, not the Act name: "compare unfair contract terms NSW vs
      // Cth" is about the terms, and the Act titles differ by jurisdiction.
      params.query = nonEmpty(stripQuestionNoise(query), query)
    }
    if (rule.task === "amendment_track") {
      const dates = extractDates(query)
      if (dates.range) {
        params.fromDate = dates.range.range.from
        params.toDate = dates.range.range.to
      }
    }
    return {
      ...params,
      _alternates: [
        {
          tool: TASK_TO_CHAIN[rule.task],
          params: { ...params, task: undefined },
          why: `legal_research(task="${rule.task}") and ${TASK_TO_CHAIN[rule.task]} are the same chain reached by two names — the advertised entry point and the direct one.`,
        },
      ],
    }
  },
  reason: `${rule.scenario} vocabulary → legal_research(task="${rule.task}")`,
  priority: rule.precedence,
}))

// ──────────────────────────────────────────────────────────────────────────
// Assembly
// ──────────────────────────────────────────────────────────────────────────

/**
 * Every pattern in priority order, built once at module load.
 *
 * Scenario patterns go first so that within a priority band a scenario beats a
 * hand-written pattern of the same number — the scenario table is the more
 * specific statement, and the hand-written ones are the general fallbacks.
 * `Array.prototype.sort` is stable, so this ordering survives the sort.
 */
export const sortedRoutePatterns: readonly Pattern[] = [...scenarioPatterns, ...routePatterns].sort(
  (a, b) => a.priority - b.priority,
)

/**
 * Name → the patterns carrying it.
 *
 * A list, not a single entry: scenario names can repeat (two rules may share a
 * scenario at different precedences), and a `Map<string, Pattern>` would let
 * the later one silently replace the earlier, leaving a guard evaluating the
 * wrong regexes.
 */
const patternsByName = new Map<string, Pattern[]>()
for (const pattern of [...routePatterns, ...scenarioPatterns]) {
  const list = patternsByName.get(pattern.name)
  if (list) list.push(pattern)
  else patternsByName.set(pattern.name, [pattern])
}

/**
 * A typo or a rename silently disables a guard, and the pattern it protected
 * starts winning queries again with nothing to show that it changed. Fail at
 * load instead.
 */
for (const pattern of [...routePatterns, ...scenarioPatterns]) {
  for (const target of pattern.yieldsTo ?? []) {
    if (!patternsByName.has(target)) {
      throw new Error(`route-patterns: "${pattern.name}".yieldsTo names a pattern that does not exist: "${target}"`)
    }
  }
}

/** Exposed for tests: the names a guard may legally reference. */
export function patternNames(): string[] {
  return [...patternsByName.keys()]
}

/**
 * Would one of the patterns this one defers to actually take the query?
 *
 * Matching the receiver's regex is not enough. If the receiver's extractor
 * would answer `_skip` or `_fallback` it is not going to handle this query
 * either, and yielding to it drops the whole thing through to generic research
 * — losing the provision lookup that was already correct.
 */
export function yieldsToOther(pattern: Pattern, query: string): boolean {
  for (const name of pattern.yieldsTo ?? []) {
    for (const receiver of patternsByName.get(name) ?? []) {
      for (const regex of receiver.patterns) {
        const match = query.match(regex)
        if (!match) continue
        const params = receiver.extract(query, match)
        if (!params._fallback && !params._skip) return true
      }
    }
  }
  return false
}

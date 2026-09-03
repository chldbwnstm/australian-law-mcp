# Australian Law MCP — Architecture

> Functional doppelganger of [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp) v4.12 for Australian law.
> Reference clone: `/tmp/korean-law-mcp` (read-only). Research basis: `docs/research/*.md` (all endpoints live-verified 2026-09-03).
> Tool surface: `docs/TOOL-MAPPING.md`.

## Layering (ported 1:1 from the reference)

```
MCP client (stdio / stateless Streamable HTTP)  |  CLI (natural-language router)
        └── tool-registry.ts  (allTools[], 10 EXPOSED via ListTools, rest via execute_tool)
              └── src/tools/*          (one file per tool cluster, Zod schemas)
                    └── src/lib/*      (routing, citation vocab, parsers, alias, cache)
                          └── upstream boundary (budgets, retry, body-shape miss detection,
                              chain deadline, rate limit)  — ALREADY PORTED, tests green
                                └── AuApiClient (multi-host facade, below)
```

Everything the reference learned stays in force here: a 200 with an HTML/empty body is a
*miss shape*, not a success; an unreachable upstream is **never** reported as "does not
exist" (`[UPSTREAM_NO_DATA]` vs `[UPSTREAM_BLOCKED]` vs `[NOT_FOUND]` are distinct);
chains assemble partial results at the 45s deadline; every request shares one upstream
budget (48 attempts / 2 MiB / 8 MiB).

## Upstream hosts (single source: `src/lib/upstream-hosts.ts`)

| key | base | kind | notes |
|-----|------|------|-------|
| `frlApi` | api.prod.legislation.gov.au/v1 | OData JSON | keyless; $top<=100; manual pagination ($filter lost on nextLink) |
| `frlDocs` | www.legislation.gov.au | epub/pdf/docx + epub-member extraction | `{id}/{asat}/{viewedat}/text/{rect}/{format}`; NCX TOC slicing |
| `nswCaselaw` | www.caselaw.nsw.gov.au | HTML | param `query` (NOT q); page 0-indexed; robots discourages bulk — on-demand only, cache hard |
| `hcourt` | www.hcourt.gov.au | HTML | facet `f[0]=d:YYYY` must NOT be percent-encoded |
| `qldJudgments` | www.queenslandjudgments.com.au | HTML | citation-addressable `/caselaw/{code}/{yr}/{n}`; slow ~2s |
| `qldLegislation` | www.legislation.qld.gov.au | projectdata JSON | 90s timeout on Content searches |
| `tasLegislation` | www.legislation.tas.gov.au | projectdata JSON | `EnAct-` datasource prefix |
| `waLegislation` | www.legislation.wa.gov.au | Domino HTML | A–Z lists + mrdoc full text |
| `vicLegislation` | www.legislation.vic.gov.au | HTML + sitemap | full text = authorised PDF/DOCX links |
| `ntLegislation` | legislation.nt.gov.au | HTML + PDF/Word API | By-Title list for search |
| `actLegislation` | www.legislation.act.gov.au | deep URLs only | `/a/YYYY-N/`, DownloadFile PDFs; homepage is F5-walled |
| `ato` | www.ato.gov.au | POST form + HTML | `/API/v1/law/lawservices/result`; 60s |
| `fwc` | www.fwc.gov.au | HTML | document-search; ignore facet-total count element |
| `oaic` | www.oaic.gov.au | HTML | determinations index only |
| `dfat` | docs.dfat.gov.au | POST JSON | `/api/search`; SPA 404-status quirk |
| `glossary` | legalanswers.sl.nsw.gov.au | HTML | legal glossary |

**Blocked set (never fetched server-side; emit deep links + `[UPSTREAM_BLOCKED]`):**
AustLII (all), LawCite, judgments.fedcourt.gov.au, legislation.nsw.gov.au,
legislation.sa.gov.au, accc.gov.au, competitiontribunal.gov.au.
Deep-link builders live in `src/lib/external-links-map.ts` (AustLII viewdoc grammar,
LawCite `?cit=`, NSW/SA legislation, Fed Court).

All requests send a browser UA (env `LAW_USER_AGENT` override), flow through
`fetch-with-retry` (budget-charged), and per-host `timeoutMs`/`minIntervalMs` come from
the hosts table (politeness: >=1 req/s per scraped host, QLD/TAS 90s, ATO 60s).

## `AuApiClient` contract (`src/lib/api-client.ts`) — Wave-1 deliverable, frozen interface

```ts
class AuApiClient {
  constructor(config?: { userAgent?: string })
  // generic transport (budget/cancellation-aware; tools may use these directly)
  fetchJson(host: HostKey, path: string, opts?: FetchOpts): Promise<unknown>
  fetchHtml(host: HostKey, path: string, opts?: FetchOpts): Promise<string>
  fetchBinary(host: HostKey, path: string, opts?: FetchOpts): Promise<Uint8Array>
  // FRL conveniences
  searchTitles(p: { text?: string; searchType?: "name" | "nameAndText";
    collection?: string; status?: string; pointInTime?: string;   // criteria DSL path
    filter?: string;                                              // raw $filter path
    top?: number; skip?: number; select?: string; expand?: string
  }): Promise<{ count: number; titles: FrlTitle[] }>
  getTitle(titleId: string): Promise<FrlTitle>            // incl. nameHistory, statusHistory
  listVersions(titleId: string, p?: { top?: number; skip?: number }): Promise<FrlVersion[]>
  findVersion(p: { titleId: string; asAt?: string; spec?: "latest" | "current" | "asmade";
    registerId?: string }): Promise<FrlVersion>           // normalizes PascalCase quirk
  listAmenders(titleId: string, kinds?: AffectKind[]): Promise<{ count: number; titles: FrlTitle[] }>
  getToc(titleId: string, date?: string): Promise<NcxEntry[]>          // epub NCX
  getVolumeHtml(titleId: string, volume: number, date?: string): Promise<string>
  getProvision(titleId: string, provision: string, date?: string): Promise<ProvisionText>
    // resolves via section-ref normalizer + NCX anchor slicing; schedules supported (sch 2 s 18)
}
```

`FetchOpts = { query?, method?, body?, headers?, timeoutMs?, apiKey? }`. Types
`FrlTitle`/`FrlVersion`/`NcxEntry`/`ProvisionText` in `src/lib/types.ts`.
The FRL criteria DSL builder (double-encoding, `and()` function form, unquoted enums)
is its own module `src/lib/frl-criteria.ts` — single source of that grammar.

## Domain vocabulary modules (single-source rule, as in the reference)

| module | owns |
|--------|------|
| `lib/section-ref.ts` | grammar `s 18`, `s 10AA`, `s 5(2)(a)`, `sub-s`, `pt`, `div`, `sch 2 s 18`, `reg 2.01`, `r 42.02.2`, `cl`, item — parse/normalize/format (replaces Korean JO codes) |
| `lib/case-citation.ts` | MNC + report-series regexes, court-code table (HCA…NTCAT incl. historical), dotted-form absorption, AGLC parallel citations |
| `lib/law-alias.ts` | alias dictionary `{alias, official, jurisdiction, titleId?, sch?}` seeded from research §5 (CCA/TPA same title; ACL = CCA sch 2; UEA set; per-state Crimes Acts need jurisdiction) + `hasRelatedHit` guard |
| `lib/external-links-map.ts` | AustLII/LawCite/blocked-source deep-link grammar |
| `lib/au-dates.ts` | English date-phrase parsing ("as at 1 July 2020", "on 15/03/2019", "two years ago") for applicable_law/router |

## 18 decision domains (`search_decisions` / `get_decision_text`)

| domain | source | grade |
|--------|--------|-------|
| `cases` | fan-out NSW Caselaw + HCA + QLD Judgments | live |
| `constitutional` | HCA `keywords=constitutional` (catchwords) | live |
| `admin_appeals` | NCAT (NSW Caselaw court ids) + QCAT (QLD Judgments) + ART deep links | live (states) |
| `tax_tribunal` | ATO legal DB (decision impact statements etc.) + ARTA deep links | partial |
| `tax_rulings` | ATO legal DB TR/TD/GSTR/… | live |
| `interpretations` | ATO interpretative decisions (AID) + practice statements (PS LA) | live |
| `customs` | ATO customs/excise docs + ABF/ADRP deep links | partial |
| `competition` | attempt ACCC/ACompT (expect 403 → `[UPSTREAM_BLOCKED]` + links) + case fan-out fallback | degraded |
| `workplace` | FWC document-search + PDF | live |
| `privacy` | OAIC determinations index + AICmr deep links | live (index) |
| `integrity` | NACC/Ombudsman attempt + links | degraded |
| `public_service` | MPC attempt + ART links | degraded |
| `university_rules` | university acts via state legislation clients | live |
| `agency_rules` | FRL NotifiableInstrument collection | live |
| `gazettes` | FRL Gazette collection | live |
| `treaties` | DFAT ATD JSON API | live |
| `explanatory` | FRL ES documents (`/es/` segment, type=ES) + APH EM links | live |
| `state_law` | unified state/territory legislation search (QLD/TAS/WA/VIC/NT/ACT; NSW/SA link-only) | live |

Degraded domains still exist and behave honestly: they attempt the real upstream, map the
WAF block to `[UPSTREAM_BLOCKED]` with deep links, and never claim absence.

## Killer features

- `verify_citations` — AGLC4 regexes (research §4.5) → statute existence via FRL (alias
  first), provision existence via NCX, **content match** = cited section description vs
  actual heading (bigram Jaccard, port `citation-content-matcher`). Flagship trap: CCA
  s 18 ("Meetings of Commission") vs ACL = CCA sch 2 s 18 ("Misleading or deceptive
  conduct"). Case citations: MNC/report parse → resolve against NSW/QLD/HCA; unresolvable
  ≠ nonexistent when a source is blocked. "the Act" anaphora inherits the last statute
  cite within a paragraph, never across a blank line.
- `cite_check` — verdicts `cited` / `overruled_candidate` / `legislative_override` /
  `not_found` / `unverified_treatment` (default). Back-trace = full-text search of the
  citation string across NSW+QLD+HCA; overruling-language scan ("overruled", "should no
  longer be followed", "we decline to follow", "not good law"); `legislative_override`
  checks FRL amendment of relied-on provisions after decision date; always lists later
  citing cases + LawCite deep link. Never claims Shepard's-grade treatment.
- `applicable_law` — `Versions/Find(asAt)` + point-in-time provision text + diff vs
  current + `reasons[].markdown` amendment attribution + `isCurrent` vs `isLatest`
  unincorporated-amendments warning + rename handling (TPA→CCA must not read as repeal).
- `impact_map` — provision → citing cases (full-text back-trace) + instruments made
  under the act (FRL `enabledBy` search) + state application acts + mermaid graph.

## Build waves (agent assignments; file ownership is exclusive per wave-mate)

| wave | agent | scope |
|------|-------|-------|
| 0 ✅ | scaffold | core lib ported, 64 tests |
| 1 | B | `AuApiClient` + hosts + frl-criteria + ncx/section slicing + section-ref + case-citation + law-alias + au-dates + external-links-map (+tests, live smoke gated by env) |
| 2 | C | statute tools: search_law, get_law_text, get_schedules, get_batch_provisions, compare_old_new, get_three_tier, historical, provision/law history, suggest_law_names, advanced_search, law_tree, statistics, system tree, linkage ×4, instrument_radar |
| 2 | D | decision tools: 18 domains search/get pairs + per-source scrapers + unified-decisions dispatcher |
| 2 | E | knowledge base ×7, legal terms, plain-language mapping, analyze_document port, external_links tool, parse_section_ref tool, search_all, search_ai_law |
| 3 | F | verify_citations, cite_check, applicable_law, impact_map, legal_analysis |
| 3 | G | chains ×8, legal_research, meta-tools, tool-registry, tool-profiles (V3_EXPOSED) |
| 4 | H | CLI + query-router + route-patterns (English) + query-extract + scenario-rules |
| 4 | I | index.ts, http-server, http-config, Dockerfile polish, setup wizard |
| 5 | QA | integration, live smoke, README/API/DEVELOPMENT docs, npm pack sanity |

Rules for every coding agent: TypeScript strict; vitest tests ported/adapted per file
(fixtures = recorded upstream responses, no live calls in `npm test`; live smoke scripts
under `scripts/` gated by `LIVE=1`); files ~200 lines; English throughout; error labels
in brackets; never invent upstream behavior — cite `docs/research/*` line for every
endpoint used.

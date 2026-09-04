# Australian Law MCP — Tool Mapping

> **v0.1.0 — as built.** Originally the architect's draft; the tables below have been
> reconciled against the shipped registry (`src/tool-registry.ts`, `src/lib/tool-profiles.ts`)
> and against a live run of all 18 domains on 2026-09-04 (`docs/VERIFICATION.md`).

Goal: a functional doppelganger of [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp) v4.12
for Australian law. Every tool in the reference has an Australian counterpart with the same name
wherever the concept transfers, and an adapted name where the legal system differs.
Reference clone: `/tmp/korean-law-mcp` (structure, budgets, error taxonomy, and test discipline are ported 1:1).

## Legal-system translation (the five structural decisions)

| # | Korean concept | Australian counterpart | Rationale |
|---|----------------|------------------------|-----------|
| 1 | 법령 (statute, MST id) + 시행령/시행규칙 3-tier | **Cth Acts + Legislative Instruments** on the Federal Register of Legislation (FRL). 3-tier = Act → Regulations → Rules/other instruments ("enabled by" metadata) | FRL is the single authoritative federal register with an OData API |
| 2 | 시점법령/연혁법령 (point-in-time, applicable_law) | **FRL compilations** — every compilation has a register id + start/end dates | Native point-in-time support; better than Korea's |
| 3 | 자치법규 (local ordinances) | **State/Territory legislation** (8 jurisdictions: NSW, Vic, Qld, WA, SA, Tas, ACT, NT) | The federal/state split is the natural "second layer" of Australian law; local council by-laws are not systematically published |
| 4 | 판례 + 18 decision domains | **Multi-source fan-out** — AustLII is Cloudflare-blocked to non-browser clients (verified 2026-09-03), so live sources are NSW Caselaw (best), Queensland Judgments (citation-addressable), hcourt.gov.au (HCA), + per-domain first-party sites; AustLII/LawCite kept as user-facing deep links only | See docs/research/case-law-access.md; citator = full-text citation back-trace (same technique as Korean cite_check) |
| 5 | 조문번호 JO code (`제38조` ↔ `003800`) | **Section reference grammar** (`s 18`, `s 355-25`, `sub-s (2)(a)`, Sch 2 item 1) with a normalizer `parse_section_ref` | AU has no numeric codes; the normalizer is the single source of section-reference truth |

## Exposed tools (10 — the same surface shape as the reference's v4.4.0+ consolidation)

| Tool | AU semantics |
|------|-------------|
| `legal_research` | 8 tasks: full_research · law_system · action_basis · dispute_prep · amendment_track · state_law_compare · procedure_detail · document_review |
| `legal_analysis` | 4 modes: verify_citations · cite_check · applicable_law · impact_map |
| `search_law` | FRL title/keyword search (Acts + instruments), alias resolution (CCA, FW Act, Corps Act…), repealed→successor annotation, not-yet-commenced annotation |
| `get_law_text` | Full text / single provision of an Act or instrument (current or specific compilation) |
| `get_schedules` | Schedules/forms of an Act or instrument (analog of `get_annexes` — AU schedules are inline document parts, no HWP parsing) |
| `instrument_radar` | Analog of `ordinance_radar`: for a legislative instrument, extract its enabling Act(s) (authorising provisions), compare the Act's latest amendment date vs the instrument's last compilation → flag "enabling Act amended after instrument last updated" |
| `search_decisions` | Unified search across the 18 AU decision domains (table below) |
| `get_decision_text` | Unified full-text retrieval across those domains |
| `discover_tools` | Ranked pointer format, same category taxonomy in English |
| `execute_tool` | Proxy to all unexposed tools |

## 18 decision domains (`search_decisions` / `get_decision_text`)

| # | Korean domain | Australian domain (`domain` value) | Source | Grade |
|---|--------------|-------------------------------------|--------|-------|
| 1 | 판례 (courts) | `cases` | fan-out: NSW Caselaw + hcourt.gov.au + QLD Judgments | live |
| 2 | 헌재 | `constitutional` | HCA `keywords=constitutional` (catchwords) | live |
| 3 | 행정심판 | `admin_appeals` | NCAT (NSW Caselaw) + QCAT (QLD Judgments) + ART deep links | live (states) |
| 4 | 조세심판원 | `tax_tribunal` | ATO legal DB (decision impact statements) + ARTA deep links | partial |
| 5 | 국세청 해석 | `tax_rulings` | ATO Legal Database TR/TD/GSTR/… | live |
| 6 | 법령해석례 | `interpretations` | ATO interpretative decisions (AID) + practice statements (PS LA) | live |
| 7 | 관세 해석 | `customs` | ATO customs/excise docs + Anti-Dumping Review Panel indexes (`adrp` is a fetched host, not a deep link) | live |
| 8 | 공정위 | `competition` | ACCC/ACompT attempt (→ [UPSTREAM_BLOCKED] + links) + case fan-out fallback | degraded |
| 9 | 노동위 | `workplace` | FWC document-search + PDFs | live |
| 10 | 개보위 | `privacy` | OAIC determinations index + AICmr deep links | live (index) |
| 11 | 권익위 | `integrity` | NACC investigation reports (live index); Cth Ombudsman is Cloudflare-gated → `[UPSTREAM_BLOCKED]` + link | partial |
| 12 | 소청심사 | `public_service` | Merit Protection Commissioner case-studies index (live, faceted) | live |
| 13 | 학칙 | `university_rules` | university acts via state legislation clients | live |
| 14 | 공단 규정 | `agency_rules` | FRL NotifiableInstrument collection | live |
| 15 | 공공기관 규정 | `gazettes` | FRL Gazette collection (18,593 notices) | live |
| 16 | 조약 | `treaties` | DFAT Australian Treaties Database JSON API | live |
| 17 | 영문법령 | `explanatory` | FRL Explanatory Statements (type=ES) + APH EM links — "the version written for humans" | live |
| 18 | 자치법규 (also own tools) | `state_law` | unified state/territory legislation search (QLD/TAS/WA/VIC/NT/ACT; NSW/SA link-only) | live |

Live grades, re-measured end to end on 2026-09-04 (`docs/VERIFICATION.md`): **11 live,
6 partial (`admin_appeals`, `tax_tribunal`, `privacy`, `integrity`, `treaties` and
`state_law` each pair a live source with a blocked one), 1 degraded (`competition`)**. Every
domain answers; the degraded and partial ones attempt the real upstream, map WAF blocks
to `[UPSTREAM_BLOCKED]` with deep links, and never claim absence.

## The registry, by category

81 tools registered; 10 advertised. The categories below are `TOOL_CATEGORIES` in
`src/lib/tool-profiles.ts` — the same table `discover_tools` searches and the CLI's
`list --category` filters on. A tool can appear in more than one category, so the counts
below do **not** sum to 81; the authoritative figure is `TOOL_COUNTS` exported from
`src/tool-registry.ts` (derived from `allTools` and `V3_EXPOSED`, never hand-counted).
Tools marked ★ are the ten `ListTools` advertises.

| Category | Tools |
|----------|-------|
| legislation (10) | ★`search_law`, ★`get_law_text`, `search_ai_law`, `search_all`, `advanced_search`, `suggest_law_names`, `get_batch_provisions`, `get_law_tree`, `get_law_system_tree`, `get_law_statistics` |
| instruments (8) | `get_three_tier`, `get_enabled_instruments`, `get_enabling_acts`, `get_instrument_provisions`, ★`instrument_radar`, `search_agency_rules`, `search_gazettes`, `get_registered_instrument_text` |
| state law (5) | `search_state_law`, `get_state_law_text`, `get_state_equivalents`, `search_university_rules`, `chain_state_law_compare` |
| case law (6) | ★`search_decisions`, ★`get_decision_text`, `search_cases`, `get_case_text`, `search_constitutional_decisions`, `get_constitutional_decision_text` |
| tribunals (7) | ★`search_decisions`, `search_admin_appeals`, `get_admin_appeal_text`, `search_tax_tribunal_decisions`, `get_tax_tribunal_decision_text`, `search_public_service_decisions`, `get_public_service_decision_text` |
| tax and rulings (4) | `search_rulings`, `get_ruling_text`, `search_tax_tribunal_decisions`, `get_tax_tribunal_decision_text` |
| workplace (2) | `search_workplace_decisions`, `get_workplace_decision_text` |
| privacy (2) | `search_privacy_decisions`, `get_privacy_decision_text` |
| competition (2) | `search_competition_decisions`, `get_competition_decision_text` |
| integrity (2) | `search_integrity_decisions`, `get_integrity_decision_text` |
| public service (2) | `search_public_service_decisions`, `get_public_service_decision_text` |
| treaties (2) | `search_treaties`, `get_treaty_text` |
| explanatory (2) | `search_explanatory`, `get_explanatory_text` |
| history and versions (6) | `get_law_history`, `get_provision_history`, `compare_old_new`, `search_historical_law`, `get_historical_law`, `chain_amendment_track` |
| schedules (2) | ★`get_schedules`, `chain_procedure_detail` |
| terminology (7) | `get_legal_term_kb`, `get_legal_term_detail`, `get_plain_term`, `get_plain_to_legal`, `get_legal_to_plain`, `get_term_provisions`, `get_related_laws` — backed by a bundled AU legal glossary plus Act definition-section extraction |
| citations and verification (5) | ★`legal_analysis`, `verify_citations`, `cite_check`, `applicable_law`, `impact_map` |
| documents and links (4) | ★`legal_research`, `analyze_document`, `chain_document_review`, `get_external_links` |
| research (7) | ★`legal_research`, `chain_full_research`, `chain_law_system`, `chain_action_basis`, `chain_dispute_prep`, `chain_procedure_detail`, `search_all` |
| utilities (2) | `parse_section_ref`, `get_law_abbreviations` |
| *(uncategorised)* | ★`discover_tools`, ★`execute_tool` — the meta pair is deliberately outside the taxonomy it searches |

### The four killer features

| Tool | What it does |
|------|--------------|
| `verify_citations` | AGLC statute + neutral/report case citations, checked for **existence and content**. A real section carrying a description of a different provision is `CONTENT_MISMATCH` with the provision the writer meant. |
| `cite_check` | Citator. Back-traces the citation by full-text search over NSW Caselaw, Queensland Judgments and the High Court — **not** LawCite, which is a blocked host and appears only as a deep link — then scans for overruling language. Returns one of five verdicts: `cited`, `overruled_candidate`, `legislative_override`, `not_found`, `unverified_treatment`, always scoped to what was scanned. |
| `applicable_law` | Compilation in force at a date + point-in-time provision text + diff against current + the amending Acts' application/transitional provisions (identified, never interpreted). |
| `impact_map` | Provision → citing cases/tribunals/instruments + mermaid graph. |

## ID scheme (replaces MST/lawId/ordinSeq…)

| Entity | Id field | Format | Example |
|--------|----------|--------|---------|
| Act/instrument series | `registerId` | FRL series id | `C2004A00818` |
| Compilation (point-in-time) | `versionId` | FRL version register id | `C2021C00528` |
| Provision | `provision` | normalised section ref | `s 18`, `s 355-25`, `sch 2 s 18`, `sch 1 item 4`, `reg 2.01` |
| Case | `citation` | medium-neutral citation | `[2020] HCA 41` |
| Decision (any domain) | `id` | per domain — see `docs/API.md` | `nsw:174af54a434669161f7da9d3`, `TR 2024/1`, `operation-wilson` |
| State law | `jurisdiction` + `title` | e.g. `nsw` + title slug | per research |

## Infrastructure parity checklist (ported 1:1 — all shipped in v0.1.0)

Execution budgets · fetch-with-retry · body-shape miss detection ("a 200 that is a failure") ·
chain 45s deadline with partial results · LRU cache (search 1h / text 24h) · token-bucket rate
limiting · AsyncLocalStorage request isolation · stateless Streamable HTTP · CLI with
natural-language router · discover/execute meta layer · 50KB response truncation ·
English date-phrase parser ("as at 1 July 2020", "two years ago") replacing the Korean date engine ·
alias dictionary (LAW_ALIAS_ENTRIES analog: CCA, FW Act, Corps Act, ITAA97, TPA→CCA successor…) ·
repealed-law successor tracing · not-yet-commenced law annotation.

# Australian Law MCP — Tool Mapping (Architect Draft v1)

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

## Exposed tools (10 — identical surface to reference v4.4.0+)

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

| # | Korean domain | Australian domain (`domain` value) | Source |
|---|--------------|-------------------------------------|--------|
| 1 | 판례 (courts) | `cases` — HCA, FCA, FCAFC + state supreme courts | AustLII (+ NSW Caselaw, HCA eresources per research) |
| 2 | 헌재 | `constitutional` — HCA constitutional matters | AustLII HCA filtered |
| 3 | 조세심판원 | `tax_tribunal` — ART/AAT taxation division | AustLII ARTA/AATA |
| 4 | 국세청 해석 | `tax_rulings` — ATO public rulings/determinations | ATO Legal Database |
| 5 | 관세 해석 | `customs` — customs/excise tribunal + rulings | ART customs + ABF (per research) |
| 6 | 법령해석례 (MOLEG interpretations) | `interpretations` — ATO IDs + official interpretive guidance | per research |
| 7 | 행정심판 | `admin_appeals` — ART (formerly AAT) decisions | AustLII ARTA/AATA |
| 8 | 공정위 | `competition` — Australian Competition Tribunal + ACCC | AustLII ACompT |
| 9 | 노동위 | `workplace` — Fair Work Commission decisions | FWC / AustLII FWC/FWCFB |
| 10 | 개보위 | `privacy` — OAIC determinations | AustLII AICmr |
| 11 | 감사원 심사 | `ombudsman` — Cth Ombudsman / integrity bodies | per research |
| 12 | 감사원 특별행심 | `integrity` — NACC/audit decisions | per research |
| 13 | 소청심사 | `public_service` — public-service employment appeals (ART/MPC) | per research |
| 14 | 학칙 | `university_rules` — university legislation/statutes | per research |
| 15 | 공단 규정 | `agency_rules` — statutory agency rules/instruments | FRL notifiable instruments |
| 16 | 공공기관 규정 | `gazettes` — Commonwealth gazette notices | FRL gazettes |
| 17 | 조약 | `treaties` — Australian Treaty Series | DFAT/AustLII ATS |
| 18 | 영문법령 | `explanatory` — Explanatory Memoranda / Statements | AustLII/FRL EMs (AU-specific analog: "the version written for humans") |

Domains 11–16 carry the weakest analogies; final source assignments follow the research reports.
The count and the unified two-tool surface are preserved regardless.

## Unexposed specialized tools (reachable via discover/execute — same names unless noted)

| Category | Tools (AU adaptation notes) |
|----------|------------------------------|
| Search (11) | `search_law`, `search_instruments` (admin-rule analog), `search_state_law` (ordinance analog), `search_cases` (precedents), `search_rulings` (interpretations analog), `search_all`, `suggest_law_names`, `parse_section_ref` (JO analog), `get_law_history`, `advanced_search`, `get_schedules` |
| Retrieval (9) | `get_law_text`, `get_instrument_text`, `get_state_law_text`, `get_case_text`, `get_ruling_text`, `get_batch_provisions`, `get_provision_with_cases`, `compare_old_new` (compilation diff), `get_three_tier` (Act→Regs→Rules) |
| Analysis (10) | `compare_provisions`, `get_law_tree`, `get_provision_history`, `summarize_case`, `extract_case_keywords`, `find_similar_cases`, `get_law_statistics`, `parse_provision_links`, `get_external_links`, `analyze_document` |
| Specialist (4) | `search_tax_tribunal_decisions`/`get_…_text`, `search_customs_rulings`/`get_…_text` |
| Tribunal/committee (8) | constitutional ×2, admin_appeals ×2, competition/workplace/privacy search ×3 + text ×3, ombudsman ×2 |
| Knowledge base (7) | `get_legal_term_kb`, `get_legal_term_detail`, `get_plain_term`, `get_plain_to_legal`, `get_legal_to_plain`, `get_term_provisions`, `get_related_laws` — backed by a bundled AU legal glossary + Act definition-section extraction |
| Other (6+) | `search_ai_law` (natural-language search), `search_explanatory_memoranda`/`get_em_text` (english-law analog), `search_historical_law`/`get_historical_law` (compilation series), `search_legal_terms`, `get_law_system_tree`, `get_law_abbreviations`, `compare_instrument_old_new` |
| Linkage (4) | `get_enabled_instruments` (Act → instruments made under it), `get_instrument_provisions`, `get_enabling_acts` (instrument → enabling Act), `get_state_equivalents` (Cth ↔ state counterpart acts — ordinance-linkage analog) |
| Treaties (2) | `search_treaties`, `get_treaty_text` |
| Institutional (6) | university/agency/gazette search+text pairs (domains 14–16) |
| Special appeals (4) | integrity ×2, public_service ×2 |
| Killer features (4) | `verify_citations` (AGLC statute + neutral/report case citations, existence + content match), `impact_map` (provision → citing cases/tribunals/instruments + mermaid), `cite_check` (LawCite back-trace + overruling-language scan → ✅/⚠️/❌), `applicable_law` (compilation in force at date + point-in-time provision + diff vs current + application/transitional provisions) |
| Chains (8) | `chain_law_system`, `chain_action_basis`, `chain_dispute_prep`, `chain_amendment_track`, `chain_state_law_compare`, `chain_full_research`, `chain_procedure_detail`, `chain_document_review` |
| Meta (2) | `discover_tools`, `execute_tool` |

## ID scheme (replaces MST/lawId/ordinSeq…)

| Entity | Id field | Format | Example |
|--------|----------|--------|---------|
| Act/instrument series | `registerId` | FRL series id | `C2004A00818` |
| Compilation (point-in-time) | `versionId` | FRL version register id | `C2021C00528` |
| Provision | `provision` | normalized section ref | `s 18`, `s 355-25`, `sch 2 it 4` |
| Case | `citation` | neutral citation | `[2020] HCA 41` |
| State law | `jurisdiction` + `title` | e.g. `nsw` + title slug | per research |

## Infrastructure parity checklist (ported 1:1, already in progress)

Execution budgets · fetch-with-retry · body-shape miss detection ("a 200 that is a failure") ·
chain 45s deadline with partial results · LRU cache (search 1h / text 24h) · token-bucket rate
limiting · AsyncLocalStorage request isolation · stateless Streamable HTTP · CLI with
natural-language router · discover/execute meta layer · 50KB response truncation ·
English date-phrase parser ("as at 1 July 2020", "two years ago") replacing the Korean date engine ·
alias dictionary (LAW_ALIAS_ENTRIES analog: CCA, FW Act, Corps Act, ITAA97, TPA→CCA successor…) ·
repealed-law successor tracing · not-yet-commenced law annotation.

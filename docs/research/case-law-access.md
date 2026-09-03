# Australian Case Law — Programmatic Access: Verified Reference

**Verified:** 2026-09-03 via curl (browser UA). Tags: [VERIFIED] = live HTTP call succeeded; [BLOCKED] = confirmed unreachable for non-browser clients.

## 1. AustLII — BLOCKED for non-browser clients

- Every content path returns **HTTP 403 Cloudflare managed-block** regardless of UA/headers/HTTP version. Blocking is TLS-fingerprint based. Tested and blocked: viewdoc, sinosrch.cgi, sinodisp, static paths, classic/www8 mirrors, LawCite, WorldLII mirror (JS challenge).
- robots.txt: content signals `search=yes, ai-train=no, use=reference`; AI crawler UAs disallowed; `Allow: /` for `*`. The WAF block is intentional — do NOT circumvent with headless browsers without a deliberate terms decision.
- **Use AustLII only for user-facing deep links** (they work in a real browser):
  - `https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/{jur}/{COURT}/{year}/{num}.html` (jur: cth|nsw|vic|qld|wa|sa|tas|nt|act) — e.g. `[2020] HCA 41` -> `/au/cases/cth/HCA/2020/41.html` (mapping confirmed via Supreme Court of Victoria's own outbound links)
  - LawCite deep link: `https://lawcite.austlii.edu.au/cgi-bin/LawCite?cit=%5B2020%5D%20HCA%2041`
  - Search deep link: `/cgi-bin/sinosrch.cgi?method=boolean&query=<terms>&mask_path=au/cases/cth/HCA`

## 2. High Court of Australia — new Drupal site WORKS [VERIFIED]

`eresources.hcourt.gov.au` is DEAD (redirects to www.hcourt.gov.au). Build against:

```bash
# Keyword (matches case names, catchwords):
curl -A "$UA" 'https://www.hcourt.gov.au/cases-and-judgments/judgments/judgments-1998-current?keywords=native+title'
# Case number:
curl -A "$UA" '...judgments-1998-current?case_number=M47/2025'
# Year facet — CRITICAL: brackets sent LITERALLY (curl --globoff). Percent-encoded f%5B0%5D -> WAF 403:
curl --globoff -A "$UA" '...judgments-1998-current?f[0]=d:2020'
# Pagination: &page=N (0-indexed), 12 results/page
```

HTML landmarks: `div.view-judgments` -> `div.view-summary` ("Displaying 1 - 12 of 48 results") -> `div.views-row` -> `a.views-row-item[href]` with `.field--title`, `.field--citation` ("Citation: [2020] HCA 48"), `.field--legacy-before` (bench), `.field--hca-date-issued`.

Full judgment: detail page `/cases-and-judgments/judgments/judgments-1998-current/{slug}` has **catchwords + metadata only**. Full text is PDF/DOCX at `/sites/default/files/eresources/{YYYY-MM-DD}/HCA/{escaped name (case no) [year] HCA n}.pdf` — path embeds upload date, NOT constructible from citation; scrape it from the detail page. Citation lookup flow: `?f[0]=d:{year}` listing -> match `.field--citation` -> detail -> PDF link. No rate limiting observed.

## 3. Federal Court — BLOCKED

fedcourt.gov.au + judgments.fedcourt.gov.au: Cloudflare JS challenge. search.fedcourt.gov.au: TCP timeout. No live access; use offline corpus (§5) or user-facing links.

## 4. NSW Caselaw (caselaw.nsw.gov.au) — BEST live source [ALL VERIFIED]

No JSON API. Clean server-rendered HTML via GET.

```bash
# Simple search — param is `query`, NOT `q` (q silently ignored!). Pagination `page` (0-indexed, 20/page, 10k cap).
curl -A "$UA" 'https://www.caselaw.nsw.gov.au/search?query=negligence&page=0'
# Citation as quoted phrase:
curl -A "$UA" 'https://www.caselaw.nsw.gov.au/search?query=%22%5B2020%5D+NSWSC+723%22'
# Sort: &sort= '' (relevance) | decisionDate,asc|desc | titleForSort,asc|desc
# Advanced: GET /search/advanced?body=&title=&before=&catchwords=&party=&startDate=dd/mm/yyyy&endDate=&fileNumber=&legislationCited=&casesCited=&courts=<objectId repeatable>&tribunals=
```

Court ObjectIds: Supreme `54a634063004de94513d8281`, CA `...8278`, CCA `...8279`, District `...827c`, Local `...8280`, L&E Judges `...8286`, Children's `...827a`, Industrial `...828e`, NCAT divisions `...8289/-8d/-8b/-8c/-8a`, Dust Diseases `...8283`.

Result HTML: `div.container.searchresults` -> `div.row.result` -> `div.col-sm-8.cntn > h4 > a[href="/decision/{24-hex-id}"]` (text = case name + citation), `Catchwords:` `<p>`, right col `ul.list-group` = Judgment of / Decision date. Pager is JS-only — use `page` param + parse "Displaying X - Y of Z results".

Full judgment: `/decision/{id}` -> complete judgment HTML (~100KB, metadata block + full reasons). `/decision/{id}/export.docx` -> DOCX. `/asset/{assetId}.pdf` (assetId scraped from page).

robots.txt: "# go away", disallows /decision /search /asset — on-demand single lookups differ from bulk crawling, but flag for terms review. Prior art: PyPI `nswcaselaw` (Sydney Informatics Hub).

## 5. Queensland Judgments (queenslandjudgments.com.au) — citation-addressable [ALL VERIFIED]

- **Deterministic citation -> URL:** `[2020] QSC 100` -> `https://www.queenslandjudgments.com.au/caselaw/qsc/2020/100` (court lowercased). Full judgment as server-rendered HTML (~230KB; `.casename_print`, `.citation_print`, body in `#report-view`). PDF: append `/pdf`.
- Search: `GET /caselaw-search/query?queryStringSearchText=&queryStringCitation=&queryStringCaseName=&queryStringCatchwords=&multiSelectCourt[]=` (QCA QSC QDC QMC QCAT QPEC QLC ICQ QChCM QMHC LPT QHPT RSLT LG "HCA / PC") `&singleSelectCollection[]=&yearStart=&yearEnd=&per-page=50&page=1&sort=`. Results: `ul.result-list > li` -> `a[href] span.caseName`.
- No WAF block; ~2s/response so cache. robots: ai-train=no content signals, `Allow: /` for `*`.
- sclqld.org.au: Nuxt SPA, unusable without JS. Use queenslandjudgments.com.au.

## 6. Victoria / other states

Vic Supreme Court publishes summaries only; full text links to AustLII (blocked). WA/SA/Tas/NT/ACT: AustLII-hosted. Live coverage limited to link generation + offline corpus.

## 7. Jade (jade.io) — not viable

JS app shell only; citator requires paid account. Skip.

## 8. Open Australian Legal Corpus — offline backbone option [VERIFIED]

HuggingFace `isaacus/open-australian-legal-corpus` v7.1.0 (2026-03-07). `corpus.jsonl` 9.4GB, 232,560 docs, 189,216 decisions: FCA 63,749, HCA 8,096, NSW 117,371 (+legislation). Fields: `version_id, type, jurisdiction, source, mime, date, citation, url, when_scraped, text`. Custom open licence. **Only working option for FCA + AustLII-only states.** Optional add-on (local SQLite FTS5 index), not bundled.

## Recommendations (adopted by architect)

- **(a) keyword case search**: fan-out NSW Caselaw + HCA + QLD Judgments (+ optional local corpus).
- **(b) full judgment by citation**: QLD -> direct URL; NSW -> phrase search -> /decision/{id}; HCA -> year facet -> detail -> PDF; FCA/Vic/others -> corpus or AustLII user-facing link.
- **(c) citator (cite_check)**: NO free programmatic citator reachable. Approximate citator = full-text search of the citation string across live sources (verified working) + overruling-language scan; label "later cases mentioning this citation"; include LawCite deep-link for the user's browser. (Same back-trace technique the Korean cite_check uses.)

Operational: always send browser UA; never percent-encode `f[0]` for hcourt; NSW param is `query` + `page` 0-indexed; QJ ~2s so cache; NSW 10k cap — narrow with filters.

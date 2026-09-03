# Australian Tribunals / State Legislation / Treaties — Verified Reference

Live-tested with curl 2026-09-03 (Chrome UA). "VERIFIED" = search and/or retrieval returned real data.

## CRITICAL: AustLII hard-blocked for curl
All hosts/paths return 403 Cloudflare regardless of headers. Domains whose only full text is AustLII (ART/AATA, AICmr, ATS treaty texts) are metadata + user-facing-link only.

## MAPPING TABLE

| Korean domain | Australian equivalent | Access | Verified? |
|---|---|---|---|
| Statutes | Cth Acts/instruments | FRL OData + EPUB/HTML | YES |
| Local ordinances | State/territory legislation | QLD/TAS projectdata JSON; WA Domino HTML+Atom; VIC PDF/DOCX+sitemap; NT Sitecore PDF/Word; ACT deep URLs | QLD TAS WA yes; VIC NT ACT partial; NSW SA blocked |
| Court precedents | HCA judgments | hcourt.gov.au SSR + PDF/DOCX | YES (FCA blocked) |
| Constitutional court | HCA constitutional cases | `?keywords=constitutional` (catchwords) | YES |
| Admin appeals / tax tribunal | ART (ex-AAT) | AustLII-only full text | BLOCKED (metadata+link) |
| Tax rulings | ATO Legal Database | POST search API + doc view | YES |
| Labor commission | Fair Work Commission | document-search SSR + PDF | YES |
| Fair trade | ACCC / Competition Tribunal / FedCourt | all WAF-blocked | BLOCKED |
| Privacy | OAIC determinations | SSR index (title+[2026] AICmr N+link); full text AustLII | index YES |
| Anti-corruption | NACC | site reachable, no decision register | partial |
| Treaties | DFAT Australian Treaties Database | POST JSON API | YES |
| Gazettes | FRL Gazette collection | OData filter | YES |
| Legal dictionary | SL NSW Legal Answers glossary + Act definition parts + QLD/TAS DefinedTerm CCL | HTML | YES |
| English-translated law | n/a (AU law is English) | — | n/a |
| Govt legal interpretations | no public equivalent; nearest = ATO IDs | — | gap |

## 2. STATE/TERRITORY LEGISLATION

### QLD — legislation.qld.gov.au — VERIFIED (best state API)
JSON at `/projectdata` (values wrapped `{"__type__","__value__"}`):
```bash
# Browse in-force acts (JSON)
curl "https://www.legislation.qld.gov.au/projectdata?ds=OQPC-BrowseDataSource&config=Y&start=1&count=20&sortDirection=asc&expression=Repealed%3DN+AND+PrintType%3D%22act.reprint%22&subset=browse&collection="
# FULL-TEXT SEARCH (30-60s! use 90s timeout)
curl -m 90 "https://www.legislation.qld.gov.au/projectdata?ds=OQPC-FragTocRelationIdxDatasource&config=Y&start=1&count=10&expression=Repealed%3DN%20AND%20PrintType%3D%22act.reprint%22%20AND%20Content%3D(murder)&subset=F&collection="
# -> records: id ("Act-2000-005"), title, version.series.id, version.desc.id, publication.date
# WHOLE-ACT HTML (must use /whole/; /view/html/... is a JS shell)
curl "https://www.legislation.qld.gov.au/view/whole/html/inforce/current/act-1899-009"
```
CCL fields: `Content, Title, Heading, "Part,Division", Schedule, DefinedTerm, Titles`; stemming `@fuzzy=80(term)`; boolean `Content=(a AND b)`. Per-doc hits: `ds=OQPC-FragHitListDataSource&expression=VersionSeriesId="..." AND VersionDescId="..." AND PrintType="..." AND (Content=(...))`.

### TAS — legislation.tas.gov.au — VERIFIED (same EnAct platform; prefix `EnAct-` not `OQPC-`)
```bash
curl -m 60 "https://www.legislation.tas.gov.au/projectdata?ds=EnAct-FragTocRelationIdxDatasource&config=Y&start=1&count=10&expression=Repealed%3DN%20AND%20Content%3D(dog)&subset=F&collection="
curl "https://www.legislation.tas.gov.au/view/whole/html/inforce/current/act-1924-069"
```

### WA — legislation.wa.gov.au — VERIFIED (browse + full text; no curl-able search)
Base `https://www.legislation.wa.gov.au/legislation/statutes.nsf/`:
```bash
curl ".../actsif_c.html"    # A-Z in-force per letter; links law_aNNN.html, class="citation alive"
curl ".../law_a196.html"    # act page (+ .atom currency feed)
curl -L ".../RedirectURL?OpenAgent&query=mrdoc_49336.htm"   # FULL TEXT HTML (mrdoc id from act page; also .pdf/.docx)
```
Search = title-match over the A-Z lists (Domino search form not curl-reproducible).

### VIC — legislation.vic.gov.au — PARTIAL
SSR act pages `/in-force/acts/crimes-act-1958` + version pages `/305`. Full text = authorised PDF/DOCX from content.legislation.vic.gov.au (links in version page). Search: use `https://www.legislation.vic.gov.au/sitemap.xml` slug matching (Elasticsearch proxy not reachable via curl).

### NT — legislation.nt.gov.au — PARTIAL
```bash
curl "https://legislation.nt.gov.au/en/LegislationPortal/Acts/By-Title"    # 385 act links, use for title search
curl "https://legislation.nt.gov.au/en/Legislation/CRIMINAL-CODE-ACT-1983" # act page
curl -L "https://legislation.nt.gov.au/api/sitecore/Act/PDF?id=11734"      # or /Act/Word?id=11734
```

### ACT — legislation.act.gov.au — PARTIAL (homepage F5-walled, deep URLs open)
```bash
curl "https://www.legislation.act.gov.au/a/2001-14/"
curl "https://www.legislation.act.gov.au/DownloadFile/a/2001-14/current/PDF/2001-14.PDF"   # also /DOCX/
```

### NSW + SA — BLOCKED (Cloudflare, all paths incl. search). AustLII fallback also blocked. Link-only.

## 3. ART/AAT — art.gov.au confirms decisions publish to AustLII only (`/au/cases/cth/ARTA/`, `/AATA/`). Blocked -> metadata/deep-link domain.

## 4. ATO Legal Database — VERIFIED
API base `https://www.ato.gov.au/API/v1/law/lawservices/`:
```bash
# SEARCH — POST form-encoded; returns HTML fragment (10 items), totals in hidden inputs
curl -X POST "https://www.ato.gov.au/API/v1/law/lawservices/result" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "tm_and=capital+gains+main+residence"
# hidden inputs: total=2584, start, pageSize; items: <li class="document"><a class="resultTitle" href="/law/view/document?...docid=TXR%2F...">, <div class="summary">
# Params: tm_and (all words), tm_phrase (exact), tm_or / tm_sis; paging start & pageSize.
# FULL TEXT — server-rendered HTML:
curl "https://www.ato.gov.au/law/view/document?DocID=TXR%2FTR20065%2FNAT%2FATO%2F00001"
```
DocID prefixes: `TXR/` rulings (TR), `TXD/` determinations (TD), `AID/` interpretative decisions. Other endpoints: `search`, `advancedsearch`, `quicksearch?fid=`, `browse`, `browse-header` (JSON), `browse-content`. Allow 60s.

## 5. Fair Work Commission — VERIFIED
```bash
curl "https://www.fwc.gov.au/document-search?search-ui=decisions&search=genuine%20redundancy&sort=search_api_relevance%3ADESC&page=0"
# NOTE: the "N results" count element always shows facet total (186,201) — ignore; rows ARE filtered.
# Rows: div.views-row.faceted-search-item -> title "<case name> - [2026] FWCA 2428",
#   link /document-view/decisions/<slug>?from=search, snippet, PDF /document-view/media/download/<id>
# Facets: &f[0]=bench-type:full|single, case-type:<tid>. Other search-uis: awards, agreements, rlhao.
curl -L -o d.pdf "https://www.fwc.gov.au/document-view/media/download/883192"   # FULL TEXT PDF
```

## 6. ACCC / Competition Tribunal / judgments.fedcourt.gov.au — all blocked (WAF/Cloudflare). Link-only.

## 7. OAIC — index VERIFIED
```bash
curl "https://www.oaic.gov.au/privacy/privacy-assessments-and-decisions/privacy-decisions/privacy-determinations"
# entries: title + [2026] AICmr N + AustLII link. Pagination: ?result_26111_result_page=2
```

## 8. DFAT Australian Treaties Database — VERIFIED JSON API
```bash
curl -X POST "https://docs.dfat.gov.au/api/search" -H "Content-Type: application/json" \
  -d '{"keyword":"extradition","page":1,"facets":{},"dateFilters":{}}'
# -> {"totalCount":177,"currentPage":1,"pageSize":20,"totalPages":9,"results":[...],"facets":{...}}
```
Result fields (40+): `Title, ShortTitle, AtsNumber ("[2011] ATS 29"), AtsLink, AtnifNumber/Link, AtniaNumber/Link, TreatyStatusAustralia, AgreementType, Countries[], Subject, DoneAtPlace/Date, EntryIntoForceForAustraliaDate, TablingDate*, JscotReportNumber/Url, Depositary, TreatyActions, Id`. Facet names come back in response; `GET /api/treaty/<id>` is 401 (not needed). Full-text links -> AustLII (link-only). SPA routes return 404 status with valid shell — ignore status.

## 9. Gazettes — FRL `collection eq 'Gazette'` (18,593; registerId like C2025G00695, same download grammar).

## 10. Legal dictionary — `https://legalanswers.sl.nsw.gov.au/glossary` (SSR HTML). Plus: ACT acts end with a statutory Dictionary part; QLD/TAS support `DefinedTerm=(...)` CCL — usable for defined-terms lookup.

## Constitutional matters — HCA is the forum; filter `keywords=constitutional` (matches catchwords like "Constitutional law (Cth) — s 92") on hcourt.gov.au (verified; "xylophone" -> 0 rows confirms filtering).

## Rate-limit / terms
- FRL: open, CC BY 4.0.
- QLD/TAS projectdata: 30-90s server-side — 90s+ timeouts, cache aggressively, small `count`.
- ATO: 60s timeout; POST-only form-encoded.
- FWC/HCA/OAIC: polite scraping (1 req/s, cache).
- Blocked set (link-only): AustLII, NSW legislation, SA, ACCC, Competition Tribunal, Fed Court judgments, ACT homepage (deep links fine).

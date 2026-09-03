# Follow-up research (live-verified 2026-09-03)

Companion to `grok-au-law-landscape.md`. Tool names follow `docs/TOOL-MAPPING.md`. All HTTP claims below are from curl on this host unless marked otherwise.

---

## Part 1 — FRL Explanatory Statements and Act Explanatory Memoranda

### 1.1 Legislative-instrument ES — end-to-end download **works**

Instrument used: **F2011L00287** (*11/1198 - Alternative Means of Compliance to FAA Airworthiness Directive 2009-26-11*), as-made **2011-02-21**.

OData listing (`GET /v1/Documents?$filter=titleId eq 'F2011L00287'`):

| type | format | sizeInBytes | authorised | extension |
|------|--------|-------------|------------|-----------|
| Primary | Pdf | 108229 | true | .pdf |
| **ES** | **Pdf** | **100818** | **true** | **.pdf** |
| ES | Word | 27648 | false | .doc |
| Primary | Word | 183296 | false | .doc |
| ES | Epub | 5113 | false | .epub |
| Primary | Epub | 36152 | false | .epub |

`DocumentType` enum still has `ES=1` (see landscape report).

#### Website URL grammar (canonical)

```
https://www.legislation.gov.au/{titleId}/asmade/{yyyy-mm-dd}/es/original/{pdf|epub|word}
```

Live:

| URL | HTTP | Result |
|-----|------|--------|
| `https://www.legislation.gov.au/F2011L00287/asmade/2011-02-21/es/original/pdf` | **200** `application/pdf` | **100,818 bytes**, PDF 1.5, 1 page. `Content-Disposition: filename=F2011L00287ES.pdf` |
| `…/es/original/epub` | **200** `application/epub+zip` | **5,113 bytes**, ZIP/EPUB. `filename=F2011L00287ES.epub` |
| `…/es/original/word` | **200** `application/msword` | **27,648 bytes**, `.doc`. `filename=F2011L00287ES.doc` |
| `https://www.legislation.gov.au/F2016L01565/asmade/2016-09-30/es/original/pdf` (second instrument) | **200** | **733,988 bytes**, PDF 1.4, **24 pages**. `F2016L01565ES.pdf` |

The date segment is the **as-made / making date**, not “today”.

#### `{id}/asmade/asmade/es/original/pdf` (the guessed doubled path)

**Also 200**, same 100,818-byte PDF as the dated URL. FRL treats the second `asmade` as the as-made specification (sibling of a `yyyy-mm-dd` compilation start). Prefer the **dated** form in production so you know which version you fetched; the doubled form is a convenient alias when you do not yet have the making date.

#### SPA HTML (not the bytes)

`https://www.legislation.gov.au/F2011L00287/asmade/text/explanatory-statement` → **200 text/html** (77,674 bytes), the Register Angular/IIS shell. Fine for humans; **not** an ES body. Do not parse this as the statement.

#### OData bytes (preferred for MCP)

Composite-key GET — **works** (unlike `Documents/Find`, which 404’d again):

```
GET https://api.prod.legislation.gov.au/v1/Documents(
  titleId='F2011L00287',
  start=2011-02-21T00:00:00Z,
  retrospectiveStart=2011-02-21T00:00:00Z,
  rectificationVersionNumber=0,
  type='ES',
  uniqueTypeNumber=0,
  volumeNumber=0,
  format='Pdf'
)
→ 200 application/pdf, 100818 bytes, filename=F2011L00287ES.pdf
```

Same key with `format='Epub'` → 200, 5,113-byte EPUB.

Recipe for `search_explanatory_memoranda` / `get_em_text` / domain `explanatory` on **instruments**:

1. Resolve title (`Titles` / `search_law`).
2. `Documents?$filter=titleId eq '{id}' and type eq 'ES'`.
3. GET composite key (Pdf for authorised; Epub if you want XML/HTML inside).
4. Fallback website `/{id}/asmade/{start:yyyy-MM-dd}/es/original/pdf`.

Acts **do not** carry `type=ES` documents on FRL. That is the EM problem below.

### 1.2 Act Explanatory Memoranda — programmatically reachable as HTML; PDFs need a Referer

FRL does **not** host EMs. It stores `originatingBillUri` on the Title (live):

| Act | titleId | originatingBillUri |
|-----|---------|--------------------|
| *Fair Work Act 2009* | C2009A00028 | `https://parlinfo.aph.gov.au/parlInfo/search/display/display.w3p;query=Id:"legislation/billhome/r4016"` |
| *Administrative Review Tribunal Act 2024* | C2024A00040 | `…/legislation/billhome/r7117` |
| *Privacy Legislation Amendment (Enforcement and Other Measures) Act 2022* | C2022A00083 | `…/legislation/billhome/r6940` |

Bill-home id pattern: `legislation/billhome/{r|s}{nnnn}` (`r` = House, `s` = Senate).

#### APH bill homepage (best index)

```
https://www.aph.gov.au/Parliamentary_Business/Bills_Legislation/Bills_Search_Results/Result?bId=r6940
```

Live: **HTTP 200**, 90,923 bytes HTML, contains the short title **and** EM download links. Extracted hrefs (real):

```
https://parlinfo.aph.gov.au/parlInfo/search/display/display.w3p;query=Id:"legislation/ems/r6940_ems_715c9651-94ce-4b91-9912-a4023d8c7f61"
https://parlinfo.aph.gov.au/parlInfo/download/legislation/ems/r6940_ems_715c9651-94ce-4b91-9912-a4023d8c7f61/upload_pdf/22113%20EM.pdf;fileType=application/pdf
https://parlinfo.aph.gov.au/parlInfo/download/legislation/ems/r6940_ems_715c9651-94ce-4b91-9912-a4023d8c7f61/upload_word/22113%20EM.DOCX;fileType=…
https://parlinfo.aph.gov.au/parlInfo/download/legislation/ems/r6940_ems_ec367c09-f2c4-4f0c-8b94-ddb88b0794b4/upload_pdf/Supplementary%20EM%20-%20Privacy%20LA%20(Enforcement%20and%20OM)%20Bill%202022.pdf;fileType=application/pdf
```

Grammar:

```
https://parlinfo.aph.gov.au/parlInfo/download/legislation/ems/{billId}_ems_{uuid}/upload_pdf/{filename}.pdf;fileType=application/pdf
https://parlinfo.aph.gov.au/parlInfo/search/display/display.w3p;query=Id:"legislation/ems/{billId}_ems_{uuid}"
```

You **cannot** guess `{uuid}` or `{filename}`. Scrape them from the APH `bId=` page (or the ParlInfo billhome HTML, which also lists `legislation/ems/...`).

#### ParlInfo HTML of the EM (curl gets the actual text)

```
https://parlinfo.aph.gov.au/parlInfo/search/display/display.w3p;query=Id:"legislation/ems/s1493_ems_73602a77-426e-4fa3-aa0a-2bfc4f7156df"
```

Live: **200**, 164,237 bytes, landmarks `EXPLANATORY MEMORANDUM`, `Circulated by authority`, `General outline`, `Schedule 1`, Treasurer Chalmers. This is usable EM body without a PDF.

`displayPrint.w3p` with the same `Id:` query also 200 (125,073 bytes) — printer view.

Billhome pages (`legislation/billhome/r6940`, `r7117`) 200, contain `Explanatory Memorandum` + `legislation/ems` links.

#### ParlInfo PDF download

| Request | Result |
|---------|--------|
| GET download URL, no Referer | **403** Azure WAF JS challenge (`<title>Azure WAF</title>`, ~8 KB HTML, `x-azure-ref`) |
| GET same URL with `Referer: https://www.aph.gov.au/Parliamentary_Business/Bills_Legislation/Bills_Search_Results/Result?bId=r6940` and a browser UA | **200 application/pdf**, **324,704 bytes**, PDF 1.7, **25 pages** (Privacy LA 2022 EM) |
| Guessed `…/r6940_ems/upload_pdf/r6940em.pdf` (no UUID) | **404** TeraText “Not Found” |

So: **HTML EM is curl-open; PDF is curl-open only with a same-site/APH Referer** (and a real UA). Bare wget of the download path is WAF-blocked. For `get_em_text`, prefer:

1. FRL `originatingBillUri` → APH `bId=` page → collect `legislation/ems/{id}_ems_{uuid}` hrefs.
2. Fetch `display.w3p;query=Id:"legislation/ems/…"` HTML (full text).
3. Optionally fetch `upload_pdf` with `Referer` set to the APH bill page.

There is **no** FRL OData entity for EMs and **no** stable ParlInfo JSON API. Bills Digests (`/Parliamentary_Business/Bills_Legislation/bd/…` and `parlInfo/download/legislation/billsdgs/{n}/upload_binary/{n}.pdf`) are a second human-readable layer; not verified as PDF-bytes in this pass.

---

## Part 2 — NSW Caselaw `mnc` GET, re-verified

Endpoint family:

- Advanced form (does **not** search by itself): `GET https://www.caselaw.nsw.gov.au/search/advanced`
- Results (form `action="/search"`): `GET https://www.caselaw.nsw.gov.au/search`

Citation under test: **`[2010] NSWCCA 333`** = *Dela Cruz v R*, decision URI `/decision/549fff1d3004262463c85662`. Court id for CCA: `54a634063004de94513d8279`.

### Matrix (all GET, 2026-09-03)

| # | URL + params | Displaying? | Hits | First decision | Notes |
|---|--------------|-------------|------|----------------|-------|
| 1 | `/search/advanced?mnc=[2010] NSWCCA 333` | **no** | form only | — | **mnc-only on advanced is dead.** Matches the other researcher. |
| 2 | `/search/advanced` + empty `page,body,title,…` + `mnc=` | **no** | form only | — | Empty fields do not trigger search. |
| 3 | `/search/advanced?query=[2010] NSWCCA 333` | **no** | form only | — | `query` is **not** an advanced-form field. |
| 4 | `/search/advanced` + `mnc=` + `_courts=on` + `courts=54a634063004de94513d8279` + `_tribunals=on` | **yes** | **1 of 1** | `/decision/549fff1d3004262463c85662` *Dela Cruz* | **This is the working MNC search.** |
| 5 | same as 4 but **all 13 court ids** selected | **yes** | **1 of 1** | Dela Cruz | MNC is exact; extra courts do not inflate. |
| 6 | `/search/advanced` + `mnc=2010 NSWCCA 333` (no brackets) + CCA court | **yes** | **0 of 0** | — | Brackets are mandatory (as Search Tips say). |
| 7 | `/search/advanced` + `body=[2010] NSWCCA 333` (no courts) | **no** | form only | — | |
| 8 | `/search/advanced` + `body=[2010] NSWCCA 333` + CCA court | **yes** | **9,890** | Dela Cruz first, then many others | `body` is full-text, not the MNC field. Unusable as a citator lookup. |
| 9 | `/search?mnc=[2010] NSWCCA 333` | **yes** | **10,000** | unrelated recent ids; h1 searchquery **empty** | **`mnc` is ignored on `/search`.** |
| 10 | `/search?body=[2010] NSWCCA 333` | **yes** | 10,000 | same junk as 9; query empty | `body` ignored on simple search. |
| 11 | `/search?query=[2010] NSWCCA 333` | **yes** | **10,000** | Dela Cruz **first**, then lots of later citers | Simple-box **phrase** search. Not exact. Caps at 10k. |

### Exact param set that reproduces example 8.4 (1 hit)

```
GET https://www.caselaw.nsw.gov.au/search/advanced
  ?page=
  &body=
  &title=
  &before=
  &catchwords=
  &party=
  &mnc=[2010]%20NSWCCA%20333
  &startDate=
  &endDate=
  &fileNumber=
  &legislationCited=
  &casesCited=
  &_courts=on
  &courts=54a634063004de94513d8279
  &_tribunals=on
```

Minimum that actually runs: **`mnc` + at least one `courts=` (or `tribunals=`) id + `_courts=on`**. Without a selected court/tribunal checkbox, GET returns the blank advanced form — which is what “mnc param dead via GET” looks like.

### Phrase search vs MNC field

- **Exact lookup:** advanced `mnc=` + court filter → 1 row. Use this for `get_case_text` / `search_cases` when the user typed a NSW MNC.
- **Phrase:** `/search?query=[2010] NSWCCA 333` → Dela Cruz plus every later decision that *mentions* the citation (9,890 on `body`+court; 10,000 cap on simple search). That is a cheap NSW **Noteup**, not an identifier lookup.
- Simple `/search` does **not** honour `mnc` or `body`. Only `query`.

Recommendation for the client: if the citation matches `\[20\d{2}\] NSW[A-Z]+ \d+`, map court code → hex id, then call advanced `mnc=` with that id. Fall back to `/search?query=` only for “cited by” style tasks.

---

## Part 3 — Degraded domains + ATO legal database

### 3.1 Merit Protection Commissioner — **curl-reachable HTML index** (upgrade from “degraded / attempt only”)

Host **200**, no WAF: `https://www.mpc.gov.au/` (Drupal/GovCMS, 47,947 bytes). Title: *Merit Protection Commissioner*.

| Page | URL | Live | Landmarks |
|------|-----|------|-----------|
| Home | https://www.mpc.gov.au/ | 200 | nav: Review of Actions, Resources |
| **Case studies of merits review outcomes** | https://www.mpc.gov.au/resources/case-studies-merits-review-outcomes | **200**, 90,647 bytes | `<h1>Case studies of merits review outcomes</h1>`, `<h2>Our decisions</h2>`, `<h2>Filter by code of conduct</h2>`, Drupal `pager` (10 hits), `article` cards, facet `?f[0]=filter_by_code_of_conduct:18#case-summaries-results` and `filter_by_employment_related_actions` |
| Policies / PDFs | https://www.mpc.gov.au/resources/policies-and-publications | 200 | PDF hrefs under `/sites/default/files/20xx-xx/…pdf` (discretion not to review; Code of Conduct procedures 2025; PRC Instructions) |
| Annual reports | https://www.mpc.gov.au/resources/annual-reports | 200 | `Annual Report 2024-25.pdf` etc. + transparency.gov.au mirrors |
| Promotion review notifications | https://www.mpc.gov.au/review-actions/review-promotion-decisions/promotion-review-notifications | 200 | “find a notice” node links (`/node/59`, `/review-actions/review-promotion-decisions/find-a-notice-about-a-review`) |

There is **no JSON search** and **no MNC corpus**. What exists is a **paged, facet-filtered HTML case-study index** plus policy PDFs. Enough for `search_decisions(domain=public_service)` to scrape the case-studies listing and return titles + node URLs, with a `[NOT_A_TRIBUNAL_DECISION]` caveat. Individual reviews of APS promotions are mostly notices, not reasons.

### 3.2 NACC — **curl-reachable report listing + PDFs**

`https://www.nacc.gov.au/` **200** (Drupal 11 + GovCMS, 142,581 bytes). Not Cloudflare.

**Index (the listing that counts):**

https://www.nacc.gov.au/investigation-reports-and-case-studies  
**200**, 149,804 bytes. Landmarks: `<h1>Investigation reports and case studies</h1>` then per-operation `<h2>`/`<h1>` anchors:

`#operation-angelo` `#operation-bannister` `#operation-elektra` `#operation-kingscliff` `#operation-myrtleford` `#operation-overbeek` `#operation-pelican` `#operation-pentecost` `#operation-roe-` `#operation-wilson` `#operation-young`

Direct report PDFs (curl **200 application/pdf** verified on Wilson, 442,673 bytes):

```
https://www.nacc.gov.au/sites/default/files/documents/2025-02/Operation Wilson - Investigation Report.pdf
https://www.nacc.gov.au/sites/default/files/documents/2024-10/operation_bannister_-_investigation_report.pdf
https://www.nacc.gov.au/sites/default/files/documents/2025-06/Investigation Report - Operation Elektra_0.pdf
https://www.nacc.gov.au/sites/default/files/documents/2026-03/Operation Myrtleford Investigation Report.pdf
https://www.nacc.gov.au/sites/default/files/documents/2026-04/Operation Pelican Investigation Report.pdf
https://www.nacc.gov.au/sites/default/files/documents/2026-06/Operation Pentecost - Investigation Report_0.pdf
https://www.nacc.gov.au/sites/default/files/documents/2026-05/Operation Young - Investigation Report.pdf
```

Also HTML case-studies `https://www.nacc.gov.au/case-study-operation-{name}` and some `/operation-{name}` pages. News index: https://www.nacc.gov.au/about-nacc/news-and-media (200).

No full-text search API. For domain `integrity`: scrape the investigation-reports page (it’s a single HTML index, not a pager), emit operation name + PDF URL. Do **not** claim “no NACC reports exist”.

### 3.3 Commonwealth Ombudsman — **still blocked**

```
GET https://www.ombudsman.gov.au/          → 403  Cloudflare "Just a moment..."
GET https://www.ombudsman.gov.au/publications
GET https://www.ombudsman.gov.au/publications-and-news/reports
```

All 403, ~5.4 KB challenge HTML, zero hrefs. Domain `integrity` must map Ombudsman to `[UPSTREAM_BLOCKED]` + the human URL. Do not 404-wash.

### 3.4 Anti-Dumping Review Panel — **curl-reachable HTML review index** (adreviewpanel.gov.au redirects)

`https://www.adreviewpanel.gov.au/` **301/200** → `https://www.industry.gov.au/trade/anti-dumping-review-panel` (174,795 bytes). Title: *Anti-Dumping Review Panel | Department of Industry Science and Resources*. Landmarks: `<h2>Applications</h2>` `<h2>Reviews</h2>` `<h2>Current reviews</h2>` `<h2>Past reviews</h2>`.

Child indexes (all 200 HTML):

| Page | URL |
|------|-----|
| Current reviews | https://www.industry.gov.au/trade/anti-dumping-review-panel/current-anti-dumping-review-panel-reviews |
| Past reviews | https://www.industry.gov.au/trade/anti-dumping-review-panel/past-anti-dumping-review-panel-reviews (**289,972 bytes**, 150+ case hrefs, goods `<option>` filter e.g. `Hot rolled plate steel`) |
| Judicial-review subset | https://www.industry.gov.au/trade/anti-dumping-review-panel/judicial-past-anti-dumping-review-panel-reviews |
| Applications / duty assessment | https://www.industry.gov.au/trade/anti-dumping-review-panel/anti-dumping-review-panel-applications-and-duty-assessment-reviews |
| Process | https://www.industry.gov.au/trade/anti-dumping-review-panel/anti-dumping-review-panel-review-process |

Case URL grammar (live examples on the past-reviews page):

```
https://www.industry.gov.au/trade/anti-dumping-review-panel/past-anti-dumping-review-panel-reviews/{slug}
e.g. …/deep-drawn-stainless-steel-sinks-exported-peoples-republic-china
     …/aluminium-extrusions-peoples-republic-china
     …/a4-copy-paper-exported-peoples-republic-china
```

Guessed `/anti-dumping-review-panel/reviews` **404**. Use the long official paths. Email alerts: `https://comms.industry.gov.au/anti-dumping-review-panel-updates-subscribe`. Contact `ADRP@industry.gov.au`.

For domain `customs`: scrape current + past review indexes (HTML, no JSON). Pair with ATO customs/excise docs.

### 3.5 ATO Legal Database — document `docid` works; `fid` is **help**, not a type filter; search is a JS SPA

Help pages (curl 200 HTML, *Help | ATO Legal Database*):

| fid | URL | What it is |
|-----|-----|------------|
| `helpadvancedsearch` | https://www.ato.gov.au/law/view?fid=helpadvancedsearch | Advanced-search **help**. Lists “Refine search by” **categories / document types**, including **decision impact statements**, public rulings, PCGs, ATO IDs, PS LAs, technical discussion papers. Point-in-time search is documented for those types. |
| `helpquicksearch` | https://www.ato.gov.au/law/view?fid=helpquicksearch | Quick-search help. Category checklist: rulings, PCGs, taxpayer alerts, **decision impact statements**, ATO IDs, cases, legislation, extrinsic materials, edited private advice. |
| `helpaccess` | https://www.ato.gov.au/law/view?fid=helpaccess | Quick access (known document number). |
| `helpresults` | https://www.ato.gov.au/law/view?fid=helpresults | Interpreting results. |

**`fid=` is not a document-type filter.** `fid=helpadvancedsearch` does not isolate DIS. The SPA UI is:

- https://www.ato.gov.au/single-page-applications/legaldatabase
- hashes `#Law/search` `#Law/advancedSearch` `#Law/searchResults`

`GET /law/view?query=decision%20impact&dbfrom=` → **200, 350 bytes, empty body**. Not a search API.

#### What *does* curl: known-document fetch

Working `docid` grammar (live):

```
https://www.ato.gov.au/law/view?docid={PREFIX}/{CODE}/NAT/ATO/00001
https://www.ato.gov.au/law/view/document?docid={PREFIX}/{CODE}/NAT/ATO/00001
https://www.ato.gov.au/law/view/print?DocID={PREFIX}/{CODE}/NAT/ATO/00001&PiT=99991231235958
https://www.ato.gov.au/law/view/pdf?DocId={PREFIX}/{CODE}/NAT/ATO/00001&PiT=99991231235958
```

Verified:

| docid | URL style | Result |
|-------|-----------|--------|
| `TXR/TR20241/NAT/ATO/00001` | `?docid=` | **200**, title **TR 2024/1 \| Legal database**, 213,433 bytes |
| same | `/print?DocID=` | **200** HTML print view, 114,703 bytes, contains `TR 2024/1` |
| same | `/pdf?DocId=` | **200 application/pdf**, 207,351 bytes, PDF 1.4 |
| `PSR/PS20099/NAT/ATO/00001` | `/document?docid=` | **200**, title **PS LA 2009/9**, body discusses Decision Impact Statements |

`/law/view/document?DocID=` (capital, old path) **404** “Error \| ATO Legal Database” for the ICD guesses. Prefixes seen in the wild:

| Prefix | Product |
|--------|---------|
| `TXR` | Taxation Ruling (`TR 2024/1` → `TR20241`) |
| `TXD` | Taxation Determination (`TD 2017/20` → `TD201720`) |
| `PSR` | PS LA (`PS20099`) |
| `PAC` | Principal legislation (FRL Act number) |
| `NEM` | Extrinsic materials / EM |
| `JUD` | Cases (e.g. `JUD/*1998*AATA65/00002`) |
| `ESO` | Legislative-instrument ES |
| `AID` | ATO Interpretative Decision (not live-probed this pass) |
| DIS | **not found** under `LIT/ICD/…`, `SIT/DIS/…`, `SIT/DIS20241/NAT/ATO/00001` (all 404) |
| `AID/AID20101/NAT/ATO/00001` | **404** — ATO ID prefix is not `AID/AID…` in this shape |
| `PSR/PSLA20091/NAT/ATO/00001` | **404** — PS LA uses `PSR/PS20099/…` not `PSLA` in the code |
| `TXR/TR20231/NAT/ATO/00001` | **200**, title **TR 2023/1** (270,803 bytes) — same TR pattern as 2024/1 |

SPA `/api/public/content/{uuid}` URLs on the legaldatabase page are **Sitecore CMS blobs**, not a rulings search API. `GlobalConstants.js` is ABN/email validation strings only.

**Decision impact statements:** help text confirms they are a first-class **Refine search by** category in the SPA, and they are in the point-in-time-eligible set. There is **no curl-reachable `fid=` / query param** that isolates them. To implement `search_decisions(domain=tax_tribunal)` / ATO DIS:

1. Treat SPA advanced search as `[UPSTREAM_JS]` unless you reverse the XHR (not done here; `GlobalConstants.js` is only form-validation strings).
2. If you already have a DIS `docid`, fetch via `/law/view/document?docid=` or `/print?DocID=`.
3. Do not use `fid=helpadvancedsearch` as a filter — it is documentation.

`PiT=99991231235958` is the ATO “current” point-in-time sentinel (also used on print/pdf). Historical PIT is `yyyyMMdd000001`.

---

## Part 4 — Router corpus (72 natural-language queries)

Labels use **TOOL-MAPPING.md** names. Where a chain is the right *task*, the exposed entry is `legal_research` with that task (still reachable as `chain_*` via `execute_tool`). Killer features sit on `legal_analysis` *or* the unexposed name.

Legend: **primary** is the tool that should fire first.

| # | User query | Primary tool | Notes |
|---|------------|--------------|-------|
| 1 | what does s 18 of the ACL say | `get_law_text` | Alias ACL → CCA sch 2; provision `sch 2 s 18` |
| 2 | Competition and Consumer Act 2010 section 18 | `get_law_text` | Must not silently rewrite to ACL s 18; heading is “Meetings of Commission” |
| 3 | s 46 CCA | `get_law_text` | Misuse of market power |
| 4 | show me Fair Work Act s 387 | `get_law_text` | FW Act alias |
| 5 | Corps Act definition of director | `get_law_text` *or* `get_legal_term_detail` | s 9 dictionary |
| 6 | meaning of consumer in the ACL | `get_legal_term_kb` then `get_law_text` | ACL s 3 |
| 7 | what is a financial product under the Corps Act | `get_legal_term_detail` | s 763A |
| 8 | search for the Privacy Act | `search_law` | |
| 9 | is there a Commonwealth act about modern slavery | `search_law` | |
| 10 | FW Act | `search_law` | alias only, then offer get_law_text |
| 11 | TPA s 52 | `search_law` + `applicable_law` | successor CCA; s 52 was the old misleading-conduct provision |
| 12 | what did s 52 TPA say in 2009 | `legal_analysis` mode `applicable_law` | `asAt=2009-12-31`, titleId C2004A00109, name still TPA |
| 13 | point in time Corporations Act 1 July 2018 s 588G | `applicable_law` | |
| 14 | which version of the Migration Act applied on 20 March 2020 | `applicable_law` | |
| 15 | Privacy Act as at 1 December 2022 | `get_historical_law` / `applicable_law` | |
| 16 | what changed in the Privacy Act since 2020 | `legal_research` task `amendment_track` (`chain_amendment_track`) | compare_old_new + get_provision_history |
| 17 | amendments to the Fair Work Act 2024 | `get_law_history` / `chain_amendment_track` | |
| 18 | compare old and new s 18 ACL | `compare_old_new` | compilations |
| 19 | history of CCA s 46 | `get_provision_history` | |
| 20 | enabling instruments under the Biosecurity Act | `get_enabled_instruments` | |
| 21 | what Act authorises the Migration Regulations | `get_enabling_acts` | |
| 22 | is this instrument stale relative to the parent Act | `instrument_radar` | |
| 23 | Fair Work Regulations 2009 reg 1.07 | `get_instrument_text` | |
| 24 | High Court Rules 2004 r 42.02 | `get_law_text` | court rules are LIs |
| 25 | ACL schedule 2 | `get_schedules` | |
| 26 | Corps Act sch 2 forms | `get_schedules` | |
| 27 | form of a statutory declaration Cth | `get_schedules` *or* `chain_procedure_detail` | |
| 28 | gazette notice appointing the ACCC chair | `search_decisions` domain `gazettes` | FRL Gazette collection |
| 29 | Administrative Arrangements Order current | `search_law` collection AAO | |
| 30 | Australia-US FTA text | `get_treaty_text` / `search_treaties` | ATS / DFAT |
| 31 | is the China-Australia FTA in force | `search_treaties` | |
| 32 | NSW equivalent of the ACL | `get_state_equivalents` | Fair Trading Act 1987 (NSW) |
| 33 | compare unfair contract terms NSW vs Cth | `legal_research` task `state_law_compare` (`chain_state_law_compare`) | |
| 34 | Crimes Act 1900 s 61I | `get_state_law_text` | **must** pick NSW; do not hit Cth Crimes Act 1914 |
| 35 | Vic Civil Liability Act s 48 | `search_state_law` + `get_state_law_text` | |
| 36 | QLD WHS Act duties | `search_state_law` | |
| 37 | drink driving penalty NSW | `legal_research` task `full_research` | statute + cases + procedure |
| 38 | can I get a refund if the phone is defective | `legal_research` | ACL consumer guarantees |
| 39 | unfair dismissal after 5 months casual | `legal_research` task `action_basis` | FW Act + FWC |
| 40 | how do I apply to the ART for a tax review | `legal_research` task `procedure_detail` (`chain_procedure_detail`) | |
| 41 | review this employment contract for FW Act risks | `legal_research` task `document_review` (`chain_document_review`) | `analyze_document` |
| 42 | law system around the EPBC Act | `legal_research` task `law_system` (`chain_law_system`) | `get_three_tier` + `get_law_tree` |
| 43 | dispute prep: ACCC vs a merger | `legal_research` task `dispute_prep` | competition domain + FCA |
| 44 | is [2019] HCA 23 still good law | `legal_analysis` mode `cite_check` | |
| 45 | is Mabo (1992) 175 CLR 1 still cited | `cite_check` | report series |
| 46 | [2010] NSWCCA 333 | `search_cases` / `get_case_text` | NSW Caselaw mnc + court id |
| 47 | Dela Cruz v R | `search_cases` | party search |
| 48 | CCA s 46 cases | `get_provision_with_cases` | |
| 49 | cases on ACL s 18 misleading | `get_provision_with_cases` *or* `impact_map` | |
| 50 | who has cited [2020] HCA 3 | `impact_map` / `cite_check` | |
| 51 | verify these citations: s 18 CCA and [2020] HCA 41 | `legal_analysis` mode `verify_citations` | content-mismatch on s 18 |
| 52 | does Commercial Arbitration Act 2010 (Cth) s 999 exist | `verify_citations` | hallucination; likely NSW/Vic not Cth |
| 53 | HCA constitutional implied freedom cases 2024 | `search_decisions` domain `constitutional` | |
| 54 | latest High Court judgment | `search_decisions` domain `cases` | hcourt.gov.au |
| 55 | NCAT tenancy decision about mould | `search_decisions` domain `admin_appeals` | NSW Caselaw NCAT |
| 56 | FWC unfair dismissal decision small business | `search_decisions` domain `workplace` | |
| 57 | OAIC determination Optus privacy | `search_decisions` domain `privacy` | |
| 58 | ATO TR on ordinary income | `search_rulings` / `search_decisions` domain `tax_rulings` | `TXR/…` docid |
| 59 | ATO decision impact statement on [2019] HCA 3 | `search_decisions` domain `tax_tribunal` | DIS; SPA search may be JS-only |
| 60 | ATO ID 2010/1 | `get_ruling_text` | interpretative domain |
| 61 | PS LA 2009/9 | `get_ruling_text` | live docid `PSR/PS20099/NAT/ATO/00001` |
| 62 | dumping review aluminium extrusions China | `search_decisions` domain `customs` | ADRP past-reviews HTML |
| 63 | NACC Operation Wilson report | `search_decisions` domain `integrity` | PDF on nacc.gov.au |
| 64 | Merit Protection Commissioner case study code of conduct | `search_decisions` domain `public_service` | mpc.gov.au case-studies index |
| 65 | Commonwealth Ombudsman report on robodebt | `search_decisions` domain `integrity` | expect `[UPSTREAM_BLOCKED]` + link |
| 66 | University of Sydney by-law parking | `search_decisions` domain `university_rules` | state legislation / uni rules |
| 67 | CSIRO staff determination | `search_decisions` domain `agency_rules` | FRL NotifiableInstrument |
| 68 | EM for the Privacy Legislation Amendment 2022 | `search_explanatory_memoranda` / `get_em_text` | APH bId=r6940 |
| 69 | explanatory statement for CASA instrument F2011L00287 | `get_em_text` domain `explanatory` | FRL type=ES |
| 70 | three-tier: FW Act → Regulations → FWC Rules | `get_three_tier` | |
| 71 | abbreviation CCA | `get_law_abbreviations` | |
| 72 | what tools do I use to check if a case is good law | `discover_tools` | |

### Tricky negatives (look like sections / citations but are not)

| # | User query | Do **not** route as | Route as | Why |
|---|------------|---------------------|----------|-----|
| N1 | s 18 of the ACL vs CCA s 18 — which is misleading conduct | `get_law_text` alone on “s 18 CCA” | `get_law_text` **sch 2 s 18** + `verify_citations` | Classic content mismatch |
| N2 | Part 2-1 of the ACL | `parse_section_ref` as `s 2-1` | `get_law_text` pinpoint `ch 2 pt 2-1` | Hyphenated chapter/part, not a section |
| N3 | Schedule 2 item 1 Corps Act | `s 2` | `get_schedules` / provision `sch 2 it 1` | |
| N4 | s 109 of the Constitution | Cth *Constitution Act* compilation only | `get_law_text` on *Australian Constitution* s 109 | Covering clause vs s 109 inconsistency |
| N5 | 18C | `s 18C` of a random Act | `search_law` + disambiguate *Racial Discrimination Act 1975* (Cth) s 18C | Bare alphanumeric |
| N6 | section 90 of the Constitution | money bills, not a state s 90 | constitutional domain | |
| N7 | [2010] NSWCCA 333 still good law? | `get_case_text` only | `cite_check` | Identifier vs citator |
| N8 | 175 CLR 1 | `search_law` | `search_cases` / `cite_check` | Report series, not an Act |
| N9 | TR 2024/1 | `get_law_text` | `get_ruling_text` | Ruling, not a statute |
| N10 | F2011L00287 | `search_cases` | `search_law` / `get_instrument_text` | FRL title id |
| N11 | C2004A00109 | case citation | `get_law_text` registerId | FRL series id |
| N12 | penalty unit | `s 4AA` guess without Act | `get_legal_term_kb` then *Crimes Act 1914* (Cth) s 4AA | |
| N13 | consumer under the ASIC Act | ACL s 3 | ASIC Act s 12BC / 12BAA — different | Same English word, different Act |
| N14 | “section 51(xx)” | `s 51` of an Act called xx | *Constitution* s 51(xx) corporations power | |
| N15 | Art 9 ICCPR | `get_law_text` | `search_treaties` / `get_treaty_text` | Treaty article, not a Cth section |
| N16 | GSTR 2001/1 as at 30 June 2002 | `applicable_law` on FRL | ATO `PiT=` on the ruling docid | ATO PIT, not FRL compilations |
| N17 | s 18 *meetings of the Commission* | ACL | CCA body s 18 | User already named the *wrong-heading* section |
| N18 | “the Act” s 18 in a pasted letter that never named the Act | `get_law_text` | `verify_citations` → `⚠ law name unclear` | Korean 같은-법 rule |

---

## Implementation notes (cross-cutting)

1. **ES for instruments is a solved FRL fetch** (`type=ES` + composite key or `/{id}/asmade/{date}/es/original/pdf`). Doubled `/asmade/asmade/` works but is sloppy.
2. **EMs for Acts are APH/ParlInfo.** HTML `display.w3p` is the reliable curl path; PDFs need `Referer` or they 403 Azure WAF.
3. **NSW `mnc` is not dead** — it is **gated on a selected court/tribunal id**. Phrase `query=` is a different, noisy operator.
4. **MPC, NACC, ADRP are scrapeable HTML indexes** (NACC PDFs download cleanly). **Ombudsman is Cloudflare 403.**
5. **ATO `fid` ≠ document-type filter.** Use `docid`/`DocID` for known products; DIS isolation stays in the JS advanced search until an XHR is mapped.

DONE-GROK-FOLLOWUP

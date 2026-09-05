# Australian legal data landscape — mapping report for Australian Law MCP

**Role of this document.** Research brief for building **Australian Law MCP**, a doppelganger of [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp) (local clone `/tmp/korean-law-mcp`, README-EN.md + `docs/API.md` + `src/tools/unified-decisions.ts`).

**Verified live on 2026-09-03** unless a row is marked *documentary only*. Live probes used `https://api.prod.legislation.gov.au/v1/` (OData + OpenAPI), `https://www.legislation.gov.au`, `https://www.caselaw.nsw.gov.au`, `https://www.hcourt.gov.au`, `https://jade.io`. AustLII and `judgments.fedcourt.gov.au` are Cloudflare-gated from this research host (HTTP 403); URL grammar for those systems is taken from AustLII’s published CGI/FAQ/help pages and indexed copies.

---

## 0. What korean-law-mcp actually wraps (the feature surface to clone)

The Korean server compresses **42 upstream APIs → 10 advertised tools**. Internally it still has ~98 tools. The advertised surface (v4.12.0) is:

| Korean tool | Job | Australian analogue (this report) |
|---|---|---|
| `search_law` / `get_law_text` / `get_annexes` | Statute search, article text, schedules/forms | **FRL OData** (`Titles`, `Versions`, `Documents`) + HTML/PDF/Word/EPUB. Schedules live *inside* the compiled Act (no HWP annex pipeline). |
| `ordinance_radar` | Local ordinance vs parent statute drift | **State/territory legislation registers** vs Cth parent on FRL. No single ordinance API. |
| `search_decisions` / `get_decision_text` | **18 domains** (see §3) | Per-body HTML/AustLII databases. No unified Cth decisions API. |
| `legal_analysis` `verify_citations` | Hallucination guard on statute *and* case cites | Parse **AGLC4** + resolve against FRL + AustLII/JADE/HCA/FCA/NSW Caselaw. |
| `legal_analysis` `cite_check` | “Is this still good law?” (Korean Shepard’s) | **LawCite** (free, automated) + **JADE** (free-ish) + paid **CaseBase / FirstPoint**. No official free treatment-flag citator. |
| `legal_analysis` `applicable_law` | Point-in-time version + transitional notes | **FRL `Versions/Find(titleId, asAt)`** + compilation endnotes. |
| `legal_analysis` `impact_map` | Reverse citations of an article | AustLII **Noteup** + LawCite “legislation considered” + JADE. |
| Alias dictionary | the *Chemicals Control Act* (a Korean short-title alias) → official title | §5 below (`CCA`, `FW Act`, `Corps Act`, …). |
| Repealed-statute successor | v4.10.0 | FRL `nameHistory` + `statusHistory.reasons[].affectedByTitle`. |

The 18 Korean `search_decisions` domains, taken from `src/tools/unified-decisions.ts`, are:

```
precedent, interpretation, tax_tribunal, customs, nts,
constitutional, admin_appeal, ftc, pipc, nlrc, acr,
appeal_review, acr_special,
school, public_corp, public_inst,
treaty, english_law
```

Australia has **no single Open API in the style of MOLEG (the Korean Ministry of Government Legislation)**. The implementable architecture is a **federation**: FRL (statutes, first-class API) + AustLII/SINO (cases, HTML CGI) + court/tribunal sites + one state JSON-ish search (NSW Caselaw).

---

## 1. Federal Register of Legislation API

### 1.1 Identity, licence, access

| Item | Value | Live? |
|---|---|---|
| Human site | https://www.legislation.gov.au | yes |
| Public API root | https://api.prod.legislation.gov.au/v1/ | yes — OData service document |
| OpenAPI 3.0.1 | https://api.prod.legislation.gov.au/swagger/v1/swagger.json | yes (614,929 bytes) |
| Swagger UI | https://api.prod.legislation.gov.au/swagger/index.html | yes |
| `$metadata` | https://api.prod.legislation.gov.au/v1/$metadata | yes — OData 4.0 EDMX, 30,308 bytes |
| Auth | **None.** No API key. HTTP client is enough. | yes |
| Cost | Free. Commercial reuse allowed (CC; see terms). | docs |
| Operator | Office of Parliamentary Counsel, under *Legislation Act 2003* (Cth) | docs |
| Product header (2026-09-03) | `x-frl-version: 2026.08.13-releaseyaml.1+196e8e595528bb8e0d8f473387d92ad1f7907f05` | yes |
| Status | Live; “may be subject to change”; performance can drop under load | docs |
| Crawl policy | `robots.txt` crawl-delay; prefer incremental crawls **outside 08:00–20:00 Australian time**; notify OPC 1–2 weeks before a full crawl | https://www.legislation.gov.au/help-and-resources/using-the-legislation-register/data-share-and-reuse |
| Title count | **132,171** `GET /v1/Titles/$count` | yes |

Help pages used:

- Data share and reuse: https://www.legislation.gov.au/help-and-resources/using-the-legislation-register/data-share-and-reuse
- FAQ (Register IDs, compilations, linking): https://www.legislation.gov.au/help-and-resources/using-the-legislation-register/frequently-asked-questions
- Linking and downloads (old ComLaw URL redirects): https://www.legislation.gov.au/help-and-resources/using-the-legislation-register/linking-and-downloads

### 1.2 Entity sets (OData service document)

| Entity set | Entity type | Role for an MCP |
|---|---|---|
| `Titles` | `Title` | Principal Act / instrument identity, in-force flag, **name history**, **status history** |
| `Versions` | `Version` | Point-in-time compilations (`start`/`end`, `compilationNumber`, `registerId`) |
| `Documents` | `Document` | Bytes of Word / PDF / EPUB for a version (composite key; multi-volume) |
| `Affect` | `Affect` | Title–title amendment / repeal graph (`affectingTitleId` ↔ `affectedTitleId` + provisions) |
| `TextApplies` | `TextApplies` | Which provisions of a title apply a regime (disallowance, sunsetting, …) |
| `Departments` | `Department` | Administering department / portfolio |
| `_SearchContexts` and friends | `SearchContexts`, `FullTextVersionSearch`, `PointInTimeSearch`, `AffectSearch`, `TextSearch`, `DisallowanceSearch`, `OpenForDisallowanceSearch`, `FutureSunsetDateSearch` | Bound search helpers (full text, as-at, amending/repealing, sunset) |
| `Content` | `ContentDocument` | Site CMS content, not legislation |
| `DocumentPrints` / print-order actions | — | Paid print copies. Ignore for MCP. |
| `Users` / `Sessions` / `PublicFeedback` | — | My Account. Ignore. |

Bound **functions** that matter:

| Function | Binding | Purpose |
|---|---|---|
| `Versions/Find(titleId, asAt)` | `Collection(Version)` | **Point-in-time compilation** for a date |
| `Versions/Find(titleId, asAtSpecification)` | | `Latest` / `AsMade` / `Current` (`AsAtType` enum) |
| `Versions/Find(titleId, compilationNumber)` | | Pin a numbered compilation |
| `Versions/Find(registerId)` | | Pin a compilation Register ID (`C2019C00028` style) |
| `Documents/Find(...)` | `Collection(Document)` | Same selectors, returns a `Document` (in live testing this path 404’d; the **composite-key GET** worked — see §1.6) |
| `Titles/Search(criteria)` | | Full-text / criteria search. Unquoted `criteria='Fair Work Act'` returned HTTP 400 `Unexpected error` — treat as fragile; prefer `$filter=contains(name,'…')` |
| `TextApplies/Search(criteria)` | | Provision-level search |

### 1.3 `Title` schema (identity + successor/repeal metadata)

Keys and fields (from `$metadata`):

| Field | Type | Meaning |
|---|---|---|
| `id` | string (title ID) | Stable principal ID. Acts: `CyyyyAxxxxx` (e.g. CCA = **`C2004A00109`**). Legislative instruments: `FyyyyLxxxxx`. Notifiable: `FyyyyNxxxxx`. Gazettes `G`, prerogative/Constitution/AAO `Q`. |
| `name` | string | **Current** short title |
| `makingDate` | datetime | Royal assent / making |
| `collection` | enum | `Act`, `LegislativeInstrument`, `NotifiableInstrument`, `AdministrativeArrangementsOrder`, `Constitution`, `ContinuedLaw`, `Gazette`, `PrerogativeInstrument` |
| `subCollection` | enum | `Regulations`, `CourtRules`, `Rules`, `ByLaws` |
| `isPrincipal` | bool | Principal vs amending |
| `isInForce` | bool | |
| `status` | enum | `InForce`, `Ceased`, `Repealed`, `NeverEffective` |
| `hasCommencedUnincorporatedAmendments` | bool | Orange-icon case: amendments have commenced but a new compilation is not yet registered |
| `nameHistory[]` | `{name, start, affecterTitleId, affecterName}` | **Rename / successor of title** |
| `namePossibleFuture[]` | same | Prospective rename |
| `statusHistory[]` | `{status, start, reasons[]}` | In-force → repealed/ceased, with the **repealing Act** |
| `statusPossibleFuture[]` | same | Prospective repeal/cessation |
| `year` / `number` / `seriesType` | | Act number. CCA still carries `year=1974, number=51` because it *is* Act No. 51 of 1974 (originally the Trade Practices Act). |
| `originatingBillUri` | | APH Bills page (Acts from 1997+) |
| nav `versions` | collection | All compilations |
| nav `authorisedBy` | `Affect` | What this title authorises |
| nav `administeringDepartments` | | Portfolio |
| nav `parliamentaryScrutiny` | | Tabling / disallowance motions |
| nav `textApplies` | | Disallowance / sunsetting regimes |

**Register ID grammar (FAQ, verified against live titles):**

- **Title ID** = first/principal version. Letter after the year: `A` Act, `L` legislative instrument, `N` notifiable, `Q` prerogative/Constitution/AAO/Norfolk Island, `G` gazette.
  - *Acts Interpretation Act 1901* → `C1901A00002`
  - *Competition and Consumer Act 2010* → `C2004A00109` (live)
  - *Fair Work Act 2009* → `C2009A00028` (live)
  - *Corporations Act 2001* → `C2004A00818` (live)
- **Compilation ID** = a later compiled version. Letter after the year is `C`.
  - *Acts Interpretation Act 1901* compilation 36 → `C2019C00028`; compilation 37 → `C2023C00213`
  - CCA compilation 165 (start 2026-07-01) → **`C2026C00323`** (live)

Human URLs (do **not** deep-link into HTML `#_Toc…` fragments — those 404 after the Register rebuild):

| Pattern | Resolves to |
|---|---|
| `https://www.legislation.gov.au/{titleId}` | Always the **latest** version |
| `https://www.legislation.gov.au/{titleId}/latest/text` | Latest text |
| `https://www.legislation.gov.au/{titleId}/{yyyy-mm-dd}/text` | Compilation whose start date is that day |
| `https://www.legislation.gov.au/{titleId}/latest/versions` | All versions + enabled instruments |
| `https://www.legislation.gov.au/{titleId}/asmade/text` | As made |
| `https://www.legislation.gov.au/{liTitleId}/asmade/text/explanatory-statement` | ES for a legislative instrument |

Old ComLaw URLs still redirect: `/Latest/{id}`, `/Details/{id}`, `/Series/{id}` → new `/ {titleId}/latest/text` or `/versions`.

### 1.4 Point-in-time compilations (`Version`)

`Version` key: `(titleId, start, retrospectiveStart)`.

| Field | Meaning |
|---|---|
| `start` / `end` | Inclusive start, exclusive end of the compilation’s **effective** window |
| `retrospectiveStart` / `retrospectiveEnd` | Retrospective application window |
| `isCurrent` | The compilation whose window contains “today” |
| `isLatest` | The latest **registered compiled** document (can lag `isCurrent` when unincorporated amendments exist) |
| `compilationNumber` | Integer as string (`"165"`) |
| `registerId` | Compilation ID (`C2026C00323`) |
| `hasUnincorporatedAmendments` | Same orange-icon signal as on `Title` |
| `reasons[]` | Why this version exists: `ReasonAffect` = `AsMade` / `Amend` / `Repeal` / `Cease` / `ChangeDate` / `Disallow`, with `affectedByTitle` (amending Act + provisions) |
| nav `documents` | Word/PDF/EPUB files |

**`isCurrent` vs `isLatest` is the MCP-critical distinction** (live on CCA, 2026-09-03):

| Selector | `registerId` | `compilationNumber` | `start` | `end` | flags |
|---|---|---|---|---|---|
| `isLatest eq true` | `C2026C00323` | `165` | 2026-07-01 | 2026-08-27 | `isLatest=true`, `isCurrent=false`, `hasUnincorporatedAmendments=false` |
| `isCurrent eq true` | `null` | `null` | 2026-08-27 | 2027-07-01 | `isLatest=false`, `isCurrent=true`, **`hasUnincorporatedAmendments=true`** |

So on 2026-09-03 the *in-force text as compiled* is compilation 165, but amendments commencing 2026-08-27 are **not yet compiled**. `applicable_law` must surface that orange-icon gap, exactly as Korean MCP warns on pending-enforcement amendments.

**Live point-in-time rename (this is the TPA → CCA successor story):**

```
GET /v1/Versions/Find(titleId='C2004A00109',asAt=2010-12-31T00:00:00Z)
→ name = "Trade Practices Act 1974"
   start = 2010-12-18, end = 2011-01-01, registerId = null

GET /v1/Versions/Find(titleId='C2004A00109',asAt=2011-01-01T00:00:00Z)
→ name = "Competition and Consumer Act 2010"
   start = 2011-01-01, end = 2011-04-13, registerId = C2011C00003
```

Same `titleId` across the rename. Searching “Trade Practices Act 1974” and “Competition and Consumer Act 2010” must resolve to **`C2004A00109`**.

`nameHistory` on that title (live):

| name | start | affecter |
|---|---|---|
| Trade Practices Act 1974 | 1974-08-24 | (original) |
| Competition and Consumer Act 2010 | 2011-01-01 | `C2010A00103` *Trade Practices Amendment (Australian Consumer Law) Act (No. 2) 2010* |

`AsAtType` enum for `asAtSpecification`: `Latest=0`, `AsMade=1`, `Current=2`.

`PointInTimeType` (search helper): `PointInTime=0`, `Anytime=1`, `AsMade=2`, `Latest=3`.

### 1.5 Repeal / cease / successor metadata

`Status` enum: `InForce=0`, `Ceased=1`, `Repealed=2`, `NeverEffective=3`.

Live repealed principal Acts still carry the repealing instrument in `statusHistory.reasons`:

```
GET /v1/Titles?$filter=status eq 'Repealed'&$top=2

C1901A00003  Consolidated Revenue
  InForce from 1901-07-12
  Repealed from 1934-08-06
    reason.affect = Repeal
    reason.markdown = "second sch of the Statute Law Revision Act 1934"
    reason.affectedByTitle = { titleId: C1934A00045, name: "Statute Law Revision Act 1934", provisions: "second sch" }
```

Ceased (spent / self-ceasing), distinct from repealed:

```
C2014A00065  Appropriation (Parliamentary Departments) Act (No. 1) 2014-2015
  InForce 2014-06-30 → Ceased 2017-07-01
  reason.affect = Cease, markdown = "Self Ceasing"
```

`Affect` entity (amending graph):

| Field | Meaning |
|---|---|
| `affectingTitleId` / `affectedTitleId` | Pair of title IDs |
| `affectingProvisions` / `affectedProvisions` | e.g. `sch 1 (item 66)` |
| nav `affectingTitle` / `affectedTitle` | Expand to names |

`AffectSearch` flags on a title: `isAmending`, `isRepealing`, `isCeasing`, `isModifying`, `isCommencing`, `isSunsetAltering`, `isSavingTransitionalOrApplication`, plus commenced / uncommenced / never-applied.

`ReasonAffect` on a version: `AsMade`, `Amend`, `Repeal`, `Cease`, `ChangeDate`, `Disallow`.

**Successor lookup recipe for MCP** (Korean v4.10.0 analogue):

1. Resolve query to a `Title` (`$filter=name eq '…'` or `contains(name,'…')`, then exact-match rank; also search `nameHistory/any(h: h/name eq '…')` if the OData any-lambda is enabled).
2. If `status` is `Repealed`/`Ceased`, emit `statusHistory[-1].reasons[].affectedByTitle` as the repealing/ceasing instrument.
3. If the title was **renamed** rather than repealed (TPA/CCA), `nameHistory` is the successor — **do not** report “repealed”.
4. If `hasCommencedUnincorporatedAmendments`, point at the amending titles in the latest version’s `reasons[]` and warn that compiled text lags.

### 1.6 Fetching full text (`Document`)

`Document` composite key (all required):

```
titleId, start, retrospectiveStart, rectificationVersionNumber,
type, uniqueTypeNumber, volumeNumber, format
```

Enums:

- `DocumentType`: `Primary=0`, `ES=1`, `SupportingMaterial=2`, `IncorporatedByReference=3`, `SupplementaryES=5`
- `DocumentFormatType`: `Word=1`, `Pdf=2`, `Epub=3`, `NameOnly=4`
- `DocumentVersionType`: `Rectification=0`, `Replacement=1`, `RetrospectiveCompilation=2`

**Live download that worked** (CCA compilation 165, volume 1, authorised PDF, 550 pages, 2,195,863 bytes):

```
GET https://api.prod.legislation.gov.au/v1/Documents(
  titleId='C2004A00109',
  start=2026-07-01T00:00:00Z,
  retrospectiveStart=2026-07-01T00:00:00Z,
  rectificationVersionNumber=0,
  type='Primary',
  uniqueTypeNumber=0,
  volumeNumber=1,
  format='Pdf'
)
→ 200 application/pdf
  Content-Disposition: attachment; filename=C2026C00323VOL01.pdf
```

CCA compilation 165 is **four PDF volumes** (`volumeNumber` 1–4, `uniqueTypeNumber=0`, `isAuthorised=true`). Large Cth Acts (CCA, Corps, ITAA 1997, FW Act) are split this way — `get_law_text` must iterate volumes.

`Documents/Find(...)` overloads in the OpenAPI spec (by `asAt`, `asAtSpecification`, `compilationNumber`, `registerId`) returned **HTTP 404** in live testing even with `volumeNumber`/`uniqueTypeNumber` set. Prefer:

1. Query `Versions` (or `Versions/Find`) to get `start` / `retrospectiveStart` / `registerId`.
2. Query `Documents?$filter=titleId eq '…' and registerId eq '…' and format eq 'Pdf'` to list volumes.
3. GET the composite-key URL above.

`$select` works. `bytes` is omitted unless requested (and is large). Metadata includes `sizeInBytes`, `extension`, `isAuthorised`, `rectificationReason`.

EPUB exists (`format=Epub`) and is the closest thing to structured article-level HTML. The public website HTML text view is **not** a documented article-level API — FRL FAQ says old `#_Toc` deep links 404. For `jo`-style article fetch (Korean `get_law_text(mst, jo="Article 38")`) the MCP will need to:

- parse EPUB/HTML of the compilation, or
- fall back to AustLII section URLs (`…/s18.html`) which *do* have per-section pages, with the usual AustLII lag.

### 1.7 Search patterns that work today

```
# exact principal Act
GET /v1/Titles?$filter=name eq 'Competition and Consumer Act 2010'
# substring (308 hits for this string — rank exact + isPrincipal + collection eq 'Act')
GET /v1/Titles?$filter=contains(name,'Competition and Consumer')&$top=5
# current compilation
GET /v1/Versions?$filter=titleId eq 'C2004A00109' and isCurrent eq true
# latest compiled document
GET /v1/Versions?$filter=titleId eq 'C2004A00109' and isLatest eq true
# point in time
GET /v1/Versions/Find(titleId='C2004A00109',asAt=2011-01-01T00:00:00Z)
# repealed
GET /v1/Titles?$filter=status eq 'Repealed'&$top=2
```

`$expand=versions` on a heavily compiled Act is **not viable** as a default: a follow-up `Titles?$filter=name eq 'Competition and Consumer Act 2010'&$expand=versions` returned an empty body after ~63s (JSON parse fail). Query `Versions?$filter=titleId eq '…'` instead.

`Titles/Search(criteria='Competition and Consumer Act')` returned **HTTP 400** `cannot parse Competition`. The bound `Search` function is a structured criteria DSL, not a Google box — do not send raw statute names. Prefer `$filter=contains(name,'…')` or `name eq '…'`.

**Rename trap (live):** `contains(name,'Trade Practices Act')` returned **102 titles**, all *legislative instruments* that still carry “Trade Practices Act 1974” in their **current** name (product-safety notices, etc.). The renamed principal Act **does not** match, because `name` is now `Competition and Consumer Act 2010`. Successor lookup **must** walk `nameHistory` (or the alias table). One of those LIs (`F2010L03061`, movable soccer goals) is still `InForce` under a TPA-era title — a naive “TPA was renamed, ignore TPA hits” rule would hide live law.

A combined filter `status eq 'Repealed' and collection eq 'Act' and isPrincipal eq true` failed in this probe (non-JSON body). Enum filters work one-at-a-time (`status eq 'Repealed'` worked); compound enum filters may need `Default.Status'Repealed'` / `Default.Collection'Act'` cast syntax, and should be treated as brittle until re-tested.

OData `$filter` / `$top` / `$skip` / `$orderby` / `$select` / `$count` are supported in the usual ASP.NET OData way. Enums accept the string form (`'Repealed'`, `'Act'`, `'Pdf'`) for simple filters.

### 1.8 What FRL does **not** give you

- No case law.
- No official article-number query (`s 18`) as an API parameter.
- No legal-term thesaurus (Korean `get_legal_term_kb`).
- No treaties (those sit on AustLII DFAT library / DFAT).
- No state legislation.
- Bills and EMs: FRL links out to **APH** https://www.aph.gov.au/Parliamentary_Business/Bills_Legislation and ParlInfo https://parlinfo.aph.gov.au/ for 1997+; it is not the Bills database.
- `Titles/Search(criteria)` is not a safe default (400 on a simple quoted-looking string in this probe).

---

## 2. Case law access

Australia publishes judgments as **HTML/PDF on many sites**, not as one OData feed. Medium-neutral citation (MNC) is the join key.

### 2.1 AustLII — URL grammar + SINO CGI

**Sites:** https://www.austlii.edu.au · https://classic.austlii.edu.au · numbered mirrors `www4`–`www8.austlii.edu.au`

**Cloudflare:** this research host received HTTP 403 on `www.austlii.edu.au`, `classic.austlii.edu.au`, `www8.austlii.edu.au`. An MCP deployed on a clean IP will still need polite rate limits, a real User-Agent, and a fallback (JADE / court sites / NSW Caselaw). Do **not** treat a 403/anti-bot page as `NOT_FOUND` — that is exactly the Korean v4.12 failure mode.

#### Database path grammar

```
/au/{kind}/{jurisdiction}/{collection}/
/au/cases/{jurisdiction}/{COURT}/{year}/{n}.html
/au/legis/{jurisdiction}/{kind}/{slug}/s{n}.html
```

| Collection | Path | Example |
|---|---|---|
| HCA | `/au/cases/cth/HCA/` | `[2020] HCA 41` → https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/HCA/2020/41.html (file = `{year}/{n}.html`). |
| HCA single justice | `/au/cases/cth/HCASJ/` (and HCA historical) | MNC `[2026] HCASJ 28` |
| FCA single judge | `/au/cases/cth/FCA/` | `[2020] FCA 1` → `…/FCA/2020/1.html` |
| FCA Full Court | `/au/cases/cth/FCAFC/` | `[2024] FCAFC 170` |
| Cth consolidated Acts | `/au/legis/cth/consol_act/{slug}/` | CCA live slug **`caca2010265`** (https://www5.austlii.edu.au/au/legis/cth/consol_act/caca2010265/s18.html). **Do not guess slugs**; resolve via SINO title search. Section: `…/s18.html` |
| Cth consol regs | `/au/legis/cth/consol_reg/` | |
| NSW Acts | `/au/legis/nsw/consol_act/` | |
| Treaties | `/au/other/dfat/` | Australian Treaties Library (DFAT) |
| FWC | `/au/cases/cth/FWC/` | `[2025] FWC 120` → `…/FWC/2025/120.html` (~31,861 docs; updated ~weekly) |
| FWA (predecessor) | `/au/cases/cth/FWA/` | pre-2013 |
| AICmr | `/au/cases/cth/AICmr/` | `[2025] AICmr 42` → `…/AICmr/2025/42.html` |
| ACompT | `/au/cases/cth/ACompT/` | Australian Competition Tribunal |
| ART | `/au/cases/cth/ARTA/` | `[2025] ARTA 1041` (post-14 Oct 2024) |
| AAT (closed) | `/au/cases/cth/AATA/` | historical |

AustLII FAQ (https://www.austlii.edu.au/austlii/faq) states the hierarchy explicitly: Cth consolidated Acts at `/au/legis/cth/consol_act`, HCA at `/au/cases/cth/HCA/`.

**MNC → AustLII file rule:** `[YYYY] COURT N` → `/au/cases/{jurisdiction}/{COURT}/{YYYY}/{N}.html`. Court code is the directory name (`HCA`, `FCAFC`, `NSWCA`, `VSCA`, `FWC`, `AICmr`, `ARTA`).

**Legislation section rule:** AustLII uses a **generated slug** plus `s{n}.html` (and `s18aa.html` etc. for lettered sections). Example indexed URL: https://www.austlii.edu.au/cgi-bin/viewdoc/au/legis/cth/consol_act/ma1958118/s275.html (*Migration Act 1958* s 275). Slug is not the AGLC short title — resolve via search, cache `titleId ↔ slug`.

#### SINO CGI search API

Documented at https://www.austlii.edu.au/techlib/webdev/cgiapi.html (SINO = “Size Is No Object”).

Typical stored-search URL (from AustLII HTML tutorial):

```
https://www.austlii.edu.au/cgi-bin/sinosrch.cgi
  ?method=boolean
  &meta=/au
  &mask_path=au/cases/cth/HCA
  &query=negligen*+and+defam*
  &results=50
  &rank=on
```

| Param | Role |
|---|---|
| `query` | SINO query string |
| `method` | `boolean` / `auto` / `title` / `any` / … |
| `meta` | Virtual concordance: `/au`, `/nz`, `/austlii` |
| `mask_path` | Restrict to a database, e.g. `au/cases/cth/HCA`, `au/legis/cth/consol_act`. Repeatable. |
| `results` | Page size |
| `rank` | Ranking on/off |
| `legisopt` | Legislation display options (collapse multi-sections, etc.) |

Operators (https://www.austlii.edu.au/austlii/help/operators.html / classic chart):

| Operator | Meaning |
|---|---|
| `and` `or` `not` | Boolean |
| `near` | within 50 words |
| `w/n` `/n/` | within *n* words |
| `pre/n` | precedes within *n* |
| `*` `?` | truncation / single char |
| `"phrase"` | phrase (also `"crime #and punishment"` to literalise `and`) |
| `title(…)` or `term@title` | title field |
| parentheses | grouping |

**Noteup (Korean `cite_check` / `impact_map` free path):** every AustLII case and section page has a **Noteup** control. It is a stored SINO search for later documents that mention this citation/section. Example idea (legislation): Noteup on *Copyright Act* s 41. For cases: Noteup on the MNC and parallel citations. This is **mention-search**, not editorial treatment (no “overruled / applied / distinguished” flags).

Front-page autosearch detects “Act name + section” and jumps to legislation. For citator work, **do not** use autosearch (it restricts to titles); use boolean + `near`/`w/n` as AustLII case-help says (`Mabo w/2 Queensland`).

Update lag (AustLII legislation status page https://www7.austlii.edu.au/cgi-bin/legstatus.cgi, sampled 2026-08): Cth/NSW/Vic weekly-ish consolidations; Qld monthly; SA has a dedicated **point-in-time Acts** collection. **FRL is authoritative for Cth in-force text;** AustLII is the cross-jurisdiction search index and the section-level HTML.

### 2.2 LawCite — free citator (“cited by later cases”)

| Item | Value |
|---|---|
| Search UI | http://www.austlii.edu.au/LawCite/ · http://classic.austlii.edu.au/cgi-bin/LawCite |
| Overview | http://austlii.edu.au/LawCite/doc/overview.html |
| Search help | http://www.austlii.edu.au/LawCite/doc/search-help.html · http://commonlii.org/LawCite/doc/search-help.html |
| Record template | https://www.austlii.edu.au/LawCite/doc/result.html.template |
| Markup tool | http://austlii.edu.au/LawCite/markup.html (non-commercial; contact AustLII before automating) |
| Scale (2024 AustLII Year in Review) | **> 6.6 million** indexed documents |
| Method | Automated data-mining of LII corpora. **No editorial treatment flags.** |

**Deep-link by citation (verified in indexed copies):**

```
https://classic.austlii.edu.au/cgi-bin/LawCite?cit=%5B2015%5D%20NSWCA%20228
https://www.austlii.edu.au/cgi-bin/LawCite?cit=[2020]%20HCA%2041
```

Citation parser is deliberately sloppy (help page): all of these hit the same report:

```
[2008] 3 All ER 1069
[2008] 3 All E.R. 1069
(2008) 3 All E.R 1069
[2008] 3 AllER 1069
[2008] 3 AER 1069
(1903) 1 CLR 1   ==   1 CLR 1
```

Partial citations work: `2009] HCA`, `HCA 1`. Boolean in a field disables the smart parser.

A LawCite **record** has:

1. Header: name, parallel citations (MNC first, then authorised, then by frequency), court, jurisdiction, date, stars (~50 citing docs per star).
2. **Legislation Cited** (links).
3. **Cases and Articles Cited** (this case’s outbound citations).
4. **Cases Referring to this Case** ← this is `cite_check`.
5. **Journal Articles Referring to this Case**.

That is the free “cited by later cases” graph. It will **not** tell you “overruled by *XYZ*”. For overruling you still need: (a) HCA/intermediate appellate language, (b) paid citators, (c) heuristic scan of later catchwords/holdings for “overrule”, “no longer good law”, “depart from”, “not follow”.

LawCite also has a **Cases Considered** field (find cases from jurisdiction A citing court B) and **Legislation Considered** (Act + optional section) — the latter is the free `impact_map` for a section.

### 2.3 High Court of Australia eresources

`https://eresources.hcourt.gov.au/` **301-redirects** (live, 2026-09-03) to:

https://www.hcourt.gov.au/cases-and-judgments/judgments

Collections on that Drupal site:

| Collection | URL | Coverage |
|---|---|---|
| Judgments 1998–current | https://www.hcourt.gov.au/cases-and-judgments/judgments/judgments-1998-current | Official unreported as delivered. Live list showed **1,667** results; newest sampled `[2026] HCA 29` *The King v Ko* (12 Aug 2026). |
| Judgment summaries | https://www.hcourt.gov.au/cases-and-judgments/judgments/judgment-summaries | One-page PDFs from Dec 2002, e.g. `hca-29-2026-08-12.pdf` |
| Single justice | https://www.hcourt.gov.au/cases-and-judgments/judgments/single-justice-judgments | From **Jan 2024**; MNC **`[YYYY] HCASJ N`**. Earlier single-justice sit in the 1998–current collection. Sample: `[2026] HCASJ 28` *Ogbonna v Link Workforce* with PDF `Ogbonna v. Link Workforce Pty Ltd Anor (P16-2026) 2026 HCASJ 28.pdf` |
| CLR vols 1–100 | https://www.hcourt.gov.au/cases-and-judgments/judgments/1-clr-100-clr | 1903–1959 authorised reports |
| Unreported 1906–1994 | https://www.hcourt.gov.au/cases-and-judgments/judgments/unreported-judgments | Incomplete |
| Current Full Court cases | https://www.hcourt.gov.au/cases-and-judgments/cases/current | Since Feb 2011 |
| Decided Full Court cases | https://www.hcourt.gov.au/cases-and-judgments/cases/decided | Since Feb 2011 |
| Recent judgments news | https://www.hcourt.gov.au/announcements/recent-judgments | |

There is **no public HCA JSON API**. Search is the Drupal “Search by case name or party names” box. For MCP: prefer AustLII `/au/cases/cth/HCA/{year}/{n}.html` plus this site as official PDF source.

Catchwords on HCA pages are gold for `constitutional` domain routing (live example *EGH19 v Commonwealth* [2026] HCA 7: “**Constitutional law (Cth)** – Judicial power…”).

### 2.4 Federal Court judgments search

| Item | Value |
|---|---|
| Search UI | https://www.fedcourt.gov.au/digital-law-library/judgments/search |
| Latest | https://www.fedcourt.gov.au/digital-law-library/judgments/latest |
| Hosted judgment browser | https://www.judgments.fedcourt.gov.au/judgments/browse_judgments |
| FAQ | https://www.fedcourt.gov.au/digital-law-library/judgments/judgments-faq |
| MNC tips | https://www.judgments.fedcourt.gov.au/judgments/mnc-search-tips |
| Docket/orders (not reasons) | Federal Law Search https://www.comcourts.gov.au/public/esearch/federal/query (file no. like `NSD123/2008`) |
| Cloudflare | `judgments.fedcourt.gov.au` returned 403/challenge from this host |

Coverage (FAQ): **FCA 1977–**; also **Australian Competition Tribunal 1997–**, Copyright Tribunal 1980–, Defence Force Discipline Appeal Tribunal, Federal Police Disciplinary Tribunal, Industrial Relations Court, Norfolk Island Supreme Court. HTML+Word from 1995; searchable PDF 1977–1994.

URL pattern used by the Court (MNC search tips / browse):

```
https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/single/{year}/{year}fca{nnnn}
https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/full/{year}/…
```

MNC search box examples: `2012 fca 6`. Party search: no `v` required.

FCA Full Court MNC is **`[YYYY] FCAFC N`** from 2002 (1999–2001 Full Court used `FCA`). AustLII split: `/au/cases/cth/FCA/` vs `/au/cases/cth/FCAFC/`.

No official public REST API. Subscribe to daily judgment alerts by National Practice Area.

### 2.5 NSW Caselaw — the only state “API” that is actually a documented query surface

| Item | Value | Live? |
|---|---|---|
| Site | https://www.caselaw.nsw.gov.au | yes |
| Advanced search | **GET** `https://www.caselaw.nsw.gov.au/search/advanced` | yes |
| Search tips | https://www.caselaw.nsw.gov.au/search-tips | yes |
| Policy / copyright | https://www.caselaw.nsw.gov.au/policy.html | yes |
| Decision URL | `https://www.caselaw.nsw.gov.au/decision/{hexId}` | yes |
| Official JSON API | **None.** HTML search + HTML decision pages. | |
| Unofficial client | https://github.com/Sydney-Informatics-Hub/nswcaselaw (`pip install nswcaselaw`) | |

**Live MNC search (2026-09-03):**

```
GET https://www.caselaw.nsw.gov.au/search/advanced
  ?page=
  &body=&title=&before=&catchwords=&party=
  &mnc=[2010] NSWCCA 333
  &startDate=&endDate=&fileNumber=&legislationCited=&casesCited=
  &_courts=on
  &courts=54a634063004de94513d8279          # Court of Criminal Appeal
  &_tribunals=on
→ "Displaying 1 - 1 of 1"
→ /decision/549fff1d3004262463c85662
→ Dela Cruz v R [2010] NSWCCA 333
```

Without a `courts=` (or tribunal) id the same query returns the **empty form**, not results. The unofficial Python client always sends `_courts=on` / `_tribunals=on` plus selected ids.

Query fields (form + `nswcaselaw` source `constants.py` / `search.py`):

| Param | Meaning |
|---|---|
| `body` | Full text. Advanced search: multiple words = **AND**. Quick box: multiple words = **OR**. |
| `title` | Case name |
| `before` | Judicial officer |
| `catchwords` | |
| `party` | |
| `mnc` | **Exact phrase. Square brackets required.** `[2010] NSWCCA 333` |
| `startDate` / `endDate` | `dd/mm/yyyy` |
| `fileNumber` | |
| `legislationCited` / `casesCited` | |
| `page` | 0-based; page size **20** |
| `courts` / `tribunals` | Mongo-style hex ids (below) |
| `_courts` / `_tribunals` | `on` (checkbox plumbing) |

Connectors in text fields (capitals): `AND`, `OR`, `NOT`. Wildcards `*` `?` (min 3 chars). Phrases in `"double quotes"`.

Court / tribunal ids (scraped into `nswcaselaw.constants.COURTS`):

| id | body |
|---|---|
| `54a634063004de94513d8278` | Court of Appeal |
| `54a634063004de94513d8279` | Court of Criminal Appeal |
| `54a634063004de94513d8281` | Supreme Court |
| `54a634063004de94513d827c` | District Court |
| `54a634063004de94513d8280` | Local Court |
| `54a634063004de94513d827a` | Children’s Court |
| `54a634063004de94513d827f` / `…8285` | Industrial Relations Commission (Judges / Commissioners) |
| `54a634063004de94513d8286` / `…827f` | Land and Environment Court (Judges / Commissioners) |
| `54a634063004de94513d828d` | NCAT Appeal Panel |
| `54a634063004de94513d8289` | NCAT Administrative and Equal Opportunity |
| `54a634063004de94513d828b` | NCAT Consumer and Commercial |
| `54a634063004de94513d828c` | NCAT Guardianship |
| `54a634063004de94513d828a` | NCAT Occupational |
| `173b71a8beab2951cc1fab8d` | NCAT Enforcement |
| plus historical ADT, Dust Diseases, Medical Tribunal, … | |

Decision pages are HTML. Robots exclusion applies to **decisions** (not the search engine). Copyright authorisation (policy): reproduce accurately, not as “official”, no State Arms, no editorial NSWLR material. Linking: do **not** put party names in hyperlink text that search engines will index; prefer the MNC.

Release: generally within 24 hours. NCAT/District/Local are **selective**. Restricted decisions still expose MNC + “Decision restricted”.

### 2.6 Other free case-law surfaces (not requested but needed for a doppelganger)

| Source | URL | Notes |
|---|---|---|
| **JADE** (BarNet) | https://jade.io | Free account. Lookup by MNC. Subsequent consideration / catchwords. Closest free *editorial-ish* citator. Example article URLs: `https://jade.io/article/{id}`. Third-party wrappers exist; no stable public documented API for bulk. |
| **FCFCOA** | AustLII `FCFCOA` / `FedCFamC1A` / `FedCFamC2F` etc. | Family + general federal law post-2021 restructure. |
| **State equivalents of NSW Caselaw** | See §3 “ordinances / state legislation” and court tables in §4 | Victoria: https://www.austlii.edu.au/au/cases/vic/ plus https://www.supremecourt.vic.gov.au. Qld: https://www.sclqld.org.au/caselaw. WA: https://ecourts.justice.wa.gov.au/eCourtsPortal. SA: https://www.courts.sa.gov.au. Tas: https://www.supremecourt.tas.gov.au. ACT: https://www.courts.act.gov.au. NT: https://supremecourt.nt.gov.au. |
| **ART** | https://www.art.gov.au + AustLII `ARTA` | Replaced AAT on **14 Oct 2024**. |

---

## 3. Eighteen Korean decision domains → Australian equivalents

Korea’s `search_decisions(domain)` is one tool because MOLEG (the Korean Ministry of Government Legislation) + agency portals share a similar XML shape. Australia is **one court/tribunal website each**. Recommended MCP shape: keep `search_decisions(domain)` as the advertised API, dispatch to the URLs below.

| # | Korean `domain` | Korean body | Australian primary equivalent | Access (best → fallback) | MNC / cite code | Notes |
|---|---|---|---|---|---|---|
| 1 | `precedent` | Supreme Court / ordinary courts | **HCA + FCA/FCAFC + FCFCOA + state supreme/district/county/magistrates** | AustLII SINO (`mask_path=au/cases`) → JADE → court sites | `HCA`, `FCA`, `FCAFC`, `NSWCA`, `VSCA`, … | This is the default case-law domain. |
| 2 | `constitutional` | Constitutional Court of Korea | **High Court constitutional matters** (Australia has **no** separate constitutional court). Also state Supreme Courts on *Kable* / state constitutions; FCA ACLHR NPA. | HCA eresources catchwords `Constitutional law (Cth)` + AustLII HCA + CLR | `HCA` + authorised **CLR** | Route “constitution / Chapter III / implied freedom / s 109” here. |
| 3 | `tax_tribunal` | Tax Tribunal | **ART** Taxation (and former **AAT** Taxation) **+** **AAT/ART** reported as `ATD`/`AA` unofficially; first-instance objections inside ATO | AustLII `ARTA` / `AATA`; ART site | `[YYYY] ARTA n`, historically `[YYYY] AATA n` | ART commenced **14 Oct 2024** (*Administrative Review Tribunal Act 2024* (Cth)). AAT abolished same day. |
| 4 | `nts` | National Tax Service statutory interpretations | **ATO** public rulings and interpretative decisions | https://www.ato.gov.au/law (Legal database): TR, TD, MT, CR, GSTR, SGR, SMSFR, PS LA, ATOID | `ATO TR 2024/1`, `ATO ID 2010/1` | Not “cases”. This is the interpretation layer. |
| 5 | `customs` | Korea Customs Service statutory interpretations | **ABF** / Comptroller-General of Customs + **ATO** (GST/excise) + **ART** customs/tariff + **Anti-Dumping Review Panel** | ABF notices; AustLII ART/AATA customs; https://www.adreviewpanel.gov.au | ART; ADN series | Korean “customs interpretation” ≠ ABF media releases — prefer formal advices/rulings and tribunal decisions. |
| 6 | `interpretation` | MOLEG statutory interpretation rulings | **No public AGD/OLSC interpretation database** comparable to Korean statutory interpretation rulings. Closest: **OPC** drafting notes (not law); **AGS** advices (generally not public); **Explanatory Memoranda** (APH); **ALRC** reports; agency FOI Guidelines (OAIC). | APH EMs; ALRC https://www.alrc.gov.au; OAIC FOI Guidelines | EM / ALRC report citations (AGLC ch 7) | Do not fake a statutory interpretation ruling. Expose EMs + selected agency guidelines. |
| 7 | `admin_appeal` | administrative appeal rulings | **ART** (Cth merits review) **+ state super-tribunals**: NCAT, VCAT, QCAT, SACAT, SAT (WA), TASCAT, ACAT, NTCAT | AustLII `ARTA`/`AATA`/`NCAT`/`VCAT`/`QCAT`/… + NSW Caselaw NCAT | `[YYYY] ARTA n`, `[YYYY] NSWCATAD n`, `[YYYY] VCAT n` | This is the workhorse domain after `precedent`. |
| 8 | `ftc` | Fair Trade Commission | **ACCC** (investigations, s 87B undertakings, infringement notices, merger determinations under the 2025 mandatory regime) **+ Australian Competition Tribunal** | ACCC https://www.accc.gov.au ; AustLII `ACompT`; FCA competition list | `[YYYY] ACompT n`; FCA; ACCC determinations are **not** MNCs | Authorisation determinations and s 51ABZE merger decisions are administrative, then reviewable in ACompT/FCA. |
| 9 | `pipc` | Personal Information Protection Commission | **OAIC** — Privacy Commissioner determinations + Information Commissioner FOI reviews | AustLII `AICmr` https://www.austlii.edu.au/au/cases/cth/AICmr/ ; OAIC site | **`[YYYY] AICmr n`** | Database: FOI + Privacy from 1 Nov 2010. Pre-2010: closed Federal Privacy Commissioner determinations. Case notes: `AICmrCN`. |
| 10 | `nlrc` | Labor Relations Commission | **Fair Work Commission** (unfair dismissal, EAs, industrial action, general protections conferences) **+** Federal Court / FCFCOA for civil penalty/unlawful termination **+ Fair Work Ombudsman** (compliance, not a tribunal) | https://www.fwc.gov.au/hearings-decisions/find-decisions-and-orders ; AustLII `FWC` (~31k decisions) | **`[YYYY] FWC n`**, Full Bench **`[YYYY] FWCFB n`**, pred. `FWA`/`AIRC` | FWC site publishes as issued (incl. after hours). Appeals: permission, 21 days. |
| 11 | `acr` | Anti-Corruption and Civil Rights Commission (anti-corruption / rights) | **NACC** (from 1 Jul 2023, replacing ACLEI for Cth) **+** state ICAC/IBAC/CCC/CIC/IBAC-equivalents **+ Commonwealth Ombudsman** **+ ANAO** | NACC https://www.nacc.gov.au (many investigations **not** public); state ICAC reports | Reports, not MNCs; some state ICAC have “operation” names | Korean ACR decisions are more routinely published than NACC. Pair with Ombudsman investigation reports. |
| 12 | `appeal_review` | Appeals Review Committee (civil-service appeals) | **Merit Protection Commissioner** (APS) https://www.mpc.gov.au **+** Defence Force tribunal / Veterans’ ART lists **+** FWC for some APS enterprise matters | MPC reports; ART veterans/defence | mostly non-MNC | Thin public corpus. |
| 13 | `acr_special` | Anti-Corruption and Civil Rights Commission special administrative appeals | **Inspector-General of Taxation and Taxation Ombudsman**; **IGIS**; **NDIS Quality and Safeguards**; specialised inspectors-general | IGT https://www.igt.gov.au | reports | No single “special administrative appeal” court. |
| 14 | `school` | university rules | University statutes/rules + TEQSA + state education Acts. **Not centralised.** | Individual university legal offices; state consolidated Acts (e.g. *Education Act 1990* (NSW)) | — | Low priority unless a partner university is in scope. |
| 15 | `public_corp` | public-corporation and agency regulations | Cth **corporate Commonwealth entities** rules: often **notifiable/legislative instruments on FRL** + entity websites (Australia Post, NBN, CSIRO, ABA) | FRL `NotifiableInstrument` / `LegislativeInstrument` filtered by administering department | FRL title IDs | Prefer FRL over scraping entity sites. |
| 16 | `public_inst` | public-institution regulations | APS agency policies, Accountable Authority Instructions under *PGPA Act 2013* (Cth), Procurement Rules | FRL (`C2013A00123` PGPA Act); Department of Finance RMG series | — | Finance RMGs are guidance, not law — label them as such (Korean MCP’s “don’t claim absence” ethic). |
| 17 | `treaty` | treaties | **Australian Treaties Library** (DFAT on AustLII) + DFAT FTA pages | https://www.austlii.edu.au/au/other/dfat/ ; https://www.dfat.gov.au/trade/agreements/trade-agreements ; ATS series | `[YYYY] ATS n` / [YYYY] ATNIF n | Authentic texts also in [United Nations Treaty Series] but ATS is the Australian citation. |
| 18 | `english_law` | English-language statutes | **Not applicable.** Australian statutes are made in English. Optional extras: official compilations on FRL; **Easy Read** / translations on some agency sites; UK/NZ persuasive authorities via AustLII/BailII/NZLII. | FRL | — | Do not invent a translation corpus. If the tool is kept for API symmetry, map it to “official English compilation (FRL latest)”. |

### 3.1 “Ordinances” → Australian state and territory legislation

Korea’s local-government ordinances are the **closest analogue to state/territory Acts and regulations**, plus genuine local-government ordinances/by-laws. Australia is a federation: **state legislation is not subordinate to Cth in the Korean delegated-ordinance sense**; inconsistency is *Constitution* s 109.

| Jurisdiction | Official register | Point-in-time? | AustLII | Notes |
|---|---|---|---|---|
| **Cth** | https://www.legislation.gov.au + **FRL API** | Yes — compilations + `Versions/Find` | `/au/legis/cth/` | Authoritative. |
| **NSW** | https://legislation.nsw.gov.au | In force + as made + some historical. **No public OData twin of FRL.** | `/au/legis/nsw/` | Also NSW Government Gazette. Local orders: council sites + AustLII NSW SEPP/LEP fragments. |
| **Vic** | https://www.legislation.vic.gov.au | Compilations (“in force”) | `/au/legis/vic/` | |
| **Qld** | https://www.legislation.qld.gov.au | In force reprints | `/au/legis/qld/` | AustLII Qld consolidations ~monthly. |
| **WA** | https://www.legislation.wa.gov.au | Yes | `/au/legis/wa/` | |
| **SA** | https://www.legislation.sa.gov.au | **Point-in-time Acts** called out on AustLII status page | `/au/legis/sa/` | data.sa.gov.au has legislative-database PDF update packages (not an API). |
| **Tas** | https://www.legislation.tas.gov.au | | `/au/legis/tas/` | |
| **ACT** | https://www.legislation.act.gov.au | Strong consolidations; ACT is the most “register-like” after Cth | `/au/legis/act/` | |
| **NT** | https://legislation.nt.gov.au | | `/au/legis/nt/` | |
| **Norfolk Island** | FRL `ContinuedLaw` / `Q` series | | | Now largely on FRL. |

**`ordinance_radar` analogue:** for a state provision that cites a Cth parent (e.g. ACL applied as a law of NSW by *Fair Trading Act 1987* (NSW)), compare FRL `Versions.isCurrent.start` of the Cth parent against the state compilation date. There is **no** `lnkOrd`-style linkage API; parse AGLC citations in the state text (Korean radar’s strategy).

Local government **by-laws / local laws / LEPs**:

- NSW LEPs: NSW legislation register + planning portal.
- Vic local laws: council sites.
- Qld local laws: departmental register + council.

Treat these as a third tier, not as the state-Act analogue.

### 3.2 Administrative-review map (replaces the Korean administrative-appeal + tax-tribunal + labor-commission overlap)

```
Cth merits review ── ART (14 Oct 2024–) ── AustLII ARTA
                 └─ AAT (1976–14 Oct 2024) ── AustLII AATA  (closed; still citable)

Workplace ──────── FWC / FWCFB / (hist. FWA, AIRC, Australian Industrial Court)

Competition ────── ACCC (admin) → ACompT → FCA → HCA

Privacy / FOI ──── OAIC AICmr → ART (FOI) / FCA

Tax ────────────── ATO objection → ART (tax) → FCA → HCA
                   (+ IGT complaints)

Customs/dumping ── ABF / ADRP → ART / FCA

Integrity ──────── NACC / ACLEI(hist.) / state ICAC family
```

---

## 4. Citation conventions for a `verify_citations` engine (AGLC4)

Authority: *Australian Guide to Legal Citation* (4th ed, Melbourne University Law Review Association, 2018) — **AGLC4**. University libguides (UWA, UQ, USC, Newcastle, SCU, ECU) reproduce the grammar below. Pinpoint rule numbers are AGLC4’s.

### 4.1 Statutes (AGLC4 r 3.1)

```
<italic short title including year> (<jurisdiction abbreviation>) <pinpoint>
```

**Canonical example (the one in the brief):**

```
Competition and Consumer Act 2010 (Cth) s 18
```

Rendered in AGLC: *Competition and Consumer Act 2010* (Cth) s 18.

| Element | Rule | Grammar |
|---|---|---|
| Short title | 3.1.1 | Italicise. Include the year *in the title italics* even if you think of the year as a separate field. |
| Year | 3.1.2 | The year the Act received assent / year in the short title. |
| Jurisdiction | 3.1.3 | Round brackets, roman, not italic: `(Cth)` `(NSW)` `(Vic)` `(Qld)` `(SA)` `(WA)` `(Tas)` `(ACT)` `(NT)`. |
| Pinpoint | 3.1.4–3.1.7 | Abbreviation + **space** + number. **Never** `s18`. Subdivisions hang off the number: `s 5(2)(a)` not `s 5 sub-s (2)`. |

**Pinpoint abbreviations (r 3.1.4):**

| Designation | Singular | Plural |
|---|---|---|
| section | s | ss |
| subsection | sub-s | sub-ss |
| paragraph | para | paras |
| sub-paragraph | sub-para | sub-paras |
| part | pt | pts |
| division | div | divs |
| subdivision | sub-div | sub-divs |
| chapter | ch | chs |
| schedule | sch | schs |
| clause | cl | cls |
| sub-clause | sub-cl | sub-cls |
| order (delegated) | ord | ords |
| regulation | reg | regs |
| sub-regulation | sub-reg | sub-regs |
| rule | r | rr |
| sub-rule | sub-r | sub-rr |
| article | art | arts |
| appendix | app | apps |

Multiple pinpoints: plural of the **highest** level: `ss 5–6`, `ss 5(1)–(3)`.

**Definition pinpoint (r 3.1.6 style):** *Corporations Act 2001* (Cth) s 9 (definition of ‘administrator’ para (a)(i)).

**ACL as a schedule (very common hallucination magnet):**

```
Competition and Consumer Act 2010 (Cth) sch 2 ('Australian Consumer Law')
Competition and Consumer Act 2010 (Cth) sch 2 s 18
```

ACL s 18 is **not** CCA s 18. Live AustLII headings (2026): **CCA s 18 = “Meetings of Commission”**; **ACL s 18 (sch 2) = “Misleading or deceptive conduct”**. This is the flagship LLM mix-up. A verifier **must** know `sch 2`.

**Delegated legislation (r 3.4):** same shape as Acts.

```
Migration Regulations 1994 (Cth) regs 2.01–2.02
High Court Rules 2004 (Cth) r 42.02.2
```

**Bills (r 3.2):** title and year **not** italicised; pinpoint is usually `cl`:

```
Major Events Bill 2014 (Qld) cl 2
```

**Constitution (r 3.6):**

```
Australian Constitution s 51(xx)
Constitution s 109
Commonwealth of Australia Constitution Act 1900 (Imp) s 9
```

**Anaphora the Korean verifier had to learn — Australian equivalents:**

| Korean | Australian lawyer-speak | Verifier rule |
|---|---|---|
| `the same Act` / `that Act` (Korean statutory back-references) | “the Act”, “that Act”, “the *FW Act*” after a short-title definition | Inherit last full statute cite **within the same paragraph**. Do not inherit across a blank line (Korean v4.9.0 rule — copy it). |
| `「statute title」` (Korean corner-bracket title marks) | italics or *Title Year* (Cth) | Strip italics/`_`/`*` markdown. |
| branch-number articles (`Article 10-2`) | `s 10AA`, `s 10AB`, `s 41A` lettered sections | Regex: `s\s*\d+[A-Z]{0,3}` plus `(subdiv)` |

**Jurisdiction abbreviations (always these, never `Cwlth` / `Commonwealth` / `NSW.`):**

`Cth` `NSW` `Vic` `Qld` `SA` `WA` `Tas` `ACT` `NT`

### 4.2 Reported cases (AGLC4 r 2)

```
<italic party names> (<year>) <volume> <series> <start page>, <pinpoint>
```

**Canonical CLR example from the brief:**

```
Mabo v Queensland (No 2) (1992) 175 CLR 1
```

(Party italics; “(No 2)” inside the name; round brackets because CLR is a **volume-numbered** series.)

| Series organised by | Year brackets | Example |
|---|---|---|
| Volume number (CLR, FCR, NSWLR, ALR, ALJR) | **round** `(1992)` | *Mabo* (1992) 175 CLR 1 |
| Year as volume (VR, Qd R, WAR historically some) | **square** `[1977]` | *Nydam v The Queen* [1977] VR 430 |

**Authorised / unauthorised preference (r 2.2.2) — verifier should accept all, prefer left:**

| Rank | Kind | Series (abbrev) |
|---|---|---|
| 1 | Authorised | **CLR** (HCA), **FCR** (FCA), **NSWLR**, **VR**, **Qd R**, **SASR**, **WAR**, **Tas R**, **ACTR** (in ALR), **NTR** |
| 2 | General unauthorised | **ALR**, **ALJR**, **FLR**, **ACTLR** |
| 3 | Subject unauthorised | **A Crim R**, **ACSR**, **IR**, **IPR**, **ATD**, **ATR** |
| 4 | MNC unreported | `HCA`, `FCA`, `NSWSC`, … |
| 5 | Unreported without MNC | (Court, Judge, Full Date) |

Pinpoint for reported: **page** (and optionally paragraph): `(1992) 175 CLR 1, 42` or `, 42 [15]`.

### 4.3 Medium-neutral citations (AGLC4 r 2.3.1)

```
<italic party names> [<year>] <unique court identifier> <judgment number>, [<para>]
```

**Canonical:**

```
[2020] HCA 41
Love v Commonwealth (2020) 270 CLR 152; [2020] HCA 3
Quarmby v Keating [2009] TASSC 80, [11]
```

Rules:

- Use **only** if the court allocated it (from the start-year in the table below).
- Pinpoints are **paragraphs in square brackets**, comma before: `, [11]`, `, [11]–[14]`.
- Parallel citation: MNC and report may be joined with `;` or the report preferred in footnotes if authorised exists.
- Unique court identifiers are **not** followed by a full stop.

**Unreported without MNC (r 2.3.2):**

```
Smith v Jones (Supreme Court of New South Wales, Simpson J, 18 June 1996) [12]
```

### 4.4 Medium-neutral court / tribunal codes (AGLC4 Appendix B + current practice)

Years = when the court started allocating MNCs. A verifier should accept codes even outside those years if a database uses them, but should **warn** pre-adoption citations.

#### Commonwealth / federal

| Body | Code | From |
|---|---|---|
| High Court of Australia | **HCA** | 1998 |
| HCA special leave dispositions | **HCASL** | 2008 |
| HCA single justice | **HCASJ** | 2024 (practice) |
| Federal Court | **FCA** | 1999 (Full Court 1999–2001 also FCA) |
| Federal Court Full Court | **FCAFC** | 2002 |
| Family Court (hist.) | **FamCA** | 1998–2021 |
| Family Court Full Court (hist.) | **FamCAFC** | 2008–2021 |
| Federal Circuit Court (hist.) | **FCCA** / **FMCA** (pre-2013) | |
| Federal Circuit and Family Court (Div 1) | **FedCFamC1F** / **FedCFamC1A** (appeals) | 2021 |
| Federal Circuit and Family Court (Div 2) | **FedCFamC2F** / **FedCFamC2G** (GFL) | 2021 |
| Administrative Appeals Tribunal (closed 14 Oct 2024) | **AATA** | |
| Administrative Review Tribunal | **ARTA** | 2024 |
| Fair Work Commission | **FWC** | 2013 |
| FWC Full Bench | **FWCFB** | 2013 |
| Fair Work Australia (hist.) | **FWA** / **FWAFB** | 2009–2013 |
| Australian Industrial Relations Commission (hist.) | **AIRC** | |
| Australian Competition Tribunal | **ACompT** | |
| Copyright Tribunal | **ACopyT** | |
| Australian Information Commissioner | **AICmr** | 2010 |
| Takeovers Panel | **ATP** | |
| Native Title Tribunal | **NNTTA** | |
| Defence Force Discipline Appeal Tribunal | **ADFDAT** | |

#### New South Wales

| Body | Code |
|---|---|
| Supreme Court | **NSWSC** (1999–) |
| Court of Appeal | **NSWCA** |
| Court of Criminal Appeal | **NSWCCA** |
| Land and Environment Court | **NSWLEC** |
| District Court | **NSWDC** |
| Local Court | **NSWLC** |
| Industrial Relations Commission | **NSWIRComm** / **NSWIRComm** |
| NCAT (from 2014) | **NSWCAT** plus divisional: **NSWCATAD**, **NSWCATAP**, **NSWCATCD**, **NSWCATGD**, **NSWCATOD** |
| ADT (hist.) | **NSWADT** / **NSWADTAP** |

#### Victoria

| Body | Code |
|---|---|
| Supreme Court | **VSC** |
| Court of Appeal | **VSCA** |
| County Court | **VCC** |
| Magistrates’ Court | **VMC** |
| VCAT | **VCAT** |

#### Queensland

| Body | Code |
|---|---|
| Supreme Court | **QSC** |
| Court of Appeal | **QCA** |
| District Court | **QDC** |
| Magistrates | **QMC** |
| QCAT | **QCAT** / **QCATA** |

#### South Australia / WA / Tasmania / ACT / NT

| Body | Code |
|---|---|
| SA Supreme | **SASC** |
| SA Full Court / CoA | **SASCFC** / **SASCA** (check era) |
| SA District | **SADC** |
| SA ERD Court | **SAERDC** |
| SACAT | **SACAT** |
| WA Supreme | **WASC** |
| WA Court of Appeal | **WASCA** (1999–; previously Full Court) |
| WA District | **WADC** |
| SAT (WA) | **WASAT** |
| Tas Supreme | **TASSC** |
| Tas CCA | **TASCCA** |
| ACT Supreme (incl Full Court) | **ACTSC** |
| ACT Court of Appeal | **ACTCA** |
| ACAT | **ACAT** |
| NT Supreme | **NTSC** |
| NT Court of Appeal / CCA | **NTCA** / **NTCCA** |
| NTCAT | **NTCAT** |

A production alias table should also accept **dots/spaces** (`F.C.A.F.C.`, `N.S.W.C.A.`) and map them to the canonical token, then reject unknown tokens as `⚠ court code unclear` rather than `✗ NOT_FOUND` (Korean v4.9.0 lesson).

### 4.5 Citation-extraction regexes (starting point)

```
# MNC
\[((?:19|20)\d{2})\]\s*([A-Z][A-Za-z0-9]{1,12})\s+(\d+)

# Report series (volume-numbered)
\(((?:19|20)\d{2})\)\s+(\d+)\s+([A-Z][A-Za-z. ]{1,12}?)\s+(\d+)

# Report series (year-as-volume)
\[((?:19|20)\d{2})\]\s*(\d+\s+)?([A-Z][A-Za-z. ]{1,12}?)\s+(\d+)

# Statute
\*{0,2}([A-Z][^;*]{3,120}?Act)\s+((?:19|20)\d{2})\*{0,2}\s*\((Cth|NSW|Vic|Qld|SA|WA|Tas|ACT|NT)\)(?:\s+(s(?:ch)?|ss|pt|div|reg|regs|r|rr|cl|cls)\s+(\d+[A-Za-z]{0,3}(?:\(\d+[A-Za-z]*\))*))?
```

Then resolve:

1. Statute → FRL `Titles` (alias dictionary first) → optional EPUB/AustLII section existence check.
2. MNC → AustLII path `/au/cases/{j}/{CODE}/{year}/{n}.html` and/or JADE / NSW Caselaw `mnc=` / HCA list.
3. Report series → LawCite `?cit=` (best free resolver of parallel citations).

Content-mismatch (Korean v4.6): if the model cites `Competition and Consumer Act 2010 (Cth) s 18 (misleading or deceptive conduct)`, compare the **section heading** in FRL/AustLII. Live headings: CCA s 18 is “Meetings of Commission”; misleading-or-deceptive conduct is **sch 2 s 18**. That is the flagship trap. FRL also exposes per-volume EPUB HTML (e.g. `https://www.legislation.gov.au/C2004A00109/{date}/{date}/text/original/epub/OEBPS/document_4/document_4.html` for the schedules volume) — a possible article-level path that does not depend on AustLII slugs.

---

## 5. Act abbreviation / alias dictionary (seed)

Korean MCP’s `LAW_ALIAS_ENTRIES` is the pattern: **short spoken form → official short title**, plus guards so a failed alias search is not reported as “the Act does not exist”.

Below is a practitioner-frequency seed, not a complete thesaurus. Official short titles are FRL/`Legislation Act 2003` (Cth) s 10 style. Always store **jurisdiction**.

### 5.1 Commonwealth — high frequency

| Alias | Official short title | FRL title ID (live where probed) |
|---|---|---|
| **CCA** | *Competition and Consumer Act 2010* (Cth) | **C2004A00109** |
| **TPA** / Trade Practices Act | same Act, former name until 1 Jan 2011 | same ID |
| **ACL** | *Competition and Consumer Act 2010* (Cth) **sch 2** (applied as a law of each State/Territory by application Acts) | same + sch 2 |
| **FW Act** / FWA / Fair Work Act | *Fair Work Act 2009* (Cth) | **C2009A00028** |
| **FWRO Act** / Registered Organisations | *Fair Work (Registered Organisations) Act 2009* (Cth) | |
| **Corps Act** / CA 2001 / Corporations Act | *Corporations Act 2001* (Cth) | **C2004A00818** |
| **ASIC Act** | *Australian Securities and Investments Commission Act 2001* (Cth) | C2004A00819 |
| **PPSA** | *Personal Property Securities Act 2009* (Cth) | |
| **NCCP Act** / National Credit Code | *National Consumer Credit Protection Act 2009* (Cth) (Code is sch 1) | |
| **ITAA 1936** / 36 Act | *Income Tax Assessment Act 1936* (Cth) | |
| **ITAA 1997** / 97 Act | *Income Tax Assessment Act 1997* (Cth) | |
| **TAA** / TAA 1953 | *Taxation Administration Act 1953* (Cth) | |
| **GST Act** | *A New Tax System (Goods and Services Tax) Act 1999* (Cth) | |
| **FBTAA** | *Fringe Benefits Tax Assessment Act 1986* (Cth) | |
| **SIS Act** | *Superannuation Industry (Supervision) Act 1993* (Cth) | |
| **CGT** (informal) | Parts of ITAA 1997 Pts 3-1, 3-3 | not an Act |
| **AIA** / Interpretation Act (Cth) | *Acts Interpretation Act 1901* (Cth) | C1901A00002 |
| **LA 2003** / Legislation Act | *Legislation Act 2003* (Cth) | C2004A01224 |
| **Judiciary Act** | *Judiciary Act 1903* (Cth) | |
| **Migration Act** / MA | *Migration Act 1958* (Cth) | |
| **Citizenship Act** | *Australian Citizenship Act 2007* (Cth) | |
| **ADJR Act** | *Administrative Decisions (Judicial Review) Act 1977* (Cth) | |
| **ART Act** | *Administrative Review Tribunal Act 2024* (Cth) | C2024A00040 |
| **AAT Act** (hist.) | *Administrative Appeals Tribunal Act 1975* (Cth) — **repealed 14 Oct 2024** | successor = ART Act |
| **Privacy Act** | *Privacy Act 1988* (Cth) | |
| **FOI Act** | *Freedom of Information Act 1982* (Cth) | |
| **Archives Act** | *Archives Act 1983* (Cth) | |
| **EPBC Act** | *Environment Protection and Biodiversity Conservation Act 1999* (Cth) | |
| **TIA Act** / TIAA | *Telecommunications (Interception and Access) Act 1979* (Cth) | |
| **SD Act** / Surveillance | *Surveillance Devices Act 2004* (Cth) | |
| **Crimes Act (Cth)** | *Crimes Act 1914* (Cth) — **not** the state Crimes Acts | |
| **Criminal Code (Cth)** | *Criminal Code Act 1995* (Cth) sch (“Criminal Code”) | |
| **CDPP** (body) | — | not an Act |
| **NSI Act** | *National Security Information (Criminal and Civil Proceedings) Act 2004* (Cth) | |
| **PGPA Act** | *Public Governance, Performance and Accountability Act 2013* (Cth) | |
| **Fair Work Regulations** | *Fair Work Regulations 2009* (Cth) | |
| **Corporations Regulations** | *Corporations Regulations 2001* (Cth) | |
| **Banking Act** | *Banking Act 1959* (Cth) | |
| **Insurance Contracts Act** / ICA | *Insurance Contracts Act 1984* (Cth) | |
| **Life Insurance Act** | *Life Insurance Act 1995* (Cth) | |
| **AML/CTF Act** | *Anti-Money Laundering and Counter-Terrorism Financing Act 2006* (Cth) | |
| **Cth Evidence Act** | *Evidence Act 1995* (Cth) | UEA |
| **Native Title Act** / NTA | *Native Title Act 1993* (Cth) | |
| **Fair Work Act s 90** etc. | still the FW Act | |
| **Modern Slavery Act** | *Modern Slavery Act 2018* (Cth) | |
| **Whistleblower / PID Act** | *Public Interest Disclosure Act 2013* (Cth) | |
| **NACC Act** | *National Anti-Corruption Commission Act 2022* (Cth) | |
| **Work Health and Safety Act (Cth)** | *Work Health and Safety Act 2011* (Cth) | (harmonised; states have their own) |

### 5.2 Uniform Evidence Law / “UEA”

*Evidence Act 1995* (Cth) and the NSW/Vic/Tas/ACT/NT Evidence Acts are often called **UEA** / “uniform evidence law”. **Queensland, WA, SA** are **not** UEA jurisdictions (they retain common law + local Acts). A verifier that maps “Evidence Act s 138” without a jurisdiction is in `⚠ jurisdiction unclear` territory.

### 5.3 State aliases lawyers actually type

| Alias | Official |
|---|---|
| **CLA** (NSW) | *Civil Liability Act 2002* (NSW) — Vic/Qld/WA/Tas/ACT have similarly named Acts, **different section numbering** |
| **CPA** (NSW) | *Civil Procedure Act 2005* (NSW) |
| **UCPR** | *Uniform Civil Procedure Rules 2005* (NSW) |
| **PPSA** (don’t confuse) | Cth PPSA, not a state Act |
| **EPA** | *Environmental Planning and Assessment Act 1979* (NSW) (now often “Planning Act” informally — still EPA Act) |
| **LEP / SEPP** | local / state environmental planning policies (NSW) |
| **POEO Act** | *Protection of the Environment Operations Act 1997* (NSW) |
| **Crimes Act** | *Crimes Act 1900* (NSW); *Crimes Act 1958* (Vic); *Criminal Code Act 1899* (Qld); etc. **Always require (NSW)/(Vic)/…** |
| **Sentencing Act** | *Crimes (Sentencing Procedure) Act 1999* (NSW); Vic *Sentencing Act 1991* |
| **BA / Bail Act** | *Bail Act 2013* (NSW) etc. |
| **LTA / LEPRA** | *Law Enforcement (Powers and Responsibilities) Act 2002* (NSW) |
| **RTA / Road Transport Act** | *Road Transport Act 2013* (NSW) |
| **Residential Tenancies Act** | per-state; NSW 2010, Vic 1997, Qld 2008… |
| **FTA** (NSW) | *Fair Trading Act 1987* (NSW) — applies ACL |
| **ACL (Vic)** | *Australian Consumer Law and Fair Trading Act 2012* (Vic) |
| **OMA** | *Owners Corporations Act* variants |
| **VCAT Act** | *Victorian Civil and Administrative Tribunal Act 1998* (Vic) |
| **QCAT Act** | *Queensland Civil and Administrative Tribunal Act 2009* (Qld) |
| **SACAT Act** | *South Australian Civil and Administrative Tribunal Act 2013* (SA) |
| **SAT Act** | *State Administrative Tribunal Act 2004* (WA) |
| **WHS Act** | harmonised *Work Health and Safety Act 2011* in most jurisdictions; **Vic still Occupational Health and Safety Act 2004 (Vic)** |
| **IA** (NSW) | *Interpretation Act 1987* (NSW) |

### 5.4 Bodies that get used as if they were statutes

| Token | Resolve to |
|---|---|
| ACCC | body; statute = CCA |
| ASIC | body; statute = ASIC Act + Corps Act |
| APRA | body; *APRA Act* + industry Acts |
| ATO | body; ITAA 36/97 + TAA |
| FWO | Fair Work Ombudsman; statute = FW Act |
| FWC | tribunal; statute = FW Act |
| OAIC | body; Privacy Act + FOI Act |
| ABF | body; *Customs Act 1901* (Cth), *Migration Act 1958* (Cth) |
| ART | tribunal; ART Act 2024 |
| NCAT/VCAT/QCAT | tribunals; their establishing Acts |

### 5.5 Implementation notes for the alias table

1. Store `{alias, official, jurisdiction, titleId?, notes, sch?}`.
2. **ACL is a schedule**, not a separate FRL title.
3. **TPA and CCA are one titleId.**
4. On zero FRL hits after alias expansion, return `⚠ no overlap` (Korean `hasRelatedHit` guard) — never `✗ the Fair Work Act does not exist`.
5. Disambiguate bare `Crimes Act` / `Evidence Act` / `Civil Liability Act` by requiring jurisdiction or returning candidates.

---

## 6. “Is this case still good law?” — noteups and citators

### 6.1 What Australian lawyers actually do

Order of operations in a firm:

1. **Open the authorised report** if there is one (CLR/FCR/NSWLR/…).
2. Run a **paid citator**:
   - **CaseBase** (Lexis+) — signal flags (red/yellow), treatment (applied, followed, distinguished, overruled, considered, cited).
   - **FirstPoint / KeyCite-style** (Westlaw AU / Thomson) — same job; FirstPoint is the Australian digest + citator.
3. Skim **subsequent appellate treatment**, especially HCA and the intermediate appellate court of the same jurisdiction (*Farah Constructions* / *CAL No 14* constraints on intermediate courts departing from each other).
4. Check **legislation** — a case can be good law and still **dead in practice** because the section was amended (FRL point-in-time + amending Act). This is the Korean `applicable_law` ∩ `cite_check` intersection.
5. Only then, if no subscription, use **free** tools (below).

There is **no** Australian equivalent of Korea’s en banc “we hereby depart from the earlier holding” formula that you can grep with high precision. Overruling is discursive (“we decline to follow”, “should not be regarded as authority for”, “*X* is overruled”). HCA occasionally says “overruled” in terms; more often it “explains” or “does not follow”.

### 6.2 Free sources that allow a *partial* citator

| Source | What you get | What you don’t | MCP use |
|---|---|---|---|
| **LawCite** “Cases Referring to this Case” | Later cases (AU + many foreign LIIs) that **cite** this one; parallel citations; stars | Editorial treatment; reliability of “overruled” | **Primary free `cite_check`**. Deep-link `LawCite?cit=` |
| **AustLII Noteup** | SINO mention-search of the citation / section | Same; plus false positives on party names | Fallback when LawCite is thin; **best for statute sections** (`impact_map`) |
| **JADE** subsequent consideration | Often richer catchword/consideration UI than LawCite; MNC lookup | Not a fully documented API; ToS | Second free citator |
| **Court of Appeal / HCA catchwords** | Sometimes “overruled” in catchwords | Not systematic | Heuristic |
| **NSW Caselaw `casesCited` field** | Decisions that list a citation in the “cases cited” headnote field | Only NSW corpus; only if the field was populated | Useful extra signal for NSW |
| **FRL `statusHistory` / `nameHistory`** | The **statute** is/isn’t in force; renamed | Says nothing about cases | Always run in parallel with case citators |
| **ART/AAT “disapproved”** | Occasional | Tribunals do not bind | Weak |

### 6.3 Recommended `cite_check` verdicts (do not overclaim)

Mirror Korean `✅ still cited / ⚠️ successor exists / ❌ overruling detected`, but **recalibrate**:

| Verdict | When to emit |
|---|---|
| `cited` | LawCite/Noteup/JADE shows later citations; no contrary appellate language found |
| `not_found` | MNC/report does not resolve in AustLII **and** LawCite **and** JADE **and** (if NSW) Caselaw — after distinguishing 403/503 from absence (Korean v4.12) |
| `overruled_candidate` | Later HCA or same-jurisdiction CoA catchwords/text match overrule language **and** name the case |
| `legislative_override` | FRL shows the relied-on section amended/repealed after the decision date |
| `unverified_treatment` | Citations exist but treatment cannot be classified — **default**. Do not pretend to be CaseBase. |

Always print the **later citing cases** (Korean does this) so a human can finish the job.

### 6.4 Paid sources to name in the product docs (not to scrape)

- Lexis+ **CaseBase**
- Westlaw AU **FirstPoint**
- CCH / IntelliConnect subject citators
- BarNet JADE professional tiers

Scraping these is a licence violation. The MCP should **cite them as the professional standard** and implement the free graph.

---

## 7. Korean killer-features → Australian implementation sketch

| Korean feature | Australian build |
|---|---|
| `search_law` | `Titles?$filter=contains(name,'…')` + alias table + exact rank + `isPrincipal` + `collection`. Always return `titleId`, current `status`, `nameHistory`. |
| `get_law_text` | `Versions` → `Documents(composite key)` PDF/Word/EPUB. Multi-volume loop. Optional AustLII `s{n}.html` for one section. |
| `applicable_law` | `Versions/Find(titleId, asAt=ISO)`. Compare `isCurrent` vs `isLatest`. Extract `reasons[].markdown` as the amending schedule items. Pull endnotes from the PDF/EPUB for transitional provisions. |
| Repealed successor | `statusHistory.reasons.affectedByTitle` + `nameHistory`. TPA/CCA must not look “repealed”. |
| `verify_citations` | AGLC regexes §4.5 → FRL existence + section heading Jaccard (reuse Korean LexDiff idea) → MNC HEAD/GET AustLII/JADE. |
| `cite_check` | LawCite `?cit=` + Noteup + overrule heuristics §6.3. |
| `impact_map` | LawCite “Legislation Considered” + AustLII Noteup on `s n` + (NSW) `legislationCited`. |
| `ordinance_radar` | State register compilation date vs FRL parent `isCurrent.start`. |
| `search_decisions` | Domain table §3; SINO `mask_path` per domain. |
| Annexes | FRL schedules are in-compilation (sch, not HWP). ACL = sch 2. Forms often in rules/regulations as sch. |
| Terms KB | No legal-terminology API. Seed from *Acts Interpretation Act 1901* (Cth) s 2B, *Legislation Act 2003*, UEA Dictionary, Corps Act s 9. |

### 7.1 Hard constraints the Korean server already learned (apply here)

1. **Never convert upstream failure into `NOT_FOUND`.** AustLII will 403. FRL will 5xx under load. NSW Caselaw empty form ≠ zero hits (you forgot `courts=`).
2. **Per-request upstream budget** (Korean `MCP_MAX_UPSTREAM_REQUESTS=48`). A CCA 4-volume PDF pull plus LawCite plus Noteup burns the budget fast.
3. **Partial results on deadline** for research chains.
4. **Alias miss ≠ statute does not exist.**
5. **Unclear law name ≠ NOT_FOUND.**

### 7.2 Suggested advertised tool list (keep 10-tool shape)

1. `legal_research` (tasks: full_research, law_system, action_basis, dispute_prep, amendment_track, state_compare, procedure_detail, document_review)
2. `legal_analysis` (modes: verify_citations, cite_check, applicable_law, impact_map)
3. `search_law`
4. `get_law_text`
5. `get_schedules` (FRL sch/EPUB tables; ACL sch 2)
6. `state_radar` (ordinance_radar analogue)
7. `search_decisions` (domains in §3)
8. `get_decision_text`
9. `discover_tools`
10. `execute_tool`

---

## 8. Worked examples (end-to-end)

### 8.1 “s 18 CCA” hallucination check

Input: `s 18 Competition and Consumer Act 2010 (Cth)` (misleading conduct).

1. Alias `CCA` → *Competition and Consumer Act 2010* (Cth) → `C2004A00109`.
2. FRL title `status=InForce`.
3. Section heading check (AustLII `…/caca2010265/s18.html`, live): CCA s 18 heading is **“Meetings of Commission”**. If the surrounding words are “misleading or deceptive”, emit **`CONTENT_MISMATCH`**: the provision is **ACL s 18** (*CCA* sch 2 s 18).
4. Point-in-time: ACL s 18 has been stable; still resolve `Versions/Find` if a date is supplied.

### 8.2 Point-in-time TPA

Input: conduct on **2010-12-15**, “s 52 TPA”.

1. Alias `TPA` → titleId `C2004A00109`.
2. `Versions/Find(asAt=2010-12-15)` → name **Trade Practices Act 1974**, compilation window ending 2011-01-01.
3. Cite as *Trade Practices Act 1974* (Cth) s 52 (then the misleading-conduct provision).
4. Do not say the TPA “does not exist”.

### 8.3 Case citator

Input: `[2020] HCA 41` or `(1992) 175 CLR 1`.

1. Normalise via LawCite `?cit=`.
2. Pull “Cases Referring to this Case”.
3. If CLR, also Noteup `175 CLR 1` and `Mabo w/2 Queensland`.
4. Check FRL only if the user tied the case to a section.

### 8.4 NSW judgment

Input: `[2010] NSWCCA 333`.

```
GET caselaw.nsw.gov.au/search/advanced?mnc=[2010] NSWCCA 333&courts=54a634063004de94513d8279&_courts=on&_tribunals=on
→ /decision/549fff1d3004262463c85662
→ Dela Cruz v R [2010] NSWCCA 333
```

(The policy page’s *Regina v Whyte* `[2002] NSWCCA 343` is a linking example; it is **not** 2010 NSWCCA 333.)

---

## 9. Source log (what was actually hit)

| Source | Result on 2026-09-03 |
|---|---|
| `GET https://api.prod.legislation.gov.au/v1/` | 200, entity sets listed |
| `GET …/v1/$metadata` | 200, EDMX parsed |
| `GET …/swagger/v1/swagger.json` | 200, OpenAPI 3.0.1, 108 paths |
| `GET …/Titles/$count` | **132171** |
| `Titles?$filter=name eq 'Competition and Consumer Act 2010'` | `C2004A00109`, `year=1974`, `number=51`, `nameHistory` TPA→CCA |
| `Titles?$filter=name eq 'Fair Work Act 2009'` | `C2009A00028` |
| `Titles?$filter=name eq 'Corporations Act 2001'` | `C2004A00818` |
| `Versions/Find(C2004A00109, 2010-12-31)` | name `Trade Practices Act 1974` |
| `Versions/Find(C2004A00109, 2011-01-01)` | name `Competition and Consumer Act 2010`, `C2011C00003` |
| `Versions` isLatest / isCurrent on CCA | compilation 165 `C2026C00323` vs unincorporated from 2026-08-27 |
| `Documents(…volumeNumber=1,format='Pdf')` | **200**, `C2026C00323VOL01.pdf`, 550 pages, 2.2 MB |
| `Documents/Find(...)` | **404** in this probe — use composite key |
| `Titles?$filter=status eq 'Repealed'` | `statusHistory.reasons.affectedByTitle` populated |
| `TextApplies?$top=2` | *Legislation Act 2003* ss 42, 50 regimes |
| `https://www.legislation.gov.au/C2004A00109` | 200, title “Competition and Consumer Act 2010” |
| NSW Caselaw advanced MNC search | 200, 1 hit, `/decision/549fff1d3004262463c85662` |
| `eresources.hcourt.gov.au` | **301** → `hcourt.gov.au/cases-and-judgments/judgments` |
| AustLII / LawCite / judgments.fedcourt.gov.au | **403 Cloudflare** from this host |
| FRL help/FAQ/data-share pages | 200, used for ID grammar and linking |

---

## 10. Bottom line for the build

Australia can support a korean-law-mcp-shaped product, but **the centre of gravity flips**:

- **Statutes (Cth):** first-class. FRL OData is the one gift. Point-in-time, rename, repeal-with-successor, multi-volume authorised PDFs are all there.
- **Statutes (States):** eight separate registers + AustLII. This is the ordinance problem, except the “ordinances” are sovereign Parliaments.
- **Cases:** HTML federation. AustLII SINO + LawCite are the search/citator backbone; HCA/FCA/NSW Caselaw are official-text backends. Expect anti-bot.
- **18 Korean domains:** all have an Australian institution, **none** share an API. ART (2024) and FWC/OAIC/ACCC/ACompT/NACC are the non-court mappings.
- **Citation verifier:** AGLC4 is strict and regular enough to parse; the ACL-as-sch-2 and TPA=CCA traps are the Korean “the same Act” moment.
- **Good law:** free tools give **citation graphs**, not Shepard’s signals. Product copy must say so.

If only one upstream is wired in v1, wire **FRL**. If only one case upstream, wire **AustLII SINO + LawCite** with a JADE/HCA/NSW fallback and the v4.12 “unreachable ≠ absent” rule turned on from day one.

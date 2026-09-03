# Federal Register of Legislation (legislation.gov.au) API — Verified Reference

**Verification date: 2026-09-03** (live curl verification by research agent). Two hosts matter:

- **`https://api.prod.legislation.gov.au/v1/`** — OData 4.0 API (JSON). This is what www.legislation.gov.au's Angular frontend calls.
- **`https://www.legislation.gov.au/`** — serves the actual document files (epub/pdf/docx) via a path-based URL grammar (not OData).

## 1. Base API, auth, rate limits

```bash
curl "https://api.prod.legislation.gov.au/v1/"          # service document (entity sets)
curl "https://api.prod.legislation.gov.au/v1/\$metadata" # full EDM schema (XML, ~30KB)
```

- **Verified: fully public and keyless.** No API key, no auth header, no cookie needed for any read described here. CORS is open.
- Served via CloudFront (Sydney POPs), `odata-version: 4.0`.
- **Rate limits: none observed** (20-req burst all 200s; no Retry-After headers). Be polite.
- Entity sets (verified): `Titles`, `Versions`, `Documents`, `Affect`, `Content`, `Departments`, `DocumentPrints`, `TextApplies`, plus internal `_*Search` sets.
- **Gotcha:** `Affect` appears in the service document but **404s when queried directly**.

### Key entity fields (from `$metadata`, confirmed in live responses)

- **Title** (key `id`, e.g. `C2004A00109`): `name, makingDate, collection (Act|LegislativeInstrument|NotifiableInstrument|AdministrativeArrangementsOrder|Constitution|ContinuedLaw|Gazette|PrerogativeInstrument), subCollection (Regulations|CourtRules|Rules|ByLaws), isPrincipal, isInForce, status (InForce|Ceased|Repealed|NeverEffective), hasCommencedUnincorporatedAmendments, nameHistory[], statusHistory[], originatingBillUri, asMadeRegisteredAt, year, number, seriesType (Act|SR|SLI)`.
- **Version** (key `titleId,start,retrospectiveStart`): `end, retrospectiveEnd, isCurrent, isLatest, name, status, registerId, registeredAt, compilationNumber, hasUnincorporatedAmendments, reasons[]`.
- **Document** (composite key incl. `format,type,volumeNumber`): `format (Word|Pdf|Epub|NameOnly), type (Primary|ES|SupportingMaterial|IncorporatedByReference|SupplementaryES), extension, pageCount, sizeInBytes, isAuthorised, registerId, compilationNumber`.

## 2. Searching for acts/instruments by title

### a) Plain OData `$filter` on `Titles`

```bash
# keyword in current name
curl "https://api.prod.legislation.gov.au/v1/Titles?\$filter=contains(name,'Competition%20and%20Consumer')%20and%20collection%20eq%20'Act'&\$select=id,name,status,isPrincipal,isInForce,year,number&\$top=10&\$count=true"

# exact name -> the one principal act
curl "https://api.prod.legislation.gov.au/v1/Titles?\$filter=name%20eq%20'Competition%20and%20Consumer%20Act%202010'&\$select=id,name,status"
# -> {"id":"C2004A00109","name":"Competition and Consumer Act 2010","status":"InForce"}

# by act year/number (Act No. 51 of 1974 = TPA = CCA series)
curl ".../v1/Titles?\$filter=year%20eq%201974%20and%20number%20eq%2051%20and%20seriesType%20eq%20'Act'&\$select=id,name"
# -> C2004A00109
```

**Key fact:** `name eq`/`contains(name, ...)` **also matches historical names**. `name eq 'Trade Practices Act 1974'` returns `C2004A00109` (current name "Competition and Consumer Act 2010"). Results may show a different `name` than searched.

`startswith(name,'Privacy Act')` also verified (41 hits).

### b) The `Search(criteria=...)` bound function — a custom criteria DSL

```
GET /v1/Titles/Search(criteria='<expr>')?$top=...&$select=...
```

| Criteria function | Syntax (verified) | Notes |
|---|---|---|
| `text(...)` | `text("phrase",searchType,matchType)` | searchType: `nameAndText` (default) \| `name` \| `id`; matchType: `contains` (default, phrase) \| `exact` \| `startswith` \| `excludes` \| `any` \| `all` |
| `collection(...)` | `collection(Act)` — **unquoted** enum | quoted form errors |
| `status(...)` | `status(InForce)` — unquoted | |
| `pointintime(...)` | `pointintime("2015-06-30")` or `pointintime(Latest)` | quoted date, unquoted keyword |
| `id(...)` | `id("C2004A00109")` | |
| `affectedby(...)` | `affectedby("C2004A00109",[amending])` | see section 6 |
| `and(...)` / `or(...)` | `and(expr1,expr2,expr3)` — **function style, not infix** | |

**Critical gotchas (all observed):**
- Search text is **URI-encoded inside the criteria string**: spaces must be `%2520` in the final curl URL (`%20` after one decode). Plain space -> 0 hits.
- Infix `A AND B` **parses but silently ignores B**. Always use `and(A,B)`.
- Unknown function names -> HTTP 400 `cannot parse <token>`.
- `[` `]` in criteria: pass `-g` to curl.

```bash
# VERIFIED: title/name-only search
curl -g "https://api.prod.legislation.gov.au/v1/Titles/Search(criteria='text(%22competition%2520and%2520consumer%22,name,contains)')?\$top=3&\$select=id,name&\$count=true"   # 311 hits
```

Response shape: normal OData `{"@odata.count":N,"value":[{Title fields...}]}`.

## 3. Full text of an act / a specific section

**No API endpoint returns one section.** Text is delivered as complete documents (per volume) from `www.legislation.gov.au`:

```
https://www.legislation.gov.au/{titleId}/{asat}/{viewedat}/{type}/{rect}/{format}[/{volume}][/OEBPS/...]
  asat/viewedat: yyyy-mm-dd | asmade | latest
  type:          text | es | supportingmaterial | incorporatedbyreference | supplementaryes | bill
  rect:          original | latest | <n>
  format:        epub | word | pdf
```

Verified downloads:

```bash
# current compiled act, ePub (all volumes in one ~1MB zip; XHTML inside)
curl -O "https://www.legislation.gov.au/C2004A00109/latest/latest/text/latest/epub"        # 200, epub+zip
# as-made original, PDF
curl -O "https://www.legislation.gov.au/C2004A00109/asmade/asmade/text/original/pdf"       # 200
# Word: MUST give a volume number for multi-volume acts
curl -O "https://www.legislation.gov.au/C2004A00109/latest/latest/text/latest/word/1"      # 200 (.../word and /word/0 -> 404)
# point-in-time (any date inside a version window works)
curl -O "https://www.legislation.gov.au/C2004A00109/2015-06-30/2015-06-30/text/latest/epub" # 200
```

**HTML without downloading the whole zip — the server extracts individual epub members:**

```bash
# table of contents (NCX) — hierarchical: Chapter -> Part -> Division -> section, with anchors
curl "https://www.legislation.gov.au/C2004A00109/latest/latest/text/latest/epub/OEBPS/document.ncx"
# one volume's full HTML (volumes are OEBPS/document_N/document_N.html)
curl "https://www.legislation.gov.au/C2004A00109/latest/latest/text/latest/epub/OEBPS/document_4/document_4.html"
```

**Section retrieval recipe (verified end-to-end for CCA s 18):**
1. Fetch `OEBPS/document.ncx`. Each `<navPoint>` has `<text>18  Misleading or deceptive conduct</text>` and `<content src="document_4/document_4.html#_Toc235543096"/>`. CCA latest: 2,603 navPoints across 4 volumes. Section labels use `\xa0` non-breaking spaces.
2. Fetch that volume's HTML, slice between the section's `_Toc...` anchor and the next navPoint's anchor.

Formats: **Epub (XHTML — best for text extraction), Pdf (the `isAuthorised: true` copies), Word (.docx)**. No plain-text or per-section JSON. Document metadata via OData:

```bash
curl "https://api.prod.legislation.gov.au/v1/Documents?\$filter=titleId%20eq%20'C2004A00109'%20and%20start%20eq%202026-07-01&\$select=type,format,extension,pageCount,isAuthorised,registerId,compilationNumber"
```

(`Documents/Find(...)` 404s — use the `$filter` form.)

## 4. Point-in-time (versions / compilations) — fully supported

```bash
# all versions of the series (CCA has 210)
curl "https://api.prod.legislation.gov.au/v1/Versions?\$filter=titleId%20eq%20'C2004A00109'&\$select=start,end,retrospectiveStart,retrospectiveEnd,isCurrent,isLatest,status,registerId,compilationNumber&\$orderby=start%20desc&\$count=true"

# THE time-travel call: version in force at a date
curl "https://api.prod.legislation.gov.au/v1/Versions/Find(titleId='C2004A00109',asAt=2015-06-30T00:00:00)"
# -> {"TitleId":"C2004A00109","Start":"2015-01-01","End":"2015-07-01","RegisterId":"C2015C00019",...}

# named specifications: 'latest' | 'current' | 'asmade'
curl "https://api.prod.legislation.gov.au/v1/versions/find(titleId='C2004A00109',asAtSpecification='latest')"
# reverse lookup by compilation register id
curl "https://api.prod.legislation.gov.au/v1/versions/find(registerId='C2015C00019')"
```

- Version fields: `start`/`end` (window of force; `end:null` = open), `registerId` (compilation id), `compilationNumber`, `isCurrent` vs `isLatest`.
- **Gotcha:** `isCurrent` version may have `registerId:null` (amendments commenced, compilation pending). `isLatest` = newest *registered* compilation.
- **Gotcha:** the `asAt=<datetime>` form returns **PascalCase** field names (`TitleId`, `Start`); the `asAtSpecification` form returns camelCase. Handle both.
- `viewedAt` parameter also accepted (retrospective compilations).
- Datetime literals: **no trailing `Z`**; `Z` -> 400.
- To download that point-in-time text, plug the date into the file URL (section 3).
- Enum `Default.AsAtType` = `Latest | AsMade | Current`.

## 5. Series / repeal / principal metadata

```bash
curl "https://api.prod.legislation.gov.au/v1/Titles?\$filter=contains(name,'Australian%20Securities%20and%20Investments%20Commission%20Act%201989')&\$select=id,name,status,isInForce,statusHistory"
```

Returns `status:"Repealed"`, `isInForce:false`, and `statusHistory` with the repeal event including **what repealed it**:

```json
{"status":"Repealed","start":"2001-07-15T00:00:00","reasons":[{"affect":"Repeal",
  "markdown":"sch 1 (item 1) of the [Corporations (Repeals, Consequentials and Transitionals) Act 2001](/C2004A00823)",
  "affectedByTitle":{"titleId":"C2004A00823","name":"Corporations (Repeals, Consequentials and Transitionals) Act 2001","provisions":"sch 1 (item 1)","year":2001,"number":55,"seriesType":"Act"}}]}
```

- `isPrincipal` distinguishes principal vs amending acts.
- "As made" = `.../asmade/asmade/...` URLs + `asMadeRegisteredAt`; "in force" = compilations/versions. `statusPossibleFuture` exists for scheduled repeals.
- **"What replaced it"**: no dedicated field — the repealing title in `statusHistory.reasons[].affectedByTitle` is the machine-readable link.

## 6. Amendment relationships ("affected by / affects")

**a) `affectedby()` criteria — everything that amended/repealed/modified a title:**

```bash
curl -g "https://api.prod.legislation.gov.au/v1/titles/search(criteria='affectedby(%22C2004A00109%22,[amending])')?\$select=id,name,year,number&\$orderby=name%20asc&\$count=true&\$top=100"
# -> @odata.count: 201 amending acts for the CCA
```

Affect-type list: `[repealing,amending,modifying,savingTransitionalOrApplication]` (also `ceasing,commencing,sunsetAltering` per AffectSearch schema). Add `&$expand=searchContexts($expand=affects)` for per-result flags: `isAmending,isRepealing,isModifying,isCommencing,hasCommencedAffect,hasUncommencedAffect,...` (verified).

**b) Per-version `reasons` — which act/provisions caused each compilation:**

```bash
curl "https://api.prod.legislation.gov.au/v1/Versions?\$filter=titleId%20eq%20'C2004A00109'%20and%20registerId%20eq%20'C2026C00323'&\$select=registerId,start,reasons"
# reasons[]: {"affect":"Amend","affectedByTitle":{"titleId":"C2025A00057","name":"Treasury Laws Amendment (Payday Superannuation) Act 2025","provisions":"sch 1 (item 66)"},...}
```

`ReasonAffect` = `AsMade|Amend|Repeal|Cease|ChangeDate|Disallow`.

- **Converse direction** (what does amending act X affect): **not exposed** (`affects("id")` invalid; `Affect` set 404s). Confirmed absent.

## 7. Names / abbreviations

- `nameHistory` on Title (verified): CCA returns Trade Practices Act 1974 -> Competition and Consumer Act 2010 with dates and `affecterTitleId`. Duplicate entries occur — dedupe. `namePossibleFuture` also exists.
- Name filters match historical names automatically.
- **No abbreviation/alias field exists** (no "CCA", "ACL"). The MCP must keep its own alias map.

## 8. Full-text search + working OData options

Full-text search inside legislation text via `text(...,nameAndText,...)`. Point-in-time full-text combos verified:

```bash
# acts containing the phrase today (53) vs at 30 Jun 2015 (33)
curl -g ".../v1/Titles/Search(criteria='and(text(%22misleading%2520or%2520deceptive%22,nameAndText,contains),collection(Act))')?\$top=100&\$count=true"
curl -g ".../v1/Titles/Search(criteria='and(text(%22misleading%2520or%2520deceptive%22,nameAndText,contains),collection(Act),pointintime(%222015-06-30%22))')?\$count=true"
# relevance score per hit:
# ...&$expand=searchContexts($expand=fullTextVersion($select=relevance))
```

Default order for `text()` searches is relevance descending (verified).

| OData option | Status |
|---|---|
| `$filter` (`eq`, `and`, `contains`, `startswith`, enum literals as strings, date literals w/o `Z`) | Verified working |
| `$select`, `$top`, `$skip`, `$count=true` | Verified working |
| `$orderby` | Partial: `name`, `year`, `asMadeRegisteredAt`, `start` work; **`makingDate` -> 500** |
| `$expand` | Only on Titles: `searchContexts($expand=fullTextVersion\|pointInTime\|affects)`, `textApplies`, `administeringDepartments`. **Blocked on Versions** |
| `$search` | **Silently ignored** — never rely on it |
| Pagination | **`$top` max = 100** (larger -> 400). No `$top` -> server pages at 510 rows **and `@odata.nextLink` DROPS your `$filter`**. Always paginate manually with `$top<=100` + `$skip`. |

## 9. Other collections & extras

- `collection eq 'Gazette'` (18,593 titles; pdf/epub downloads work, e.g. `C2026G00247/asmade/asmade/text/original/pdf`), `AdministrativeArrangementsOrder` (36), `Constitution` (1: `C2004Q00685`), `NotifiableInstrument`, `PrerogativeInstrument`, `ContinuedLaw` (Norfolk Island).
- `Departments` entity: `{id:"O-000778",name:"Attorney-General's Department",portfolio:"Attorney-General's"}`; Titles expand `administeringDepartments`.
- `originatingBillUri` on Title links to parlinfo.aph.gov.au — bills not in FRL.
- Explanatory statements/memoranda: document `type=ES` + URL segment `/es/` (schema-verified; download not exercised).
- Sunsetting/disallowance: `searchContexts` navs `futureSunsetDate`, `openForDisallowance`, `disallowance` (schema-verified only).

## 10. Consolidated gotcha list

1. Criteria DSL: double-URL-encode search text (`%2520`); use `and()`/`or()` — infix `AND` silently ignored; enums unquoted; curl needs `-g` for `[...]`.
2. `$top` hard cap 100; `@odata.nextLink` loses `$filter` — paginate manually.
3. Datetime literals without `Z`.
4. `Versions/Find(asAt=...)` returns PascalCase; other forms camelCase.
5. `$search` silently ignored; `$orderby=makingDate` 500s; `$expand` forbidden on Versions; `Affect` set 404s.
6. Word downloads need explicit volume (`/word/1`); epub is single-file all volumes.
7. Current in-force version may have `registerId:null`; use `isLatest` for latest registered compilation; check `hasUnincorporatedAmendments`.
8. Name filters match historical names — returned `name` may differ from query.
9. No per-section endpoint — slice epub HTML via NCX anchors (labels contain `\xa0`).

## Summary table

| Capability | Endpoint | Verified |
|---|---|---|
| Service/metadata, keyless access | `GET /v1/`, `GET /v1/$metadata` | Yes |
| Title/keyword search (filter) | `GET /v1/Titles?$filter=contains(name,'...')` | Yes |
| Search DSL (name/full-text/facets) | `GET /v1/Titles/Search(criteria='and(text("...",nameAndText,contains),collection(Act))')` | Yes |
| Full act text (epub/pdf/docx) | `GET https://www.legislation.gov.au/{id}/{asat}/{viewedat}/text/{rect}/{format}[/vol]` | Yes |
| Section-level TOC + single section | `.../epub/OEBPS/document.ncx` + `.../OEBPS/document_N/document_N.html` (client-side slice) | Yes (CCA s 18) |
| List all versions of a series | `GET /v1/Versions?$filter=titleId eq '...'` | Yes (210 for CCA) |
| Version in force at date (time travel) | `GET /v1/Versions/Find(titleId='...',asAt=YYYY-MM-DDT00:00:00)` | Yes |
| Version by keyword spec / registerId | `.../versions/find(titleId='...',asAtSpecification='latest')`, `...find(registerId='...')` | Yes |
| Point-in-time document download | `.../{id}/2015-06-30/2015-06-30/text/latest/epub` | Yes |
| Repeal status + repealing act | `Titles` -> `status`, `statusHistory[].reasons[].affectedByTitle` | Yes |
| Principal vs amending; in-force flag | `Titles.isPrincipal`, `isInForce` | Yes |
| Amendment history (who amended X) | `titles/search(criteria='affectedby("id",[amending,repealing,...])')` | Yes (201 for CCA) |
| Per-compilation amendment reasons | `Versions.reasons[]` | Yes |
| What X amends (converse) | none exposed | Confirmed absent |
| Name history / renames | `Titles.nameHistory` | Yes |
| Full-text search @ point in time + relevance | `Search(criteria='and(text(...),pointintime("date"))')` + expand fullTextVersion | Yes |
| Gazettes / AAOs / Constitution | `Titles?$filter=collection eq 'Gazette'` etc. | Yes |
| Departments / administering dept | `GET /v1/Departments`; `$expand=administeringDepartments` | Yes |
| Bill link | `Titles.originatingBillUri` -> aph.gov.au | Field only |
| Rate limiting / auth | none observed / none required | Yes |

# Australian Law MCP — API Reference

> **v1.0.0** | 10 advertised tools (81 registered; the other 71 are reached with `execute_tool`, or called directly by name)

Tool structure and the honest-limitations tables are in [README.md](../README.md).
Exhaustive parameter definitions are the Zod schemas in `src/tools/*.ts` — this
document covers **shape, identifiers and the traps**, not every field.
The rules in [DEVELOPMENT.md](DEVELOPMENT.md) are the source of truth for behaviour.

---

## Common

### Identifier formats

Every id this server prints can be passed straight back to another tool.
**Never construct one.** An invented `registerId` is well-formed and wrong, and
the Register will answer about a different Act.

| Kind | Where it comes from | Format | Example |
|---|---|---|---|
| Act | `search_law` | `C` + 4-digit year + `A` + 5 digits | `C2004A00109` |
| Legislative instrument | `search_law`, `get_three_tier` | `F` + year + `L` + 5 digits | `F2011L00287` |
| Notifiable instrument | `search_agency_rules` | `F` + year + `N` + 5 digits | `F2021N00171` |
| Gazette notice | `search_gazettes` | `C` + year + `G` + 5 digits | `C2026G00108` |
| Continued law (Norfolk Island etc.) | `search_law` | `C` + year + `Q` + 5 digits | `C2015Q00131` |
| Compilation (point-in-time version) | `search_historical_law`, `applicable_law` | `C` + year + `C` + 5 digits | `C2010C00331` |
| Provision reference | you write it | see below | `sch 2 s 18` |
| Medium-neutral citation | `search_decisions`, `search_cases` | `[YYYY] COURT N` | `[2020] HCA 41` |
| Reported citation | text being checked | `(YYYY) VOL SERIES PAGE` | `(1992) 175 CLR 1` |
| Decision id | `search_decisions` | per domain, see below | `nsw:174af54a434669161f7da9d3` |

The year in a register id is the year the record entered the Register, **not**
the year of the Act. `C2004A00109` is the *Competition and Consumer Act 2010*,
originally the *Trade Practices Act 1974*, No 51 of 1974.

### Provision references

`src/lib/section-ref.ts` is the single source of this grammar.

| Form | Meaning |
|---|---|
| `s 18` | Section 18 of the Act's body |
| `sch 2 s 18` | Section 18 **inside schedule 2** — this is ACL s 18 |
| `s 5(2)(a)` | Subsections carried through as `["2","a"]` |
| `s 10AA` | Lettered section; the suffix is kept separate from the number |
| `s 355-25` | ITAA-style compound section number — **not** a range |
| `ss 5-6` | A *range*, because the plural abbreviation is present |
| `pt IVA`, `div 2`, `ch 3` | A structural unit; returns the whole subtree |
| `sch 1 item 4` | An item within a schedule |
| `reg 2.01` | An instrument's regulation |

> ⚠️ **The single most expensive mistake in Australian law is dropping the schedule prefix.**
> *Competition and Consumer Act 2010* (Cth) **s 18** is "Meetings of Commission".
> **sch 2 s 18** is "Misleading or deceptive conduct" — the Australian Consumer
> Law. Both exist, both return text, and only one is what anyone means.
> Call `get_schedules` first whenever the user names a *body of law* (the ACL, a
> Criminal Code, a model law) rather than an Act.

`s18` without the space is accepted on input and never produced on output —
AGLC r 3.1.4 requires the space.

### Decision ids by domain

| Domain | Id format | Example |
|---|---|---|
| `cases` | `nsw:<hex>` · `hca:<slug>` · `qld:<numeric>`. The prefix is what routes the lookup, so a bare MNC is refused here — `get_case_text(citation=…)` is the citation path | `nsw:174af54a434669161f7da9d3`, `hca:potter-pseudonym-v-king` |
| `constitutional` | High Court slug | `calidad-pty-ltd-v-seiko-epson-corporation` |
| `admin_appeals` | `ncat:<hex>` · `qcat:<…>` · or a QCAT citation | `ncat:591a8d78e4b074a7c6e16046` |
| `tax_tribunal` | ATO DocID | `AID/AID20161/00001` |
| `tax_rulings` | ATO DocID or product code | `TR 2024/1`, `TXR/TR20241/NAT/ATO/00001` |
| `interpretations` | ATO DocID or product code | `PS LA 2009/9` |
| `customs` | ATO DocID | — |
| `competition` | case-law id (the fallback path) | `nsw:…` |
| `workplace` | FWC slug | `werner-david-bradley-v-bhpm-…-2014-fwc-3013` |
| `privacy` | AICmr citation | `[2025] AICmr 89` |
| `integrity` | NACC operation anchor | `operation-wilson` |
| `public_service` | MPC slug | `no-serious-defects-selection-process` |
| `university_rules` | State register id + `options.jurisdiction` | `act-1998-047` |
| `agency_rules` | Federal Register id | `F2021N00171` |
| `gazettes` | Federal Register id | `C2026G00108` |
| `treaties` | numeric database id + `options.keyword` | `3030` |
| `explanatory` | Federal Register id | `F2025L00385`, `C2022A00083` |
| `state_law` | State register id + `options.jurisdiction` | `Act-2000-005` |

### Error labels

Every result carries a bracket label as its first token. The label is the
contract; the prose after it is for a human. `src/lib/errors.ts` is the single
source, and a label is **never** constructed ad hoc outside that constant.

| Label | Meaning | What a caller must do |
|---|---|---|
| `[NOT_FOUND]` | A source that authoritatively covers this record says it is not there | You may report absence — this is the only label that permits it |
| `[UPSTREAM_NO_DATA]` | The source was asked and did not hand the record over | **Not** absence. Retrying, or a different addressing, may work |
| `[UPSTREAM_BLOCKED]` | The source exists and is known, and this server refuses to fetch it | **Not** absence and **not** retryable. Hand the user the deep link that travels with this label |
| `[EXTERNAL_API_ERROR]` | The upstream failed, timed out, or exceeded a limit | A failure of the lookup, not a finding about the record |
| `[INVALID_PARAMETER]` | The call was malformed | Fix the call |
| `[RATE_LIMITED]` | A limiter refused the call | Back off |
| `[REQUEST_TIMEOUT]` | The upstream did not answer in its per-host budget | Retry, or narrow the query |
| `[PARSE_ERROR]` | The response arrived but did not have the expected shape | Usually an upstream markup change — report it |
| `[ANNEX_BODY_UNAVAILABLE]` | A schedule was located but its body is not inline in the record | Follow the document link |

The three "we do not have it" labels are kept strictly apart on purpose. If
`[UPSTREAM_BLOCKED]` reads as absence, this server advises a real Act or a real
judgment out of existence — the worst failure a legal research tool has.

Analysis tools add four verdict labels of their own:

| Label | Emitted by | Meaning |
|---|---|---|
| `[VERIFIED]` | `verify_citations` | Every citation checked and correct |
| `[PARTIALLY_VERIFIED]` | `verify_citations` | Some citations could not be checked here (`⚠`). **Not** a pass |
| `[CITATION_ERRORS_FOUND]` | `verify_citations` | At least one citation cannot be right. Sets `isError: true` |
| `[NO_CITATIONS_FOUND]` | `verify_citations` | Nothing was found to check. **Explicitly not** a clean bill of health |

### Verdict glyphs

| Glyph | Meaning |
|---|---|
| `✓` | Verified against a source that covers it |
| `✗` | Cannot be right — the provision or case does not exist, or the text describes a different provision |
| `⚠` | Not checked here. **Never** a finding that something is wrong |
| `⭐` | A pointer to the provision the caller almost certainly meant |
| `⚖️` | A legal question this tool identifies but does not answer |

### Error response shape

```json
{
  "content": [{
    "type": "text",
    "text": "[UPSTREAM_BLOCKED] nswLegislation is not fetched by this server (no public query surface and the register discourages automated access). This is a refusal to request, not an observation about the record — nothing here says the material is absent.\nTool: search_state_law\nSuggestions:\n  1. ⚠️ Do not report this as 'no such case/legislation'. …\n  2. Open directly: https://legislation.nsw.gov.au"
  }],
  "isError": true
}
```

### Caching

| Kind | TTL |
|---|---|
| Search results | 1 hour |
| Provision / document text, tables of contents | 24 hours |

The cache is in-process and per-server. A table of contents is fetched once per
Act per date and reused by every tool in the request — that is why
`verify_citations` can check six citations against one Act without six fetches.

### Limits

| Limit | Default | Env |
|---|---|---|
| Upstream attempts per request (retries included) | 48 | `MCP_MAX_UPSTREAM_REQUESTS` |
| Bytes from one upstream response | 8 MiB | `MCP_MAX_UPSTREAM_BODY_BYTES` |
| Upstream bytes for one whole request | 32 MiB | `MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES` |
| Characters in one tool response | 50,000 | `MCP_MAX_TOOL_RESPONSE_CHARS` |
| Chain deadline | 45,000 ms | `MCP_CHAIN_DEADLINE_MS` |
| `tools/call` items per JSON-RPC envelope (HTTP) | 20 | `MCP_MAX_BATCH_CALLS` |
| `get_law_text` returned characters | 20,000 (max 45,000) | `maxChars` parameter |
| `get_batch_provisions` | 20 titles · 50 provisions each · 100 total | — |
| `search_law` results | 10 (max 50) | `limit` parameter |

One budget serves the whole request. A JSON-RPC batch and every step of a chain
draw on the same allowance, so a single envelope cannot multiply this server's
footprint on the public sources it reads.

> ⚠️ The 8 MiB per-response default is **sized against the upstream, not
> rounded**. The Federal Register has no per-section endpoint: Act text arrives
> as whole epub volumes, and the *Competition and Consumer Act*'s are 2.0 MiB and
> 4.1 MiB. Setting `MCP_MAX_UPSTREAM_BODY_BYTES` below ~5 MiB makes `get_law_text`
> fail on the largest Acts with `[EXTERNAL_API_ERROR]`, which a caller reads as
> "not found".

---

## Advertised tools (10)

### Aggregate entry points (2)

#### `legal_research`

Multi-step research in one call. Eight patterns behind `task`, each running
several searches in parallel and returning one document with **every gap
explicitly marked**.

| Parameter | Required | Description |
|---|:---:|---|
| `query` | ✓ | The question, in plain English or as a law name |
| `task` | | `full_research` (default) · `law_system` · `action_basis` · `dispute_prep` · `amendment_track` · `state_law_compare` · `procedure_detail` · `document_review` |
| `text` | | Required by `document_review` — the document to triage |

| `task` | Answers |
|---|---|
| `full_research` | Open question, no Act known. Legislation → the base law's structure → case law → a judgment and a ruling in full |
| `law_system` | One Act's structure, its former names, what amended it, what is made under it |
| `action_basis` | What authorises a decision: the three tiers, rulings, cases, tribunal review |
| `dispute_prep` | What has already been decided, including by the specialist body |
| `amendment_track` | What changed in an Act, and when |
| `state_law_compare` | Commonwealth against the State counterparts — the usual source of a wrong Australian answer |
| `procedure_detail` | Fees, forms, steps (which in Australia live in schedules) |
| `document_review` | Triage a document, then find the law behind each flag |

For a single lookup `search_law` → `get_law_text` is faster.

#### `legal_analysis`

| `mode` | Required | Optional |
|---|---|---|
| `verify_citations` | `text` | `maxCitations` (default 15, max 30) |
| `cite_check` | `caseNumber` (`"[2020] HCA 41"`) **or** `query` | — |
| `applicable_law` | `lawName` or `query`, plus `date` or `asAt` | `provision` |
| `impact_map` | `lawName` or `query` | `provision` / `section` |

**`verify_citations`** extracts statute citations (AGLC or loose, markdown
italics, `the Act` anaphora within a paragraph, jurisdiction omitted) and case
citations (medium-neutral and reported), then checks each one for **existence
and content**. Content is compared against the Register's own provision heading
in two layers: an exact longest-common-substring of ≥30 normalised characters,
then character-bigram Jaccard ≥0.25. A real section carrying a description of a
different provision is reported as `CONTENT_MISMATCH`, with the provision the
writer actually meant.

**`cite_check`** locates the case, then searches the reachable sources for later
judgments that mention it and scans the surrounding language for treatment. The
verdict is always scoped to what was scanned, and the retrieved count is printed
alongside the count the source claims.

**`applicable_law`** finds the compilation in force on a date, returns the
provision as it stood then, diffs it against today, and lists the application,
saving and transitional headings from the amending Acts — which it does **not**
interpret.

### Legislation (3)

#### `search_law`

| Parameter | Required | Description |
|---|:---:|---|
| `query` | ✓ | Name or abbreviation, min 2 chars. `CCA`, `ACL`, `FW Act`, `TPA` resolve through the alias table, and so do former names |
| `collection` | | `Act` · `LegislativeInstrument` · `NotifiableInstrument` · `Constitution` · `Gazette` |
| `status` | | `InForce` · `Repealed` · `Ceased` · `NeverEffective`. Omit to see repealed titles too — they are annotated with what repealed them |
| `pointInTime` | | `YYYY-MM-DD` — search the law as it stood on that date |
| `searchText` | | Search the full text as well as titles. Slower and much broader |
| `limit` | | Default 10, max 50 |

Principal Acts are re-ranked above same-named instruments. Every hit carries
rename, repeal and unincorporated-amendment warnings.

#### `get_law_text`

| Parameter | Required | Description |
|---|:---:|---|
| `registerId` | | From `search_law`. Preferred |
| `query` | | A name, if you have no `registerId` |
| `provision` | | `"s 18"`, `"sch 2 s 18"`, `"pt IVA"`, `"reg 2.01"`. A structural reference returns the whole subtree |
| `date` | | `"YYYY-MM-DD"`, `"latest"` (default), or `"asmade"` |
| `maxChars` | | Default 20,000, max 45,000 |

Without a `provision` this returns the **table of contents and guidance**, never
the full text. That is a deliberate refusal, not an empty result: a compiled Act
is several megabytes across multiple volumes.

#### `get_schedules`

| Parameter | Required | Description |
|---|:---:|---|
| `registerId` | | From `search_law` |
| `query` | | A name or alias, if you have no `registerId` |
| `schedule` | | Schedule number to open, e.g. `"2"` for the ACL. Omit to list all |
| `titleContains` | | Filter the list to schedules whose heading contains this word |
| `date` | | `"YYYY-MM-DD"`, `"latest"` (default) or `"asmade"` |
| `includeText` | | With `schedule`, return its full text instead of its outline. Schedules can be very long |
| `maxChars` | | Default 20,000, max 45,000 |

Call it before `get_law_text` whenever the user names a body of law rather than
an Act. The response marks the ACL explicitly.

### Instruments (1)

#### `instrument_radar`

Compares when an instrument was last compiled against when its enabling Act was
last amended, and flags instruments whose Act has moved since — with the
intervening amendments and their register ids, so the enabling provision can be
checked. **A flag is a prompt to review, not a finding that the instrument is
invalid or out of date.**

### Decisions (2)

#### `search_decisions`

| Parameter | Required | Description |
|---|:---:|---|
| `domain` | ✓ | One of the 18 (see README) |
| `query` | | Search terms. Required by every domain except `constitutional`, `privacy`, `integrity`, `public_service` and `treaties`, whose sources are browsable indexes. Omitted elsewhere the call comes back `[INVALID_PARAMETER]`: the target domain's own schema is checked before anything is fetched, so nothing was searched |
| `limit` | | Maximum hits, 1–50, default 10 — this tool's own default, so a domain whose stand-alone tool defaults differently (`search_agency_rules` and `search_gazettes` default to 20) still gets 10 here. `constitutional` and `treaties` ignore it: their sources hand over a fixed page (12 and 20 rows), so move with `page` instead. For `privacy`, `integrity`, `public_service` and `workplace` it trims the page that was fetched rather than fetching more |
| `page` | | 1-based. `competition`, `integrity`, `university_rules`, `state_law` and `explanatory` have no paging at all and ignore it |
| `options` | | Domain-specific parameters — the table below is the whole of it. A key the target domain does not declare is neither rejected nor used: it is silently ignored. `domain`, `query`, `limit` and `page` are this tool's own parameters, so they are dropped from `options` and the response says which |

**`options` by domain, for `search_decisions`.** Each row is what that domain's
own Zod schema declares, which is what its handler reads.

| Domain | Honoured `options` |
|---|---|
| `cases` | `{jurisdiction, court}` — `Cth`/`NSW`/`Qld`/… and a court token such as `NSWCA` |
| `constitutional` | `{year, verifyCatchwords}` |
| `admin_appeals` | `{tribunal, division}` — `ncat`/`qcat`/`all`, and an NCAT division token |
| `tax_tribunal` | `{decisionImpactOnly}` — true by default |
| `tax_rulings` · `interpretations` · `customs` | `{exactPhrase}` |
| `workplace` | `{benchType}` — `full` or `single` |
| `public_service` | `{facets}` |
| `treaties` | `{facets, dateFilters}` |
| `explanatory` | `{collection, verifyEs}` |
| `state_law` | `{jurisdiction, field, includeRepealed}` — `jurisdiction` is **required** and the call is refused without it |
| `university_rules` | `{jurisdiction}` — optional; omitted, `QLD`, `TAS`, `WA` and `NT` are searched together. `field` and `includeRepealed` are not read here, only by `state_law` |
| `competition` · `privacy` · `integrity` · `agency_rules` · `gazettes` | `{}` — nothing beyond the four parameters above |

No domain takes an `asAt` on the search side: point-in-time is a property of
`get_decision_text` (see below). A date passed here is ignored in silence — the
response carries no note about it, and the hits are today's.

#### `get_decision_text`

| Parameter | Required | Description |
|---|:---:|---|
| `domain` | ✓ | The same domain the id came from |
| `id` | ✓ | The identifier printed by `search_decisions`. **Never an invented one** |
| `full` | | `true` returns the body verbatim. Omitted shortens a long body from the middle, marking the exact number of characters removed. Every domain that hands over a body honours it except `constitutional`, whose High Court reasons are shortened by their own renderer — that response says so and prints the judgment URL. `privacy`, `competition`, `agency_rules`, `gazettes`, `treaties` and `explanatory` return metadata and links, so there is no body to return verbatim |
| `options` | | Domain-specific parameters, **not** the same set as `search_decisions` — the table below is the whole of it. `domain`, `id` and `full` are dropped from `options` with a note; anything a domain does not declare is silently ignored |

**`options` by domain, for `get_decision_text`.**

| Domain | Honoured `options` |
|---|---|
| `tax_tribunal` · `tax_rulings` · `interpretations` · `customs` | `{asAt}` — `YYYY-MM-DD`, the ATO's own point-in-time index, which is separate from the Register's compilation series |
| `treaties` | `{keyword, page}` — the database has no single-record endpoint, so without the keyword that produced the id the lookup scans page 1 only |
| `privacy` | `{page}` — the index page the determination is on, if it is not page 1 |
| `state_law` · `university_rules` | `{jurisdiction}` — **required**; the id alone does not say which register it belongs to |
| `cases` · `constitutional` · `admin_appeals` · `competition` · `workplace` · `integrity` · `public_service` · `agency_rules` · `gazettes` · `explanatory` | `{}` — nothing beyond the three parameters above |

`get_case_text` also takes a `citation`, but `get_decision_text` always sets `id`
and the id branch returns first, so a citation passed through `options` does
nothing. For the citation path call
`execute_tool(tool_name="get_case_text", params={citation:"[2020] HCA 41"})`.

### Meta (2)

#### `discover_tools`

`{intent: string}` — what you are trying to do, or the area of law. Returns the
matching tools grouped by category, ranked, each with its full description, and
closes with the **right call path**: advertised tools are named as direct calls,
everything else as `execute_tool(tool_name, params)`.

```
Tools for "point in time law":

[history and versions]
  - get_law_history: …
  - get_provision_history: …
  …

Run any of these with execute_tool(tool_name, params).
```

#### `execute_tool`

`{tool_name: string, params: object}` — runs any of the 81 by name. Parameters
pass straight through and are validated by the target tool, so a malformed
parameter comes back as that tool's own error rather than a generic one. Pass
`{}` for a tool that takes none.

---

## Unadvertised tools (71)

All of these are callable directly by name, and reachable through
`discover_tools` → `execute_tool`. Categories are `TOOL_CATEGORIES` in
`src/lib/tool-profiles.ts` — the same table `discover_tools` searches and the
CLI's `list --category` filters on.

### legislation (10)

| Tool | Description |
|---|---|
| `search_law` | *(advertised)* |
| `get_law_text` | *(advertised)* |
| `search_ai_law` | Natural-language search over the full text of Commonwealth legislation. Every word must appear; principal Acts ranked first |
| `search_all` | Commonwealth + one State register + case law at once, as a compact merged answer with a section per family. Each family degrades on its own |
| `advanced_search` | Full-text phrases, multiple collections, status and point-in-time facets, AND/OR |
| `suggest_law_names` | Autocomplete from a prefix or abbreviation. The Register has no abbreviation field, so `CCA`/`ACL` resolve only through this server's table |
| `get_batch_provisions` | Many provisions at once, from one Act or several. The TOC and each volume are fetched once per title and reused. Misses are listed, never omitted |
| `get_law_tree` | An Act's structure as an indented outline. `from:"sch 2"` re-roots on the ACL |
| `get_law_system_tree` | Status, former names, amending Acts and delegated legislation in one view — the orientation call for an unfamiliar statute |
| `get_law_statistics` | Live `@odata.count` figures by collection, status or year |

### instruments (8)

| Tool | Description |
|---|---|
| `get_three_tier` | Delegated legislation made under an Act, grouped by kind, each with the enabling provision |
| `get_enabled_instruments` | The same relation, flat and paged |
| `get_enabling_acts` | The Act an instrument was made under, and the exact enabling provision, from the Register's own authorisation relation |
| `get_instrument_provisions` | An instrument's outline, or one provision. Instruments number as `reg 2.01` or `s 7` |
| `instrument_radar` | *(advertised)* |
| `search_agency_rules` | Notifiable instruments — agency determinations, delegations, appointments |
| `search_gazettes` | Commonwealth Gazette notices, proclamations, appointments |
| `get_registered_instrument_text` | A notifiable instrument or gazette notice by register id |

### state law (5)

| Tool | Description |
|---|---|
| `search_state_law` | QLD and TAS by full text; WA/NT/VIC/ACT by title or register number. NSW and SA are refused, with links |
| `get_state_law_text` | QLD/TAS/WA return text; VIC and NT return the authorised PDF/DOCX links, because that is the only authorised form; ACT is addressed by register number |
| `get_state_equivalents` | A curated map onto counterparts in the other jurisdictions — ACL application Acts, harmonised WHS, uniform Evidence, uniform Defamation — saying **how** each relates and naming the non-adopters |
| `search_university_rules` | The Acts that establish and govern Australian universities, across the State registers |
| `chain_state_law_compare` | *(chain)* Commonwealth against the State counterparts |

### case law (6)

| Tool | Description |
|---|---|
| `search_decisions` / `get_decision_text` | *(advertised)* |
| `search_cases` | The three reachable sources at once. An MNC routes to an exact lookup |
| `get_case_text` | One judgment by MNC or by the prefixed id from `search_cases` |
| `search_constitutional_decisions` | High Court judgments whose catchwords are constitutional. Can verify the catchwords rather than trusting the facet |
| `get_constitutional_decision_text` | One High Court judgment by slug |

### tribunals (7)

`search_decisions` · `search_admin_appeals` · `get_admin_appeal_text` ·
`search_tax_tribunal_decisions` · `get_tax_tribunal_decision_text` ·
`search_public_service_decisions` · `get_public_service_decision_text`

### tax and rulings (4)

| Tool | Description |
|---|---|
| `search_rulings` | TR/TD/GSTR/PCG public rulings, ATO IDs, practice statements, customs and excise, plus the Anti-Dumping Review Panel indexes. An exact product code is resolved by exact search |
| `get_ruling_text` | By product code or DocID. `asAt` reaches the ATO's own point-in-time index, which is **separate** from the Register's compilation series |
| `search_tax_tribunal_decisions` | ATO decision impact statements — where the ATO says whether it will follow a decision |
| `get_tax_tribunal_decision_text` | One decision impact statement by DocID |

### workplace · privacy · competition · integrity · public service (10)

`search_workplace_decisions` / `get_workplace_decision_text` ·
`search_privacy_decisions` / `get_privacy_decision_text` ·
`search_competition_decisions` / `get_competition_decision_text` ·
`search_integrity_decisions` / `get_integrity_decision_text` ·
`search_public_service_decisions` / `get_public_service_decision_text`

### treaties (2) · explanatory (2)

| Tool | Description |
|---|---|
| `search_treaties` | DFAT Australian Treaties Database, with status and entry into force. A treaty binds Australia internationally without being domestic law until legislation implements it; the results say which is which where the database records it |
| `get_treaty_text` | One record by database id. The database has **no single-record endpoint**, so pass the `keyword` that produced the id or the lookup scans page 1 only |
| `search_explanatory` | Explanatory statements (registered with the instrument) and memoranda (belonging to the originating bill). Extrinsic material under s 15AB of the *Acts Interpretation Act 1901* |
| `get_explanatory_text` | An instrument resolves to its registered statement; an Act to the bill's memoranda on ParlInfo |

### history and versions (6)

| Tool | Description |
|---|---|
| `get_law_history` | What changed in a date window — commencements, amendments, repeals, cessations. `{date:"2026-07-01"}` sweeps the whole Register for that day |
| `get_provision_history` | One provision's history from the Act's own endnotes. `sch 2 s 18` and `s 18` give different answers — **pass the schedule prefix** |
| `compare_old_new` | Two compilations of the same Act: the amending Acts recorded for each intervening compilation, and a text diff of one provision |
| `search_historical_law` | The compilations, newest first, with the amending Acts that caused each. `asAt` finds the single one in force on a date |
| `get_historical_law` | A specific compilation, by `date` or `compilationId`. `date:"asmade"` is the original enacted text |
| `chain_amendment_track` | *(chain)* |

### schedules (2) · terminology (7) · documents and links (4) · utilities (2)

| Tool | Description |
|---|---|
| `get_schedules` | *(advertised)* |
| `chain_procedure_detail` | *(chain)* Fees, forms and steps — which live in schedules |
| `get_legal_term_kb` | A term across the bundled Australian glossary and the definition sections of Commonwealth Acts |
| `get_legal_term_detail` | One term in full: definition, defining provisions, related terms |
| `get_plain_term` | The legal term behind an everyday word — "sacked", "ripped off", "bond" |
| `get_plain_to_legal` | Everyday wording → vocabulary that will match legislation and judgments |
| `get_legal_to_plain` | A legal term in ordinary English, for reporting back to a non-lawyer |
| `get_term_provisions` | The provisions that **define** a term. A term defined in one Act's dictionary can mean something else in another |
| `get_related_laws` | The Acts and instruments that use a term |
| `analyze_document` | Triage a contract, terms of service, letter or notice: numbered clauses, risk signals with severity, key amounts and periods, internal conflicts. Pattern matching, **not advice** — a quiet result is never a clearance |
| `get_external_links` | Deep links for sources this server will not fetch |
| `chain_document_review` | *(chain)* |
| `parse_section_ref` | Parse and normalise a provision reference to AGLC form |
| `get_law_abbreviations` | The abbreviation table `search_law` resolves through |

### citations and verification (5)

`legal_analysis` *(advertised)* · `verify_citations` · `cite_check` ·
`applicable_law` · `impact_map` — each also callable under its own name.

### research — chains (8)

`chain_full_research` · `chain_law_system` · `chain_action_basis` ·
`chain_dispute_prep` · `chain_amendment_track` · `chain_state_law_compare` ·
`chain_procedure_detail` · `chain_document_review` — each also reachable as a
`legal_research` `task`.

---

## Workflow examples

### The ACL trap, done correctly

```
1. search_law(query="ACL")
   → C2004A00109 · Competition and Consumer Act 2010
     ↳ previously named: Trade Practices Act 1974 (renamed, NOT repealed)

2. get_schedules(registerId="C2004A00109")
   → Schedule 2—The Australian Consumer Law
     ⭐ ACL s 18 = provision "sch 2 s 18", NOT "s 18"

3. get_law_text(registerId="C2004A00109", provision="sch 2 s 18")
   → 18 Misleading or deceptive conduct
```

Skipping step 2 and asking for `"s 18"` returns "Meetings of Commission" — real
text, wrong provision, no error.

### Point in time

```
1. legal_analysis(mode="applicable_law", lawName="Trade Practices Act",
                  date="2010-06-30", provision="s 52")
   → the compilation in force (C2010C00331), the text as it stood,
     a diff against today, and the transitional headings

2. get_provision_history(registerId="C2004A00109", provision="s 52")
   → s 52: rep by No 103, 2010
```

### Checking an LLM's advice before relying on it

```
1. legal_analysis(mode="verify_citations", text="<the drafted advice>")
   → ✗ CONTENT_MISMATCH · ✗ NOT_FOUND · ⚠ not checked here

2. for each ✗: get_law_text(registerId=…, provision=<the corrected ref>)
3. for each case cited: legal_analysis(mode="cite_check", caseNumber="[YYYY] CRT N")
```

`⚠` is not a pass. Report it as unchecked.

### Finding a tool you were not told about

```
1. discover_tools(intent="explanatory memorandum")
   → search_explanatory, get_explanatory_text  [explanatory]
     Run any of these with execute_tool(tool_name, params).

2. execute_tool(tool_name="get_explanatory_text",
                params={registerId:"C2022A00083"})
```

### Decisions, end to end

```
1. search_decisions(domain="workplace", query="serious misconduct")
   → id: werner-david-bradley-…-2014-fwc-3013

2. get_decision_text(domain="workplace",
                     id="werner-david-bradley-…-2014-fwc-3013")
   → metadata + PDF link
     Note: the FWC serves reasons as a PDF inside a viewer; the reasons exist —
     this server just did not receive them as text.
```

---

## Related documents

- [README.md](../README.md) — tool structure, the 18-domain table, honest limitations
- [ARCHITECTURE.md](ARCHITECTURE.md) — sources, layering, the client contract
- [DEVELOPMENT.md](DEVELOPMENT.md) — the canonical rules, plus build, test and fixture conventions
- [VERIFICATION.md](VERIFICATION.md) — the live verification log

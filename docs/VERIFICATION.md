# Live verification log

> **v0.1.0** | Run 2026-09-04, macOS 15 (darwin 25.6.0), Node 22, from a residential
> Australian-reachable IP. Every result below is from the **real built server**
> talking to the **real upstreams** — no fixtures, no mocks.

This file is evidence, not documentation. It records what was run, what came
back, and whether the answer was good enough to rely on. Where an answer was
wrong it says so, and says whether the cause was this server or the upstream.

Method: `npm run build`, then `node build/index.js` spawned as a child process
and driven over stdio with raw JSON-RPC — `initialize`, `notifications/initialized`,
then `tools/call` per scenario. The CLI scenarios ran the real `build/cli.js`
binary. The packed-artifact scenarios ran from a tarball installed into a clean
directory.

---

## 1. Test suites

| Suite | Command | Result |
|---|---|---|
| Offline (before any change) | `npx vitest run` | **94 files passed, 1 skipped · 1700 passed, 18 skipped · 30.6s** |
| Offline (after the fixes below) | `npx vitest run` | **94 files passed, 1 skipped · 1708 passed, 18 skipped · 30.5s** |
| Typecheck | `npx tsc --noEmit` | **clean** |
| Live-gated | `LIVE=1 npx vitest run src/tools/decision-domains.live.test.ts` | **18 passed / 18 · 16.4s** |

`src/tools/decision-domains.live.test.ts` is the only live-gated file. Per-test
results, in run order:

| # | Test | Result | ms |
|---|---|---|---|
| 1 | case law — NSW simple search returns rows with decision ids | PASS | 232 |
| 2 | case law — NSW exact-MNC lookup finds one decision | PASS | 802 |
| 3 | case law — the High Court year facet survives the WAF (literal brackets) | PASS | 499 |
| 4 | case law — a Queensland citation resolves straight to its judgment | PASS | 2205 |
| 5 | tribunals — the ATO form POST returns a result list | PASS | 537 |
| 6 | tribunals — an ATO product code resolves to exactly one document | PASS | 593 |
| 7 | tribunals — FWC row count is the row count, not the facet total | PASS | 1899 |
| 8 | tribunals — the OAIC determinations index parses | PASS | 257 |
| 9 | tribunals — the DFAT treaty API answers with records | PASS | 265 |
| 10 | tribunals — the NACC investigation-report index parses | PASS | 240 |
| 11 | tool surface — `search_decisions(cases)` merges the live sources and labels each hit | PASS | 2205 |
| 12 | tool surface — `get_decision_text(cases)` returns reasons for a Queensland citation | PASS | 2143 |
| 13 | tool surface — `get_decision_text(treaties)` returns DFAT metadata plus the AustLII link | PASS | 1119 |
| 14 | state legislation — Queensland full-text search answers (slowly) | PASS | 377 |
| 15 | state legislation — Tasmania full-text search answers | PASS | 170 |
| 16 | state legislation — Western Australia's A–Z index doubles as the search surface | PASS | 1775 |
| 17 | state legislation — the Northern Territory By-Title list resolves a title | PASS | 577 |
| 18 | state legislation — NSW and SA refuse before any request is made | PASS | 3 |

No upstream flakiness was observed in the live run; nothing needed a retry.

---

## 2. End-to-end MCP scenarios (stdio, real server, real upstreams)

`isError` is the MCP field. It is `true` on some **passing** scenarios by
design — `verify_citations` sets it when it finds a bad citation, which is the
tool working, not failing.

| # | Scenario | Verdict | ms | Quality note |
|---|---|:---:|---:|---|
| 1 | `tools/list` | PASS | 8 | 10 tools, 16,401 bytes of payload. Exactly `V3_EXPOSED`. |
| 2 | `search_law {query:"CCA"}` | PASS | 1144 | Resolves the alias and ranks the principal Act first. |
| 3 | `search_law {query:"Trade Practices Act"}` | PASS | 1067 | Rename annotation, not "repealed". |
| 4 | `get_law_text {registerId:"C2004A00109", provision:"sch 2 s 18"}` | **FAIL → FIXED** | 1382 | Was `[EXTERNAL_API_ERROR]`. See bug 1. |
| 5 | `get_schedules {registerId:"C2004A00109"}` | PASS | 597 | Both schedules, with the ACL called out. |
| 6 | `legal_analysis {mode:"verify_citations", …}` | **PARTIAL → FIXED** | 2271 | Missed the content mismatch. See bugs 2 and 3. |
| 7 | `legal_analysis {mode:"applicable_law", lawName:"Trade Practices Act", date:"2010-06-30", provision:"s 52"}` | **PARTIAL → FIXED** | 5802 | Text and diff were unreadable until bug 1 was fixed. |
| 8 | `legal_analysis {mode:"cite_check", caseNumber:"[2020] HCA 41"}` | PASS | 4154 | Names the case, 13 citing judgments, honest verdict. |
| 9 | `search_decisions {domain:"cases", query:"misleading conduct"}` | PASS | 1967 | Three sources merged and labelled. |
| 10 | `search_decisions {domain:"workplace", query:"unfair dismissal"}` | PASS | 1971 | 25 rows. |
| 11 | `search_decisions {domain:"treaties", query:"extradition"}` | PASS | 218 | 20 of 177. |
| 12 | `get_decision_text {domain:"cases", id:"nsw:174af…"}` | PASS | 138 | Reasons returned. |
| 13 | `get_decision_text {domain:"treaties", id:"3030", options:{keyword:"extradition"}}` | PASS | 284 | Full DFAT record. See bug 4 for the guidance defect found here. |
| 14 | `get_decision_text {domain:"workplace", id:"werner-…-2014-fwc-3013"}` | PASS | 655 | Metadata + PDF link, honest about the PDF. |
| 15 | `legal_research {query:"penalty for misleading conduct", task:"full_research"}` | PASS | 17954 | Multi-section, well inside the 45s deadline. Relevance caveat below. |
| 16 | `discover_tools {intent:"point in time law"}` | PASS | 5 | Six ranked tools, all in `history and versions`. |
| 17 | `execute_tool {tool_name:"get_provision_history", …}` | PASS | 8180 | Round-trip to an unexposed tool works. |

### Scenario detail

**#2 — `search_law {query:"CCA"}`** → resolves the abbreviation and returns
`C2004A00109` first:

```
Federal Register search: "CCA"
41 matching title(s); showing 10, principal Acts ranked first.
Alias "CCA" resolved to Competition and Consumer Act 2010 (Cth).

1. Competition and Consumer Act 2010
   id: C2004A00109 | Act | InForce | principal | No 51 of 1974
   ↳ previously named: Trade Practices Act 1974 (renamed, not repealed — same register id).
   ⚠️ Commenced amendments are NOT yet incorporated into the compiled text.
```

Quality: the "No 51 of 1974" on a 2010-titled Act is the tell that this is a
rename, and the annotation says so rather than leaving the reader to notice.

**#3 — `search_law {query:"Trade Practices Act"}`** → the required behaviour,
verbatim:

```
↳ matched former name: "Trade Practices Act 1974" — now "Competition and Consumer
  Act 2010" (same register id, a rename, NOT a repeal).
```

The word "repealed" does not appear. PASS.

**#4 — `get_law_text` for ACL s 18**, after the fix:

```
Provision: sch 2 s 18 — 18 Misleading or deceptive conduct
In: Volume 4 › Schedule 2—The Australian Consumer Law › Chapter 2—General
    protections › Part 2-1—Misleading or deceptive conduct
18 Misleading or deceptive conduct
    (1) A person must not, in trade or commerce, engage in conduct that is
        misleading or deceptive or is likely to mislead or deceive.
    (2) Nothing in Part 3-1 (which is about unfair practices) limits by
        implication subsection (1).
```

Cross-checked against `provision:"s 18"` on the same Act, which returns
"18 Meetings of Commission" from Volume 1 — the two are correctly distinguished.

**#5 — `get_schedules`** lists both schedules and flags the one that matters:

```
Schedule 2—The Australian Consumer Law
   432 table-of-contents entries, 325 numbered provisions
   ⭐ This is the Australian Consumer Law. ACL s 18 = provision "sch 2 s 18", NOT "s 18".
```

**#6 — `verify_citations`**, after the fixes:

```
[CITATION_ERRORS_FOUND] Citation check
Statute citations: 2 | ✓ 0 verified | ✗ 2 cannot be right | ⚠ 0 not checked here

✗ CONTENT_MISMATCH: Competition and Consumer Act 2010 (Cth) s 18 is 'Meetings of
  Commission'; misleading conduct is sch 2 s 18 (Australian Consumer Law)
✗ NOT_FOUND: Privacy Act 1988 (Cth) s 999 — Privacy Act 1988 [C2004A03712] has no
  s 999 in its current compilation. the body of the Act runs from s 1 to s 100
  in this compilation (313 numbered entries). Nearest entries: 100 Regulations |
  99A Conduct of directors, employees and agents | 98A Treatment of partnerships
```

Both required outcomes: `CONTENT_MISMATCH` on s 18 pointing at ACL s 18, and
`✗` on s 999 with the real range. Before the fixes this printed
`✓ … 'Meetings of Commission'` for s 18 — a tick on a hallucinated citation,
the single worst failure this tool can have. See bugs 2 and 3.

**#7 — `applicable_law`** for the TPA on 2010-06-30 returns the pre-ACL text of
s 52 and diffs it against today's s 52, which is a different provision entirely
(the 2010 renumbering moved misleading conduct into schedule 2 and put the
consumer guarantee about undisturbed possession at s 52):

```
▶ In force on that date
  Trade Practices Act 1974 — compilation window 2010-04-15 → 2010-07-01,
  registerId C2010C00331
  ⚠️ On that date this law was titled "Trade Practices Act 1974". … the SAME Act,
     renamed, NOT repealed and replaced. Cite it as "Trade Practices Act 1974"
     for conduct on 2010-06-30.

▶ s 52 as at 2010-06-30
52 Misleading or deceptive conduct
    (1) A corporation shall not, in trade or commerce, engage in conduct that is
        misleading or deceptive …

▶ Compared with today: CHANGED — 14 line(s) added, 4 removed.
- 52 Misleading or deceptive conduct
+ 52 Guarantee as to undisturbed possession

▶ Application / saving / transitional provisions in the 1 most recent amending Act(s)
  Trade Practices Amendment (Australian Consumer Law) Act (No. 2) 2010 [C2010A00103]
    • Schedule 2—Application of the Australian Consumer Law
    • Schedule 7—Transitional matters
```

Quality: excellent. This is the answer a practitioner needs and it refuses to
interpret the transitional provisions, which is correct.

**#8 — `cite_check {caseNumber:"[2020] HCA 41"}`**:

```
▶ The case itself
  ✓ Calidad Pty Ltd v Seiko Epson Corporation, 12 Nov 2020 — High Court of Australia

▶ Verdict: cited — later judgments mention this case and no contrary appellate
  language was found in what was scanned

▶ Later cases mentioning [2020] HCA 41 (13 found)
  NSW Caselaw: 1 mention(s)
  Queensland Judgments: 0 mention(s)
  High Court of Australia: 12 mention(s) (source reports 74)
```

Case identification correct. The verdict is hedged to what was actually
scanned, and the "source reports 74" against 12 retrieved is the honest
disclosure that the citator is not complete — which it cannot be without
AustLII/LawCite.

**#15 — `legal_research` full research** returned a five-section answer in
17.9s: legislation hits, the base law's structure, case law, the judgment in
full, and a ruling in full.

*Quality caveat, not a bug:* the chain took the Federal Register's top
full-text hit as the "base law", and for `"penalty for misleading conduct"` that
was the *Foreign Passports (Law Enforcement and Security) Act 2005* — the CCA
was hit #4. The register's relevance ranking is the cause. The chain's own text
labels the list "These are pointers, not an answer", so it does not assert
anything false, but the base-law pick is weaker than a reader would expect.
Recorded as a deferred item, not fixed: re-ranking live search results is a
behavioural change, not a QA fix.

**#16 — `discover_tools {intent:"point in time law"}`** returned exactly the six
`history and versions` tools, ranked, with the correct closing advice
(`Run any of these with execute_tool(tool_name, params).` — none of the six is
advertised, so there is no direct-call path to offer).

---

## 3. All 18 decision domains — live grades

One `search_decisions` call per domain, 2026-09-04. Every domain answered; none
returned a bare failure, and every degraded domain explained itself in the
response body.

| # | Domain | Verdict | ms | What came back |
|---|---|:---:|---:|---|
| 1 | `cases` | LIVE | 2540 | NSW + HCA + QLD merged. Federal Court noted as Cloudflare-gated with an AustLII link. |
| 2 | `constitutional` | LIVE | 387 | HCA catchword facet. |
| 3 | `admin_appeals` | PARTIAL | 1138 | NCAT + QCAT live (2,173 hits). Federal ART noted as AustLII-only with a link. |
| 4 | `tax_tribunal` | PARTIAL | 301 | ATO decision impact statements live. ARTA reasons link-only. |
| 5 | `tax_rulings` | LIVE | 837 | `TR 2024/1` resolved to exactly one document. |
| 6 | `interpretations` | LIVE | 1072 | ATO IDs and practice statements. |
| 7 | `customs` | LIVE | 3110 | ATO customs/excise + ADRP indexes. |
| 8 | `competition` | DEGRADED | 1832 | `[UPSTREAM_BLOCKED]` for ACCC and the Tribunal, three deep links, then a live case-law fallback clearly labelled as court decisions rather than the register. |
| 9 | `workplace` | LIVE | 1792 | FWC rows; count is the row count, not the facet total. |
| 10 | `privacy` | PARTIAL | 245 | OAIC index parses with findings and catchwords. The index has no keyword parameter, so the query matched page 1 of 101 only — stated in the response. Reasons are on AustLII. |
| 11 | `integrity` | PARTIAL | 354 | NACC reports live (single index page). Ombudsman `[UPSTREAM_BLOCKED]` with a link. |
| 12 | `public_service` | LIVE | 490 | MPC case studies, with `[NOT_A_TRIBUNAL_DECISION]` explaining that individual promotion reviews are published as notices, not reasons. |
| 13 | `university_rules` | LIVE | 146 | QLD register, 183 hits. Warns that some university rules exist only on university websites. |
| 14 | `agency_rules` | LIVE | 2497 | FRL notifiable instruments, 552 hits. |
| 15 | `gazettes` | LIVE | 3191 | FRL gazettes, 483 hits. Warns that pre-online paper gazettes are not indexed. |
| 16 | `treaties` | LIVE (metadata) | 248 | DFAT records complete; treaty text is AustLII-hosted and link-only. |
| 17 | `explanatory` | LIVE | 3822 | FRL explanatory statements + ParlInfo memoranda. |
| 18 | `state_law` | PARTIAL | 509 | QLD full text, 1,640 hits. NSW returns `[UPSTREAM_BLOCKED]` in 1 ms — refused before any request, with the correct "this carries no evidence either way" wording. |

The blocked-source wording was checked verbatim on the NSW path:

```
[UPSTREAM_BLOCKED] nswLegislation is not fetched by this server (no public query
surface and the register discourages automated access). This is a refusal to
request, not an observation about the record — nothing here says the material is
absent.
Suggestions:
  1. ⚠️ Do not report this as 'no such case/legislation'. The source was never
     queried, so this response carries no evidence either way.
```

---

## 4. CLI

| Command | Verdict | Note |
|---|:---:|---|
| `node build/cli.js "what does s 18 of the ACL say"` | PASS | Routed to `get_law_text`, and the router *volunteered* the ACL/CCA trap before answering. |
| `node build/cli.js "is [2020] HCA 41 still good law"` | PASS | Routed to `cite_check`; correctly warned that a date condition it extracted is not applied by that tool. |
| `node build/cli.js list --category "case law"` | **FAIL → FIXED** | Right tools, wrong heading. See bug 5. |
| `node build/cli.js --help` | PASS | Global options plus one generated subcommand per tool. |

The routing line from the first command is worth quoting, because it is the
project's core domain trap answered without being asked:

```
  [routing] get_law_text — statute name + provision reference → get_law_text
  also: get_law_text — ACL is schedule 2 of Competition and Consumer Act 2010, so
  the reference was read as "sch 2 s 18". The body of the Act has its own section
  of that number, and it is a different provision.
```

---

## 5. HTTP transport

`PORT=8899 node build/index.js --mode http`:

| Check | Result |
|---|---|
| Startup warnings | Both fired correctly: `ALLOWED_ORIGINS is unset …`, `MCP_AUTH_TOKEN is unset — loopback HTTP only.` |
| Bind | `127.0.0.1:8899` (loopback default, correct) |
| `GET /` | `{"name":"Australian Law MCP Server","version":"0.1.0","transport":"streamable-http (stateless)","tools":{"exposed":10,"total":81,…}}` — counts derived from the registry, not hard-coded |
| `GET /health` | `{"status":"ok","timestamp":"2026-09-04T02:04:56.171Z"}` |
| `POST /mcp` `tools/list` | 10 tools returned without a session handshake (stateless, as documented) |

---

## 6. Packaged artifact

`npm pack` → install the tarball into an empty directory → run both bins.

| Check | Result |
|---|---|
| Tarball | `australian-law-mcp-0.1.0.tgz`, 500.6 kB packed / 1.7 MB unpacked, 260 files |
| Top level shipped | `build/`, `package.json`, `README.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md` |
| Stray files | **none** — 0 test files, 0 `__fixtures__`, 0 source maps |
| Runtime file reads | only `src/version.ts` → `../package.json`, which is shipped |
| `node_modules/.bin/australian-law-mcp` | symlink resolves → `--version` prints `0.1.0` |
| `node_modules/.bin/australian-law` | symlink resolves → `list --category treaties` prints the right two tools under the right heading |
| Packed server `tools/list` | 10 tools, correct names, 16,401-byte payload |

`files` was extended from `["build","README.md","LICENSE"]` to add `NOTICE` and
`CHANGELOG.md`, matching what is now written.

---

## 7. Bugs found and fixed

### Bug 1 — the default upstream body limit was smaller than the documents the server must read

*Severity: high. The flagship documented example failed on a healthy upstream.*

`get_law_text({registerId:"C2004A00109", provision:"sch 2 s 18"})` — the example
in `get_law_text`'s own tool description, and the one `get_schedules` prints as
the next step — returned:

```
[EXTERNAL_API_ERROR] Upstream response body is 2113536 bytes, over the
per-response limit of 2097152 bytes (MCP_MAX_UPSTREAM_BODY_BYTES).
```

The Federal Register has no per-section endpoint: Act text arrives as whole epub
volumes. `src/tools/law-text.ts`'s own header comment records that the CCA's are
"2.3 MB and 4.3 MB" — so the 2 MiB default in `DEFAULT_EXECUTION_LIMITS` could
never serve them. The same failure cascaded into `applicable_law`, which reported
`[UPSTREAM_NO_DATA]` for both the point-in-time text and the amendment endnote.

**Fix:** `src/lib/execution-limits.ts` — `maxUpstreamBodyBytes` 2 MiB → 8 MiB,
`maxTotalUpstreamBodyBytes` 8 MiB → 32 MiB, both with the measurement in a
comment. `.env.example` updated with the reason. `src/lib/response-body.limits.test.ts`
now carries its own 2 MiB cap so it tests the *mechanism* rather than the
constant, and gained two cases pinning the default against the largest measured
volume.

**Verified:** scenario 4 returns ACL s 18; scenario 7 returns the 2010 text plus
a diff and the transitional headings.

### Bug 2 — the citation content check never fired on the most common sentence shape

*Severity: high. It ticked off a hallucinated citation.*

`src/tools/analysis-helpers/content-claims.ts` recognised the claim in
`"CCA s 18 prohibits misleading or deceptive conduct"` (active, claim follows the
verb) and in `"misleading conduct is prohibited by the CCA s 18"` (passive, claim
*precedes* the citation) — but not in
`"Under the Competition and Consumer Act 2010 (Cth) s 18, misleading conduct is
prohibited"`, where the citation comes first and the passive claim follows it.
That is how the sentence is usually written. With no claim extracted, the
verifier fell through to existence-only and printed:

```
✓ Competition and Consumer Act 2010 (Cth) s 18 — 'Meetings of Commission' [C2004A00109]
```

A tick, on exactly the citation the tool exists to catch.

**Fix:** added a `FOLLOWING_PASSIVE` pattern, ordered last among the `after`
shapes so an active-voice description still wins, and factored the participle
list out so it cannot drift from `PRECEDING_PASSIVE`. The comma before the claim
is required, so a bare `", the applicant filed on 3 March"` does not manufacture
a claim. Two tests added in `statute-citations.test.ts`, one positive and one
guarding against over-firing.

### Bug 3 — the "you meant this provision" pointer picked the wrong provision

*Severity: medium. Right verdict, wrong redirect.*

With bug 2 fixed, the mismatch fired but pointed at **ACL s 31** ("Misleading
conduct as to the nature etc. of employment") instead of **ACL s 18**
("Misleading or deceptive conduct").

Cause: in `matchCitationContent`, a claim shorter than the 30-character exact
floor is judged by containment and scored a flat `1`. `"misleading conduct"` is
literally a substring of the s 31 heading (score 1) but only a paraphrase of the
s 18 heading (bigram Jaccard 0.55), so `bestHeadingMatch` ranked the buried
match first.

**Fix:** the containment branch now scores *coverage of the heading*
(`claim.length / heading.length`) rather than a flat 1. The buried match scores
0.35, the paraphrase keeps 0.55, and s 18 wins. `matched` is unchanged — this
only affects ranking. Two tests added in `citation-content-matcher.test.ts`,
including one pinning that a near-whole-heading claim still scores above 0.9.

**Verified:** scenario 6 now prints `misleading conduct is sch 2 s 18 (Australian
Consumer Law)`.

### Bug 4 — the treaty follow-up hint taught a call that cannot work

*Severity: low.*

`search_decisions {domain:"treaties"}` closed with a hard-coded
`get_treaty_text(id="3030") — the id printed on each hit`. The DFAT database has
no single-record endpoint, so `getById` looks the id up *inside a search
response*; without the caller's `keyword` (and `page`) it scans page 1 only, and
an id from any later page comes back as `[UPSTREAM_NO_DATA]` — which reads as
"no such treaty".

**Fix:** `src/tools/treaties.ts` now builds the follow-up from the caller's own
query and page, and also shows the unified-tool form
(`get_decision_text({domain:"treaties", id:"…", options:{keyword:"…"}})`), since
`search_decisions` is the advertised entry point and its options nest under
`options`.

*Not a bug:* the `[UPSTREAM_NO_DATA]` seen at first in scenario 13 was this
harness passing `keyword` at the top level instead of inside `options`. With the
documented shape the call succeeds in 284 ms.

### Bug 5 — `list --category` filtered on one taxonomy and printed headings from another

*Severity: low.*

`node build/cli.js list --category "case law"` returned the correct six tools and
printed them all under `── Other ──`. `cli-format.ts`'s default categoriser reads
a `[Prefix]` off the tool description — the taxonomy this project abandoned — and
Australian tool descriptions have no such prefix, so every tool fell into
`"Other"`. The REPL's `tools` command passed a `TOOL_CATEGORIES`-based
categoriser; the `list` subcommand did not.

**Fix:** extracted `headingFor()` in `src/cli.ts` and used it at both call sites.
Two tests added: one pinning the headings, one asserting no tool in the registry
ever falls into `"Other"`.

### Sweep

| Check | Result |
|---|---|
| `TODO` / `FIXME` / `XXX` / `HACK` in `src/`, `scripts/`, `Dockerfile` | **none** |
| Korean text in `src/` | 3 occurrences, all in doc comments referring to the reference project — rewritten in English in `src/tools/knowledge-base.ts`, `src/lib/document-profile.ts`, `src/lib/legal-terms-data.ts` |
| Korean text elsewhere | `docs/TOOL-MAPPING.md` and `docs/research/*.md` — left as-is: those are provenance records of the source research and the reference tool names being mapped |
| Dead-export check (knip) | not configured — skipped, as briefed |

---

## 8. Deferred — for the architect, not patched here

1. **`legal_research` base-law selection.** The chain takes the Federal
   Register's top full-text hit as the base law. Register relevance is weak for
   conceptual queries: `"penalty for misleading conduct"` put the *Foreign
   Passports Act* above the CCA. Nothing false is asserted, but the chain then
   spends its structure section on the wrong Act. A fix would need either local
   re-ranking against the query's legal vocabulary or an alias-table check
   before falling back to relevance order — a behavioural change, not a QA fix.

2. **OAIC privacy search matches page 1 only.** The determinations index takes no
   keyword parameter, so `search_decisions {domain:"privacy"}` filters one page
   of ten out of 101. The response says so and offers `page`, which is honest,
   but a caller asking "has the Commissioner ever determined X" gets a
   misleadingly thin list unless they paginate by hand. Fetching all 11 pages
   once and caching would fix it at a cost of 11 upstream calls.

3. **`get_law_text` volume fetches are now up to 8 MiB.** With bug 1 fixed the
   limit is adequate, but a chain that touches several large Acts will feel the
   32 MiB request ceiling. If that starts biting, the real fix is byte-range or
   per-volume caching of FRL epub members rather than a higher ceiling.

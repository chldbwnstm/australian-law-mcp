# Live verification log

## 2026-09-09 — repository verification, 1.0.0 working tree

Environment: Windows, Node 22.14.0. This pass includes the unreleased fixes in
`CHANGELOG.md`; it does not describe a published release.

| Check | Result |
|---|---|
| Baseline typecheck, build, offline suite | Passed; 2,477 tests passed, 18 live-gated tests skipped |
| Final `npm run typecheck` and `npm test` | Passed; 2,498 tests passed across 105 files, 18 live-gated tests skipped in one file |
| Live decision/register suite after the fixes | 18/18 passed, 16.06 seconds |
| `npm audit --json` | 0 reported vulnerabilities, including development dependencies |
| `npm run build` and `npm run verify:stdio` | Passed; built server starts, reports 1.0.0, and returns the exact advertised schema payload |
| Real CLI version, routing explanation and provision parser | Passed; ACL s 18 routes to `sch 2 s 18` |
| Real CLI: `what does s 18 of the ACL say` | Returned the latest compilation's schedule 2 section 18, with the heading “Misleading or deceptive conduct” and its source link |
| `npm pack --dry-run --json` | 261 entries; both binaries and compiled output included; no tests, fixtures, environment files or local agent state |
| `npm run build:mcpb` | Built a 4.01 MiB bundle; manifest validation passed; unpacked into a separate temporary directory, started successfully and advertised the manifest's 10 tools |
| `git diff --check` | Passed |

The new tests reproduced three failure classes before the relevant fixes:

- Malformed FRL collection envelopes such as `{}` were accepted as empty results
  or converted to `LAW_NOT_FOUND`. The shared JSON boundary now returns `PARSE_ERROR`.
  Valid empty collections still retain their original absence semantics.
- Scraped-host retries bypassed the minimum interval, and cancellation left callers
  waiting for their scheduled slot. Every attempt now reserves a cancellable slot.
- The bundle verifier parsed each pipe chunk as complete JSON. A simulated server
  splitting a UTF-8 character and a 100 KB response made the old verifier time out;
  complete-line buffering now handles both. Early exit, timeout and stray logging
  are also tested using actual child processes.

The normal suite includes the existing HTTP transport integration tests with a real
local listener. CI now includes Windows as well as Ubuntu and runs the built stdio
check, but the updated GitHub workflow was not executed remotely during this pass.
Docker was unavailable locally, so the container image was reviewed but not built
or run. The bundle validator reported non-fatal icon-size and unsigned-bundle notices.
Successful live probes establish availability at the time of this run, not future
availability or complete legal coverage.

---

## Earlier verification — 0.1.0

*Recorded against 0.1.0. The package was renamed `au-law-mcp` in 1.0.0; the packaging rows below name the 0.1.0 tarball and bin.*

> **v0.1.0** | Re-run 2026-09-04 against `882b13d` + the fixes in §7, macOS 15
> (darwin 25.6.0), Node 22, from a residential Australian-reachable IP. Every
> result below is from the **real built server** talking to the **real
> upstreams** — no fixtures, no mocks.

This file is evidence, not documentation. It records what was run, what came
back, and whether the answer was good enough to rely on. Where an answer was
wrong it says so, and says whether the cause was this server or the upstream.

This is the **second** full pass. The first ran before commits `b4d551f` and
`882b13d` (44 confirmed defects). Those two commits changed behaviour in hot
paths — provision grammar, alias schedules, partial verification, chain failure
reporting, CLI argument handling, HTTP accounting — so the whole matrix was
re-run rather than spot-checked, and **13 new scenarios were added** to pin the
changed behaviour. New scenarios are marked ★ and each says what it pins.

Method: `npm run build`, then `node build/index.js` spawned as a child process
and driven over stdio with raw JSON-RPC — `initialize`,
`notifications/initialized`, then `tools/call` per scenario. The CLI scenarios
ran the real `build/cli.js` binary. The HTTP scenarios ran the real server on
`--mode http --port 3998`. The packed-artifact scenarios ran from a tarball
installed into a clean directory.

---

## 1. Test suites

| Suite | Command | Result |
|---|---|---|
| Offline, before this pass (`882b13d`) | `npx vitest run` over tracked files | **100 files passed, 1 skipped · 1912 passed, 18 skipped · 30.5s** |
| Offline, after the fixes in §7 | same | **100 files passed, 1 skipped · 1920 passed, 18 skipped · 30.6s** |
| Typecheck | `npx tsc --noEmit` | **clean** |
| Live-gated | `LIVE=1 npx vitest run src/tools/decision-domains.live.test.ts` | **18 passed / 18 · 19.3s** |

The `1912` baseline matches the figure carried into this pass exactly. The `+8`
are the regression tests added with the four fixes in §7 (two each).

> **Measurement note.** A bare `npx vitest run` reported anywhere between 1916
> and 1926 tests during this pass, and once failed with
> `Cannot find module src/tools/zz-scratch-bp.test.ts`. The cause was outside
> this server: a **concurrent review agent** was creating and deleting scratch
> `*.test.ts` files in the working tree (`probe.test.ts`,
> `src/zzprobe.test.ts`, `src/zzprobe2.test.ts` were present at the time of
> writing), and `vitest.config.ts` globs `src/**/*.test.ts`. Every figure in
> the table above was therefore taken over `git ls-files '*.test.ts'`, which is
> stable across repeated runs. Nothing in this repository is flaky.

`src/tools/decision-domains.live.test.ts` is the only live-gated file. Per-test
results, in run order:

| # | Test | Result | ms |
|---|---|---|---|
| 1 | case law — NSW simple search returns rows with decision ids | PASS | 318 |
| 2 | case law — NSW exact-MNC lookup finds one decision | PASS | 727 |
| 3 | case law — the High Court year facet survives the WAF (literal brackets) | PASS | 111 |
| 4 | case law — a Queensland citation resolves straight to its judgment | PASS | 2134 |
| 5 | tribunals — the ATO form POST returns a result list | PASS | 305 |
| 6 | tribunals — an ATO product code resolves to exactly one document | PASS | 906 |
| 7 | tribunals — FWC row count is the row count, not the facet total | PASS | 2117 |
| 8 | tribunals — the OAIC determinations index parses | PASS | 276 |
| 9 | tribunals — the DFAT treaty API answers with records | PASS | 257 |
| 10 | tribunals — the NACC investigation-report index parses | PASS | 163 |
| 11 | tool surface — `search_decisions(cases)` merges the live sources and labels each hit | PASS | 2197 |
| 12 | tool surface — `get_decision_text(cases)` returns reasons for a Queensland citation | PASS | 2341 |
| 13 | tool surface — `get_decision_text(treaties)` returns DFAT metadata plus the AustLII link | PASS | 1094 |
| 14 | state legislation — Queensland full-text search answers (slowly) | PASS | 424 |
| 15 | state legislation — Tasmania full-text search answers | PASS | 1515 |
| 16 | state legislation — Western Australia's A–Z index doubles as the search surface | PASS | 3331 |
| 17 | state legislation — the Northern Territory By-Title list resolves a title | PASS | 624 |
| 18 | state legislation — NSW and SA refuse before any request is made | PASS | 2 |

No upstream flakiness was observed in the live run; nothing needed a retry.

---

## 2. End-to-end MCP scenarios (stdio, real server, real upstreams)

`isError` is the MCP field. It is `true` on some **passing** scenarios by
design — `verify_citations` sets it when it finds a bad citation, which is the
tool working, not failing.

| # | Scenario | Verdict | ms | Quality note |
|---|---|:---:|---:|---|
| 1 | `tools/list` | PASS | 7 | 10 tools, 16,797 bytes. Exactly `V3_EXPOSED`. |
| 2 | `search_law {query:"CCA"}` | PASS | 2223 | Resolves the alias, ranks the principal Act first. |
| 3 | `search_law {query:"Trade Practices Act"}` | PASS | 964 | Rename annotation, not "repealed". |
| 4 | `get_law_text {registerId:"C2004A00109", provision:"sch 2 s 18"}` | PASS | 3586 | ACL s 18. The 8 MiB body limit from the last pass holds. |
| 5 | `get_schedules {registerId:"C2004A00109"}` | PASS | 165 | Both schedules, ACL called out. |
| 6 | `legal_analysis {mode:"verify_citations"}` — the old two-citation text | PASS | 2115 | `CONTENT_MISMATCH` + `NOT_FOUND`, unchanged. |
| 7 | `legal_analysis {mode:"applicable_law", lawName:"Trade Practices Act", date:"2010-06-30", provision:"s 52"}` | PASS | 10240 | Richer than last pass — see below. |
| 8 | `legal_analysis {mode:"cite_check", caseNumber:"[2020] HCA 41"}` | PASS | 4134 | Names the case, 13 citing judgments, honest verdict. |
| 9 | `search_decisions {domain:"cases", query:"misleading conduct"}` | PASS | 2374 | Three sources merged and labelled. |
| 10 | `search_decisions {domain:"workplace", query:"unfair dismissal"}` | PASS | 2374 | 10 rows; count is the row count. |
| 11 | `search_decisions {domain:"treaties", query:"extradition"}` | PASS | 287 | 20 of 177. |
| 12 | `get_decision_text {domain:"cases", id:"nsw:174af…"}` | PASS | 231 | Reasons returned. |
| 13 | `get_decision_text {domain:"treaties", id:"3030", options:{keyword:"extradition"}}` | PASS | 711 | Full DFAT record. |
| 14 | `get_decision_text {domain:"workplace", id:"werner-…-2014-fwc-3013"}` | PASS | 639 | Metadata + PDF link, honest about the PDF. |
| 15 | `legal_research {query:"penalty for misleading conduct", task:"full_research"}` | PASS | 19150 | **Base law is now the CCA.** Well inside the 45s deadline. |
| 16 | `discover_tools {intent:"point in time law"}` | PASS | 7 | Six ranked tools, all in `history and versions`. |
| 17 | `execute_tool {tool_name:"get_provision_history", …}` | PASS | 17313 | Round-trip to an unexposed tool works. |
| ★18 | `get_law_text {query:"ACL", provision:"s 18"}` | PASS | 1671 | **Pins the alias-schedule fix.** |
| ★19 | `get_law_text {query:"Competition and Consumer Act 2010", provision:"s 18"}` | PASS | 5429 | The contrast case: still the body section. |
| ★20 | `get_law_text {query:"Income Tax Assessment Act 1997", provision:"s 355-25"}` | PASS | 2661 | **Pins hyphen-vs-range-dash.** |
| ★21 | `get_batch_provisions {query:"ACL", provisions:["s 18","s 29"]}` | PASS | 1893 | Alias schedule applied to every member. |
| ★22 | `verify_citations` — ACL + ITAA + `Privacy Act s 999` | **FAIL → FIXED** | 3682 | Was a false `✗` on ITAA s 355-25. See bug 1. |
| ★23 | `verify_citations {maxCitations:2}` over four citations | PASS | 1888 | **Pins partial verification.** |
| ★24 | `get_law_text {query:"Constitution", provision:"s 51(xx)"}` | **FAIL → FIXED** | 1358 | No section of the Constitution was reachable. See bug 2. |
| ★25 | `get_law_text {registerId:"C2004A00109", provision:"ss 45-46"}` | PASS | 1204 | Plural + hyphen = a real range. |
| ★26 | `get_law_text {query:"Income Tax Assessment Act 1997", provision:"ss 355-25"}` | PASS | 1915 | Plural + hyphen, but an ITAA number: **not** a range. |
| ★27 | `get_law_text {registerId:"C2004A00109", provision:"ss 46-45"}` | PASS | 794 | **Pins descending ranges.** Honest `[LAW_NOT_FOUND]`. |
| ★28 | `execute_tool get_provision_history {query:"ACL", provision:"s 18"}` | **FAIL → FIXED** | 8195 | Printed the ACL warning, returned the body's history. See bug 3. |
| ★29 | `legal_research` on a query no Act matches | PASS | 4799 | Every branch labelled `[NOT RETRIEVED]`, no invention. |
| ★30 | `instrument_radar {query:"Privacy Act 1988"}` | PASS | 1846 | Honest `[NOT_FOUND]` — an Act is not an instrument. |

### Scenario detail

**★18 / ★19 — the alias schedule is now *applied*, not just announced.**
`{query:"ACL", provision:"s 18"}`:

```
Alias "ACL" → Competition and Consumer Act 2010 (Cth), sch 2. The Australian
Consumer Law is schedule 2 of the CCA, not a separate Act. ACL s 18 (misleading
or deceptive conduct) is NOT CCA s 18 (meetings of Commission).
Read "s 18" as "sch 2 s 18": "ACL" names sch 2 of this Act, so the bare
reference would have returned the body provision instead.
Provision: sch 2 s 18 — 18 Misleading or deceptive conduct
```

The required outcome, and the rewrite is *stated* rather than done silently.
The contrast case (★19, the Act's full name, and the CLI's `--query CCA`) still
returns `18 Meetings of Commission` from Volume 1 — the rewrite is keyed to the
alias's own `sch`, not applied to the Act as a whole.

**★20 / ★26 — the ITAA grammar.** `s 355-25` returns `355-25 Core R&D
activities` from Volume 7 of the ITAA 1997, and so does `ss 355-25`: a plural
designation no longer converts an ITAA-style compound number into the
impossible range 355–26. `ss 45-46` on the CCA is still read as a range and
returns both sections, formatted `ss 45–46` with the AGLC en dash. `ss 46-45`
runs backwards, is therefore never a range, and comes back as an honest
`[LAW_NOT_FOUND]` for the compound number `46-45`.

**★21 — `get_batch_provisions`** with `query:"ACL"` returns
`2 requested, 2 retrieved, 0 not found`, both inside schedule 2, under the
header `Alias "ACL" names sch 2 of this Act — 2 bare reference(s) were read
inside that schedule.`

**★22 — `verify_citations`**, after bug 1 was fixed:

```
[CITATION_ERRORS_FOUND] Citation check
Statute citations: 3 checked of 3 found | ✓ 2 verified | ✗ 1 cannot be right

✓ Australian Consumer Law s 18 — 'Misleading or deceptive conduct' [C2004A00109];
  the description in the text matches the heading. [read as sch 2 s 18 …]
✓ Income Tax Assessment Act 1997 (Cth) s 355-25 — 'Core R&D activities'
  [C2004A05138]
✗ NOT_FOUND: Privacy Act 1988 (Cth) s 999 — … has no s 999 in its current
  compilation. the body of the Act runs from s 1 to s 100 …
```

All three required outcomes: the ACL citation attributed to schedule 2 *and*
content-verified, the ITAA citation verified against the 1997 Act, and s 999 the
only `✗`. Before the fix the ITAA line read
`✗ NOT_FOUND: … Income Tax Assessment Act 1922 [C1922A00037] has no s 355-25` —
a false hallucination signal against a real provision, resolved to the wrong Act.

**★23 — partial verification.** With `maxCitations:2` over four citations:

```
[PARTIALLY_VERIFIED] Citation check
Statute citations: 2 checked of 4 found | ✓ 2 verified | ✗ 0 cannot be right
⚠️ NOT CHECKED: 2 citation(s) in this text were never looked at — this call
checks at most 2 of each kind (maxCitations=2) and they fell past that limit.
They are listed below. This report covers PART of the text only: a wrong or
invented citation among them would not appear here. …
⚠ Corporations Act 2001 (Cth) s 181 — NOT checked: past this call's maxCitations limit (2).
⚠ Fair Work Act 2009 (Cth) s 385 — NOT checked: past this call's maxCitations limit (2).
```

The status code is `PARTIALLY_VERIFIED`, not `VERIFIED`; the skipped citations
are named rather than dropped; and the caller is told not to report the text as
verified. Correct.

**#7 — `applicable_law`** is materially better than the last pass. It still
returns the pre-ACL s 52 and diffs it against today's s 52 (a different
provision — the 2010 renumbering moved misleading conduct into schedule 2), and
it now also separates *in force now* from *latest registered*:

```
▶ Today's text
  ⚠️ The compilation in force now (from 2026-08-27) is NOT the latest registered
     one (C2026C00323, from 2026-07-01). Commenced amendments are not yet
     incorporated, so the current text on the Register is already behind the law
     in force.
▶ Since 2010-06-30: 92 later compilation(s) in the 100 most recent version rows.
▶ Compared with today: CHANGED — 14 line(s) added, 4 removed.
- 52 Misleading or deceptive conduct
+ 52 Guarantee as to undisturbed possession
```

**#15 — `legal_research` full research**, 19.1s, five sections. The base-law
defect deferred at the end of the last pass is **fixed**:

```
Base law: Competition and Consumer Act 2010 (registerId: C2004A00109)
  note: Base law chosen by subject, not by search relevance: the question
  matches "misleading or deceptive conduct" in the bundled term dictionary,
  which is anchored to Competition and Consumer Act 2010. The full-text search
  ranked Inspector-General of Animal Welfare and Live Animal Exports Act 2019
  [C2019A00081] first; that is a body-text match, not a subject match.
```

The chain then spends its structure section on the CCA. It also says *why* it
overrode relevance, which is the part a reader needs in order to disagree.

*Upstream weather, not a bug:* the legislation list's first hit prints
`Foreign Passports (Law Enforcement and Security) Act 2005 | id: C1938A00015 |
No 15 of 1938`. That id/year pairing looks wrong, so it was checked against the
Register directly — `GET /v1/titles/C1938A00015` returns exactly that name with
`year: 1938, number: 15`. It is the same register-id-survives-a-rename pattern
as the CCA (`No 51 of 1974`), and the server is echoing upstream faithfully.

**★29 — the chain under total upstream failure.** Run with
`MCP_MAX_UPSTREAM_BODY_BYTES=2000` so every fetch fails, `legal_research` gives:

```
▶ Legislation matching the question [NOT RETRIEVED]
   ⚠️ This branch did not return data. Do not infer, guess or generate its contents.
[UPSTREAM_NO_DATA] Every search pass failed upstream. This says nothing about
whether such a law exists — do not report the topic as unregulated.

Base law: Competition and Consumer Act 2010 (registerId: C2004A00109)
  note: Base law chosen by subject, not by search relevance …
```

Two things worth having: no branch is silently empty, and the base law still
resolves *through the subject anchor* when the full-text search is entirely
dead — the "report the upstream failure instead of `[NOT_FOUND]`" fix, working
under the harshest condition available.

**#8 / cite_check under failure.** The same tiny-cap treatment on
`cite_check {caseNumber:"[2020] HCA 41"}`:

```
  ⚠ High Court of Australia could not be reached (…) — nothing was learned either way.
▶ Verdict: unverified_treatment — the citation exists but its treatment could
  not be classified. This is the default and it is not a clean bill of health
  NSW Caselaw: SEARCH FAILED — … Absence here means nothing.
  No later mention found, but at least one source did not answer — this is not
  evidence of no citation.
```

Every source failure is named, and the verdict refuses to be a clean bill of
health. No absence is manufactured anywhere in the response.

---

## 3. All 18 decision domains — live grades

One `search_decisions` call per domain, 2026-09-04. Every domain answered; none
returned a bare failure, and every degraded domain explained itself in the
response body.

| # | Domain | Verdict | ms | What came back |
|---|---|:---:|---:|---|
| 1 | `cases` | LIVE | 2399 | NSW + HCA + QLD merged, 15,078 upstream. Federal Court noted as Cloudflare-gated with an AustLII link. |
| 2 | `constitutional` | LIVE | 439 | HCA catchword facet, 12 of 152. Warns the facet is OR-semantic, so extra words broaden. |
| 3 | `admin_appeals` | PARTIAL | 840 | NCAT + QCAT live (2,173 hits). Federal ART noted as AustLII-only with a link. |
| 4 | `tax_tribunal` | PARTIAL | 352 | ATO decision impact statements live (1,650). ARTA reasons `[UPSTREAM_BLOCKED]`, link only. |
| 5 | `tax_rulings` | LIVE | 799 | `TR 2024/1` resolved to exactly one document. |
| 6 | `interpretations` | LIVE | 1214 | ATO IDs and practice statements, 1,791. Explains that extra words *narrow* this one. |
| 7 | `customs` | LIVE | 2554 | ATO customs/excise + ADRP indexes, 1,893. |
| 8 | `competition` | DEGRADED | 1991 | `[UPSTREAM_BLOCKED]` for ACCC and the Tribunal, deep links, then a live case-law fallback clearly labelled as court decisions rather than the register. |
| 9 | `workplace` | LIVE | 2374 | FWC rows; count is the row count, not the facet total. |
| 10 | `privacy` | PARTIAL | 281 | OAIC index parses. No keyword parameter upstream, so the query matched page 1 of 101 — stated in the response. |
| 11 | `integrity` | PARTIAL | 415 | NACC reports live (11 on one page). Ombudsman `[UPSTREAM_BLOCKED]` with a link. |
| 12 | `public_service` | LIVE | 591 | MPC case studies, 58, with `[NOT_A_TRIBUNAL_DECISION]` explaining they carry no citation. |
| 13 | `university_rules` | LIVE | 2138 / 3042 | See below — a query-specificity result, not a defect. |
| 14 | `agency_rules` | LIVE | 2464 | FRL notifiable instruments, 59 for `aviation`. |
| 15 | `gazettes` | LIVE | 2427 | FRL gazettes, 484. Warns that pre-online paper gazettes are not indexed. |
| 16 | `treaties` | LIVE (metadata) | 275 | DFAT records complete; treaty text is AustLII-hosted and link-only. |
| 17 | `explanatory` | LIVE | 4268 | FRL explanatory statements + ParlInfo memoranda, 158. |
| 18 | `state_law` | PARTIAL | 556 | QLD full text, 1,640 hits. NSW returns `[UPSTREAM_BLOCKED]` in 1 ms — refused before any request. |

**Domain 13, retried once as briefed.** `{query:"student conduct"}` returned
`0 of 0 results` with both caveats intact. Retried with `{query:"university"}`
it returns `10 of 204` across the QLD, TAS, WA and NT registers. The zero was
the registers' title-search being literal, not a broken domain — and the
response said so both times, including the caveat that matters most here:

```
note: Some university rules are published only on the university's own website
and appear in no legislation register at all — absence here is not absence in law.
```

The blocked-source wording was checked verbatim on the NSW path and is
unchanged from the last pass:

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
| `node build/cli.js "what does s 18 of the ACL say"` | PASS | Routed to `get_law_text`; the router volunteers the ACL/CCA trap before answering. |
| `node build/cli.js "is [2020] HCA 41 still good law"` | PASS | Routed to `cite_check`; warns that a date condition it extracted is not applied by that tool. |
| `node build/cli.js get_law_text --query CCA --provision "s 18"` | PASS | `18 Meetings of Commission` — correct. `CCA` names the Act, not a schedule. |
| ★ `node build/cli.js search_historical_law --query CCA --limit 3 --no-withReasons` | PASS | Boolean-flag negation. See below. |
| ★ `node build/cli.js search_decisions --domain state_law --query "residential tenancies" --options '{"jurisdiction":"QLD"}'` | PASS | Object flag parsed and forwarded; 1,640 QLD hits. |
| ★ Budget wrapping — `MCP_MAX_UPSTREAM_BODY_BYTES=50000 … get_law_text …`, with and without `--json` | PASS | Both paths metered identically. See below. |
| `node build/cli.js list --category "case law"` | PASS | Six tools under `── case law ──`. The last pass's bug 5 fix holds. |
| `node build/cli.js --help` | PASS | Global options plus one generated subcommand per tool. |
| Exit codes | PASS | `0` on success, `1` on a tool error. |

The routing line from the first command is worth quoting, because it is the
project's core domain trap answered without being asked:

```
  [routing] get_law_text — statute name + provision reference → get_law_text
  also: get_law_text — ACL is schedule 2 of Competition and Consumer Act 2010, so
  the reference was read as "sch 2 s 18". The body of the Act has its own section
  of that number, and it is a different provision.
```

**Boolean negation.** `withReasons` has schema default `true`, and the
generated help advertises the negation explicitly:

```
  --withReasons         Show the amending Acts recorded for each compilation.
  --no-withReasons      set withReasons to false (it defaults to true)
```

With the flag off, the three `Amend: …` lines under each compilation disappear
and nothing else changes. With it on (or omitted) they are present. Correct in
both directions.

**Budget wrapping.** With a deliberately tiny upstream cap, the *direct* CLI
path now reports the same ceiling as the `--json` path:

```
[EXTERNAL_API_ERROR] Upstream response body is 65536 bytes, over the
per-response limit of 50000 bytes (MCP_MAX_UPSTREAM_BODY_BYTES).
```

Both forms produce that error and exit `1`; without the cap both succeed and
exit `0`. The two paths can no longer have different upstream limits.

---

## 5. HTTP transport

`node build/index.js --mode http --port 3998`:

| Check | Result |
|---|---|
| Startup warnings | Both fired: `ALLOWED_ORIGINS is unset …`, `MCP_AUTH_TOKEN is unset — loopback HTTP only.` |
| Bind | `127.0.0.1:3998` (loopback default, correct) |
| `GET /` | `{"name":"Australian Law MCP Server","version":"0.1.0","transport":"streamable-http (stateless)","tools":{"exposed":10,"total":81,…}}` — counts derived from the registry |
| `GET /health` | `200` · `{"status":"ok","timestamp":"2026-09-04T05:52:15.035Z"}` |
| `POST /mcp` `initialize` | `200` · protocol `2024-11-05`, `serverInfo.name = australian-law` |
| `POST /mcp` `tools/list` | `200` · **exactly 10 tools**, no session handshake needed (stateless, as documented) |
| `POST /mcp` `tools/call search_law` | `200` · same body as the stdio path |
| `GET /mcp` | **405** · `Method not allowed. Server runs in stateless mode.` |
| `DELETE /mcp` | **405** · same |
| Rogue `Origin: https://evil.example.com` | **403** · `Origin not allowed.` |
| Unknown path | 404 (Express default) |
| Oversized body (3 MB) | **413** · `Request entity too large.` |

★ **Batch accounting** was exercised directly, because it changed:

| Check | Result |
|---|---|
| 2-message batch (`tools/list` + `tools/call`) | `200`, **2** entries out, ids `1` and `2`, each resolved independently |
| 40-message batch, cap 20 | **429** · `Too many messages in one request (max 20).` — bounded by *envelope length*, not by the `tools/call` subset |
| Rate charge per message | Two 20-message batches passed, the third returned `429 · Too many requests — retry in 18s.` — 60 messages against `RATE_LIMIT_RPM=60`, i.e. charged **per message, not per envelope** |

---

## 6. Packaged artifact

`npm pack` → install the tarball into an empty directory → run both bins and
the packed server over stdio.

| Check | Result |
|---|---|
| Tarball | `australian-law-mcp-0.1.0.tgz`, 549.2 kB packed / 1.8 MB unpacked, 261 files |
| Top level shipped | `build/`, `package.json`, `README.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md` |
| Stray files | **none** — 0 test files, 0 `__fixtures__`, 0 source maps |
| `node_modules/.bin/australian-law-mcp` | symlink resolves → `--version` prints `0.1.0` |
| `node_modules/.bin/australian-law` | symlink resolves → `list --category treaties` prints the right two tools under the right heading |
| Packed server `tools/list` | 10 tools, correct names, 16,797-byte payload |
| Packed server `get_law_text {query:"ACL", provision:"s 18"}` | ACL s 18 — the fixes are in the artifact, not just the working tree |

---

## 7. Bugs found and fixed in this pass

All four were found by the new scenarios, all four are fixed here, and each
carries regression tests (two per bug, eight in total — the `1912 → 1920` in §1).

### Bug 1 — a statute citation's **year** was dropped before the Register was asked

*Severity: high. It reported a real, extremely common provision as invented.*

Scenario ★22. `Income Tax Assessment Act 1997 (Cth) s 355-25` came back as:

```
✗ NOT_FOUND: Income Tax Assessment Act 1997 (Cth) s 355-25 — Income Tax
  Assessment Act 1922 [C1922A00037] has no s 355-25 in its current compilation.
```

The citation is correct — s 355-25 is *Core R&D activities* — and the tool
answered it against the **1922** Act while printing the 1997 name.

Cause: `statute-citations.ts` cannot put digits in a title capture (`TITLE_BODY`
excludes `0-9`, which is what stops a pinpoint being swallowed into the name),
so a full citation arrives as `lawName: "Income Tax Assessment Act"` plus
`year: 1997` in a separate field. `checkStatuteCitation` then called
`lookupTitle(client, cite.lawName, context)` — the year was parsed, stored on
the citation, and never used. Confirmed against the live Register:
`"Income Tax Assessment Act"` → `C1922A00037`;
`"Income Tax Assessment Act 1997"` → `C2004A05138`.

This is the worst shape of failure this tool can have after a false `✓`: a
false `✗` carries `impossible: true`, the hallucination signal, so a caller is
told to correct text that was right.

**Fix:** `src/tools/analysis-helpers/statute-check.ts` — `lookupTitle` takes the
year and tries the year-qualified reading first. It takes the *first slot* in
the existing three-candidate list rather than adding one, so the per-call lookup
budget is unchanged, and the cache key now includes the year. Checked against
the live Register that this does not regress the former-name path:
`"Trade Practices Act 1974"` still resolves to the CCA.

**Verified:** ★22 now prints
`✓ Income Tax Assessment Act 1997 (Cth) s 355-25 — 'Core R&D activities' [C2004A05138]`,
and `Privacy Act 1988 (Cth) s 999` is the only `✗`.

### Bug 2 — no section of the Australian Constitution could be fetched

*Severity: high. The most-cited instrument in the country, unreachable.*

Scenario ★24. `get_law_text {query:"Constitution", provision:"s 51(xx)"}` — and
`s 51`, and every other section — returned:

```
[LAW_NOT_FOUND] s 51(xx) is not in the latest table of contents of
Commonwealth of Australia Constitution Act [C2004Q00685]
```

The entry is in the table of contents. Dumped from the live NCX, it reads
`"51. Legislative powers of the Parliament."` — with a **full stop after the
number**. `refToNcxLabelPattern` built `^51(?=\s)` for number-led labels, which
modern FRL Acts satisfy (`"18  Meetings of Commission"`) and the pre-Federation
continued laws do not: they keep their 1900 typography. The worded branch
(`Part IVA—…`) already tolerated a trailing stop through its
`(?![0-9A-Za-z])` lookahead; only the number-led branch did not.

The sting is that `get_law_text`'s own alias note advertises the citation form
it could not serve: *"AGLC r 3.6 cites it as 'Australian Constitution s 51(xx)'"*.

**Fix:** `src/lib/section-ref.ts` — `^${number}\.?(?=${gap})`. The stop is
escaped (an unescaped `.` would let `s 51` match `51A`) and optional, so
`s 51` still cannot reach `51A` (no gap after the number) or `51.2` (no gap
after the stop).

**Verified:** ★24 returns `51. Legislative powers of the Parliament.` with all
thirty-nine placita, breadcrumbed to `Chapter I.—The Parliament.`

### Bug 3 — `get_provision_history` printed the ACL warning and then answered for the body section

*Severity: medium-high. Right warning, wrong answer, directly under it.*

Scenario ★28. `{query:"ACL", provision:"s 18"}` returned:

```
Amendment history of s 18 — Competition and Consumer Act 2010 [C2004A00109]
Alias "ACL" → … ACL s 18 (misleading or deceptive conduct) is NOT CCA s 18
(meetings of Commission).

s 18  — under Part II
  am (amended):
     No 17, 1986 — Trade Practices Revision Act 1986 …
```

That is the body section's history (1986/1995/2007). ACL s 18 was *inserted* in
2010 and has never been amended. The tool's own description turns on exactly
this distinction. Printing the trap in the header and then walking into it is
worse than not printing it, because the note reads as though the schedule was
considered.

Cause: the alias-schedule rewrite added in `882b13d` was applied in
`get_law_text` and `get_batch_provisions` but not at this third call site.

**Fix:** `src/tools/provision-history.ts` — the same
`primaryLawMention` + `provisionParam` rewrite as the other two, so the three
cannot drift, with the same `Read "s 18" as "sch 2 s 18"` line. The
`compare_old_new` follow-up it prints now carries the schedule too; without that
the next call walks back into the trap.

**Verified:** ★28 returns `Amendment history of sch 2 s 18`, one row,
`ad (added or inserted) — No 103, 2010`, and the follow-up reads
`provision:"sch 2 s 18"`. `{registerId:…, provision:"s 18"}` is unaffected and
still returns the three body amendments.

### Bug 4 — a failed version list read as "the text may be unchanged"

*Severity: medium. Absence manufactured from a lookup failure.*

Found by running `applicable_law` with a deliberately tiny upstream cap so the
version list would fail. It printed:

```
▶ Since 2010-06-30: no later compilation in the 0 most recent version rows —
  the text may be unchanged.
```

Sixteen years of amendments, reported as probably nothing, because
`safeVersions` caught the error and returned a bare `[]`. Two nearby lines
inferred failure from the same emptiness and so were also stating more than they
knew. This is the class of defect the last two commits were mostly about; this
site was simply missed.

**Fix:** `src/tools/applicable-law.ts` — `safeVersions` returns
`{ versions, error? }`. The "Since" line reports the failure and says it "is a
lookup failure, not a finding that nothing has changed since"; the two adjacent
lines now distinguish *could not be read* (with the reason) from *came back
empty*. A genuinely empty list still says "may be unchanged", which is right.

**Verified:** under the tiny cap the same call now prints
`▶ Since 2010-06-30: the version list could not be read (…) — a lookup failure,
not a finding that nothing has changed since. Retry, or use get_law_history.`

### Sweep

| Check | Result |
|---|---|
| `TODO` / `FIXME` / `XXX` / `HACK` in `src/`, `scripts/`, `Dockerfile` | **none** |
| Regressions against the previous run of this document | **none found** — every scenario that passed last time passed again |
| Behaviour that improved without a fix in this pass | `legal_research` base law (deferred item 1 of the last pass, now closed); `applicable_law` "in force now vs latest registered" |
| `tools/list` payload | 16,401 → 16,797 bytes. Growth is the fixed tool descriptions, not a leak; still 10 tools. |

---

## 8. Deferred — for the architect, not patched here

1. **The chain's two searches print two different "first" hits.**
   `legal_research`'s legislation section runs `search_ai_law`, which re-ranks
   locally, while the base-law note quotes `candidates[0]` from the chain's own
   full-text call. The reader sees a list headed by *Foreign Passports Act*
   immediately above a note saying "the full-text search ranked
   *Inspector-General of Animal Welfare…* first". Both sentences are true of
   their own query, and nothing false is asserted, but they read as a
   contradiction. Fixing it means either feeding both sections from one search
   or naming which search each sentence describes — a chain-composition
   decision, not a QA fix.

2. **Word-form provision ranges are not parsed.** `parseSectionRef` returns
   `null` for `ss 45 to 46`, `ss 45 and 46` and `ss 355-25 and 355-30`, all of
   which are ordinary AGLC prose. `ss 45-46` works. The dash form covers the
   common case and a `null` is handled honestly everywhere it surfaces, so this
   is a gap rather than a wrong answer — but `extractSectionRefs`, and therefore
   `verify_citations`, silently skips those citations rather than checking them.

3. **The Constitution numbers its sections twice.** With bug 2 fixed, `s 51`
   resolves cleanly, but `C2004Q00685` contains the imperial Act's covering
   clauses 1–9 at depth 2 *and* the Constitution's own ss 1–9 at depth 3 under
   `Chapter I.—The Parliament.` `findNavPoint` takes the first non-schedule
   match, so `s 1`–`s 9` return the covering clause. Both are real provisions
   with the same number in one document; disambiguating needs a rule about which
   subtree an unqualified reference belongs to, which is a design decision.

4. **OAIC privacy search matches page 1 only.** Unchanged from the last pass and
   confirmed live: the determinations index takes no keyword parameter, so
   `search_decisions {domain:"privacy"}` filters one page of ten out of 101. The
   response says so and offers `page`, which is honest, but a caller asking "has
   the Commissioner ever determined X" gets a misleadingly thin list unless they
   paginate by hand. Fetching all 11 pages once and caching would fix it at a
   cost of 11 upstream calls.

5. **`get_law_text` volume fetches are up to 8 MiB.** Unchanged from the last
   pass. The limit is adequate, but a chain that touches several large Acts will
   feel the 32 MiB request ceiling. If that starts biting, the real fix is
   byte-range or per-volume caching of FRL epub members rather than a higher
   ceiling.

6. **Process, not product: scratch test files in `src/`.** During this run a
   concurrent agent created and deleted `probe.test.ts`, `src/zzprobe.test.ts`
   and `src/zzprobe2.test.ts`. Because `vitest.config.ts` globs
   `src/**/*.test.ts`, a bare `npx vitest run` picked them up and once failed on
   a file that vanished mid-run. Nothing here is broken, but anyone reading a
   CI failure of that shape should check `git status` before believing it.

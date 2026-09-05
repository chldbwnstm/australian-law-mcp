# Australian Law MCP

**81 tools compressed into 10.** Search, retrieve and analyse Australian law — Commonwealth legislation, State and Territory registers, judgments, tribunal decisions, ATO rulings, treaties and delegated instruments — plus **a citation hallucination guard that checks content, not just existence**, **a case citator (`cite_check`)**, **point-in-time law resolution (`applicable_law`)** and **an instrument staleness radar (`instrument_radar`)**.

![npm](https://img.shields.io/npm/v/au-law-mcp)
![MCP](https://img.shields.io/badge/MCP-1.27-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)

> Every source is a **keyless public endpoint** — the Federal Register of Legislation, NSW Caselaw, the High Court, Queensland Judgments, the State registers, the ATO, the Fair Work Commission, the OAIC, the NACC and DFAT. **There is no API key to configure.** Works with Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Zed, Gemini CLI, and any MCP client.

---

## Why this exists

Australian law is split three ways and the split is where wrong answers come from.

- **Commonwealth vs State.** Most law that touches a person directly — tenancy, crime, land, licensing, traffic — is State law. A confident answer sourced only from the Federal Register is usually the wrong answer to the question that was asked.
- **Act vs schedule.** The Australian Consumer Law is not an Act. It is **schedule 2 of the *Competition and Consumer Act 2010***, so "ACL s 18" must be fetched as `sch 2 s 18`. The Act's own body has an s 18 too, and it is *"Meetings of Commission"*. A model that cites "CCA s 18" for misleading and deceptive conduct has cited a real section for a proposition it does not contain, and an existence-only citation checker signs that off with a tick.
- **Renamed vs repealed.** The *Trade Practices Act 1974* and the *Competition and Consumer Act 2010* are the **same Act**, same register id `C2004A00109`. Treating the rename as a repeal loses forty years of authority.

The other half of the problem is access. Several of the sources a researcher would reach for first — AustLII, LawCite, the Federal Court, the NSW and SA registers — refuse automated clients. **This server never answers a refusal with an absence.** A blocked source is reported as `[UPSTREAM_BLOCKED]` with a deep link, and the response says in terms that it carries no evidence either way.

---

## Quick Start

> The package is published on npm as **`au-law-mcp`**, because the unscoped `australian-law-mcp` name already belongs to an unrelated project.

### Option 1 — MCP server (Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Zed, Gemini CLI)

**Automatic (recommended).** The wizard detects which clients are installed, shows you the config paths, and merges the entry into each file it is allowed to touch:

```bash
npx -y --ignore-scripts au-law-mcp setup
```

There is no API-key step. The wizard reads an existing config, merges, and rewrites — it never replaces a file that already holds your other servers.

**Manual.** Add this to your client's config:

```json
{
  "mcpServers": {
    "australian-law": {
      "command": "npx",
      "args": ["-y", "au-law-mcp"]
    }
  }
}
```

| Client | Config file |
|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Win) / `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) |
| Claude Code | `.mcp.json` in the project directory |
| Cursor | `~/.cursor/mcp.json` |
| VS Code | `.vscode/mcp.json` in the project directory (uses `servers`, not `mcpServers`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Zed | `~/.zed/settings.json` (uses `context_servers`, and nests the command) |

### Option 2 — CLI

```bash
npm install -g --ignore-scripts --omit=optional au-law-mcp

australian-law "what does s 18 of the ACL say"        # plain English, routed to a tool
australian-law "is [2020] HCA 41 still good law"      # → cite_check
australian-law explain "unfair dismissal time limit"  # show the routing, run nothing
australian-law list --category "case law"             # browse by category
australian-law search_law --query "Fair Work Act"     # call a tool directly
australian-law                                        # interactive REPL
```

### Option 3 — Docker

```bash
docker build -t au-law-mcp .
docker run -p 3000:3000 -e MCP_AUTH_TOKEN=replace-with-a-secret au-law-mcp
```

The image binds `0.0.0.0` because a container *is* a remote deployment. Startup fails without `MCP_AUTH_TOKEN` unless you deliberately set `MCP_ALLOW_UNAUTHENTICATED_REMOTE=1`.

### Option 4 — HTTP deployment

```bash
au-law-mcp --mode http --port 8000
```

Stateless Streamable HTTP: `POST /mcp` needs no session handshake, so any number of replicas can sit behind one load balancer. `GET /` reports the tool counts and `GET /health` is a plain liveness probe; both stay open when a token is set so a balancer can reach them.

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8000` | Listening port. `--port` wins over it. |
| `MCP_HTTP_HOST` | No | `127.0.0.1` | Bind address. A non-loopback host **requires** `MCP_AUTH_TOKEN` or an explicit `MCP_ALLOW_UNAUTHENTICATED_REMOTE=1`. |
| `MCP_AUTH_TOKEN` | No | — | When set, `/mcp` requires `x-mcp-token: <token>` or `Authorization: Bearer <token>`. `/health` and `/` stay open. |
| `MCP_ALLOW_UNAUTHENTICATED_REMOTE` | No | `0` | Set to `1` only for a deliberately public deployment with another access boundary in front of it. Emits a startup warning. |
| `ALLOWED_ORIGINS` | No | — | Comma-separated `Origin` allowlist (DNS-rebinding defence). A request carrying an `Origin` is refused unless listed; ordinary MCP clients send none and are unaffected. |
| `CORS_ORIGIN` | No | — | `Access-Control-Allow-Origin` for requests with no `Origin` header. Setting it also lets that origin pass validation. |
| `TRUST_PROXY` | No | — | Trusted reverse-proxy hops, `1`–`10`. Never `true`: trusting every hop makes `X-Forwarded-For`, and so the per-IP limit, client-controlled. |
| `RATE_LIMIT_RPM` | No | `60` | `tools/call` per minute per IP. `0` disables only this limiter. The handshake is never rate limited. |
| `MCP_MAX_BATCH_CALLS` | No | `20` | Maximum `tools/call` items in one JSON-RPC envelope. |
| `MCP_MAX_BODY_BYTES` | No | `102400` | Maximum incoming JSON request size. The older `MCP_BODY_LIMIT` spelling (`"100kb"`) is still accepted. |
| `ALLOW_QUERY_API_KEY` | No | `1` | Set to `0` to reject `?apikey=` — query strings land in proxy access logs in plain text. Headers are unaffected. |
| `ACCESS_LOG` | No | `0` | `1` for one log line per request. The path only, never the query string. |
| `MCP_MAX_UPSTREAM_REQUESTS` | No | `48` | Request-wide upstream attempt budget, retries included. A batch and every chain step share one budget. |
| `MCP_MAX_UPSTREAM_BODY_BYTES` | No | `8388608` | Bytes read from one upstream response. The Register serves Act text as whole epub volumes — the CCA's are 2.0 MiB and 4.1 MiB — so lowering this below ~5 MiB makes `get_law_text` fail on the largest Acts. |
| `MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES` | No | `33554432` | Upstream body bytes for one outer request (~4 full-size volumes). Must be ≥ `MCP_MAX_UPSTREAM_BODY_BYTES`. |
| `MCP_MAX_TOOL_RESPONSE_CHARS` | No | `50000` | Characters returned in one tool response. |
| `MCP_CHAIN_DEADLINE_MS` | No | `45000` | Deadline for chain tools. On expiry the chain returns what arrived and marks the rest, instead of losing everything to a client timeout. |
| `FALLBACK_RATE_LIMIT_RPM` | No | `120` | Shared upstream allowance, refilled per minute. These sources are scraped public sites with politeness intervals, not a paid quota. |
| `FALLBACK_RATE_LIMIT_BURST` | No | `120` | Burst the shared bucket holds. |
| `FALLBACK_DAILY_CAP` | No | `0` | Rolling 24-hour cap on that shared path. `0` disables it. |
| `LAW_USER_AGENT` | No | a browser UA | Some upstreams reject Node's default undici agent. |
| `LAW_REFERER` | No | — | Sent as `Referer` on every upstream request when set. |

Every numeric setting is validated as a whole integer at startup. An invalid value **fails the boot** rather than quietly disabling the limit it configures — `parseInt("60x")` is `60`, and `NaN > limit` is `false`, and either one turns a gate off with nothing in the logs.

---

## The 10 advertised tools

`ListTools` returns ten. The other 71 are reachable — by name through `CallTool`, and by discovery through `discover_tools` → `execute_tool`. Nothing is ever removed from the registry to shrink the advertised list, so a name learned from an earlier version keeps working.

Ten, not eighty, because every advertised entry is context that every client pays for on every request, and a model choosing between eighty near-synonyms chooses badly. These ten are not "the best ten" — they are the ones where the two-hop round trip is not worth its latency.

| Category | Tool | What it does |
|---|---|---|
| **Aggregate** (2) | `legal_research` | Eight multi-step research patterns behind `task`: `full_research` (default), `law_system`, `action_basis`, `dispute_prep`, `amendment_track`, `state_law_compare`, `procedure_detail`, `document_review`. Every gap in the result is marked rather than dropped. |
| | `legal_analysis` | The four analysis features behind `mode`: `verify_citations`, `cite_check`, `applicable_law`, `impact_map`. |
| **Legislation** (3) | `search_law` | Federal Register search by name or abbreviation — `CCA`, `ACL`, `FW Act`, `TPA` all resolve. Returns the `registerId` every other tool needs, plus repeal, rename and commencement warnings. |
| | `get_law_text` | One provision, or a whole Part / Division / Schedule. `{registerId:'C2004A00109', provision:'sch 2 s 18'}` is ACL s 18. Without a `provision` it returns the table of contents and says which call fetches which piece — never the whole Act, which runs to megabytes. |
| | `get_schedules` | An Act's schedules, or one of them opened. Australian schedules carry substantive law: fees, forms, penalty tables, and the ACL itself. |
| **Instruments** (1) | `instrument_radar` | Staleness check: has the enabling Act moved since this instrument was last compiled? Returns the intervening amendments with register ids. A flag is a prompt to review, **not** a finding that the instrument is invalid. |
| **Decisions** (2) | `search_decisions` | All 18 decision domains from one tool, chosen with `domain`. |
| | `get_decision_text` | One decision from any domain: the same `domain` plus the `id` printed in the results — never an invented one. Long reasons are shortened from the middle with the exact number of omitted characters marked. |
| **Meta** (2) | `discover_tools` | "What tool do I need for X?" Ranked, grouped by category, with the right call path for each. |
| | `execute_tool` | Run any of the 81 by name. Parameters pass straight through to the target tool's own validation. |

---

## The 18 decision domains

One `search_decisions` / `get_decision_text` pair covers all of them. Grades below are from a live run on **2026-09-04** (`docs/VERIFICATION.md` has the raw output and timings).

| Domain | Source | Grade | What that means |
|---|---|:---:|---|
| `cases` | NSW Caselaw + High Court + Queensland Judgments | 🟢 live | Three sources merged; a medium-neutral citation routes to an exact lookup. Federal Court is Cloudflare-gated → deep link. |
| `constitutional` | High Court (catchword facet) | 🟢 live | The closest Australian analogue of a constitutional docket. |
| `admin_appeals` | NCAT (via NSW Caselaw), QCAT (via Queensland Judgments) | 🟡 partial | The **federal ART** publishes only through AustLII → deep link. |
| `tax_tribunal` | ATO Legal Database | 🟡 partial | Decision impact statements — the Commissioner's published response. **ARTA reasons** are AustLII-only → deep link. |
| `tax_rulings` | ATO Legal Database | 🟢 live | TR / TD / GSTR / PCG. An exact product code is resolved by exact search. |
| `interpretations` | ATO Legal Database | 🟢 live | ATO IDs and practice statements. |
| `customs` | ATO + Anti-Dumping Review Panel | 🟢 live | Customs and excise material plus the ADRP indexes. |
| `competition` | ACCC, Australian Competition Tribunal | 🔴 degraded | Both return **403** to non-browser clients. Reported as `[UPSTREAM_BLOCKED]` with three deep links, then a live case-law fallback labelled as court decisions rather than the register. |
| `workplace` | Fair Work Commission | 🟢 live | Unfair dismissal, general protections, agreements, awards. Reasons themselves are PDFs behind a viewer. |
| `privacy` | OAIC | 🟡 partial | The determinations index carries findings, remedies and catchwords, but **takes no keyword parameter** — a query matches one page of ten at a time. Full reasons are on AustLII. |
| `integrity` | NACC | 🟡 partial | Investigation reports live. The **Commonwealth Ombudsman** is Cloudflare-gated → deep link. |
| `public_service` | Merit Protection Commissioner | 🟢 live | De-identified case studies. Individual promotion reviews are published as notices, not reasons, and the tool says so. |
| `university_rules` | State registers | 🟢 live | Universities are creatures of State statute; there is no Commonwealth list. Some rules exist only on the university's own site. |
| `agency_rules` | Federal Register (notifiable instruments) | 🟢 live | Determinations, delegations, appointments. |
| `gazettes` | Federal Register (Gazette collection) | 🟢 live | Post-digitisation only; older paper gazettes are with the National Library. |
| `treaties` | DFAT Australian Treaties Database | 🟡 partial | Full metadata, status, entry into force, JSCOT report. **Treaty text is AustLII-hosted** → link only. |
| `explanatory` | Federal Register + ParlInfo | 🟢 live | Explanatory statements for instruments, explanatory memoranda for Acts. Extrinsic material under s 15AB of the *Acts Interpretation Act 1901* — evidence, not commentary. |
| `state_law` | QLD, TAS, WA, VIC, NT, ACT | 🟡 partial | QLD and TAS by full text; WA/NT/VIC/ACT by title or register number. VIC and NT return authorised PDF/DOCX links because that is the only authorised form. **NSW and SA are refused** → deep link. |

---

## Honest limitations

This section is not a disclaimer. It is the list of things you would otherwise discover by getting a wrong answer.

### Sources this server will not fetch

| Source | Why | What you get instead |
|---|---|---|
| **AustLII** / **LawCite** | Cloudflare-gated, and AustLII asks automated clients to contact it first | A deep link. LawCite is the reason the citator is partial. |
| **Federal Court of Australia** | Cloudflare challenge on every request | A deep link, plus an AustLII search URL scoped to `au/cases/cth/FCA` |
| **NSW legislation register** | No public query surface; the register discourages automated access | A deep link, refused in ~1 ms before any request |
| **SA legislation register** | Same | A deep link |
| **ACCC** / **Australian Competition Tribunal** | 403 to non-browser clients | Deep links plus a case-law fallback |
| **Commonwealth Ombudsman** | Cloudflare-gated | A deep link |

**A blocked source is never reported as absence.** The label is `[UPSTREAM_BLOCKED]`, distinct from `[NOT_FOUND]` (the source authoritatively says the record is not there) and from `[UPSTREAM_NO_DATA]` (the source was asked and did not hand it over). The response says, in words, that it carries no evidence either way.

### What is materially incomplete even where it works

- **No reported citations.** CLR, FCR, NSWLR and every other reported series is reachable only through AustLII/LawCite. `verify_citations` marks a reported citation `⚠`, never `✓` or `✗`.
- **Victoria, SA, WA, Tasmania, ACT and NT judgments** are not searched. Only NSW, the High Court and Queensland are.
- **The citator is not complete.** `cite_check` scans what it can reach and reports the count it retrieved alongside the count the source claims — e.g. *"High Court of Australia: 12 mention(s) (source reports 74)"*. It never presents a partial scan as a clean bill of health.
- **Judgment and determination text is often a PDF.** The FWC, the OAIC and the High Court publish reasons as PDF/DOCX behind an HTML metadata page. You get the metadata and the download link, and a note saying the reasons exist and were not received as text.
- **Compiled text can lag the law in force.** Where the Register flags unincorporated commenced amendments, every response carries the warning. Cite the amending Act, not just the compilation.
- **Terminology is a bundled dictionary, not an API.** There is no Australian statutory-terminology service. `get_legal_term_kb` and friends read a bundled table plus the State Library of NSW glossary, and every answer names which of the two it came from.

### Not legal advice

This software retrieves and formats public legal material. It does not give legal advice, and nothing it returns substitutes for reading the authorised text or consulting an Australian legal practitioner.

---

## Usage examples

Real output from the verification run. Full transcripts in [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

### The citation hallucination guard

An LLM writes a paragraph of advice:

> Under the Competition and Consumer Act 2010 (Cth) s 18, misleading conduct is prohibited; see also Privacy Act 1988 (Cth) s 999.

`legal_analysis({mode:"verify_citations", text: "…"})`:

```
[CITATION_ERRORS_FOUND] Citation check
Statute citations: 2 | ✓ 0 verified | ✗ 2 cannot be right | ⚠ 0 not checked here

✗ CONTENT_MISMATCH: Competition and Consumer Act 2010 (Cth) s 18 is 'Meetings of
  Commission'; misleading conduct is sch 2 s 18 (Australian Consumer Law)
✗ NOT_FOUND: Privacy Act 1988 (Cth) s 999 — Privacy Act 1988 [C2004A03712] has no
  s 999 in its current compilation. the body of the Act runs from s 1 to s 100 in
  this compilation (313 numbered entries). Nearest entries: 100 Regulations |
  99A Conduct of directors, employees and agents | 98A Treatment of partnerships

⚠️ 2 citation(s) cannot be right as written … Do NOT answer "verified".
```

Both citations are of real Acts. One section exists but says something else; the other does not exist. An existence-only checker catches the second and ticks the first.

### Point-in-time law

`legal_analysis({mode:"applicable_law", lawName:"Trade Practices Act", date:"2010-06-30", provision:"s 52"})`:

```
▶ In force on that date
  Trade Practices Act 1974 — compilation window 2010-04-15 → 2010-07-01, registerId C2010C00331
  ⚠️ On that date this law was titled "Trade Practices Act 1974". It is now
     "Competition and Consumer Act 2010" — the SAME Act, renamed, NOT repealed
     and replaced. Cite it as "Trade Practices Act 1974" for conduct on 2010-06-30.

▶ s 52 as at 2010-06-30
52 Misleading or deceptive conduct
    (1) A corporation shall not, in trade or commerce, engage in conduct that is
        misleading or deceptive or is likely to mislead or deceive.

▶ Compared with today: CHANGED — 14 line(s) added, 4 removed.
- 52 Misleading or deceptive conduct
+ 52 Guarantee as to undisturbed possession

▶ Application / saving / transitional provisions in the 1 most recent amending Act(s)
  Trade Practices Amendment (Australian Consumer Law) Act (No. 2) 2010 [C2010A00103]
    • Schedule 2—Application of the Australian Consumer Law
    • Schedule 7—Transitional matters
```

Today's s 52 is a different provision. Answering from the current text would have been confidently wrong.

### The citator

`legal_analysis({mode:"cite_check", caseNumber:"[2020] HCA 41"})`:

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

Note "in what was scanned" and "source reports 74". The verdict is scoped to the evidence.

### The schedule trap, from the CLI

```bash
$ australian-law "what does s 18 of the ACL say"
  [routing] get_law_text — statute name + provision reference → get_law_text
  also: ACL is schedule 2 of Competition and Consumer Act 2010, so the reference
  was read as "sch 2 s 18". The body of the Act has its own section of that
  number, and it is a different provision.

Provision: sch 2 s 18 — 18 Misleading or deceptive conduct
In: Volume 4 › Schedule 2—The Australian Consumer Law › Chapter 2—General
    protections › Part 2-1—Misleading or deceptive conduct
18 Misleading or deceptive conduct
    (1) A person must not, in trade or commerce, engage in conduct that is
        misleading or deceptive or is likely to mislead or deceive.
```

### Blocked, not absent

```
$ search_decisions {domain:"state_law", query:"residential tenancies", options:{jurisdiction:"nsw"}}

[UPSTREAM_BLOCKED] nswLegislation is not fetched by this server (no public query
surface and the register discourages automated access). This is a refusal to
request, not an observation about the record — nothing here says the material is
absent.
Suggestions:
  1. ⚠️ Do not report this as 'no such case/legislation'. The source was never
     queried, so this response carries no evidence either way.
  2. Open directly: https://legislation.nsw.gov.au
```

### Typical call chains

```
User: "what does s 18 of the ACL say"
→ get_schedules(registerId="C2004A00109") → get_law_text(registerId="C2004A00109", provision="sch 2 s 18")

User: "was misleading conduct illegal in 2010 and under which Act"
→ legal_analysis(mode="applicable_law", lawName="Trade Practices Act", date="2010-06-30", provision="s 52")

User: "find unfair dismissal decisions about serious misconduct"
→ search_decisions(domain="workplace", query="serious misconduct") → get_decision_text(domain="workplace", id="…")

User: "what tools do you have for point-in-time law"
→ discover_tools(intent="point in time law") → execute_tool(tool_name="get_provision_history", params={…})
```

---

## Features

- **Two-list registry** — 81 tools registered, 10 advertised. Everything stays callable by name forever; the advertised surface is a projection, not the truth.
- **Bracket-labelled errors** — `[NOT_FOUND]`, `[UPSTREAM_NO_DATA]`, `[UPSTREAM_BLOCKED]`, `[EXTERNAL_API_ERROR]` and the rest are a machine-readable contract, and the three "we don't have it" cases are kept strictly apart because they mean different things to a caller.
- **One execution budget per request** — a JSON-RPC batch and every chain step share one allowance, held in `AsyncLocalStorage`, so a single envelope cannot multiply the upstream footprint.
- **Chains that degrade rather than die** — on deadline a chain assembles what arrived and marks the rest, instead of losing everything to a client timeout.
- **Per-host politeness** — every upstream has its own timeout and minimum interval, sized from measurement (Queensland content search takes up to 90s; the ATO form up to 60s), so one slow host does not stall every other tool.
- **Natural-language CLI** — a query router with an `explain` mode that shows where a question would go without running it, plus a generated subcommand per tool.
- **2,429 offline tests** against recorded fixtures, plus **18 live-gated tests** that only run with `LIVE=1` and check the real upstreams still answer the shapes the parsers expect.

---

## Documentation

- [`docs/API.md`](docs/API.md) — tool reference: id formats, error taxonomy, caching and limits, all 10 advertised tools with parameters, category tables for the other 71, workflow examples.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — sources, layering, the client contract.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — build, test, fixture-recording conventions, how to add a tool or a domain.
- [`docs/TOOL-MAPPING.md`](docs/TOOL-MAPPING.md) — how each tool maps onto an Australian source.
- [`docs/VERIFICATION.md`](docs/VERIFICATION.md) — the live verification log this README's grades come from.
- [`CLAUDE.md`](CLAUDE.md) — repo guide for coding agents.
- [`CHANGELOG.md`](CHANGELOG.md) — release history.

---

## Credits

- [**Federal Register of Legislation**](https://www.legislation.gov.au/) — Commonwealth legislation, published by the Office of Parliamentary Counsel under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [**NSW Caselaw**](https://www.caselaw.nsw.gov.au/), [**High Court of Australia**](https://www.hcourt.gov.au/), [**Queensland Judgments**](https://www.queenslandjudgments.com.au/) — judgments.
- [**ATO Legal Database**](https://www.ato.gov.au/law/), [**Fair Work Commission**](https://www.fwc.gov.au/), [**OAIC**](https://www.oaic.gov.au/), [**NACC**](https://www.nacc.gov.au/), [**Merit Protection Commissioner**](https://www.mpc.gov.au/), [**DFAT Australian Treaties Database**](https://docs.dfat.gov.au/), [**ParlInfo**](https://parlinfo.aph.gov.au/), [**State Library of NSW**](https://legalanswers.sl.nsw.gov.au/) — decisions, rulings, treaties and terminology.
- The QLD, TAS, WA, VIC, NT and ACT legislation registers.
- [**korean-law-mcp**](https://github.com/chrisryugj/korean-law-mcp) (MIT) — the architectural reference. The two-list registry, the meta-tool pair, the request budget, the error taxonomy and the two-layer citation content matcher are re-implementations of that project's design for a different jurisdiction. No data, client or source adapter is shared. See [`NOTICE`](NOTICE).
- [**Model Context Protocol**](https://modelcontextprotocol.io/) — the protocol and TypeScript SDK.

Full source attribution and the accuracy disclaimer are in [`NOTICE`](NOTICE).

## License

[MIT](./LICENSE) — © 2026 australian-law-mcp contributors. The licence covers the code; the legal material the tools retrieve is governed by each source's own terms.

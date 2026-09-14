# Aside research verification

Two live records, each dated and each from the built source at the time. The
macOS matrix below was tested on **13 September 2026** and shipped in v1.0.4;
the [Windows run](#windows-run) was tested on **14 September 2026** and ships in
v1.0.5. Both used the built server through MCP stdio with `AU_LAW_ASIDE=true`,
and the harness did not supply manually corrected publisher URLs to the server.

## Automated regression checks

The local suite passes **2,961 tests**, with 21 skipped: **103 additional tests**
over the preceding 2,858-test baseline. Type checking, the build and the stdio
handshake/tool-call check also pass. Normal tests never launch Aside or request
a public website.

| Area | What is checked |
| --- | --- |
| Judgment identity | Exact year, court and number; dotted tokens and pinpoints; rejection of a different judgment merely citing the requested case |
| Original body | Recorded Federal Court and AustLII HTML, paragraph numbering, older WA anchors, short reasons, navigation, metadata and PDF viewers |
| Search scope | Court/jurisdiction masks, URL/citation agreement, duplicates, totals, page offsets, and redirects changing the query, scope or page |
| Source failures | Interstitials, long 404/403/5xx pages, empty output, wrong documents, second-publisher fallback and pending gaps |
| Browser protocol | Generated REPL exercised against a controlled page API, gate/load transitions, owned-tab cleanup, final URLs, JSON framing, Unicode and marker collisions |
| CLI lifecycle | Real harmless Node subprocesses: paths with spaces, literal arguments, split UTF-8, start/exit failures, output bounds, timeout, cancellation and Unix process-group cleanup |
| Concurrency and budgets | One active CLI per server process, bounded queue, ordering, queued cancellation/deadlines, recovery, byte accounting and terminal retry conditions |
| Follow-up | Source fixture through `get_case_text`, transport truncation, JSON serialization, planning and supplied-evidence checks; wrong identity/source/task, partial text, OCR, missing locator/quote and omitted annexes remain pending |

Recorded HTML and capture metadata are in
[`src/lib/sources/__fixtures__/aside`](../src/lib/sources/__fixtures__/aside).
In the judgment and search pages, scripts and styles were removed and document
structure and visible text retained; the recorded challenge page is verbatim,
because its markup is what the detector reads. `provenance.json` records each
file's publisher URL, capture date, the hash of the original HTML, and which of
the two it is.

## Live MCP matrix

The final run completed **22 MCP calls** in approximately 146 seconds:

| Observed outcome | Calls |
| --- | ---: |
| Identifiable HTML judgment reasons returned | 9 |
| Scoped search results returned | 10 |
| Original PDF linked; body still pending | 1 |
| Publisher reported zero results for the query | 1 |
| Unavailable address retained as unresolved | 1 |

The [machine-readable report](ASIDE-LIVE-REPORT.json) records every request,
status, source link, follow-up gap and elapsed time. It also includes hashes of
the original JSON-RPC response files and the tested JavaScript build. Its base
commit is marked dirty because these fixes were tested before being committed.

The matrix covers TPG in full/compact modes, dotted citation/pinpoint input,
ordinary FCA and FCAFC judgments, older judgments, two AustLII pages and
search-to-judgment retrieval. It also covers the family court, Victoria, WA,
SA, Tasmania, ACT and NT, an empty query and an unavailable judgment address.

`retrieved` means identifiable HTML reasons were returned. It does not mean the
whole judgment fit in the response or that a legal argument was verified.
`document_link` means the original PDF still requires extraction. Search results,
empty queries and unresolved sources are recorded separately.

The first new regression batch exposed 17 failures in 19 checks. Live testing
then exposed a head-only search snapshot after a challenge, `at [38]` input,
a Victorian PDF viewer and an older WA reasons template. These observations led
to fixes and regression tests before the final recorded run.

## Windows run

Aside shipped its Windows build on **14 September 2026** (browser 1.0.914.1,
CLI 1.26.906.1630, installed by `install.ps1` to
`%LOCALAPPDATA%\Aside\CLI\current\aside.exe`). The same matrix was run that day
on local Windows 11 24H2 — `os.release()` `10.0.26200`, x64 — against the built
source of the Windows-parity change, with the Aside browser already running and
signed in. It completed **22 MCP calls in approximately 163 seconds**:

| Observed outcome | Calls |
| --- | ---: |
| Identifiable HTML judgment reasons returned | 9 |
| Scoped search results returned | 10 |
| Original PDF linked; body still pending | 1 |
| Publisher reported zero results for the query | 1 |
| Unavailable address retained as unresolved | 1 |

The [machine-readable record](ASIDE-LIVE-REPORT-WINDOWS.json) covers the same
cases as the macOS matrix above, and its header also carries the CLI path and
version, the NT release, the architecture and whether the browser was already
running — the fields that make a Windows run comparable to a macOS one. Its
`version` field reads `1.0.4` because the run was made from the working tree
before the release bump, against the same source that ships here.

Alongside it, on the same machine: the offline suite passes **2,961 tests** with
21 skipped, and type checking, the build, `npm run verify:stdio` (which plans
browser follow-up for a macOS and a Windows probe and keeps a Linux probe on
standard research) and `npm run build:mcpb` — including the packed bundle's
offline switch check — all pass. The project-local companion was installed by
`setup-followup` with no `--aside-command`: it found the CLI at the installer's
location on its own, wrote it into `.mcp.json` and `.codex/config.toml` with
backslashes correctly escaped for each format, and the installed helper's probe
returned `eligible: true`, `platform: "win32"`, `osVersion: "10.0.26200"` with
`repl` and `exec`, then ran init → status → stop → resume-matter with the matter
budget preserved.

**The publisher's gate is a session fact, not a platform one.** AustLII's search
endpoint served Cloudflare's interactive challenge to this freshly installed
browser profile — localised to the machine's own language, which is why the
detector recognises it by its markup rather than by its wording — and the server
labelled every affected call a bot-verification page, never an empty result. The
ten search calls above succeeded only after a person passed that check once in
the browser. A later run about two hours on was challenged again, while the six
judgment retrievals in the same run still succeeded in 6.4–9.2 s each; judgment
pages on `judgments.fedcourt.gov.au` and AustLII's `viewdoc` were not challenged
in either run. The recorded challenge page is
[`austlii-challenge-ko.html`](../src/lib/sources/__fixtures__/aside/austlii-challenge-ko.html).
Nothing in this server attempts to satisfy such a check.

## Repeat the checks

From a checkout on a Mac or a Windows (x64) PC with Aside installed and running:

```sh
npm ci --ignore-scripts
npm run build
LIVE_ASIDE=1 AU_LAW_ASIDE=true npm run verify:aside
```

On Windows, from PowerShell:

```powershell
npm ci --ignore-scripts
npm run build
$env:LIVE_ASIDE='1'; $env:AU_LAW_ASIDE='true'; npm run verify:aside
```

This opens public legal pages in your local Aside session. The server forces
`aside repl --host local` (`aside.exe` on Windows). Calls run serially.
Individual JSON-RPC responses and `report.json` go to a new temporary directory
whose location is printed. Set `ASIDE_REPORT_DIR` to choose a directory; reports
may contain source passages.

The command exits unsuccessfully if a response violates the checks or a required
retrieval/search path is unavailable. An upstream outage can make a later run
fail without a code regression. Ubuntu and Windows CI run only the offline
suite; the live browser check needs a local macOS or Windows (x64) machine with
Aside and is never run in CI.

`npm run verify:mcpb` needs no browser and runs on either platform: it starts
the unpacked bundle with the switch on and a deliberately missing CLI path and
asserts that the answer is the `[UPSTREAM_BLOCKED]` note naming that path, which
proves the extension switch reaches the server without claiming absence.

## Practical constraints

- **Availability depends on the session and publisher.** Challenges, login
  requirements, changed pages and unavailable originals can still leave a source
  unresolved. This run is a point-in-time observation.
- **PDF inspection is a further step.** A PDF viewer returns the original link
  and a `document_body` gap. Automatic case fallback does not extract or visually
  inspect that PDF; the companion can continue where supported and permitted.
- **Response limits apply to `full: true`.** Omitted text retains a `truncated`
  gap with the citation and source URL. A short response does not establish that
  every paragraph or annex was inspected.
- **Search coverage is explicit.** AustLII pages contain up to ten rows; `limit`
  controls displayed rows. Omitted rows and further pages keep a coverage gap.
  Zero results for a query do not establish that a particular case is absent.
- **Serialization is per server process.** Separate hosts/servers can initiate
  their own work. The companion also needs serial tasks and matter budgets.
- **Cancellation has a process boundary.** Cancellation and timeouts clean up
  the CLI subprocess — its process group on Unix; on Windows its process tree,
  killed with `taskkill /T /F /PID` while the CLI is alive, then
  `TerminateProcess` as the fallback — and tests establish that cleanup. They do
  not establish that disconnecting the CLI cancels JavaScript already executing
  inside Aside. Normal completion requires the owned tab to close; inspect the
  browser after a timeout or uncertain cleanup before resuming.
- **Acquisition does not establish legal correctness.** The evidence checker
  validates supplied identity, passage, locator and coverage fields. It cannot
  certify publisher authenticity or a proposition's legal application.

See [the verification history](VERIFICATION.md) for the preceding FCAFC URL and
citation-checking fixes.

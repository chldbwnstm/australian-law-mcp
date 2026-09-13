# Aside research verification

This record covers the unreleased source tested on **13 September 2026**. The
v1.0.3 installer does not contain these fixes. Live checks used the built server
through MCP stdio on local macOS with `AU_LAW_ASIDE=true`; the harness did not
supply manually corrected publisher URLs to the server.

## Automated regression checks

The local suite passes **2,858 tests**, with 18 skipped: **146 additional tests**
over the preceding 2,712-test baseline. Type checking, the build and the stdio
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
Scripts and styles were removed; document structure and visible text were
retained. The metadata records publisher URLs and hashes of the original HTML.

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

## Repeat the checks

From a checkout on a Mac with Aside installed and running:

```sh
npm ci --ignore-scripts
npm run build
LIVE_ASIDE=1 AU_LAW_ASIDE=true npm run verify:aside
```

This opens public legal pages in your local Aside session. The server forces
`aside repl --host local`. Calls run serially. Individual JSON-RPC responses and
`report.json` go to a new temporary directory whose location is printed. Set
`ASIDE_REPORT_DIR` to choose a directory; reports may contain source passages.

The command exits unsuccessfully if a response violates the checks or a required
retrieval/search path is unavailable. An upstream outage can make a later run
fail without a code regression. Windows and Linux CI run the offline suite;
the live browser check requires macOS.

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
- **Cancellation has a process boundary.** Tests establish cancellation and
  cleanup of the CLI subprocess/group. They do not establish that disconnecting
  the CLI cancels JavaScript already executing inside Aside. Normal completion
  requires the owned tab to close; inspect the browser after a timeout or
  uncertain cleanup before resuming.
- **Acquisition does not establish legal correctness.** The evidence checker
  validates supplied identity, passage, locator and coverage fields. It cannot
  certify publisher authenticity or a proposition's legal application.

See [the verification history](VERIFICATION.md) for the preceding FCAFC URL and
citation-checking fixes.

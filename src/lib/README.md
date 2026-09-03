# `src/lib` — the source-agnostic core

Everything in this directory is deliberately ignorant of *which* Australian legal source is being
called. It is the layer that makes an upstream HTTP call safe, bounded and cancellable, and that
turns whatever comes back into an MCP tool response that never lies about what it knows. A request
carries an `AsyncLocalStorage` context (`session-state.ts`) holding a cancellation signal, an
optional per-request API key and one shared `RequestExecutionBudget`; every upstream attempt and
every body byte is charged against that budget (`execution-limits.ts`, `fetch-with-retry.ts`,
`response-body.ts`), so one MCP call can never fan out without limit. When an upstream answers HTTP
200 with an empty body or a whole HTML page, `body-shape.ts` decides the shape and `upstream-miss.ts`
re-checks once before raising `UpstreamRecordMissingError` — which `errors.ts` renders as
`[UPSTREAM_NO_DATA]`, an *observation* that nothing was returned rather than a claim that the record
does not exist. Responses are then held under a character limit at meaning boundaries
(`truncate-text.ts`, `schemas.ts`) so a cut never silently swallows half a sentence. Source-specific
clients, parsers and tools build on top of this and must not reach around it.

| File | What it owns |
|------|--------------|
| `types.ts` | The `McpTool` contract (`name`/`description`/Zod `schema`/`handler`) plus `ToolResponse` and `LooseToolResponse`. Generic over the client type, so the source layer supplies its own. |
| `session-state.ts` | Per-request `AsyncLocalStorage` context: API key isolation, cancellation-signal combination (`combineAbortSignals`, `runWithRequestContext`), and the shared budget handle. |
| `execution-limits.ts` | `ExecutionLimits`, `RequestExecutionBudget`, `readExecutionLimits`, and strict `parseIntegerLimit`. Defaults: 48 upstream attempts, 2 MiB per body, 8 MiB total, 50,000 response characters. |
| `fetch-with-retry.ts` | `fetchWithRetry` (30s timeout, 3 retries, exponential backoff, clamped `Retry-After`), `sleep`, and `maskSensitiveUrl`. Charges each attempt to the budget. |
| `response-body.ts` | Bounded, cancellable body readers (`readResponseBytes`/`Text`/`ArrayBuffer`, `readBodyPrefix`). Never awaits a cleanup `cancel()` on a teed body. |
| `body-shape.ts` | The only definitions of `isBlankBody`, `isHtmlPage` (whole-page maintenance/anti-bot/notice detection) and `containsHtmlMarkup`. |
| `upstream-miss.ts` | `classifyOkBody` peeks at 1 KB of a 200 response; `UpstreamRecordMissingError` is raised only after one 200 ms re-check confirms the miss. |
| `errors.ts` | `ErrorCodes`, `LawApiError`, `noResultHint`, `notFoundResponse`, `formatToolError`. Bracket labels (`[UPSTREAM_NO_DATA]`, `[NOT_FOUND]`, …) are the machine-readable contract. |
| `cache.ts` | `SimpleCache` (LRU + TTL) and the shared `lawCache` (500 entries). `SEARCH_CACHE_TTL` 1 h, `ARTICLE_CACHE_TTL` 24 h. |
| `rate-limit.ts` | `createTokenBucket` (continuous refill, finite advised wait) and `createDailyCap` (rolling 24 h total, wired to `FALLBACK_DAILY_CAP`). |
| `schemas.ts` | Shared Zod schemas (`dateSchema`, `paginationSchema`), `MAX_RESPONSE_SIZE`, `formatDateDot`, `truncateResponse`, `truncateSections`. |
| `truncate-text.ts` | Boundary-aware cutting: `cutAtSafeBoundary`, `sliceWellFormed` (surrogate-pair safe), `extractSummary`, `summaryTail`. |
| `escape-regex.ts` | `escapeRegex` — the single escape-character set for splicing titles and keywords into patterns. |
| `cli-format.ts` | ANSI helpers, banner, interactive help, tool listing (registry passed in), and Zod→CLI option extraction. |
| `tool-chain-config.ts` | `SearchDetailChain` shape and the `SEARCH_DETAIL_CHAINS` registry that drives the CLI's search → detail auto-chain. Empty until the Australian tools land. |

Related: `../tools/chain-deadline.ts` holds the 45 s chain deadline (`MCP_CHAIN_DEADLINE_MS`),
`raceDeadline`, and the partial-result markers used when a chain runs out of time.

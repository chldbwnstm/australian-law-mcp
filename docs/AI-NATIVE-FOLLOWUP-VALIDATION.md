# AI-native follow-up implementation validation

Date: 2026-09-10

Status: source-preview implementation ready for review; not a released capability
or a completed lawyer pilot.

## Implemented contract

- Versioned gap, policy, eligibility, task and evidence schemas with stable legal
  target identities and URL normalization that preserves case-sensitive paths and
  query values.
- `plan_research_followup` and `check_research_evidence`, bringing the registry to
  83 tools while retaining the same ten-tool advertised surface.
- Typed source gaps for blocked/missing originals, reported citations, accessible
  and restricted treatment work, partial coverage, amendments, interpretation,
  truncation and chain deadlines. Key successful source-document coverage includes
  HCA, NSW, Queensland, FWC, OAIC, NACC and State-register paths.
- One response-level serialized bounder across registry success/error, direct and
  `execute_tool`, HTTP, CLI and STDIO boundaries. Omitted gaps, tasks or evidence
  force `pending: true`, carry counts, and direct callers to narrower source reruns.
- A project-local Claude Code/Codex companion skill and helper with fresh local
  macOS 15+ gates, actual Aside capability checks, persistent matter policy,
  budgets, evidence and host-assessment manifests, serial task dispatch, immediate
  session persistence, honest disconnect/stop behavior, explicit matter resume,
  and same-session continuation.
- A preserving `setup-followup` installer for project MCP settings and skills. It
  records an absolute Aside command for desktop PATH differences and refuses
  unsupported/ambiguous config shapes rather than rewriting them. The installed
  helper also recognises direct execution when macOS canonicalises `/var` to
  `/private/var` (or another directory symlink) without running on module import.

## Automated validation

All commands completed successfully in the shared worktree:

```text
npm run typecheck
npm test
  109 test files passed, 1 skipped
  2528 tests passed, 18 skipped
npm run build
npm run verify:stdio
  PASS: 10 advertised tools and structured follow-up metadata preserved
python3 .../skill-creator/scripts/quick_validate.py companion/au-law-followup
  Skill is valid
npm pack --dry-run --json
  272 entries; companion skill/helper and built follow-up modules included
git diff --check
  clean
```

The final installed-CLI correction was validated separately without rerunning
the already completed full suite:

```text
npm run typecheck
npx vitest run src/setup.test.ts src/followup-companion.test.ts
  2 test files passed; 15 tests passed
npm run build
npm run verify:stdio
  PASS: 10 advertised tools and structured follow-up metadata preserved
python3 .../skill-creator/scripts/quick_validate.py companion/au-law-followup
  Skill is valid
git diff --check
  clean
```

An exact built-entrypoint smoke installed both project-local clients into a
fresh `au-law-root-review-*` directory under the macOS temporary path. Existing
`.mcp.json` and `.codex/config.toml` entries were preserved, representative
global config hashes were unchanged, and the installed helper returned
`eligible: true` with Aside `repl`, `memory_search`, and `exec`. Its
`init -> status -> stop -> resume-matter -> status` JSON sequence completed with
the remaining budget unchanged at 10 pages, 3 documents, and 300 active seconds.

Regression cases include Windows/Linux/remote/old-mac gates; malformed OS versions;
stable and case-sensitive gap identity; oversized single gaps; evidence-only
overflow; combined escaped text/structured omission bounds; direct and
`execute_tool` HTTP paths; chain omission propagation; STDIO propagation; wrong
citation/register/provision/jurisdiction/date/task association; missing body and
locator; OCR and incomplete coverage; seed-versus-later-case citation identity;
typed PDF-summary versus full-HTML source coverage; serial dispatch; route
capability loss; waiting-for-user authorised resume; policy-off rejection;
page/document/active-time charging; idempotent finish; disconnect ownership;
budget exhaustion; stop and explicit same-session matter resume; and preserving
existing Codex/Claude project configuration. The install regression executes the
copied helper through a directory symlink, parses its probe/init/stop/resume/status
JSON, confirms stop/resume preserves the matter budget, and verifies project-local
setup leaves representative global Claude and Codex configuration untouched.

## Live Aside smoke

The local companion probe successfully completed Aside MCP initialize and
`tools/list`; the installed server exposed the observed
`repl(title, code)`, `exec(prompt, session_id?)`, and `memory_search` schemas.
The workflow does not use `memory_search`.

Two authorised benign public reads used only
`https://www.legislation.gov.au/`:

- REPL opened a new dedicated tab, observed title
  `Home Page - Federal Register of Legislation` and the same final URL, and closed
  the tab.
- Exec returned after about 13 seconds with a session id, an explicit `Done`, the
  same observed title, and the same final URL.

No login, private account, unrelated tab, form, download, access challenge or site
mutation was used. The exec result documents this installed build and one call; it
does not establish a general completion or cancellation guarantee. The companion
therefore retains serial ownership for progress-only/session-only responses and
for disconnects until the saved session is explicitly resumed and rechecked.

## Remaining limitations

- The macOS lawyer pilot, client restart/reconnection matrix, and broad legal-source
  acceptance set remain outstanding; README and installation docs label the feature
  an unreleased source preview.
- The checker assesses only supplied text and metadata. It does not certify source
  authenticity, publisher provenance, legal validity or the correctness of an AI
  interpretation; treatment, commencement and interpretation remain host-owned
  semantic work.
- Typed successful-response body/truncation gaps cover the key sources named above,
  but not every legacy full-text adapter has been migrated. Those adapters retain
  existing honest text/error output and links.
- Windows, WSL, Linux, remote/unknown hosts and macOS before 15 remain ineligible
  for every companion route, including host-model tasks. Existing law tools remain
  available and no alternate browser or remote-Mac workaround is provided.

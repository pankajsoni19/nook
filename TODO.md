# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new"), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-22).**
- **v0.43.0** is released (2026-10-22): several docs per report, Add a new section and doc links in Changes, delete from the header, edit and suggest SQL, dynamic filters (slice 1).
- Migrations: **001–066** are released and immutable (045 and 054 unused; 054 is reserved for Messages). Next free: **067**.
- Development happens directly on `main`, pushed as each change passes its gates.

## In flight

- None right now.

## In flight

- [ ] **Claude (Anthropic) as a model provider** (operator, 2026-10-22; lane CLAUDE):
  - [ ] Test says "anthropic-version header required": send `anthropic-version` (and `x-api-key`) automatically when the endpoint is Anthropic's.
  - [ ] Test tool calling reports "tool_choice type tool and any are not supported for this model" as a failure: record it as "forced choice unsupported, Nook uses auto" and confirm tools work with auto.
  - [ ] Knowledge bases: Anthropic has no embeddings API. Mark such providers as chat-only, default new bases to a provider that embeds (e.g. the OpenAI one), and say so clearly; evaluate Voyage AI (Anthropic's recommended embeddings) as an embeddings-only provider.
  - [ ] Anthropic-only instances (operator, 2026-10-22): knowledge bases in **keyword-only mode** (BM25 over the existing chunk FTS, no embeddings API), chosen automatically when no provider embeds; Change embedding model moves a base to vectors later.
  - [ ] Decide with the operator: a **local embedding model** in the image (transformers.js + a small model, ~25–100 MB, CPU) for meaning-based search with no outside provider.

## Waiting on the operator

- [ ] **Report filters, later slices** (slice 1 shipped, D532–D537): linked filters, client-side table sort and contains, saved personal views, more filter types (number range, exclude, text contains, Add filter on dates), and concurrent parameter runs, ranked in [REPORT_FILTERS.md](docs/plan/REPORT_FILTERS.md) "Later". Start a slice when the operator asks.
- [ ] **Real-model eval of report generation** (D488 chart kinds, D489 parameters): only the scripted provider has run. Run `bun --no-env-file scripts/reportEval.ts --clickhouse <test ClickHouse>` on a host whose Nook has a working model provider (it falls back to Settings → AI; the local instance's OpenAI key is a placeholder), or set `REPORT_EVAL_*`, or regenerate reports on the VM (docs/OPERATIONS.md "Report generation eval"). Check: the five kind cases (`onboarding_funnel`, `cohort_retention`, `quota_attainment`, `latency_spread`, `plan_flow`) get fitting chart kinds, and a doc that names a window or a dimension gets a date range or filter. Tune the prompts from the scores.
- [ ] **Report Lists** ([plan](docs/plan/REPORTS_ORG.md) phase 3, optional, migration 067 — 064–066 went to lanes DOCS, EDIT and FILTERS): a report in many lists; a list never grants access. Start only if the operator asks.
- [ ] **Reports: a personal copy of a report?** (lane EDIT research, D531): Metabase, Redash, and Tableau let people without edit rights save a copy and change that; Nook offers Suggest an edit instead. A "Duplicate report" would fork the schedule, sharing, and doc. Build only if the team asks.

## Small fixes

- [ ] Add filter is only proven against the scripted agent and the QA ClickHouse by hand: add a `CLICKHOUSE_TEST_URL` variant of tests/reportFiltersRequest.test.ts that seeds `eval_top_routes` and runs the identity check on a real server (ORDER BY ties, Decimal and Float rows).
- [ ] Several docs (lane DOCS): a doc added in Doc settings stays "New" after a change that attached the same doc is applied (the edit read it, but only Regenerate stamps a doc's hash); decide whether an applied change should stamp it.
- [ ] "Add a new section" after a block outside any section puts the section first among the sections, which render after every loose block (D516), so it can land below later loose blocks; placing it truly in between would need the loose blocks after the anchor to move into a section.
- [ ] Inspect → "From the doc" (D518) needs the plan todo's `docRef` (`d2`); the scripted QA provider never sets it, so only a real model's runs show it. Check after the real-model eval.
- [ ] Button lint on New report (found by lane DOCS, already on main before it): the "From a doc" / "Blank" mode buttons have under 12 px side padding, and at 390 px a Reports row's open button wraps ("title, Owner, Ready, data source").
- [ ] The edit agent re-reads every report doc's newest snapshot on each change (up to 8 docs in its 60 KB share); a change that touches one block could carry only the doc its block came from once D518's mapping is reliable.
- [ ] "Pick from Nook": before the Files index's first backfill after boot, the fallback scan can offer a scanned PDF by name (picking it gives the "no text layer" error).

## Watch (no work unless it shows up)

- Settings → Report owners past 50,000 reports: "You can't open" counts every live report on its first page (166 ms at 200,000); a blocked co-owner of a third of all reports slows the unmanaged list (205 ms at 200,000). Fix then: count the readable set from its parts, or cache the count for a minute (D506).
- PDF worker memory: Bun 1.4.2 ignores Worker `resourceLimits` (D513); bounded by 16 MiB, 300 pages, 15 s, one at a time. Add a heap limit if Bun gains one.
- `tests/restV1.test.ts` parity flake: not reproduced since lane FTS bracketed the REST call with two MCP reads; if it recurs, the failing tool name pins the shared state.

## Standing rules for agent briefs

- **Agents and lanes.** Subagents run on Opus 5.5 at medium effort. One writer works on `main` at a time. Any parallel lane uses its own worktree, with pre-assigned ports and migration ids, and merges back promptly. Releases are serial.
- **Visual QA.**
  - UI changes need screenshots at 1585, 1280, and 390 px, which the director reviews for squished or clipped buttons, overlaps, and wasted width.
  - A shared-style change must keep screens outside its module identical. Check with `scripts/buttonMetrics.ts` (diff plus lint).
- **Processes.** Never stop processes by name or pattern (no pkill/killall); stop only your own pids. Production and QA containers run `bun server/index.ts` as the same host user.
- **Scratch files.** Each agent keeps its scratch files in its own subfolder of the scratchpad (`<scratchpad>/<lane>/`). Never delete or reuse another lane's files.
- **Browser QA.** Use your own `<lane>.localhost:<port>` origin and your own tab or profile, because the session cookie is shared across localhost ports.
- **Tests.**
  - Run with `bun --no-env-file test`.
  - Tests that spawn `bun` use `--no-env-file`.
  - The Docker verify image has no `docs/` and no `git`, so guard with `test.skipIf` / `Bun.which`.
  - Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests, and `cpuTime.ts` for work budgets.
- **TODO.md.** Remove an item in the same commit that ships it.

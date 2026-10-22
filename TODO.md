# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new"), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-16).**
- **v0.42.1** is released (2026-10-16, fixes: Report owners title on Forward, the eval's Settings → AI fallback). **v0.42.0** (2026-10-15): PDFs as report docs and in `read_attachment_text`, `search_report_options`, Report owners paging. v0.41.0 brought PDF text in Files, `search_documents`, console parameters and Settings → Report owners.
- Migrations: **001–063** are released and immutable (045 and 054 unused; 054 is reserved for Messages). Next free: **064** (lane DOCS); **065** is lane EDIT's `report_query_suggestions` (unreleased); **066** (lane FILTERS, if needed), then 067.
- Development happens directly on `main`, pushed as each change passes its gates.

## In flight

- [ ] **Reports: several docs, and docs in Changes** (operator, 2026-10-22; lane DOCS, migration 064):
  - [ ] New report takes **more than one doc**, mixing Nook notes/Files and outside tool-server docs (Outline); generation reads them all; Doc settings, "doc changed" and Regenerate cover every doc.
  - [ ] Changes: the **About** dropdown gains **"Add a new section"** (placed after a chosen block, or at the end), alongside the page and the existing blocks.
  - [ ] Changes: an instruction can carry **Nook note/file or Outline doc links**; the edit agent reads them, and they join the report's docs.

- [ ] **Reports: dynamic filters** (operator, 2026-10-22, "research and build"; lane FILTERS): research beyond D489's AI-added parameters (filters people add themselves, click a chart to filter, filters that narrow each other, table filters), plan done ([REPORT_FILTERS.md](docs/plan/REPORT_FILTERS.md): slice 1 = only re-run touched queries, "filters N of M blocks", owner **Add filter** with a default-unchanged check, click a chart to filter, more date presets); build after lane DOCS lands.

## Waiting on the operator

- [ ] **Real-model eval of report generation** (D488 chart kinds, D489 parameters): only the scripted provider has run. Run `bun --no-env-file scripts/reportEval.ts --clickhouse <test ClickHouse>` on a host whose Nook has a working model provider (it falls back to Settings → AI; the local instance's OpenAI key is a placeholder), or set `REPORT_EVAL_*`, or regenerate reports on the VM (docs/OPERATIONS.md "Report generation eval"). Check: the five kind cases (`onboarding_funnel`, `cohort_retention`, `quota_attainment`, `latency_spread`, `plan_flow`) get fitting chart kinds, and a doc that names a window or a dimension gets a date range or filter. Tune the prompts from the scores.
- [ ] **Report Lists** ([plan](docs/plan/REPORTS_ORG.md) phase 3, optional, migration 067 — 064–066 went to lanes DOCS, EDIT and FILTERS): a report in many lists; a list never grants access. Start only if the operator asks.
- [ ] **Reports: a personal copy of a report?** (lane EDIT research, D531): Metabase, Redash, and Tableau let people without edit rights save a copy and change that; Nook offers Suggest an edit instead. A "Duplicate report" would fork the schedule, sharing, and doc. Build only if the team asks.

## Small fixes

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

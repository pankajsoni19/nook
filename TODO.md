# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site ("What's new"), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-22).**
- **v0.43.0** is released (2026-10-22): several docs per report, Add a new section and doc links in Changes, delete from the header, edit and suggest SQL, dynamic filters (slice 1).
- Migrations: **001–066** are released and immutable (045 and 054 unused; 054 is reserved for Messages). Next free: **067** (lane CLAUDE needed none), **068** LISTS (built), **069** FILT2, **070** SMALL, **071** LOCALEMB.
- Development happens directly on `main`, pushed as each change passes its gates.

## In flight

- [ ] **Report filters, later slices** (lane FILT2, migration 069) (slice 1 shipped, D532–D537): linked filters, client-side table sort and contains, saved personal views, more filter types (number range, exclude, text contains, Add filter on dates), and concurrent parameter runs, ranked in [REPORT_FILTERS.md](docs/plan/REPORT_FILTERS.md) "Later". Started 2026-10-22.
- [ ] **Local embedding model** (operator: "complete todo.md", 2026-10-22; lane LOCALEMB; lane CLAUDE landed: add it as another provider kind beside `compat.embeddings`, keyword-only bases (D541) move to it with Change embedding model, migration 071 if needed) (transformers.js + a small model, CPU) for meaning-based search with no outside provider.

- [ ] **API keys, after lane KEYS (D585–D589)** (general keys' Edit now adds rows with the password, and no row has a dead dropdown):
  - [ ] Vault keys' Edit (`/settings/keys/vault`, `VaultGrantBuilder` `ceiling`) is still narrowing only, with the same pattern: the Vault dropdown is always disabled and Permission collapses to the held level plus Read. Decide whether vault keys may add access on Edit with re-authentication (vault grants have their own checks, `validateVaultGrants`, and protected environments), then apply D585/D587 there.
  - [ ] Button lint on the Edit key dialog (already on main before lane KEYS, unchanged by it): at 1280 the three-column row ellipsizes long Select values ("Chosen folders and notes", "Read agents, chats, and knowledge"), and "Save" is under 64 px wide.
  - [ ] A security mail when a key gains access through Edit (today only creating and rotating send `mailApiKeyCreated`); `keys.update` is in the audit log and Access activity.

- [ ] **Chat agents can use report data sources (ClickHouse)** (operator, 2026-10-22; lane AGENTSQL): today chat agents can't reach ClickHouse. Give agents guarded schema search, describe, and SELECT tools over data sources an admin allows for agents, with results shown in chat; the reports guard, allowlist and limits apply; no ad-hoc SQL over MCP keys (T361 stands).

- [ ] **Provider code per kind** (operator, 2026-10-22; lane LOCALEMB, step 0): one adapter file per provider kind (OpenAI-compatible default, Anthropic, Voyage, local); golden tests pin OpenAI's requests to v0.43.0 so other kinds can't change them.

## Waiting on the operator

- [ ] **Real-model eval of report generation** (D488 chart kinds, D489 parameters): only the scripted provider has run. Run `bun --no-env-file scripts/reportEval.ts --clickhouse <test ClickHouse>` on a host whose Nook has a working model provider (it falls back to Settings → AI; the local instance's OpenAI key is a placeholder), or set `REPORT_EVAL_*`, or regenerate reports on the VM (docs/OPERATIONS.md "Report generation eval"). Check: the five kind cases (`onboarding_funnel`, `cohort_retention`, `quota_attainment`, `latency_spread`, `plan_flow`) get fitting chart kinds, and a doc that names a window or a dimension gets a date range or filter. Tune the prompts from the scores.

## Small fixes (lane SMALL)

- [ ] Inspect → "From the doc" (D518) needs the plan todo's `docRef` (`d2`); the scripted QA provider never sets it, so only a real model's runs show it. Check after the real-model eval.
- [ ] Report lists (lane LISTS leftover, D550–D559): the docs site describes report organization only in release notes, so lists go into "What's new" at the 0.44.0 release (operator, at the release).

## Leftovers (lane CLAUDE)

- [ ] Claude, checked only against a fake (lane CLAUDE, D539): on the VM, confirm Anthropic accepts `x-api-key` and `Authorization: Bearer` together on `/v1/chat/completions` and `/v1/models`, and Test tool calling reads "Tool calling works (auto)"; keys not scoped to a workspace also need `anthropic-workspace-id`, which Nook cannot send yet.
- [ ] Agents on Claude 4.7+: a `temperature` below 1 is a 400 there; the agent editor could say so (or leave temperature out) when the agent's provider is Anthropic.
- [ ] Voyage AI behind a proxy: `compat.flavor: "voyage"` and `dimensionsParam` are API-only (the editor offers only Anthropic's headers); and a provider's embedding model and size have no field in the editor (API `embeddingModel`, `embeddingDims`).
- [ ] Button lint (found by lane CLAUDE, not new): at 390 px a Knowledge list row with a long status ("1 source · 0 chunks · 1 source has an error") wraps; at 1280 px a provider card's `max_completion_tokens` breaks mid-word (`overflow-wrap: anywhere` in a 160 px column).

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

# Nook implementation tracker

Only open work lives here. Remove an item once it is done. Shipped work is in [CHANGELOG.md](CHANGELOG.md), the docs site's [release notes](https://pankajsoni19.github.io/nook/releases.html), and `git log`.

- Plans of record: `DEVELOPMENT_PLAN.md`, `docs/plan/research/`, [reports plan](docs/plan/WAVES_45-48_REPORTS.md), [report theme](docs/plan/REPORT_THEME.md).
- Contracts: [API](docs/plan/API_CONTRACTS.md) · [Threat model](docs/plan/THREAT_MODEL.md) · [Test plan](docs/plan/TEST_PLAN.md).

**Current state (2026-10-23).**
- **v0.45.0** is released (2026-10-23): online S3 backups, Litestream and restore drills; Tasks collapse, filter order and archive; vault key Edit adds access; docs site restructure.
- Migrations: **001–076** are released and immutable (045, 054, 067, 070, 071, 072, 075 unused; 054 reserved for Messages). Next free: **077**.
- Development happens directly on `main`, pushed as each change passes its gates.

## In flight

- [ ] **API keys, after lane KEYS (D585–D601)** (general keys' Edit adds rows with the password and a security notice, and no row has a dead dropdown):
  - [ ] Vault keys' Edit (`/settings/keys/vault`, `VaultGrantBuilder` `ceiling`) is still narrowing only, with the same pattern: the Vault dropdown is always disabled and Permission collapses to the held level plus Read. Decide whether vault keys may add access on Edit with re-authentication (vault grants have their own checks, `validateVaultGrants`, and protected environments), then apply D585/D587 there.


- [ ] **Provider code per kind** (operator, 2026-10-22; lane LOCALEMB, step 0): one adapter file per provider kind (OpenAI-compatible default, Anthropic, Voyage, local); golden tests pin OpenAI's requests to v0.43.0 so other kinds can't change them.


## Waiting on the operator

- [ ] **Real-model check of chat agents on data sources** (lane AGENTSQL, D592): only the scripted provider has called the data tools. On a host with a working model, give an agent a data source (Settings → Report data sources → Chat agents may use this data source) and check that it searches before it queries, aggregates in SQL rather than paging raw rows, and summarizes instead of repeating the table.

- [ ] **Real-model eval of report generation** (D488 chart kinds, D489 parameters): only the scripted provider has run. Run `bun --no-env-file scripts/reportEval.ts --clickhouse <test ClickHouse>` on a host whose Nook has a working model provider (it falls back to Settings → AI; the local instance's OpenAI key is a placeholder), or set `REPORT_EVAL_*`, or regenerate reports on the VM (docs/OPERATIONS.md "Report generation eval"). Check: the five kind cases (`onboarding_funnel`, `cohort_retention`, `quota_attainment`, `latency_spread`, `plan_flow`) get fitting chart kinds, and a doc that names a window or a dimension gets a date range or filter. Tune the prompts from the scores.

## Small fixes (lane SMALL)

- [ ] Inspect → "From the doc" (D518) needs the plan todo's `docRef` (`d2`); the scripted QA provider never sets it, so only a real model's runs show it. Check after the real-model eval.

## Leftovers (lane CLAUDE)

- [ ] Claude, checked only against a fake (lane CLAUDE, D539): on the VM, confirm Anthropic accepts `x-api-key` and `Authorization: Bearer` together on `/v1/chat/completions` and `/v1/models`, and Test tool calling reads "Tool calling works (auto)"; keys not scoped to a workspace also need `anthropic-workspace-id`, which Nook cannot send yet.
- [ ] Voyage AI behind a proxy: `compat.flavor: "voyage"` and `dimensionsParam` are API-only (the editor offers only Anthropic's headers). (A provider's embedding model and size now have fields, lane LOCALEMB D547.)

## Leftovers (lane FILT2)

- [ ] Remove filter (`DELETE …/filters/:paramId`, D534) still takes only multi-selects: a text-contains, date-range, or number-range filter is removed by asking in Changes. A removal of a date range cannot be identity-checked (its default narrowed the results), so it would need the same "review by hand" path as D570.
- [ ] Add filter does not offer a number range (D567); generation and the edit agent write them. Offer it on numeric columns (Float, Decimal, and wide integers), with the identity check at Any.
- [ ] Add filter on a DateTime column filters by `toDate(col)` in the data source's zone, while the presets resolve in the report's zone (D570); write `toDate(col, '<report zone>')` when the two differ.
- [ ] Narrow by (D562) recognizes a parent only when its options query lists one plain column of one table (Add filter's shape, or `SELECT DISTINCT col FROM db.t`); an agent-written options query with an expression is not offered.
- [ ] Save as report default (D566) is a manual edit, so the design rules run on every block that reads a changed default and can refuse it (e.g. a KPI without a unit); the sheet shows the refusal, but the owner has to fix the block first.
- [ ] The new filter types (D567–D569) and linked lists (D560) are proven against the fake ClickHouse and by hand on the QA ClickHouse 26.6; add a `CLICKHOUSE_TEST_URL` variant (`-inf`/`inf` Float64 ends, the `_not` flag, `positionCaseInsensitive` on LowCardinality).
- [ ] Saved views are app-only (D565). A read-only MCP `list_report_views` would be safe (the key owner's own views) if an agent needs them.

## Leftovers (lane TASKS)

- [ ] Auto-archived cards still count toward the 1,000-card board cap (D605), so a long-lived board fills up with them; decide whether archived cards leave the cap (and the board payload with "Show auto-archived cards" on stays bounded some other way) or get purged after a further period.
- [ ] "Show all levels on the board" is still per device (localStorage), while collapsed columns and "Show auto-archived cards" are per person on the server (`board_view_prefs`); move it there for one model.

## Leftovers (lane LOCALEMB)

- [ ] Local embeddings (D544–D546) are checked against the real model only by the opt-in `LOCAL_EMBEDDINGS_MODEL_TEST=1 bun --no-env-file test tests/localEmbeddingsModel.test.ts` (and once in the image, by hand); the Docker verify stage has no model files. Run it on the VM after the 0.44.0 image lands, and index a real base there to see the CPU per passage on its cores.
- [ ] The local model holds about 0.8 GB while loaded (the WASM heap about 0.55 GB, the tokenizer's 250,000-piece vocabulary about 0.22 GB in @huggingface/tokenizers' JS objects); it is let go after 10 idle minutes. A smaller tokenizer representation, or an English-only model (all-MiniLM-L6-v2, 23 MB, about twice as fast) as a second choice, would cut it; ONNX Runtime Web's own threads gave nothing on Bun 1.4.2, so it stays on one core.


## Leftovers (lane BACKUP)

- [ ] Litestream and the S3 archive path are proven against the fake S3 only (tests/litestream.test.ts runs the real 0.5.17 binary when `LITESTREAM_TEST_BIN` is set). On the VM after the 0.45.0 image: set `BACKUP_TARGET`, `LITESTREAM_ENABLED=true`, check Settings → Backups reads "Replicating" with no sync errors, and run `restore-drill` and `restore-drill --from litestream` against the real bucket (R2/AWS: path-style, region `auto`, multipart, and `BACKUP_S3_SSE=required`).
- [ ] With S3 storage an archive does not copy the bucket's objects (D612). If the operator wants self-contained archives, add `BACKUP_S3_OBJECTS=copy` (stream each object into the tar; size and time grow with the bucket).
- [ ] The manifest lists every file and is built in memory (about 150 bytes a file: 150 MB at a million local files). Stream it to a side file if an instance gets there.
- [ ] Restore into a fresh container finds `--from latest` in S3 only (its `/data/backup` is the empty folder being restored); a local archive needs a mount or `tar -xzf` (documented). A `--from-dir` option would make the local case one command.
- [ ] Litestream's compaction levels and L0 retention are its defaults (only the snapshot retention is a setting); expose them if point-in-time granularity matters.

## Watch (no work unless it shows up)

- Chat and agent-editor buttons the lint flags (a reply's Edit / Copy / Regenerate, the chat row, the Agents / Audit log / Settings links, the "Used N tools" toggle, the agent chip, Back and More at 390; the agent editor's emoji trigger, Save width, and Agents back link): **intentional existing design** (operator, 2026-10-22: screens built earlier stay exactly as they are). Not to be changed; add them to scripts/buttonLint.allow.json if the lint's screens ever open a chat.

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
  - The Docker verify image has no `docs/` and no `git`, so guard with `test.skipIf` / `Bun.which`. It does copy `scripts/` and `evals/`; a test that imports another repo folder needs that folder added to the Dockerfile's `verify` stage.
  - Run `docker build --target verify -t nook-verify-<lane> .` before a release (it must pass; remove the image after).
  - Use `tests/support/agentRuns.ts` and `clock.ts` for timing-sensitive tests, and `cpuTime.ts` for work budgets.
- **TODO.md.** Remove an item in the same commit that ships it.
- **Docs site (`site/`, GitHub Pages).** `index.html` is features first: a new app or module gets a section under "Using Nook" and a nav entry (`tests/docsSite.test.ts` checks every module); operator setup goes under Self-hosting or Operations.
- **Release notes on a release.** With the version bump: `CHANGELOG.md` gets the full entry and README's "What's new" its three bullets. On the docs site, add a `<section id="whats-new-X-Y-Z">` at the top of `site/releases.html` (and its link at the top of that page's "Release notes" nav), replace the `#whats-new` box on `site/index.html` with the same short notes (keep its "All release notes" link and id), and bump the `v…` badges, the footers, the "What's new in v…" nav entry, and the hero's "New in" pill. Upgrade steps go in `docs/OPERATIONS.md` and the Upgrading section. `bun --no-env-file test tests/docsSite.test.ts` checks that the two pages agree with `package.json`.

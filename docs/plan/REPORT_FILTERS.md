# Report filters (dynamic filters): plan

Lane FILTERS, 2026-10-22. Builds on D489–D491 and D507 (spec v3 parameters). Operator: "in the report, how can we add dynamic filters. research and build". Status: **slice 1 built** (lane FILTERS, 2026-10-22, migration 066). The plan's decisions are recorded as **DF1 = D532, DF2 = D533, DF3 = D534, DF4 = D535, DF5 = D536, DF6 = D537** (docs/plan/WAVES_45-48_REPORTS.md, "Lane FILTERS") and its threats as **TF1–TF6 = T408–T413** (docs/plan/THREAT_MODEL.md). Later slices stay as ranked below; lane FILT2 builds them in order (D560–D574, migration 069, threats from T414), each marked **Shipped** as it lands.

## What other tools do

| Tool | How a filter reaches a query | Click a chart to filter | Linked filters |
| --- | --- | --- | --- |
| Metabase | Wired per card; SQL cards only through a "field filter" variable | "Click behavior" sets a dashboard filter | Yes, for column-wired filters |
| Superset | Native filters with a scope; cross-filters | On by default | Yes |
| Looker Studio | Controls on a dimension apply to every chart on that source | A chart becomes a control | Through shared dimensions |
| Power BI | Page/report filters on the model | On; filter, highlight or none per visual pair | Through relationships |
| Tableau | Filter actions with source and target sheets | Yes, per action | "Only relevant values" |
| Grafana (ClickHouse) | Template variables; ad hoc filters via `additional_table_filters` | Data links only | Variables reading variables |
| Redash | Query parameters mapped to dashboard parameters | No | No |

Takeaways: (a) tools that filter raw SQL need the query to expose a slot (Nook's typed `{name:Type}` already is one); (b) click-to-filter is always "a click sets a filter value"; (c) authors and readers need to see which blocks a filter reaches.

## What "dynamic filters" means for Nook

1. The owner adds a filter without writing a prompt: pick a column, Nook proposes the wiring, the owner reviews it in Changes.
2. Click a bar, slice or table row to set an existing filter.
3. Readers see what each filter reaches.
4. Later: linked filters, table sort/contains, saved personal views, more filter types.

Parameters stay the only mechanism: every filter is a spec v3 parameter bound as `{name:Type}`. Nothing a reader picks or clicks is ever SQL text.

## Findings that shape the plan

- **Every filter change re-runs every query** today (`runParamSet`/`setResults` key results on the whole set's hash). Fixed first (F1).
- **ClickHouse `additional_table_filters` is unusable** (probed on 26.6.8): it refuses bound parameters (`UNKNOWN_QUERY_PARAMETER`), applies to every read of the table (totals filtered too), takes free SQL outside the guard's lexer, and `readonly=2` doesn't stop it.

## Slice 1 (one release)

### F1. Only re-run what a filter touches (DF1 = D532, server only)
- Key each query's result by the bound values of the placeholders that query reads (`queryHashOf(query, bound)`).
- A query whose read values equal the defaults is served from `report_results`; a query that reads no parameter never runs for a non-default set.
- Storage: `report_param_results` with the per-query hash (migration 066 adds `query_hash` only if 063's cascade makes reuse awkward). `set.missing` lists only queries whose own key is missing.

### F2. Which blocks a filter reaches (DF2 = D533)
- Derive `reach: { paramId: queryKey[] }` from the placeholder scan; send it in the results view and MCP `get_report`.
- When a parameter differs from its default, a block whose queries don't read it shows a muted "Not filtered by Country" line (REPORT_THEME secondary text). Pill menus and the phone sheet say "Filters 4 of 6 blocks".

### F3. Add filter (owner; DF3 = D534, DF4 = D535)
- Entry: report ⋯ menu → **Add filter**, and **+ Filter** at the end of the control bar (owner). A sheet (bottom sheet on phones) with its own history layer key.
- Column picker: columns of the tables the report's queries read (`classify(sql).tables`, allowlisted), from the schema catalog; v1 offers String, LowCardinality(String), Enum and integer types, each with its table and "read by 3 of 5 queries".
- v1 type: **multi-select, default `[]` = All**, so default results must not change (the safety check below). Dates and single selects stay with Changes.
- Options query built from catalog identifiers only: `SELECT toString(<col>) AS value FROM <db>.<table> GROUP BY value ORDER BY count() DESC LIMIT 200`, guarded, run first, must return ≥ 1 row; D491 search past 200. The sheet shows sample values and "Readers will see the values of <table>.<col>".
- Wiring: an edit instruction with a structured request `{ kind: "add_filter", id, label, table, column, chType, optionsQuery }` in `report_instructions.request_json` (migration 066). The edit agent must `add_parameter` exactly as requested, `update_query` only queries reading `table` with `(empty({id:Array(T)}) OR <col> IN {id:Array(T)})` at the innermost read, change nothing else, and list untouched queries with reasons.
- **Deterministic checks before the proposal shows (DF4):** the parameter equals the request; every changed query reads `table` and contains the placeholder; **every changed query's default result is identical to its stored result** (columns + sha256 of rows); each still runs with one other value. Any failure refuses the proposal with the reason.
- Review in the existing Changes proposal: per-query SQL diff, "Filters 4 of 6 blocks", untouched queries with reasons. Applying makes a version; never auto-applied.
- Remove filter: same path (`kind: "remove_filter"`), identity checked against the All result.
- Queries that can't take a filter stay unfiltered, listed in the proposal and marked by F2.

### F4. Click to filter (DF5 = D536)
- `ChartBlock`/`TableBlock` gain optional `clickFilter: { param, column }`: `column` is the chart's x or series (or a table column); `param` a select/multi-select of a fitting type; the block's own query must not read `param`.
- Set by the edit agent when it adds a parameter over a shown dimension, or by the owner from the block menu ("Clicking filters by…").
- Multi-select click toggles, select click replaces; the URL **pushes**, so Back undoes a click. The source chart highlights the clicked category (amber, others grey) and does not filter itself.
- Phone: a tap shows the tooltip with a **Filter by …** button; a tap alone never filters. Keyboard: focusable table rows (Enter), and "Filter by…" in the chart's block menu.
- Clicked values are checked against the options (or the D491 wrap) like picked ones.

### F5. More relative dates (DF6 = D537)
- Presets `yesterday`, `this_week`, `last_week` (ISO Mon–Sun), `last_month`, `last_quarter`, `ytd`, `12m`, in the report's zone; labels like "Last month (IST)". Additive; stored specs stay valid.

**Migration 066:** `report_instructions.request_json TEXT CHECK (request_json IS NULL OR (json_valid(request_json) AND length(request_json) <= 4096))`, plus `report_param_results.query_hash` only if F1 needs it.

## Later (ranked)

1. **Linked filters:** an options query may read earlier parameters (array order, no cycles); options cached per (param, parents' values hash), ≤ 50 lists a report; child values not in the new options drop with a note. **Shipped** (lane FILT2, D560–D562, migration 069; Add filter's "Narrow by" builds one).
2. **Table sort and contains, client side:** over loaded rows, state in the URL (`?t.<block>=col.desc`, replace), "within the first N rows" when truncated; personal. **Shipped** (lane FILT2, D563, D564).
3. **Saved views:** per-viewer named value sets and "my default view" (`report_param_views`); only the owner's "Save as report default" changes the spec.
4. **More types:** `number_range`, multi-select exclude, text contains, Add filter on Date/DateTime as a date_range (reviewed by hand, no identity check).
5. **Concurrent parameter runs** under the caller's query slots, measured after F1.

## What not to do

- No `additional_table_filters` (see findings).
- No deterministic WHERE injection: the guard is a lexer, and CTEs, joins and subqueries make a rewrite unsound. The agent writes the predicate; a deterministic check verifies it.
- No wrap-and-filter on output columns as a general mechanism (wrong for aggregates not grouped by that column and after top-N LIMIT); only for client-side table filtering.
- No per-block filter controls (scope = which queries read the parameter, made visible by F2).
- No reader-added filters saved to the report, free-form expression filters, or `Identifier` parameters.

## Who may do what

| | Owner | Comment | View |
| --- | --- | --- | --- |
| Use filters, click to filter, table sort/contains | yes | yes | yes |
| Personal saved views (later) | yes | yes | yes |
| Add/remove/edit a filter, set click-to-filter, change defaults | yes (a version) | suggest in a comment | no |

## Server changes (slice 1)

- `params.ts`: per-query keying and default reuse; `reach` in `ParamResultsView`; `assertOptionValues` for click values.
- `shared/reportParams.ts`: new presets; `readsOf(sql)` shared with the client.
- `shared/reports.ts`, `specValidate.ts`: `clickFilter`, the own-query check, type compatibility.
- New `filterRequest.ts`: options query from the catalog; `POST /api/reports/:id/filters` (owner) validates column/type, runs the options query, queues the instruction; `DELETE /api/reports/:id/filters/:param` queues removal.
- `edit.ts`: the structured-request prompt section and the DF4 checks before a proposal is stored.
- `patch.ts`: a `set_click_filter` op.
- MCP: `get_report` returns `reach` and `clickFilter`; `add_report_filter` (`reports:write`, owner), returning the instruction. Remove filter stays in the app (D180): no MCP tool, and `apply_report_proposal` refuses a removal proposal.

## UI changes (slice 1)

- `ReportParamsBar.tsx`: "+ Filter" (owner), "Filters N of M blocks", new presets.
- New `AddFilterSheet.tsx`: table/column search, sample values, exposure note, Create (opens Changes on the queued instruction).
- `charts.tsx`, `chartOption.ts`, `ResultTable.tsx`: click handlers, emphasis, the touch tooltip button, focusable rows.
- `ReportView.tsx`: "Not filtered by X".
- `ChangesPanel`/`ProposalSheet`: untouched queries; "Default results unchanged ✓".
- Visual QA at 1585/1280/390 and Back/Forward parity (after a click filter; the Add filter sheet reopened by Forward).

## Threats

- **TF1 (T408)** The agent changes a query's meaning, not just its filter: DF4 identity check, SQL diff, owner acceptance, versions.
- **TF2 (T409)** Readers now see a column's values: the owner picks the column and the sheet states the exposure; columns over 100k distinct values are refused; catalog columns named or commented like email, phone, token or secret are hidden from the picker by default.
- **TF3 (T410)** Forged click values: bound, never SQL, checked against options (D489).
- **TF4 (T411)** Cost from click storms: F1 reuse, 20 runs/min per person, 300 ms click debounce, 20 sets kept.
- **TF5 (T412)** Structured-request injection: catalog identifiers validated against the allowlist and read tables; the label (≤ 60 chars) is data in the prompt.
- **TF6 (T413)** Shared per-set cache across readers is safe only while reports have no row-level security; key per reader if that ever changes.

## Tests

- Unit: `queryHashOf`; presets × zones (week starts, quarter edges); `clickFilter` validation; options-query builder; DF4 refusals.
- Server: one filter re-runs only the queries that read it (count ClickHouse calls); `POST /filters` by a commenter refused; out-of-options click value → 400; MCP owner-only.
- Scripted edit eval: "add filter on requests.route" on `eval_top_routes`.
- UI/e2e: Add filter at 1280 and 390; click filter then Back restores values; "Not filtered by" only when non-default; touch button filters, plain tap doesn't.

## Decisions taken by the director (2026-10-22, operator may override)

1. Add filter always goes through a Changes proposal (never auto-applied), like every other agent edit.
2. The clicked chart highlights rather than filtering itself.
3. v1 Add filter is multi-select on text and integer columns; dates stay with Changes until a later slice.
4. Saved personal views stay in a later slice.

Sources: Metabase dashboard and linked filters docs; Preset on Superset cross-filtering; the Superset handbook; Grafana ClickHouse template variables; ClickHouse Grafana plugin 2.0; Looker Studio chart cross-filtering; Power BI filters and highlighting; Redash query parameters.

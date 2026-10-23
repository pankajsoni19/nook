# Tasks views that work like boards (lane VIEWS)

Operator, 2026-10-23: "boards have capability to collapse columns. but views in tasks dont have that … views only have 3 columns … drag and drop dont work here … what i wanted was views to be same as boards in the functionality they offer … if view has only 1 board in it we can offer similar capability as the board, as it's essentially a board with filters. if needed we can place this sort of view inside board."

Decisions start at **D635** (D628–D634 are lanes CAP and COLICON's). Threats start at **T442**. Migration **077**.

## Why views fell short

- A view's board layout is `StateLanes` (`src/tasks/home/QueryResults.tsx`) over `stateLanes()` (`homeResults.ts`): always the three normalized states, To do, In progress, Done.
- Drag was deferred by D143 / Q9 ("Move to…" only); collapse was never wired; results are paged (50–100) and sorted by due or updated, not by board position.
- The board page already takes the same filter grammar in `?q=` (`boardUrl.ts`, `filterBoardCards` / `matchesQuery` in `shared/taskQuery.ts`), with collapse, drag, WIP limits, the composer, the card dialog, sprints, levels, and archive. A view over one board is "the board plus `?q=`".

## Slice 1 (this lane)

### 1. A single-board view is the real board

- **D635 — Board views.** A view whose canonical filter has exactly one positive `board:` term with one value (`scopedBoardId`) is a *board view*. `toView()` returns `board_id` (null otherwise, and null when the viewer cannot read that board, so they keep the cross-board page with its empty result). The board view renders the board engine (`BoardView`: board, table, list, calendar) with the view's terms minus that `board:` term (the in-memory matcher has no `card.board_id` to match). Everything the board offers works there: collapse, drag, WIP, the composer, the card dialog, sprints, levels, archive.
- **D636 — Board view URLs.** `/tasks/:b/views/:v` is the saved view on its board; a `?q=` (present, even empty) is an unsaved change to its filter; the board's own `view`, `group`, `sort`, `cal`, `month`, and `sprint` keys work as on the board. Its card is `/tasks/:b/views/:v/card/:k` (and `/full`), the Sprints sheet `/tasks/:b/views/:v/sprints`. Opening `/tasks/views/:v` for a board view replaces the entry with the board view (keeping an unsaved single-board `?q=` minus the board term, and the saved layout); a board view whose saved filter is no longer on that board (edited elsewhere to more boards) replaces back to `/tasks/views/:v`. A deep link's in-app Back from a board view goes to the views list. These are called **saved views** on the board, because the board's own `?view=` means the layout.
- **D637 — Sprints and new cards in a board view.** The sprint switcher defaults to **All** (`sprint=all`) in a board view, so the view's filter, including any `sprint:` term it has, decides what shows and the sprint-conflict note never fires for the view's own term; picking a sprint is explicit in the URL. **New card** is prefilled from the view's single-value positive terms (`column:`, `state:` → the first column of that state, `assignee:` (me, or a person already on the board), `tag:`, `flag:`, `sprint:`); a prefilled draft is not "dirty" until something changes. If the new card does not match the view, it is added and the toast says "Added — hidden by this view's filters".
- **D638 — The saved-view picker.** The board header has **View: All cards ▾**, listing All cards and the views pinned to this board that the viewer can read (theirs, shared with them, shared with everyone). The filter bar gets **Save view…** (a new private view: `board:<b>` plus the filter, the layout mapped to list/table/board, calendar keeps board) and, on an owned, editable, changed view, **Save** (PATCH with the revision; 409 `VIEW_CHANGED` offers a reload) and **Discard**. Rename, Share, Duplicate, and Delete are in the picker's **View options** (the same rules and dialogs as the view page, D140). Choosing a view pushes an entry.
- **D639 — Collapse in a board view** uses the board's own `board_view_prefs` (operator default: shared between the board and its views), so a column collapsed on the board is collapsed in every view of it.

### 2. Multi-board views: Columns lanes (default) and State lanes, both with drag

- **D640 — Columns lanes.** Lanes are the union of the columns of the boards that have matches, keyed by (folded name, state) (`shared/taskLanes.ts`, the same fold as text matching). One name in two states is two lanes, labelled "Review · Done" and "Review · In progress". Order: state (To do, In progress, Done), then the median of each column's relative position on its board (index ÷ (columns − 1)), then the name. Over **20** lanes the results fall back to State lanes with a notice ("Too many different columns to show side by side; showing state lanes"). The choice is saved with the view (`display.lanes: "columns" | "state"`, default columns) and is a URL key (`lanes=state`).
- **D641 — Drag between lanes.** A card dropped on a lane moves to **its own board's** column of that lane (to the top; `afterCardId: null`). The drop is refused, with the lane dimmed and the reason shown, when the card's board has no such column ("<Board> has no Review column"), when that column is at its WIP limit, or when the viewer cannot edit the card's board (those cards are not draggable at all). There is no reordering inside a lane (the cards come from many boards and the query's sort). `Alt` + ← / → moves a focused card to the previous or next lane that can take it. The move is optimistic and rolls back with a toast on any refusal from the server, which stays authoritative (edit level, 409 `COLUMN_FULL`, the done and archive clocks).
- **D642 — State lanes.** To do, In progress, Done; a drop goes to the first column of that state on the card's board (refused when it has none).
- **D643 — API.** `POST /api/tasks/query` and `GET /views/:v/cards` take `lanes: "columns" | "state"`. With it, the first page also returns `lanes` (the mode used: `state` after a fallback), `lanesFallback?`, `columns` (each lane's key, label, state, and its board columns with `wip_limit` and live `card_count`), and `laneCounts` (true counts per lane over the whole match, not the loaded page); and `limit` may go to 200. The board layout pages 200 at a time with **Load more**. My work uses the same lanes.

### 3. Collapse everywhere

- **D644 — `task_view_prefs`** (migration 077): `(user_id, view_key, collapsed_lanes JSON ≤ 1024 bytes, updated_at)`, `view_key` the view's id or `my` (My work). `GET` / `PUT /api/tasks/views/:v/prefs { collapsedLanes }` (a reader of the view; `my` for anyone), not audited. `PUT` keeps only well-formed lane keys (`s:<state>` or `c:<state>:<folded name>`), at most 40, deduplicated, trimmed to fit 1 KiB; for a saved view it also drops keys that are not lanes of the view's current results. Rows go with the view (deleted with it) and with the person. A collapsed lane is the board's 44 px strip and is still a drop target (to the top). An unsaved new view keeps collapse in memory.

### 4. MCP

- **D645.** `list_views` adds `board_id` (D635) and `lanes`. `move_card` takes exactly one of `columnId`, `state` (the first column of that state on the card's board), or `columnName` (the first column with that name, case- and accent-folded, on the card's board), so an agent can move a card the way a lane drop does without looking up column ids; a board without one is `INVALID` with reason `NO_SUCH_COLUMN`.

### 5. Phones (390 px)

- **D646.** A board view is the board's one-column pager with tabs. Multi-board lanes use the same pager and tabs (a collapsed lane keeps its page and says its cards are hidden). Drag is off on phones, as on boards; **Move to…** on a card lists the merged lanes (or states) and moves it like a drop, with the same refusals; "Other column on this board…" keeps the board's own sheet. Back and Forward step through the same entries as the desktop.

## Slice 2 (recorded in TODO.md, not built)

Group lanes by assignee, tag, or sprint with drag (reassigning); board swimlanes; Add card in multi-board lanes (choose the board); a per-view collapse override of the board's; MCP `save_view`; team views a board owner pins for everyone.

## Tests

Board-view detection and the board-term drop (`tasksViews`), lane merge, order, and refusal (`taskLanes`), `laneCounts` and `columns` over the whole match, migration 077, prefs trimming, the drop permission and WIP matrix, `taskQueryParity` for board views, MCP `list_views` and `move_card` by state and name, the router and Back parity for the new URLs, and the client lanes (drag refusal, collapse, phone pager).

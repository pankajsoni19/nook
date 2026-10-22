# Research: task hierarchy, sprints, team workflows, and cross-board views

Date: 2026-09-26. Status: **research, UX plan, and build proposal**. Nothing is scheduled until the director assigns wave numbers. Base: `main` at `3d57480` (v0.7.0, migrations 1–14).

Operator requests (verbatim):

> "in card research how we can have a hierarchy, so if someone wanted to use it as sprint > task can use it. or sprint > task > subtask can also do it. research different workflows that majority of team uses, how we can support them, plan for its ux, and then build."

> "currently we have board, there is no visibility across boards, in /tasks itself add linear style filter, so users can filter tasks out and create a view for them, view can be both private and shared"

Plus a coordinator brief: make hierarchy, sprints, views, and the Wave 13 card work feel like **one** Tasks experience, and reuse idioms the app already has.

**Relationship to other plans.**

- **Wave 13** ([WAVE_13_TASK_CARD_UX.md](../WAVE_13_TASK_CARD_UX.md)) is the base. It covers migration 015 (due time, `card_assignees`, `card_relations`, WIP), 016 (Modules), shared dropdowns (D91), the composer, and the `/full` page. `TODO.md` → "Wave 13" also lists tags, flags, the card face, board views (column, table, grouped), and a Linear-style filter bar. At the time of writing, those items are **not yet in the Wave 13 plan file**. §8 says what hierarchy needs from them, so whoever plans them can build them once.
- **Team** ([2026-09-26-team-module.md](2026-09-26-team-module.md)) takes 017 and 018, and later adds viewer and guest roles. Views and sprints must respect its write gate (T87 there). Nothing here adds a new role concept.
- **Migrations here:** **`019_task_hierarchy`** (parent, level, board structure, sprints) and **`020_task_views`** (column state, saved views). They are separate so each ships in its own sub-wave (§12).
- **Numbering:** Wave 13 uses D80–D93 and T77–T87. Team uses D71–D92 and T77–T88, so the two already collide. To stay clear, this doc uses **D120–D139** and **T110–T124**. The director renumbers at merge.

---

## 1. Current state (what the code does today)

- **Flat cards.** `cards` (`server/migrations/009_task_boards.ts:37-46`) has `board_id`, `column_id`, `position`, `title`, `description`, `revision`, and the Bin columns. 011 adds `due_on`, `assignee_id`, and `board_columns.is_done` (`011_task_dates.ts:82-90`). No card has a parent, a type, or a sprint.
- **Limits** are `LIMITS` (`server/tasks/service.ts:25`): 50 boards per owner, 20 columns, 1000 live cards per board. New boards get `To do / Doing / Done` (`service.ts:26`, `:141-143`), with Done as the done column.
- **Board payload.** `getBoard` returns every live card in one list (`service.ts:111-118`). Each card row runs two count subqueries (`cardSelect`, `service.ts:98-107`). The client groups cards by column.
- **Authorization.** Readers edit, move, and bin cards. Only the owner manages columns and sharing (D38, `service.ts:7-15`). `readableBoardPredicate` (`server/tasks/access.ts:24-27`) and `readableCard` (`access.ts:63-68`) are the only gates.
- **Card writes.**
  - Create, patch, move, and delete all run under the `board:<id>` lock (`service.ts:34`, `:340`, `:397`, `:440`, `:467`).
  - Patch is a `revision` CAS (`service.ts:401-403`). Moves do not change `revision` (`service.ts:438`).
- **Bin.** Cards and boards are Bin items (`server/tasks/bin.ts:46`). Restore goes back to the old column, or to the first column when that is gone (`bin.ts:115-118`). Purge is `DELETE FROM cards` (`bin.ts:150`).
- **Today.** `tasksDue` and `tasksMine` (`server/today/providers.ts:29-57`) list cards that are not in a done column. Calendar links resolve a card title per viewer (`server/calendar/links.ts:28`).
- **MCP.**
  - `list_boards`, `list_cards`, `get_card`, `create_card`, and `move_card` (`server/tasks/mcpTools.ts:86-204`).
  - `listedCard` (`:66-82`) is the shape of a listed card.
- **UI.**
  - `/tasks` is `BoardList` (`src/tasks/BoardList.tsx:103-110`): an intro, **New board**, and a list of boards.
  - The board header holds back, heading, count, and the owner actions rename, share, and delete (`src/tasks/BoardView.tsx:340-352`). At 390 px a column tab strip picks the visible column (`BoardView.tsx:362-367`).
  - The card face shows title, due date, and meta icons (`src/tasks/BoardColumnView.tsx:109-146`), with an inline quick-add below (`:155-172`).
  - The card dialog header has Move, Delete, and Close (`src/tasks/CardDialog.tsx:459-461`). Its fields are due (`:491`) and assignee (`:511`), then Description, Files, and Comments (`:522-561`).
- **Route.** `{ app: "tasks"; boardId; cardId }` (`src/router.ts:7`, `parseTasks` at `:32-38`).
- **Idioms elsewhere in the app** that §9 reuses:
  - Collections saved views: `collection_views`, `kind` table or board, `config_json` (`server/migrations/012_collections.ts:50-55`). A toolbar of view name, Find field, and a "Sort & filter · n" chip opens `SortFilterSheet` (`src/collections/CollectionView.tsx:281-292`, `:366`). A typed filter grammar lives in `server/collections/query.ts:15-34`.
  - Files: a list/grid icon toggle (`src/files/FilesApp.tsx:659-660`).
  - Calendar: an Agenda/Month segmented control (`src/calendar/CalendarApp.tsx:459-460`).
  - The utility row: search, Bin, bell, and settings in `AccountActions` (`src/AppShell.tsx:16`).
  - The history dialog guard: `registerHistoryDialogGuard` and `acquireDialogSentinel` (`src/historyDialogs.ts:31`, `:155`).

---

## 2. How mainstream tools model hierarchy and workflow

| Tool | Hierarchy | Sprint / iteration | Boards and views | "Done" and roll-ups |
| --- | --- | --- | --- | --- |
| **Jira** | Epic → Story/Task (peers) → Sub-task. Three working levels. Sub-tasks cannot sit in a different sprint from their parent. [Seibert][jira-h] | A sprint is a **container entity**. Completing it moves unfinished work to the next sprint or the backlog. Only issues in the right-most column count as done, and a parent with open sub-tasks blocks completion. [Atlassian: complete a sprint][jira-sprint] | A board is a view over a filter. Epics can be swimlanes. | Burndown and velocity count at the Story/Task level, not the sub-task level. [Seibert][jira-h] |
| **Linear** | Issue → sub-issue (parent). Projects group issues by outcome. [Linear: parent and sub-issues][lin-sub] | **Cycles** are a field with automatic schedules. Incomplete issues roll to the next cycle. [Linear: cycles][lin-cyc] | Custom views are saved filters, personal or shared at workspace or team scope. Filters live in the URL. [Linear: custom views][lin-views], [filters][lin-filters] | Sub-issues inherit team, priority, project, and sometimes cycle. Optional auto-close of the parent when every child is done. [Linear changelog][lin-auto] |
| **GitHub Projects** | Sub-issues: ≤ 100 per parent, ≤ 8 levels, can cross repositories. [GitHub docs][gh-sub] | An **iteration field** with `@current`, `@previous`, `@next`. [GitHub: iteration fields][gh-iter] | Table, board, and roadmap layouts, saved per view. [GitHub: layouts][gh-views] | "Parent issue" and "Sub-issue progress" fields; you can group by parent. [GitHub: progress fields][gh-prog] |
| **Trello** | None native. Checklists are the "subtasks", and advanced checklists add an assignee and due date per item. [Atlassian: checklists][trello-cl] | None. Teams use lists or labels. | Lists as columns, with Butler automation. | Checklist `n/m` on the card face. |
| **Asana** | Project → Section → Task → Subtask. Up to 5 subtask levels, but Asana advises **one level**. [Asana help][asana-sub], [Asana tips][asana-tips] | None native (sections or custom fields). | List, board, calendar, timeline. **My tasks** gathers everything assigned to you across projects. [Asana: My tasks][asana-my] | Subtask count on the task. |
| **Notion** | Sub-items as a self-relation on a database, plus dependencies. [Notion: sub-items][notion-sub] | Sprints are a toggle that creates a **Sprint database**, with Current sprint, Sprint planning, and Backlog views. [Notion: sprints][notion-sprint] | Database views. | Roll-up properties. |
| **Shortcut** | Objective → Epic → Story (plus tasks inside a story). [Shortcut help][shortcut] | **Iterations** are optional, time-boxed entities that span epics. | Burndown per iteration. | Story counts and points. |
| **Height** (shut down Sept 2025) | Lists → tasks → subtasks. [Creativerly][height] | — | — | A reminder that hosted tools disappear: self-hosting is the Nook argument. |
| **Plane** (OSS) | Work items with parent and sub-work items. The parent picker searches the whole workspace, and type hierarchies can be configured. [Plane docs][plane-wi] | **Cycles** (time boxes) and **Modules** (feature groups). [Plane: core concepts][plane-core] | Saved views over filters. [Plane: views][plane-views] | Progress per cycle. |
| **Vikunja** (OSS) | Subtasks are a **relation type** ("parenttask/subtask"). Views group children under their parents. [Vikunja: relations][vik-rel], [views][vik-views] | None. | List, table, Gantt, and kanban per project. | Parent bar spans its children (Gantt). |
| **Focalboard / Mattermost Boards** (OSS) | No subtasks (a long-open request, [#252][focal-sub]). A "Type" property distinguishes epic, story, and bug. | A "Sprint Planner" **template** with properties. [Mattermost blog][focal-sprint] | Board, table, gallery, and calendar views. | Checklists in the description. |
| **Huly** (OSS) | Issues and sub-issues, milestones, and sprints. [Huly docs][huly] | Sprints. | Kanban and configurable views. | — |

### 2.1 Common patterns

1. **Working depth is 2, sometimes 3.** Jira's everyday depth is Epic → Story → Sub-task. Asana allows 5 levels but recommends 1. GitHub allows 8, but its docs and UI center on one parent level. **Nobody needs more than 3 levels on one board.**
2. **Sprints are time boxes, not tree nodes.** Jira, Linear, GitHub, Shortcut, Notion, and Plane all model a sprint (cycle or iteration) as a **separate entity or field with dates** and a "current" pointer. None of them makes a sprint a parent issue. Users still **say** "sprint > task > subtask", because the UI shows the sprint as the outer grouping.
3. **Status is per item.** A parent and its children each move through the workflow. "Done" for a parent is either manual (Jira, Asana), suggested, or automatic (Linear's optional auto-close).
4. **Roll-ups are counts first.** Children done/total is universal. Points and burndown are Jira, Shortcut, and Linear features aimed at scrum teams with estimates.
5. **Carry-over on sprint close** is universal: unfinished work goes to the next sprint (the Linear default) or to the backlog (a Jira choice). Done work stays in the closed sprint for history.
6. **Subtasks usually live inside the parent card** (a checklist-like section with a progress chip). They are shown as board cards only on request. Trello's checklists are the minimal form of this.
7. **Cross-container views are where people actually live.** Asana "My tasks", Linear views, Jira filters, and GitHub project views all query across teams or boards with a saved filter plus layout, shared or personal.

### 2.2 What small teams (2–15, self-hosted, families) use

The State of Agile data puts Scrum-ish practice at about 81% of agile teams (including hybrids) and Kanban at about 56%, with much overlap ([Parabol][parabol]). Small teams mostly run a **kanban board with a checklist per card**. Some add **light sprints** (a 1–2 week box with a "what's in this sprint" list). Few need epics. Families and personal use are **to-do lists** with due dates and "my stuff" across lists.

Design consequence: **the flat board must stay the default and stay simple.** Hierarchy and sprints are opt-in per board and invisible until turned on.

---

## 3. The workflows to support

| # | Workflow | Who | Minimal data needs | UX needs |
| --- | --- | --- | --- | --- |
| W1 | **Simple kanban** | Everyone, the default | columns, cards, done column (have); WIP (Wave 13) | Unchanged. No hierarchy chrome at all. |
| W2 | **Tasks with subtasks (checklist)** | Families, small teams | `parent_card_id`, 2 levels | "Subtasks" section in the card dialog with a checkbox and inline add; `2/5` chip on the face; subtasks hidden from columns by default |
| W3 | **Scrum with sprints** (sprint > task, sprint > task > subtask) | Dev and small product teams | sprints with dates and state, one active; `sprint_id` on work cards; carry-over | Sprint switcher in the board header (Active, Next, Backlog, All); "Start sprint" and "Complete sprint"; counts per sprint |
| W4 | **Epic > Story > Subtask** | Larger projects | 3 levels, explicit level, parent optional for stories | "Parent" picker; group by epic; epic progress; filter by level |
| W5 | **Personal to-do / GTD** | Individuals | flat or 2 levels; due dates; "My work" across boards | Tasks home "My work"; a Today section; quick capture |
| W6 | **Bug triage** | Dev teams | flat plus flags/tags (Wave 13) plus relations `duplicates` (Wave 13); state normalization | Columns Triage → Accepted → Fixing → Done; a filter `flag:bug state:todo`; a cross-board "Triage" view |
| W7 | **Content / editorial pipeline** | Families, creators, small orgs | flat, many columns, due dates, assignees, attachments (have) | Many columns (the 390 px tab strip, have); a table view; a calendar overlay (have) |

W6 and W7 need nothing from hierarchy. They are covered by Wave 13 (tags, flags, views, filters) plus the cross-board views in §10. Templates (§7.4) give each workflow a one-tap start.

---

## 4. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D120 | **Hierarchy is a column on `cards`**: `parent_card_id` plus an explicit `level` (0–2). It is **not** a `card_relations` kind. Wave 13's reserved `'parent'` kind in the 015 CHECK should be **dropped before 015 ships** (a one-word edit), or left unused forever. | A single parent is a natural FK. It gives an indexed child lookup, one place of truth, and a structural (not relational) meaning. Relations stay many-to-many metadata that never changes `revision` (Wave 13 D87). |
| D121 | **Level invariant:** when `parent_card_id` is set, `parent.level = level − 1`, the parent is on the **same board** and live, and `level < board.levelCount`. A parent is optional at every level (an "orphan" story with no epic is allowed, as in Jira). | Cycles become **impossible by construction**: level strictly increases downward and is bounded at 2, so no chain walk or cycle detector is needed (T110). Depth is capped at 3. |
| D122 | **Board structure** is `boards.structure_json`: `{ levels: [{name, plural}] (1–3), workLevel: 0..n−1, sprints: boolean }`. The default is `{levels:[{name:"Card",plural:"Cards"}], workLevel:0, sprints:false}`. The owner edits it (columns are owner workflow, D38). | Presets are just values (§7.1), and custom names are free. The **work level** is where new cards are created, the level shown as board cards, and the level that carries sprints. |
| D123 | **Presets:** Flat · Task › Subtask · Sprint › Task · Sprint › Task › Subtask · Epic › Story › Subtask · Custom. "Sprint ›" means `sprints:true` with the sprint as the outer grouping. It is **not** a card level. | This matches the operator's words, and every surveyed tool models the sprint as a time box (§2.1 #2). |
| D124 | **Sprints are a separate entity**, `board_sprints`: name, goal, `start_on`, `end_on`, and state `planned`, `active`, or `closed`, with at most one active per board. Only **work-level** cards carry `sprint_id`. Lower levels inherit their ancestor's sprint (derived, never stored). Higher levels (epics) span sprints and have none. | No sync bugs: reparenting a subtask changes its effective sprint automatically. This is Jira's rule that "sub-tasks follow the parent". |
| D125 | **Children move independently.** Each card has its own column. The parent's roll-up is `done_children / children` over **direct children**, where done means in an `is_done` column. There is no automatic move of the parent. Two assists: (a) when the last child reaches done, a toast offers "Move ‘X’ to Done?"; (b) moving a parent into a done column while children are open asks "Also move 3 open subtasks to Done?" with the default **No**. | Predictable, with nothing moving behind the user's back (Linear makes auto-close optional). The assists cover the common case. |
| D126 | **Board columns show work-level cards** by default. Display options (stored with the board view, per viewer): *Subtasks*: `nested` (default) or `as cards`. *Parents*: `chip` (default: a breadcrumb chip on each card) or `lanes` (group rows by parent, like Jira epic swimlanes; this needs Wave 13's grouped layout). | Flat boards look exactly as today. Hierarchy never floods the columns. |
| D127 | **The subtask checkbox** in the dialog and on the nested list means *move to the board's first done column* when checked and *to the first non-done column* when unchecked (a normal `move`, audited as one). When the board has no done column, the checkbox is hidden and the column is shown instead. | A checklist feel with no second state field. Done keeps a single meaning (`is_done`), so Today, the overlay, WIP, and `open_blockers` stay correct. |
| D128 | **Reparenting** is `PATCH /cards/:k {parentId}` under the board lock, with CAS on the child's `revision`. Changing a card's level is a separate action, "Change level", allowed only when the card has no children and no parent at the conflicting level. Drag-and-drop in the column view is a **drop onto a card of the level above** ("Make subtask of…"), with a keyboard and 390 px equivalent in the card menu ("Set parent…"). | A structural change is a field edit. A menu path keeps it reachable without drag on phones. |
| D129 | **Bin cascades down.** Binning a card bins its live descendants in the same transaction, tagged `bin_root_id = <root id>`. The Bin lists only roots, as "Epic A + 7 subitems". Restoring the root restores exactly the descendants that share its `bin_root_id`. A descendant that was binned on its own first keeps its own entry. Purging the root purges the group. `parent_card_id` is `ON DELETE SET NULL` as a safety net. | No orphaned live children under a binned parent, and one Undo brings a whole tree back. |
| D130 | **Restore rules:** a child restored while its parent is still binned comes back **detached** (parent cleared, same level) with the toast "Restored without its parent (it is in the Bin)". A child restored after its parent was purged is already detached through the FK. Restore still ignores WIP (Wave 13 D88). | Restore must never fail (the Bin contract). |
| D131 | **Closing a sprint** (owner) opens a dialog: "8 done · 3 not done → [Next sprint ▾ / Backlog]". Unfinished work-level cards move to the chosen sprint. If no planned sprint exists, the dialog offers "Create Sprint N+1 (dates +length)". Done cards stay in the closed sprint. Their children follow by derivation. | Linear and Jira behave this way, in one step, and it is reversible by hand. |
| D132 | **Sprint management is owner-only** (create, edit, start, close, delete an empty sprint). **Any reader** assigns work cards to a sprint (it is a card field). | Consistent with columns (D38). §13 Q2 offers "members manage sprints" for family boards. |
| D133 | **No cross-board parents in v1.** Cross-board aggregation is served by **views** (D140). Cross-board *links* are Wave 13 relations. | Keeps the board as the ACL and lock unit. Parent titles can never leak across boards (T112). |
| D134 | **Roll-up is computed at read time with one grouped query per board**, never with per-card subqueries: `SELECT parent_card_id, COUNT(*), SUM(col.is_done) FROM cards JOIN board_columns col … WHERE board_id = ? AND deleted_at IS NULL AND parent_card_id IS NOT NULL GROUP BY parent_card_id`. Sprint counts come from the same pattern. **No story points in v1.** | ≤ 1000 cards per board makes this microseconds. Points need estimation UX and reports that small teams rarely use (§13 Q4). |
| D135 | **Limits:** ≤ 100 direct children per card and ≤ 3 levels. The existing 1000 live cards per board covers every level. ≤ 50 open (planned or active) sprints per board, closed ones unbounded but listed paged. | Bounds the grouped queries, the dialog lists, and depth bombs (T111). |
| D136 | **Templates at board creation**: Simple kanban (the default), Personal to-do, Task checklist, Scrum sprint board, Epic › Story › Subtask, Bug triage, Content pipeline. Each sets columns (with `is_done` and, after 020, `state`), `structure_json`, and optionally a first sprint. `POST /boards {name, template?}`. | One-tap workflows (§3). No template ever creates cards. |
| D137 | **Filters (shared grammar, §10.3)** gain `parent:<id>\|none`, `level:<0-2>\|work`, `sprint:current\|next\|backlog\|<id>`, and `has:subtasks`. | One grammar for board filters, cross-board views, URLs, and MCP. |
| D138 | **Views of every kind show a parent breadcrumb** ("Epic › Story") from the same board only. Search, Today, the calendar overlay, and MCP listings show `parent_title` the same way. | Context for a subtask, with no ACL question, since the parent is on the same board (D133). |
| D139 | **MCP (D70):** read tools gain `parent_id`, `level`, `level_name`, `child_count`, `done_child_count`, `sprint` (effective), and `children[]` on `get_card` (≤ 100). `create_card` gains `parentId?` and `level?` (defaulting to parent.level+1, else workLevel) plus `sprintId?`. Wave 13's `update_card` gains `parentId` (nullable) and `sprintId` (nullable). New read tool `list_sprints {boardId}`. **No** sprint create, start, or close tool, and no structure tool. | Create and update only, with reversible, audited writes. Closing a sprint moves many cards, which is a ceremony for a person to do. |
| D140 | **Cross-board views** are `task_views` (020): an owner, a name, a `query` (the §10.3 grammar), `display_json` (layout, group, sort, and fields), and visibility `private`, `selected`, or `all_users` with `task_view_members`, following Collections and boards. A view **stores a question, not an answer.** It always runs as the **viewer**, ANDed with `readableBoardPredicate` for that viewer. | Sharing a view never widens access (T115). This is the Jira filter model without Jira's "the filter's owner decides" trap. |
| D141 | **Normalized column state** (020): `board_columns.state TEXT 'todo'\|'doing'\|'done'`, kept consistent with `is_done` by the service (`is_done = state = 'done'`). The backfill sets `is_done = 1` → done, the first column by position → todo, and the rest → doing. The owner changes it in the column menu, next to the done toggle, which it replaces in the UI. | Columns are per board, so cross-board lanes and filters need a shared vocabulary. Keeping `is_done` means none of its 10+ readers change. |
| D142 | **The Tasks home** has three segments: **Boards** (today's list), **My work** (the built-in view: assigned to me, not done, sorted by due), and **Views** (saved views: mine, shared with me, and all-users). Routes: `/tasks`, `/tasks/my`, `/tasks/views`, `/tasks/views/:viewId`, plus `?q=` (filter), `layout=`, and `group=` on `/tasks/my` and view routes. The URL query is the unsaved state, so Back and Forward replay filter changes (§9.5). | Asana My tasks, Linear views, and GitHub views condensed into one place. The Calendar segmented idiom is reused. |
| D143 | **Cross-board layouts:** `list` (the default, grouped), `table`, and `board` (lanes = the normalized `state`). **Drag is disabled in cross-board layouts in v1.** A card's own menu offers "Move to…" within its board. | A drag across lanes would have to pick a column on some other board and meet its WIP limit. Deferred (§13 Q9). |
| D144 | **Server-side query** `POST /api/tasks/query {q, sort, cursor, limit}` (a read, like the Collections `query` POST, which Team D75 already allowlists). It returns ≤ 50 per page (max 100) using keyset pagination on `(sortKey, id)` and scans only readable, live boards. It is rate limited. `GET /api/tasks/views/:id/cards` wraps it with the stored query. | Bounded, paged, and one code path for UI, views, and MCP. |
| D145 | **MCP views:** `list_views` and `query_cards {viewId? \| filter string, cursor?, limit ≤ 50}` under `tasks:read`. There are no view write tools. | Agents can answer "what is on my plate across boards". Views are the user's configuration. |

---

## 5. Data model

### 5.1 `server/migrations/019_task_hierarchy.ts` (assertion `[1..19]`)

Written with `addColumn` (`server/migrations/types.ts`) as in `011_task_dates.ts:82-84`. It must run after 015 because it references nothing from 015, but the assertion list is in merge order.

```sql
addColumn(cards, parent_card_id, "TEXT REFERENCES cards(id) ON DELETE SET NULL")
addColumn(cards, level,          "INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 2)")
addColumn(cards, sprint_id,      "TEXT REFERENCES board_sprints(id) ON DELETE SET NULL")   -- table created first, below
addColumn(cards, bin_root_id,    "TEXT")          -- set only while binned as part of a subtree (D129); no FK (root may be purged first)
addColumn(boards, structure_json,
  "TEXT NOT NULL DEFAULT '{\"levels\":[{\"name\":\"Card\",\"plural\":\"Cards\"}],\"workLevel\":0,\"sprints\":false}'
   CHECK (json_valid(structure_json) AND length(structure_json) <= 1024)")

CREATE TABLE board_sprints (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  goal TEXT NOT NULL DEFAULT '' CHECK (length(goal) <= 500),
  start_on TEXT CHECK (start_on IS NULL OR start_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  end_on   TEXT CHECK (end_on   IS NULL OR end_on   GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','active','closed')),
  position REAL NOT NULL,
  closed_at TEXT, created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (start_on IS NULL OR end_on IS NULL OR start_on <= end_on),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)));
CREATE UNIQUE INDEX idx_sprints_one_active ON board_sprints(board_id) WHERE state = 'active';
CREATE INDEX idx_sprints_board ON board_sprints(board_id, state, position);
CREATE INDEX idx_cards_parent ON cards(parent_card_id) WHERE parent_card_id IS NOT NULL;
CREATE INDEX idx_cards_sprint ON cards(sprint_id) WHERE sprint_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_cards_bin_root ON cards(bin_root_id) WHERE bin_root_id IS NOT NULL;
```

- **Order.** `CREATE TABLE board_sprints` runs **before** the `sprint_id` `addColumn`.
- **No backfill.** Every existing card is level 0 with no parent, and every board is Flat, so the release looks exactly like v0.8.
- **Invariants the service enforces**, because a CHECK cannot see other rows:
  - D121 parent level and same board
  - `sprint_id` only on work-level cards of the same board
  - D135 limits
- **Integrity test.** `tests/taskHierarchyIntegrity.test.ts` walks random operations and asserts these invariants.
- **Rollback.** v0.8.x code ignores the new columns. A rollback shows every card flat. Nothing is lost, and backups come first (DEVELOPMENT_PLAN §12).
- **Verify on Bun's SQLite 3.53.** `addColumn` with an FK to a table created in the same transaction. A partial unique index is already used elsewhere (Wave 13 relies on similar).

### 5.2 `server/migrations/020_task_views.ts` (assertion `[1..20]`)

```sql
addColumn(board_columns, state, "TEXT NOT NULL DEFAULT 'doing' CHECK (state IN ('todo','doing','done'))")
UPDATE board_columns SET state = 'done' WHERE is_done = 1;
UPDATE board_columns SET state = 'todo'
  WHERE is_done = 0 AND id IN (SELECT id FROM board_columns c WHERE c.position = (SELECT MIN(position) FROM board_columns x WHERE x.board_id = c.board_id));

CREATE TABLE task_views (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  query TEXT NOT NULL CHECK (length(query) <= 2000),                      -- §10.3 grammar, canonical form
  display_json TEXT NOT NULL CHECK (json_valid(display_json) AND length(display_json) <= 2048),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
  position REAL NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE task_view_members (view_id TEXT NOT NULL REFERENCES task_views(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
  PRIMARY KEY (view_id, user_id));
CREATE INDEX idx_task_views_owner ON task_views(owner_id, position);
CREATE INDEX idx_task_view_members_user ON task_view_members(user_id, view_id);
```

- **The sibling-column CHECK is deliberately absent.** `(state='done') = (is_done=1)` is kept by the service, because an `ADD COLUMN` CHECK over existing rows is fragile. A test asserts it after every column operation.
- **Views are configuration, not content.** Deleting one uses a confirm dialog plus an Undo toast (a client-side re-create with the same body), as `collection_views` does. They are not Bin items. Limits: ≤ 50 views per owner, and ≤ 100 members per view.

---

## 6. API deltas (`docs/plan/API_CONTRACTS.md` § Tasks)

### 6.1 Types

```ts
type BoardStructure = { levels: { name: string; plural: string }[] /* 1–3, names 1–24 chars */; workLevel: number; sprints: boolean };
type SprintSummary = { id: string; name: string; goal: string; start_on: string | null; end_on: string | null;
  state: "planned" | "active" | "closed"; card_count: number; done_count: number };   // work-level cards only
type CardSummary = /* existing + Wave 13 */ & {
  parent_card_id: string | null; level: 0 | 1 | 2;
  child_count: number; done_child_count: number;          // direct children (D125, D134)
  sprint_id: string | null;                               // stored (work level) or derived (below), null above
};
type CardDetail = CardSummary & { description: string;
  parent: { id: string; title: string; level: number } | null;
  ancestors: { id: string; title: string }[];             // ≤ 2, root first, for the breadcrumb
  children: (CardSummary & { column_name: string; is_done: 0 | 1 })[];   // ≤ 100, by position
};
```

`GET /boards/:b` adds `board.structure`, `sprints: SprintSummary[]` (open ones plus the last 5 closed), and the counts from the grouped queries (D134).

### 6.2 Endpoints

| Endpoint | Who | Change | Errors |
| --- | --- | --- | --- |
| `POST /boards` | any | `template?: "kanban"\|"todo"\|"checklist"\|"scrum"\|"epics"\|"triage"\|"content"` (D136) | 400 |
| `PATCH /boards/:b` | owner | `structure?: BoardStructure`. Reducing `levels.length` below the deepest used level → 409 `LEVEL_IN_USE {level, cardCount}`. Moving `workLevel` while cards carry sprints clears nothing: it is refused with 409 `SPRINTS_IN_USE` until they are unassigned. `sprints:false` with open sprints → 409 `SPRINTS_IN_USE`. | 400, 403, 409 |
| `POST /boards/:b/cards` | reader | Adds `parentId?`, `level?`, and `sprintId?`. The level defaults to parent.level+1, else `workLevel`. A child of a work-level card inherits nothing stored, because its sprint is derived. | 400 `PARENT_INVALID` (other board, wrong level, too deep, binned: all one code), 409 `LIMIT_REACHED` (100 children), 400 `SPRINT_LEVEL`, 404 sprint |
| `PATCH /cards/:k` | reader | Adds `parentId: uuid\|null` and `sprintId: uuid\|null` (revision CAS, D128). | as above, plus 409 `CARD_CHANGED` |
| `POST /cards/:k/level {level}` | reader | "Change level": allowed when the card has no children and no parent, or the new level matches its parent+1. Revision CAS. | 400, 409 `HAS_CHILDREN` |
| `POST /cards/:k/move` | reader | Adds `withOpenChildren?: boolean` (D125 b): moves the open direct children to the same column in the same transaction, positioned after the parent. | + WIP `COLUMN_FULL` counts the whole batch |
| `DELETE /cards/:k` | reader | Cascades to live descendants (D129). The response adds `descendantCount`. | — |
| `GET /boards/:b/sprints?state=` | reader | `{sprints: SprintSummary[], nextCursor}` | 404 |
| `POST /boards/:b/sprints` | owner | `{name, goal?, startOn?, endOn?}` → 201 | 400, 403, 409 `LIMIT_REACHED` |
| `PATCH /sprints/:s` | owner | name, goal, and dates; `afterSprintId` to reorder | 400, 403, 404 |
| `POST /sprints/:s/start` | owner | planned → active | 409 `SPRINT_ACTIVE {activeSprintId}` |
| `POST /sprints/:s/close {carryTo: sprintId\|"backlog"\|"new"}` | owner | active → closed, with carry-over in one transaction (D131). Returns `{closed, carried, doneCount, newSprint?}`. | 409 `SPRINT_NOT_ACTIVE` |
| `DELETE /sprints/:s` | owner | Only a planned sprint with no cards | 409 `SPRINT_NOT_EMPTY` |
| `POST /api/bin/card/:id/restore` | as now | Restores the `bin_root_id` group (D129, D130) | unchanged |

**Audit** (ids only): `task.card_reparent {boardId, cardId, parentId}`, `task.card_level`, `task.sprint_create|update|start|close {boardId, sprintId, carried}`, `task.board_structure {boardId, levels, sprints}`, and `task.card_delete` adds `descendantCount`.

### 6.3 Service notes

- **Parent checks** run inside the board lock with a single query: `SELECT level, board_id, deleted_at FROM cards WHERE id = ?`. Because levels increase strictly downward, no ancestor walk is needed for cycles. The **level-shift on reparent** only applies to "Change level", which requires no children, so no subtree rewrite ever happens.
- **The effective sprint in SQL** is `COALESCE(k.sprint_id, p.sprint_id, gp.sprint_id)` with `LEFT JOIN cards p ON p.id = k.parent_card_id LEFT JOIN cards gp ON gp.id = p.parent_card_id`. This is bounded, since the depth is ≤ 2.
- **`cardSelect`** (`service.ts:98-107`) gains `k.parent_card_id, k.level, k.sprint_id`. Counts and derived sprints are merged in TypeScript from the grouped queries, so no per-card subqueries are added (following Wave 13 §3.1).

---

## 7. UX plan: hierarchy and sprints

### 7.1 Board settings → "Structure" (owner)

This is a new **Board settings** sheet that replaces the three loose owner icons in the header (`BoardView.tsx:347-351`). It has sections: *General* (name), *Structure*, *Sprints*, *Columns* (order, done, state, WIP), *Sharing*, and *Delete*. At 390 px it is a full-height sheet with the dialog guard (D69), and on desktop a right-hand panel.

- **Structure:** a preset picker built as radio cards, each with a tiny diagram: "Card", "Task › Subtask", "Sprint › Task", "Sprint › Task › Subtask", "Epic › Story › Subtask", "Custom". Below it are the level names (1–3 text fields with singular and plural) and "New cards are created as: [Story ▾]" (workLevel, a D91 `Select`). The preview line reads "Columns show Stories. Subtasks appear inside their story."
- **Refusals** show inline: "7 cards are Subtasks. Move or change them before removing this level."

### 7.2 Card dialog (and the `/full` page)

- **Breadcrumb** above the title: `Epic: Checkout ›` with links. Opening one pushes that card's route (the same history as a relation link, Wave 13 §4.4).
- **"Parent" field** in `CardFields`: a `Combobox` (D91), with async options from the same board at level−1 ("No epic" first). Hidden on level-0 cards and on flat boards.
- **"Sprint" field** on work-level cards when sprints are on: a `Select` with *Backlog*, the active sprint (marked), and planned sprints. On lower levels it shows read-only "Sprint 12 (from parent)".
- **"Subtasks" section** (called by the level-below name, e.g. "Stories" on an epic), placed right after the fields and before Description (`CardDialog.tsx:522`):
  - A header "Subtasks 2/5" with a thin progress bar.
  - Rows: checkbox (D127), title (a link that opens the child), assignee initials, due chip, and a ⋯ menu (Open, Remove from parent, Move to Bin).
  - An inline **"+ Add subtask"** input: Enter adds a subtask and keeps focus, and Esc cancels (calling `preventDefault` as the dropdown rules require). Rows reorder with drag on desktop and ↑/↓ with Alt. Children keep their own `position` within their column, so the section orders by `(column position, card position)`; see §13 Q6.
  - **At 390 px** rows are 44 px, the checkbox target is 44 px, and the add input sits sticky at the bottom of the section.
- **Header menu** adds "Set parent…", "Change level…", and "Copy link".

### 7.3 Board (column view)

- **Card face** (building on the Wave 13 face): a parent chip `▸ Checkout` (truncated, tap opens the parent) and a subtask chip `☐ 2/5`, which expands inline to a compact list (the `nested` mode) on desktop and opens the dialog on phones. Parent-level cards (epics) do not appear in columns unless "Show all levels" is on.
- **Board header at 390 px** is two rows (§9.4):

```text
┌──────────────────────────────────────────────┐
│ ‹  Board · Web app                    ⚙  ⋯  │  back · title · settings · more
│ [Sprint 12 ▾] [☰ ▦ ⊞] [Filter · 2]         │  sprint switcher · view icons · filter chip
├──────────────────────────────────────────────┤
│ To do 5 │ Doing 3 │ Review 1 │ Done 8 │ +    │  column tabs (existing, BoardView.tsx:362)
```

- **Sprint switcher** (only when `sprints:true`): a `Select`-styled button listing *Active: Sprint 12 (Sep 22 – Oct 3) · 8/14 done*, the planned sprints, *Backlog* (no sprint), and *All cards*. The owner sees "Start sprint", "Complete sprint…", and "New sprint" at the bottom. The choice lives in the URL as `?sprint=current|backlog|<id>|all`, part of the Wave 13 filter query, so Back restores it.
- **Default when sprints are on:** the active sprint, or Backlog when none is active.
- **Sprint header strip** below the switcher, when a sprint is selected: "Sprint 12 · ends in 4 days · 8 of 14 done" with a segmented bar (todo, doing, done by column state after 020, otherwise done and not done). There is no burndown in v1 (D134).
- **Drag to reparent** on desktop: while dragging a card over a card of the level above, the target shows "Make subtask of ‘X’"; drop sets the parent (D128). Keyboard, Shift+Alt+→ or "Set parent…" in the ⋯ menu, gives the same result. At 390 px drag is off, as today, and the menu path is used.

### 7.4 Board creation templates

"New board" (`BoardList.tsx:108`) opens a sheet with the name and a template grid. Each card shows the template's columns and structure in one line:

| Template | Columns (state) | Structure | Extras |
| --- | --- | --- | --- |
| Simple kanban (default) | To do (todo), Doing (doing), Done (done) | Flat | — |
| Personal to-do | To do, Done | Task › Subtask | — |
| Task checklist | To do, Doing, Done | Task › Subtask | — |
| Scrum sprint board | Backlog (todo), To do (todo), In progress, Review, Done | Sprint › Task › Subtask | "Sprint 1", planned, 2 weeks from today |
| Epic › Story › Subtask | To do, In progress, Done | Epic › Story › Subtask, work = Story | — |
| Bug triage | Triage (todo), Accepted (todo), Fixing, Verify, Done | Flat | Flags "bug" and "regression" if Wave 13 flags exist |
| Content pipeline | Ideas (todo), Drafting, Editing, Scheduled, Published (done) | Flat | — |

Templates are data in `server/tasks/templates.ts`, like `server/collections/templates.ts`. Everything can be changed later in Board settings.

### 7.5 Sprint close dialog (owner)

```text
Complete Sprint 12
  9 done  ·  5 not done (2 in Review, 3 in To do)
  Move the 5 unfinished tasks to:  [ Sprint 13 (planned) ▾ ]   (Backlog / New sprint…)
  Subtasks follow their tasks.
                                   [Cancel]  [Complete sprint]
```

Back and Escape close it (guard). After completion a toast offers "Sprint 12 completed · 5 moved to Sprint 13 · View".

---

## 8. Where hierarchy changes Wave 13

| Wave 13 item | Change needed for hierarchy |
| --- | --- |
| D84 `card_relations.kind` CHECK reserves `'parent'` | **Drop `'parent'`** before 015 ships (D120). If 015 has already shipped, the API keeps refusing it forever. |
| `CardFields.tsx` (§4.3) | Add slots for **Parent** and **Sprint**, hidden when the board is flat. |
| Composer (D89) | When started from a card's "+ Add subtask… (full)" it pre-fills the parent. Level and sprint fields follow the structure. |
| Board views: table and grouped (TODO) | Table: a tree column (indent, ▸ expand, a "Level" column, a "Parent" column), with children under their parent when sorted by position. Grouped: add **group by parent** and **group by sprint**. The per-viewer display options from D126 live in the same display menu. |
| Filter bar (TODO) | Must be the **shared grammar** module of §10.3, so the board bar and cross-board views are one component with one parser. Adds `parent`, `level`, `sprint`, and `has:subtasks` (D137). |
| WIP (D88) | Counts **every card in the column at any level** (simplest and honest). `withOpenChildren` moves count as a batch. §13 Q7 offers "count work level only". |
| Card face (TODO) | Adds the parent chip and the `n/m` subtask chip. |
| MCP `update_card` (D93) | Adds `parentId` and `sprintId` (D139). |
| `/full` page (D90) | The two-column layout puts Subtasks in the main column, under Description. |

**Sequencing:** Wave 13A and 13B must land first (dropdowns, `CardFields`). 13C (composer) and the table and grouped views are nice to have before 17A. If they are not there, 17A ships column-view hierarchy only, and the table and grouped hooks are added when the Wave 13 views land.

---

## 9. UX cohesion: one Tasks experience

### 9.1 Principles

1. **Flat until asked.** A new board, and every existing board, looks exactly like today. Structure, sprints, and levels appear only after someone turns them on.
2. **One noun per thing:**
   - **Board**: the shared workspace, and the ACL unit.
   - **Column**: a workflow step. Its **state** is todo, doing, or done.
   - **Card**: every item. "Task", "Story", and "Subtask" are **level names**, shown as labels, never as different objects.
   - **Subtask**: the generic word for a child when the level has no name.
   - **Sprint**: a time box on a board.
   - **View**: a saved filter plus display, and nothing else. A board's layout is its "layout", not a view.
3. **Same controls, same place.** Every list-like screen uses one toolbar: *[scope switcher] [layout icons] [Filter · n] [Find]*. This is the Collections toolbar (`CollectionView.tsx:281-292`) generalized.
4. **Phones get sheets, desktops get popovers.** The same component serves both (D91). Every sheet is guarded, so Back closes it.
5. **The URL is the state.** Segment, board, sprint, layout, filter, and open card are all in the path or query, so Back and Forward, reload, and sharing a link all reproduce the screen (D69).
6. **A link or view never grants access.** Everything is resolved per viewer.
7. **Configure where you work.** Board structure lives in Board settings. Templates only pre-fill it, so there is never a setting you can only choose once.

### 9.2 Idioms reused

| Existing idiom | Where | Reused as |
| --- | --- | --- |
| Calendar Agenda/Month segmented control (`CalendarApp.tsx:459-460`) | Tasks home | Boards · My work · Views segments |
| Files list/grid icon toggle (`FilesApp.tsx:659-660`) | Board header, view header | Layout icons: column (board), table, grouped list |
| Collections "Sort & filter · n" chip plus `SortFilterSheet` (`CollectionView.tsx:292`, `:366`) | Board and view toolbar | "Filter · n" chip. At 390 px it opens the filter sheet; on desktop it shows the Linear-style inline pills with "+ Filter" |
| Collections saved views (`collection_views`, save / update / rename / delete view buttons, `CollectionView.tsx:148-190`, `:288-289`) | Views | "Save as view…" and "Update view" in the same places, with the same wording |
| Board and Collection share panels (`BoardSharePanel.tsx`, `CollectionSharePanel.tsx`) | View sharing | The same Private / Selected people / Everyone component |
| Today sections (`src/today/todaySections.ts`) | My work | Today "Assigned to me" gets a "See all → /tasks/my" link |
| Utility row (`AccountActions`, `src/AppShell.tsx:16`) | unchanged | Global search stays notes-only. Card search is the Find field inside Tasks (Wave 13 D86) |

### 9.3 How the pieces relate

```text
Today ──"See all"──▶ /tasks/my ─┐
Search (notes) ─┐               │   /tasks  (segments: Boards | My work | Views)
Calendar event links ──▶ card ◀─┼── /tasks/views/:id   (cross-board, per-viewer)
Collections (row links a card? no — events and relations only)
                                └── /tasks/:board[?sprint&layout&q] ──▶ /card/:k ──▶ /full
```

Collections stays separate. It is the "structured data" module, and a board is not a collection. The shared piece is the **toolbar and filter-sheet idiom**, not the data. The Search module keeps notes only. Card title search is Tasks-local (Wave 13 D86) and becomes the **Find** field in the Tasks toolbar (`text:` in the grammar).

### 9.4 Wireframes (text)

**A. `/tasks` home, 390 px**

```text
┌──────────────────────────────┐
│ ‹ Tasks            🔍 🗑 🔔 ⚙ │  utility row (unchanged)
│ [Boards][My work][Views]     │  segmented, 44 px; the active one is pushed (route)
│ ─ My work ─────────────────  │
│ [Filter · 1]  [≡ ▦]  Find…   │  filter chip = "not done" preset; layout icons
│ Overdue (2)                  │  grouped list, group = due bucket
│  ○ Pay insurance   Home › …  │  board name · parent breadcrumb
│ This week (5)                │
│  ○ Review PR #12  Web app    │
│ No due date (9)       ▸      │  collapsed group
│                     [+ Card] │  FAB: composer with a board picker
└──────────────────────────────┘
```

On the **Boards** segment the existing list is unchanged, plus a small line per board ("Scrum · Sprint 12 · 8/14") and the **New board** button, which opens the template sheet. On the **Views** segment: "My views", "Shared with me", and "Everyone" (sections), each row with name, owner, a visibility icon, and a live count. "+ New view" opens an empty view with the filter sheet.

**A′. `/tasks` home, desktop.** The segments sit left-aligned under the title. My work fills the width. The filter shows as inline pills `Assignee: me ×  State: not done ×  + Filter`, with layout icons on the right and "Save as view" once the filter differs from the default. Views list on the left rail (240 px) when the Views segment is active; selecting one pushes `/tasks/views/:id`.

**B. Board with hierarchy, 390 px** (Sprint › Task › Subtask)

```text
┌──────────────────────────────┐
│ ‹ Web app                ⚙ ⋯ │  ⚙ Board settings (all users see; owner edits)
│ [Sprint 12 ▾] [▦ ≡ ⊞] [Filter]│
│ Sprint 12 · 4 days left · 8/14│  progress strip (tap = sprint sheet)
│ To do 3│Doing 4│Review 1│Done 6│
│ ┌──────────────────────────┐ │
│ │ Checkout redesign        │ │  work-level card
│ │ ☐ 2/5  📅 Oct 1  AS  #ui │ │  subtask chip · due · assignees · tag
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ ▸ Payments  (parent chip)│ │  shown only on Epic › Story boards
│ │ Refund flow              │ │
│ └──────────────────────────┘ │
│ [+ Add card]                 │  composer; sprint pre-set to the selected sprint
└──────────────────────────────┘
```

**B′. Board, desktop.** All columns are visible. The header is one row: `‹  Web app  [Sprint 12 ▾]  8/14 ▰▰▰▱  ·  [▦ ≡ ⊞]  [Assignee: me ×][+ Filter]  Find…  ⚙`. Subtask chips expand inline (nested). Dragging onto a card of the level above reparents it. With `group=parent` (grouped layout) each epic is a section with its progress.

**C. Card dialog with parent and subtasks, 390 px (full screen)**

```text
┌──────────────────────────────┐
│ ✕  Task          ⇄  🗑  ⋯    │  level name as the eyebrow
│ Web app › Checkout redesign  │  breadcrumb (parent link)
│ Checkout redesign            │  title (editable)
│ Column  Doing  ▾             │
│ Sprint  Sprint 12 ▾          │
│ Parent  —  (Tasks have none) │  hidden on the top level
│ Due     Oct 1   + time       │
│ People  (AS)(PK) +           │
│ ── Subtasks 2/5 ▰▰▱▱▱ ────── │
│ ☑ Wireframes           AS    │  44 px rows; checkbox = move to done
│ ☑ Copy review                │
│ ☐ Build form      📅 Sep 30  │
│ ☐ QA on phones               │
│ ☐ Ship                       │
│ [+ Add subtask…            ] │  Enter adds, keeps focus
│ ── Description ───────────── │
│ ── Relations · Files · Comments
└──────────────────────────────┘
```

On desktop the dialog is the same, and the `/full` page puts Subtasks under Description in the main column, with fields, relations, and files on the right.

**D. Sprint switcher (sheet at 390 px, popover on desktop)**

```text
┌ Sprint ──────────────────────┐
│ ● Sprint 12   Sep 22–Oct 3   │  active · 8/14
│ ○ Sprint 13   Oct 6–Oct 17   │  planned · 3
│ ○ Backlog                    │  no sprint · 21
│ ○ All cards                  │
│ ─────────────────────────────│
│ Closed: Sprint 11 · 10 · 9 ▸ │  paged list
│ ─────────────────────────────│
│ + New sprint   Complete 12…  │  owner only
└──────────────────────────────┘
```

### 9.5 History parity (D69) for the new surfaces

| From | Action | History | Back |
| --- | --- | --- | --- |
| `/tasks` | Tap "My work" or "Views" | push `/tasks/my` or `/tasks/views` | the previous segment |
| Any list | Change a filter, layout, group, or sprint | **replace** the current entry's query (so Back doesn't replay every keystroke). A *committed* change (sheet Apply, a pill added or removed) **pushes**. | the previous filter state |
| View | Open card | push `/tasks/:b/card/:k` with a `fromView` hint | the view with its filter |
| Card | Tap the breadcrumb or a subtask | push the target card | the source card |
| Any | Filter sheet, sprint sheet, Board settings, close-sprint dialog | no entry (guard) | closes the sheet |
| Deep link `/tasks/views/:id` at depth 0 | in-app Back | `tasksBackAction`: view → views list → `/tasks` → Home | never leaves Nook |

The 390 px QA rows are in §11.3.

---

## 10. Cross-board visibility: Tasks home, My work, and Views

### 10.1 Research summary

- **Linear:** custom views are saved filters over issues, either personal or shared at workspace or team scope. Filters are in the URL, AND/OR groups are available, and "save any filtered list as a view" works in one keystroke ([custom views][lin-views], [filters][lin-filters]).
- **Jira:** saved JQL filters with view permissions (private, group, project, logged-in). Dashboards use filters, and a common failure is a shared dashboard over a private filter. Results always honour the **viewer's** browse permission ([Atlassian: share filters][jira-share], [manage filters][jira-manage]).
- **GitHub Projects:** each view is a layout (table, board, roadmap) plus filter, group, and sort, saved per project ([layouts][gh-views]).
- **Asana:** "My tasks" is the personal cross-project list with its own sections and list, board, and calendar layouts ([Asana: My tasks][asana-my]).
- **Plane:** saved views over work items, shareable ([Plane: views][plane-views]).

What Nook should take:

- **From Linear:** URL filters, one-step "Save as view", and personal vs shared.
- **From Jira:** the viewer's permission always wins, and the owner's never does.
- **From GitHub:** a view is filter + layout + group + sort.
- **From Asana:** a built-in "My work" that needs no setup.

### 10.2 Model

- **My work** is a built-in, unsaved view: `assignee:me state:todo,doing sort:due`. Users can change it for the session in the URL, and save the result as their own view.
- **Saved views** (`task_views`, D140) have visibility `private` (default), `selected` (people), or `all_users`. Only the owner edits, renames, shares, or deletes a view. Recipients may "Duplicate" it into a private copy they then own.
- **Running a view:** the stored query is compiled by the shared grammar and ANDed with `b.deleted_at IS NULL AND k.deleted_at IS NULL AND ${readableBoardPredicate}` for the **viewer** (`access.ts:24-27`). References in the filter are handled per viewer:
  - **Board ids** the viewer cannot read compile to "matches nothing". The chip shows "Restricted board", with no name.
  - **User ids** show display names. The same exposure as `GET /api/users` today (Team T79 note).
- **Layouts:** `list` (grouped), `table`, and `board` (lanes = normalized state; no drag, D143). Group by: board, state, assignee, due bucket, sprint, parent, or tag. Sort: due, updated, created, title, or board.

### 10.3 One filter grammar (shared with the Wave 13 board filter bar)

A small, Linear-flavoured text grammar that is the **canonical form** in URLs (`?q=`), in `task_views.query`, and in MCP (`filter`):

```text
query   := term (" " term)*                 -- terms AND together; values in one term OR together
term    := ["-"] key ":" value ("," value)* | quoted-text
key     := board | assignee | creator | state | column | tag | flag | due | sprint | parent | level | has | text | relation
value   := me | none | uuid | today | overdue | week | next-week | YYYY-MM-DD | <YYYY-MM-DD | >YYYY-MM-DD
         | todo | doing | done | current | next | backlog | work | 0 | 1 | 2 | subtasks | blocked | word
examples: assignee:me state:todo,doing due:overdue,week
          board:<id> sprint:current -state:done level:work
          tag:<id> "invoice"                       -- quoted text = title contains (instr, no wildcards)
```

- **Where the code lives:** one pure module, `shared/taskQuery.ts`. It has `parse(string) → Ast | ParseError`, `format(Ast) → canonical string`, and limits: ≤ 20 terms, ≤ 20 values per term, and ≤ 2000 chars. The server imports it, and `server/tasks/cardQuery.ts` compiles the `Ast` to parameterised SQL (the approach of `server/collections/query.ts:15-34`: a fixed operator table and no string concatenation of values). The client imports it for the filter bar, the sheet, and URL round-trips.
- **Why a new top-level `shared/`.** Neither side imports the other today. `shared/` would be added to `tsconfig.json` and Vite, and it is the cleanest option (§13 Q10). The fallback is a copy in each tree plus a parity test.
- **Scope rules:**
  - `column:` is valid only when the query also has exactly one `board:`, or inside a board page. Otherwise it is a 400 `FILTER_SCOPE`, and the UI hides it.
  - `sprint:current|next` resolves per board: each card matches its own board's active or next sprint.
  - `tag:` and `flag:` depend on Wave 13 tags and flags. Tags are board-scoped, so cross-board tag filters match by **tag name** (case-insensitive) as well as by id.
- **UI.** Desktop shows pills; each pill is a `Select` or `Combobox` from D91, and "+ Filter" lists keys. At 390 px there is a "Filter · n" chip that opens a sheet, a stack of rows as in `SortFilterSheet`, with "Apply" (pushes, §9.5). The **same component** mounts on the board page (scoped to that board, where `column:` is enabled) and on views and My work (cross-board).

### 10.4 API (`POST` reads, per D144)

| Endpoint | Who | Body / result | Errors |
| --- | --- | --- | --- |
| `POST /api/tasks/query` | any | `{q, sort?, group?, cursor?, limit? ≤ 100}` → `{cards: (CardSummary & {board_name, column_name, column_state, parent_title})[], nextCursor, total?}`. `total` is given only when ≤ 1000. | 400 `FILTER_INVALID {position}`, `FILTER_SCOPE`, 429 (30 per 10 s per user) |
| `GET /api/tasks/views` | any | `{mine, shared, everyone}` (names, owner, visibility, revision). Counts are fetched lazily per row. | — |
| `POST /api/tasks/views` | any | `{name, query, display}` → 201 | 400, 409 `LIMIT_REACHED` (50) |
| `PATCH /api/tasks/views/:v` | owner | name, query, display, position, revision CAS | 403 `OWNER_ONLY`, 404 (not readable), 409 `VIEW_CHANGED` |
| `PUT /api/tasks/views/:v/sharing` | owner | as board sharing (`service.ts:186-209`) | 400, 403 |
| `DELETE /api/tasks/views/:v` | owner | `{ok}` | 403, 404 |
| `POST /api/tasks/views/:v/duplicate` | reader of the view | → a private copy | 404 |
| `GET /api/tasks/views/:v/cards?cursor&limit` | reader of the view | the stored query run as the viewer | 404 |
| `PATCH /api/tasks/columns/:c` | owner | adds `state: "todo"\|"doing"\|"done"` (sets `is_done`) | as now |

**Query bounds.**

- The readable-board predicate comes first. The driving index is `idx_cards_board`, since boards per viewer are ≤ ~(50 × users) in the worst `all_users` case.
- Keyset pagination is on `(sort value, id)`. `text:` uses `instr(lower(title), lower(?))`.
- A **2 s statement budget**: SQLite has no timeout, so use Bun's `db` interrupt through a progress-handler equivalent, or refuse queries with more than N boards (§13 Q11). **Test fixture:** 10 users × 50 boards × 1000 cards, p95 under 150 ms for My work.

**Views are private configuration.** Their names and queries are visible only to the audience. Shared view queries can carry user ids and board ids, and ids are not secrets in Nook. Titles of restricted boards are never resolved (T116).

### 10.5 MCP (D145)

- **`list_views`** (`tasks:read`) returns `{views: {id, name, owner_name, visibility, query}[]}`.
- **`query_cards`** (`tasks:read`) takes `{viewId?: uuid, filter?: string (grammar), sort?, cursor?, limit? ≤ 50}`, with exactly one of `viewId` or `filter`. It returns cards in the `listedCard` shape (`mcpTools.ts:66-82`), plus `board_name`, `state`, `parent_title`, `level_name`, and `sprint_name`.
- **Today alignment.** `get_today` already covers "my due cards". `query_cards` is the general form.
- **Limits.** Both tools count in the read bucket (120 per minute). Neither is audited, the same as other reads.

### 10.6 Interplay with Wave 13 and Team

- **The Wave 13 filter bar** should be built **on `shared/taskQuery.ts` from the start**. If Wave 13 ships its bar first with an internal format, 17C migrates it: the URL `?q=` stays compatible, because 17C accepts the old keys.
- **Team's viewer and guest roles** can run queries and see views shared with them, since query is a read POST, allowlisted like the Collections query. They cannot create views unless Team decides personal configuration counts as a personal write (Team D75 lists "personal, non-content writes"). The recommendation is to **allow private views for viewers** and forbid sharing (§13 Q12).

---

## 11. Threat rows and tests

### 11.1 Threat rows (append to THREAT_MODEL.md as "Task hierarchy, sprints, and views")

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T110 | **Cycle in the parent chain** (A → B → A) hangs roll-ups or the breadcrumb | Level invariant (D121): a parent's level is exactly one less, and levels are 0–2. Checked under the board lock. There is no recursive SQL anywhere. An integrity test fuzzes reparent and level changes. | Required |
| T111 | **Depth or width bomb**: huge subtrees, a heavy roll-up, or a giant dialog | ≤ 3 levels, ≤ 100 children, 1000 cards per board. Roll-ups come from one grouped query per board. `children[]` is capped at 100 and ancestors at 2. | Required |
| T112 | **Cross-board leak through a parent title or breadcrumb** | Parents must be on the same board (D133), so the reader of a child is a reader of the parent. Views, Today, the overlay, and MCP only show `parent_title` from the same row's board. A test moves a card board-to-board (if ever added) and asserts the parent is cleared. | Required |
| T113 | **Reparenting as an existence oracle** (setting a parent id from another board) | Every invalid parent (unknown, other board, binned, wrong level) returns the same 400 `PARENT_INVALID`. The parent is fetched by `id AND board_id`. | Required |
| T114 | **Bin cascade abuse**: a member bins a whole epic tree, or restore resurrects cards binned by others | The cascade uses the existing card delete rights (D41). Undo covers the whole tree. Restore only brings back the rows whose `bin_root_id` matches the root. Separately binned descendants keep their own entry and rights. The owner sees everything in the Bin. | Required |
| T115 | **A shared view widens access** (a recipient sees cards from boards shared only with the owner) | A view stores a query only and always runs as the viewer, ANDed with `readableBoardPredicate(viewer)`. Tested across the share matrix: owner A shares a view over board X (private to A) with B, and B gets zero cards from X. The MCP `query_cards` path is tested the same way. | Required |
| T116 | **A view leaks metadata** (restricted board names, other people's private view names) | Board chips resolve names per viewer ("Restricted board"). View lists come from `readableView` (owner, member, or all_users). 404 for others. Queries never embed titles. | Required |
| T117 | **Filter injection or DoS** (SQL through the grammar, pathological queries) | A pure parser with a fixed key and operator table and bound parameters only. `instr` instead of LIKE. Term, value, and length caps. Rate limit 30 per 10 s. Keyset pagination with a limit ≤ 100. Benchmark fixture and a statement budget (§10.4). | Required |
| T118 | **A sprint close moves the wrong cards** or races a concurrent move | Runs under the board lock in one transaction, considering only live work-level cards in the sprint whose column is not done at that moment. Audited with counts. Reversible by reassigning. Owner-only. | Required |
| T119 | **MCP bulk restructuring** (reparent storms through `update_card`) | Revision CAS per card, the `task_write` bucket, audit `{via:"mcp"}`, and no sprint lifecycle or structure tools. | Required |
| T120 | **A structure change hides cards** (reducing levels orphans deep cards) | Refused while any card is at the removed level (409 `LEVEL_IN_USE`). `sprints:false` is refused while sprints are open. | Required |
| T121 | **Column state drift** (`state` and `is_done` disagree, so Today or the overlay miscount) | The service writes both in one statement. A test asserts `(state='done') = (is_done=1)` after every column mutation, and in the 020 backfill. | Required |
| T76 (extended) | Back or Forward loops across segments, views, filters, and sheets | The §9.5 table: filter changes replace, commits push, sheets are guarded. 390 px QA. | Required |

### 11.2 Automated tests

- **Unit, pure**
  - `tests/taskQuery.test.ts`: parse/format round-trips, canonical ordering, quoting, negation, caps, error positions, scope errors, and old Wave 13 keys.
  - `tests/cardQuerySql.test.ts`: the operator table produces only bound parameters (a snapshot of SQL with placeholders).
  - `tests/boardStructure.test.ts`: presets validate, and names, `workLevel`, and level-count bounds are checked.
  - `tests/tasksRoute.test.ts` gains `/tasks/my`, `/tasks/views`, `/tasks/views/:id`, the `?q&layout&group&sprint` round-trip, and malformed values falling back.
- **Migrations** (`tests/migrations.test.ts`)
  - **019** on a 014+015 fixture: defaults are flat, the FKs are `SET NULL`, the partial unique index allows only one active sprint, and the date CHECKs work.
  - **020**: the state backfill (done, first → todo, the rest → doing, a board whose first column is done), `task_views` CHECKs, and cascades.
- **API: hierarchy** (`tests/tasksHierarchy.test.ts`)
  - Create a child (level defaults), and refusals for a wrong level, another board, a binned parent, depth > levels, and 101 children.
  - Reparent with CAS, and the `revision` bump.
  - Change level with and without children.
  - Roll-up counts after moves.
  - `withOpenChildren` moves, including WIP batch refusal.
  - Structure change refusals.
  - Bin: the cascade, list roots only, restore the group, a child restored alone while its parent is binned comes back detached, and purge removes the group.
  - An integrity fuzz of 500 random operations.
- **API: sprints** (`tests/tasksSprints.test.ts`)
  - Owner-only lifecycle, one active sprint, and assigning at the work level only (400 below).
  - The derived sprint for subtasks.
  - Close with carry to next, backlog, and new; done cards stay; concurrent move during close.
  - `?sprint=` filtering on the board payload.
- **API: views** (`tests/tasksViews.test.ts`)
  - The share matrix (owner, member, stranger, `all_users`, a view over a private board): T115 zero-leak, and restricted board chips.
  - Pagination is stable under inserts. Limits and 429.
  - Duplicate. CAS `VIEW_CHANGED`. Delete.
  - A disabled user's views vanish from shared lists.
  - My work equals the Today `tasksMine` set, minus the horizon rule (a parity test).
- **Today and the overlay:** subtask rows carry `parentTitle`. Assigned subtasks show on Today.
- **MCP** (`tests/mcpTasks.test.ts`)
  - `create_card` with `parentId`, `update_card` `parentId` and `sprintId`, `list_sprints`, `list_views`, and `query_cards`.
  - `query_cards` never returns unreadable boards' cards (the T115 twin).
  - Scope hiding, and the write bucket.
- **Performance:** `tests/tasksQueryPerf.test.ts` (skipped in CI by default, runnable by hand). The 10 × 50 × 1000 fixture, p95 targets, and board payload ≤ 1.5× of v0.8 with 1000 cards of mixed levels.

### 11.3 Manual QA (390×844 and desktop, two users)

- **Templates:** create a Scrum board from the template. The columns, the structure, and Sprint 1 are right.
- **Subtasks at 390 px:** add 5 subtasks inline (the keyboard stays up and Enter keeps focus), check 2, and the face shows `☐ 2/5`. Open a subtask, Back returns to the parent, and Back again returns to the board.
- **Sprints:** the switcher sheet opens and Back closes it. Start a sprint. Complete it with carry-over to "New sprint". The toast "View" link works. Reload keeps `?sprint=`.
- **Epic board (desktop):** drag a story onto an epic to reparent. Group by parent. The breadcrumb links work.
- **Bin:** bin an epic with 3 stories and 4 subtasks. The Bin shows one row with "+7". Undo restores all of them. Bin one subtask, then the epic, then restore the epic: the subtask stays in the Bin.
- **Tasks home:** switch segments with Back and Forward. My work filters. "Save as view" as private, then share it with user B. B sees the view but **not** cards from A's private board. B duplicates it.
- **Filters:** change a filter pill, then Back restores the previous filter. Deep link `/tasks/views/:id` at depth 0 steps back view → list → `/tasks` → Home.
- **Layouts:** every layout at 390 px has no horizontal page scroll (the table scrolls inside its own container) and 44 px targets.

---

## 12. Wave split (each sub-wave is backend and UI together, and each release is runnable)

The director assigns numbers. Suggested: **Wave 17**, after Wave 13 and in parallel with Team B.

| Sub-wave | Content | Migration | Worktree scope | Depends on | Size |
| --- | --- | --- | --- | --- | --- |
| **17A Hierarchy** | 019 (all hierarchy and sprint schema). Board structure and presets. Parent and level API and invariants. Roll-ups. Subtasks section, Parent field, and breadcrumb. Card-face chips. Reparent via menu and desktop drag. Bin cascade and restore. Today and overlay `parentTitle`. MCP read fields plus `create_card`/`update_card` `parentId`. Board settings sheet (General, Structure, Columns, Sharing). Templates (without sprint extras). | 019 | `server/tasks/*`, `server/today/providers.ts`, `server/calendar/tasksOverlay.ts`, `src/tasks/*`, `src/router.ts` (none needed) | 13A, 13B | L, 3 sessions |
| **17B Sprints** | Sprint API and lifecycle, close with carry-over. The switcher, progress strip, and close dialog. `?sprint=` in the URL. `list_sprints` and `sprintId` in MCP. The Scrum template extras. The `sprint:` filter key (in the board filter bar if Wave 13's exists, else the switcher alone). | none (uses 019) | `server/tasks/sprints.ts` (new), `routes.ts`, `mcpTools.ts`, `src/tasks/Sprint*.tsx` | 17A | M, 2 sessions |
| **17C Tasks home and views** | 020 (column state, `task_views`). `shared/taskQuery.ts` plus the SQL compiler. `POST /api/tasks/query`. Views CRUD and sharing. `/tasks` segments, My work, the Views list, and the view page with list, table, and board layouts. The shared filter bar and sheet (adopting or migrating the Wave 13 bar). The column state menu. `list_views` and `query_cards`. The Today "See all" link. | 020 | `shared/*` (new), `server/tasks/query.ts`, `views.ts`, `src/tasks/home/*`, `src/router.ts`, `src/tasksRoute.ts`, `tsconfig.json`, `vite.config.ts` | 13 (filter bar, table and grouped layouts ideally), 17A for `parent` and `level` keys (it can ship before 17B, since `sprint:` keys arrive with 17B) | L, 3 sessions |

- **Parallelism.** 17C's server work (020, grammar, query) can start in parallel with 17A in its own worktree, since the files are disjoint except `routes.ts` registration (one-line merges). 17B follows 17A.
- **Releases.** v0.9.0 = 17A. v0.9.1 = 17B. v0.10.0 = 17C, or 17A+17B together as "Hierarchy and sprints". Each release takes a backup first, gets one independent review, and runs `/security-review` after 17A (Bin cascade) and 17C (views ACL). QA is delegated with a running QA instance per the memory rule.
- **Suggested commits for 17A:**
  - `feat: add task hierarchy migration 019`
  - `feat: add parent and level to cards with invariants`
  - `feat: roll up subtask progress on the board`
  - `feat: bin and restore card subtrees together`
  - `feat: edit board structure with presets`
  - `feat: show subtasks and parent in the card dialog`
  - `feat: show hierarchy chips on the board and reparent by drag`
  - `feat: create boards from templates`
  - `feat: show parent titles in Today and the calendar overlay`
  - `feat: expose card hierarchy to MCP task tools`
- **Suggested commits for 17B:**
  - `feat: add board sprints API`
  - `feat: complete sprints with carry-over`
  - `feat: switch and track sprints on the board`
  - `feat: expose sprints to MCP`
- **Suggested commits for 17C:**
  - `feat: add shared task filter grammar`
  - `feat: add cross-board card query`
  - `feat: add task views migration 020 and API`
  - `feat: add Tasks home with My work and Views`
  - `feat: save and share task views`
  - `feat: set column state in board settings`
  - `feat: add list_views and query_cards MCP tools`
- **Estimate.** About 8 worker sessions, and 3–4 days of wall time with 17A and 17C's server work in parallel.

---

## 13. Open decisions (the defaults apply unless the operator overrides them)

| # | Question | Recommended default |
| --- | --- | --- |
| Q1 | Should a sprint be a card level ("Sprint" cards) or its own entity? | **Its own entity** (D124). The UI still reads "Sprint › Task › Subtask". |
| Q2 | Who manages sprints: owner only or any member? | **Owner only** (D132), consistent with columns. Revisit with Team roles, since an "editor" role could manage them. |
| Q3 | Maximum depth? | **3 levels** (D121). Custom names up to 24 chars. |
| Q4 | Story points and a burndown chart? | **No, not in v1.** Counts and a progress strip only. Add an optional `estimate` field later if a scrum team asks. |
| Q5 | Should a parent auto-close when all its children are done (Linear)? | **No.** A toast suggests it (D125). A per-board "auto-complete parents" switch can come later. |
| Q6 | How are subtasks ordered inside the parent: their own sibling order, or column and position? | **Column order, then position** (no new field). Add `child_position` only if users ask to hand-order checklists. |
| Q7 | Do WIP limits count every level? | **Every card in the column counts.** A "work level only" option comes later. |
| Q8 | Cross-board parents? | **No, not in v1** (D133). Use views to aggregate and relations to link. |
| Q9 | Drag cards between state lanes in cross-board views? | **Not in v1** (D143). Use "Move to…" per card. |
| Q10 | Where does code shared by server and client live? | **A new top-level `shared/`**, with `tsconfig` and Vite includes. Fallback: a duplicate module plus a parity test. |
| Q11 | Query statement budget | Start with **bounds only** (readable boards, keyset, limit 100, rate limit) and the perf fixture. Add a progress-handler interrupt only if p95 > 150 ms. |
| Q12 | Can Team viewers and guests save views? | **Private views yes, sharing no.** Guests get only `assignee:me` in My work. |
| Q13 | May a shared view be edited by recipients (Jira "editors")? | **No.** Only the owner edits, and recipients duplicate. |
| Q14 | One migration or two? | **Two:** 019 for hierarchy and sprints in 17A, 020 for views in 17C, so each sub-wave is independently releasable. Fold them into one only if 17A and 17C ship in a single release. |
| Q15 | Should Wave 13 drop the reserved `'parent'` relation kind? | **Yes, before 015 ships** (D120). |
| Q16 | Default layout of My work at 390 px | **A grouped list by due bucket.** Table and board are one tap away. |

---

## Sources

[jira-h]: https://products.seibert.group/blog/jira-story-vs-task-vs-epic
[jira-sprint]: https://support.atlassian.com/jira-software-cloud/docs/complete-a-sprint/
[jira-share]: https://support.atlassian.com/jira/kb/how-to-share-a-dashboard-or-filter-ie-make-it-public-change-its-viewers-and-editor-permissions/
[jira-manage]: https://support.atlassian.com/jira-cloud-administration/docs/manage-shared-filters/
[lin-sub]: https://linear.app/docs/parent-and-sub-issues
[lin-cyc]: https://linear.app/docs/use-cycles
[lin-views]: https://linear.app/docs/custom-views
[lin-filters]: https://linear.app/docs/filters
[lin-auto]: https://linear.app/changelog/2024-09-06-auto-close-parent-and-sub-issues
[gh-sub]: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
[gh-iter]: https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-iteration-fields
[gh-prog]: https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-parent-issue-and-sub-issue-progress-fields
[gh-views]: https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/changing-the-layout-of-a-view
[trello-cl]: https://support.atlassian.com/trello/docs/adding-checklists-to-cards/
[asana-sub]: https://help.asana.com/s/article/subtasks?language=en_US
[asana-tips]: https://asana.com/resources/asana-tips-subtasks
[asana-my]: https://asana.com/features/project-management/my-tasks
[notion-sub]: https://www.notion.com/help/tasks-and-dependencies
[notion-sprint]: https://www.notion.com/help/sprints
[shortcut]: https://help.shortcut.com/hc/en-us/articles/26590478333588-Transition-from-Asana-to-Shortcut
[height]: https://www.creativerly.com/height-app-is-shutting-down/
[plane-wi]: https://docs.plane.so/core-concepts/issues/overview
[plane-core]: https://docs.plane.so/introduction/core-concepts
[plane-views]: https://docs.plane.so/core-concepts/views
[vik-rel]: https://vikunja.io/help/task-relations/
[vik-views]: https://vikunja.io/help/views/
[focal-sub]: https://github.com/mattermost/focalboard/issues/252
[focal-sprint]: https://mattermost.com/blog/mattermost-boards-how-to-sprint-planning/
[huly]: https://docs.huly.io/task-tracking/creating-issues/
[parabol]: https://www.parabol.co/blog/most-popular-agile-methodologies/

- Jira hierarchy: <https://products.seibert.group/blog/jira-story-vs-task-vs-epic> · complete a sprint: <https://support.atlassian.com/jira-software-cloud/docs/complete-a-sprint/> · share filters: <https://support.atlassian.com/jira/kb/how-to-share-a-dashboard-or-filter-ie-make-it-public-change-its-viewers-and-editor-permissions/> · manage filters: <https://support.atlassian.com/jira-cloud-administration/docs/manage-shared-filters/>
- Linear sub-issues: <https://linear.app/docs/parent-and-sub-issues> · cycles: <https://linear.app/docs/use-cycles> · custom views: <https://linear.app/docs/custom-views> · filters: <https://linear.app/docs/filters> · auto-close: <https://linear.app/changelog/2024-09-06-auto-close-parent-and-sub-issues>
- GitHub sub-issues: <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues> · iterations: <https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-iteration-fields> · progress fields: <https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-parent-issue-and-sub-issue-progress-fields> · layouts: <https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/changing-the-layout-of-a-view>
- Trello checklists: <https://support.atlassian.com/trello/docs/adding-checklists-to-cards/> · Asana subtasks: <https://help.asana.com/s/article/subtasks?language=en_US>, <https://asana.com/resources/asana-tips-subtasks> · My tasks: <https://asana.com/features/project-management/my-tasks>
- Notion sub-items: <https://www.notion.com/help/tasks-and-dependencies> · sprints: <https://www.notion.com/help/sprints> · Shortcut: <https://help.shortcut.com/hc/en-us/articles/26590478333588-Transition-from-Asana-to-Shortcut> · Height shutdown: <https://www.creativerly.com/height-app-is-shutting-down/>
- Plane: <https://docs.plane.so/core-concepts/issues/overview>, <https://docs.plane.so/introduction/core-concepts>, <https://docs.plane.so/core-concepts/views> · Vikunja: <https://vikunja.io/help/task-relations/>, <https://vikunja.io/help/views/> · Focalboard: <https://github.com/mattermost/focalboard/issues/252>, <https://mattermost.com/blog/mattermost-boards-how-to-sprint-planning/> · Huly: <https://docs.huly.io/task-tracking/creating-issues/>
- Methodology usage: <https://www.parabol.co/blog/most-popular-agile-methodologies/>

---

## 14. Director review (2026-09-26)

Accepted as the plan of record with these rulings:

- **All Q1–Q16 defaults are accepted**: sprints are their own entity, owner-managed; three levels max; counts only, no points or burndown; no auto-close of parents; no cross-board parents; two migrations (019 hierarchy + sprints, 020 views); viewers save private views only; recipients cannot edit shared views; Wave 13 drops the reserved `'parent'` relation kind (already instructed to the 13B implementer).
- **Decision numbers are D120–D145** (renumbered; Wave 13 holds D100–D115, Team D71–D82). References in §8 to Wave 13 decisions by number were written against an earlier draft; read them by topic against `docs/plan/WAVE_13_TASK_CARD_UX.md` §1 (D100–D115). Threat rows T110–T121 stand.
- **Wave numbers:** 17A Hierarchy, 17B Sprints, 17C Tasks home and views, as suggested. 17A starts after 13A and 13B merge; 17C's server half (020, grammar, query) may start as soon as 13B's server half merges, in its own worktree. 13E's filter bar is built on the shared grammar module from §10.3 from the start, so 13E and 17C share one parser (the 13E implementer will be told).
- **`shared/`** top-level directory for code used by server and client is approved (Q10).
- **Releases:** v0.9.0 = 17A, v0.9.1 = 17B, v0.10.0 = 17C, each with backup, review, delegated QA.

- **Q11 ruling (2026-09-26, after 17C server perf):** default fixture p95 15–41 ms; a 500k-readable-card fixture gives 34 ms for `assignee:me state:todo,doing` after the index-driven plan but 0.8–1.9 s for unselective queries. bun:sqlite has no statement interrupt, so the budget stays **bounds only** for v0.9: limit ≤100, `total` ≤1000, 30 req/10 s, indexes on assignee/tag/flag. 17C UI must not issue unselective cross-board queries by default (My work always carries `assignee:me`; the Views page requires at least one key or `board:`). Revisit with a worker-thread query or a row-count cap on `all_users` boards if a real install shows p95 > 150 ms.
- **17C server merged status:** branch complete (migration 020, grammar, `POST /api/tasks/query`, views CRUD/sharing, MCP `list_views`/`query_cards`, 840 tests); held until v0.8.0 ships, then merged as the first 17C commit set. 13E builds on its grammar.

## 15. Collapsed columns, the filter bar's order, and auto-archived done cards (lane TASKS, 2026-10-22)

Operator, 2026-10-22: collapse and expand a column (narrow, its cards hidden, its name and count kept); keep the filter selector on the left with applied filters after it; and auto-archive cards in done columns after N days (30 by default), hidden from the board, with a board-settings checkbox to show them. Migration 074, threats T433–T434, tests in `tests/tasksArchive.test.ts` and `tests/tasksCollapse.test.tsx`.

| ID | Decision | Why |
| --- | --- | --- |
| D602 | **Collapse is each person's own view of a board, kept on the server** (`board_view_prefs.collapsed_columns`, `PUT /api/tasks/boards/:b/view`), so it follows them to every device and never changes the board for anyone else; every reader may collapse (the ⋯ menu's **Collapse** for owners, a fold button in every column header, shown on hover like the move arrows and always on touch screens). On desktop a collapsed column is a 44 px strip: one button holding Expand, the count badge, and the name written top to bottom. **A card dropped on the strip goes to the column's top and the column stays collapsed**; `Alt` + → onto it does the same and focus moves to the strip, with an announcement. On phones (one column per page) a collapsed column keeps its page and header and shows "Collapsed, N cards hidden · Expand", and its tab is dimmed. | Collapse is a reading aid like a sort: one person hiding Done must not hide it for the team. Dropping on a collapsed Done column is how people finish cards; expanding it on every drop would undo the collapse each time, and the strip shows no cards to aim between, so the top (newest first) is the predictable place. |
| D603 | **`cards.done_at` is when the card last came into a done column** (`board_columns.state = 'done'`, the existing done notion from migration 020; no new flag). It is set on create in a done column, on a move in from a column that is not done, and for a column's cards when the column becomes done; a move between two done columns keeps it; leaving a done column or the column leaving done clears it. Migration 074 backfills it from `updated_at` for live cards already in a done column. | Moving a card out and back is "re-entering", so its clock starts again; moving between Done and Shipped is still done. `updated_at` changes on every move, so it is never earlier than the move into the column: the backfill can only archive later than the truth, never earlier. The audit log was not used: it may be pruned and has no entry for cards created in Done. |
| D604 | **Auto-archive is per board: `boards.auto_archive_days`, 1–365, or NULL for off; 30 and on for new and existing boards.** The owner or a manager sets it in Board settings → Done cards (`PATCH /boards/:b { autoArchiveDays }`, audited `task.board_auto_archive`). The hourly sweep (and the boot sweep) archives due cards 500 per transaction, each UPDATE re-checking every condition, and writes one `task.cards_auto_archived { boardId, count, days }` audit row per board and batch with a null actor (the system). Binned boards and cards are skipped. Columns named "Completed" are not turned into done columns: the column's state (To do, In progress, Done, in its ⋯ menu) is the one notion of done, already used by Today, views, subtask ticks, and blockers. | The operator asked for 30 days as the default. Existing boards get it too, announced in the upgrade notes with a one-line way back, because archiving only hides and is restorable. Renaming-based detection would silently change Today and views for those boards. |
| D605 | **Archiving sets `cards.archived_at` on a live card: never the Bin, never a delete.** The card keeps its column, position, sprint, relations, comments, and files; it counts toward the 1,000-card board cap (bin it to free room) but not toward WIP limits, and a column whose remaining cards are all archived refuses deletion with a message saying so. It comes back with **Restore to board** in the card (`POST /cards/:k/unarchive`, edit level, audited `task.card_unarchive`), by moving it to another column, or by a Bin restore (since D610 a column that stops being done no longer unarchives its cards); in a done column its clock restarts so the next sweep does not take it straight back. | Hidden cards must not silently fill a column's WIP limit or block a delete without saying why. Manual "Archive" was not asked for; the column menu and card stay as they were. |
| D606 | **"Show auto-archived cards" is per person too** (`board_view_prefs.show_archived`, Board settings → Display, "Only for you"). With it on, `GET /boards/:b` includes archived cards, marked with an **Archived** chip and a dashed border on lane cards, and the chip in Table, List, and Calendar rows; the card dialog says when it was archived. Off (the default), the board payload leaves them out and the header count leaves them out too. | The checkbox lives in board settings as asked, but a viewer revealing old cards should not clutter everyone's board. Filtering on the server keeps the payload small on long-lived boards. |
| D607 | **Search, task views, and MCP keep their semantics: archived cards are still listed, flagged.** MCP card payloads add `archived` and `archived_at`; `list_cards` takes `archived: true` (only archived) or `false` (leave them out), omitted lists both; `list_cards`'s board adds `auto_archive_days`; `search_cards` and `GET /cards/search` add `is_archived`. | An agent that lists a board must not lose cards because a sweep ran; it can now tell them apart and filter. |
| D608 | **The filter bar's order is fixed: + Filter, the text box, the applied filter chips, the filter being edited, Clear, then the count.** + Filter stays visible while a filter is being edited (it used to be replaced by the editor, which moved everything after it). Applied to the board filter bar and to Tasks home's (My work, views, shared views). Reports' filter bar is a different component whose fields are always shown, so it is unchanged; no screen outside Tasks changed. | Operator: the selector moved right as chips were added. Keeping the controls first means they never move; chips grow to the right. |
| D610 | **Archive by hand** (coordinator follow-up, 2026-10-22: the operator prefers ease of use): **Archive** in a card's ⋯ menu and in its dialog, for anyone who can edit cards (`POST /cards/:k/archive`, audited `task.card_archive`), in any column; the toast offers **Undo** (an unarchive), and the ⋯ menu of an archived card offers **Unarchive**. It sets the same `archived_at` as the sweep, so one "Show archived cards" (renamed from "Show auto-archived cards") reveals both. A column that stops being done now keeps its cards' archives (a hand archive in a former Done column must not reappear). Tasks home rows and table and the relation picker mark archived cards (`archived_at` on `POST /api/tasks/query`, `is_archived` in card search). MCP has no archive tool yet. | One click to tidy a board, with the same safety as the sweep: nothing is deleted, and Undo is right there. |
| D609 | **The view is not audited and is trimmed**: `PUT /view` takes at most 40 UUIDs, drops ids that are not columns of this board (a column deleted meanwhile) and stores the rest in board order; non-readers get 404. The board payload never sends `done_at` and sends `archived_at` only on an archived card, so a 1,000-card board stays under the D113 ceiling. | View state is like a sort order (no security meaning); the trim test caught 33 bytes a card. |


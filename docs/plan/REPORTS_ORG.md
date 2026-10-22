# Report organization at scale: favorites, shared folders, lists

Status: **phases 1 and 2 shipped (2026-10-15)**; **phase 3 (lists) built (2026-10-22, lane LISTS, migration 068)**. Phase 1 follows Tableau's favorites. **Phase 2 was simplified by the operator**: folders only group, permissions sit on each report, and reports can have several owners.
- Content lives in shared folders whose access passes down to everything inside.
- People keep personal shortcuts as favorites.
- Optional lists group reports without moving them.

This replaces two earlier TODO items: "a reader's own placement of shared reports" and "fold report shares into `group_grants`" (D460).

Next free ids at planning time: migration **061** (060 is the Files `document_fts` index), decision **D481**, threat **T389**.

## Findings that shape the plan

1. **Folder sharing does not pass down today.** D3 and D271, `server/folders.ts` and `readableDocumentPredicate` all keep folder sharing to the immediate folder. Report folders that pass access down are a reports-only exception (D481). Files and Notes are unchanged.
2. **The inheritance shape comes from Files.** Files has a folder audience plus `selected` shares, checked with `groupGrantExists`. Reports reuse that shape and add a walk up the ancestors, capped at 3 levels (`REPORT_FOLDER_DEPTH`).
3. **`group_grants` has never been rebuilt.** It was created in 025. Rebuilding it has to handle:
   - the `access_grants_v` view (041);
   - the `group_grants_no_system_folder` trigger (046);
   - triggers on other tables that delete from `group_grants`, kept with `legacy_alter_table = ON` as in 050.
4. **Report shares are view or comment only.** Anything that changes a report is `ownedReport` (D455), so a folder editor needs a new report level, `edit`.
5. **D459 redaction applies to any non-owner.** It keys off "author ≠ owner", so it already covers editors.

## Phase 1: favorites and scale (migration 061)

**Shipped (2026-10-15).** D486: a favorite is the person's own shortcut, never a grant; every list and count reads it through `readableReportSql`, so it drops out when access is lost (T393) and returns with it. The list is paged by keyset, 100 a page, with an opaque cursor; only the filters in use are written into the SQL, so SQLite picks `reports_owner`, `reports_status`, `reports_live_recent` (`(updated_at DESC, id)`, added beside the planned status index) or the favorites' key. The nav's counts and the Owner filter's choices come from one `GROUP BY` by place and owner. Filters live in the URL query (`?owner=&status=&datasource=&schedule=`); on a phone they open in a bottom sheet (`reports.filters`). At 2,000 reports, 300 folders and 50 groups a page costs about 0.3–2.4 ms of CPU (`tests/reportFavorites.test.ts`).

**Data**
- `report_favorites(user_id, report_id, created_at)`: primary key on both columns, cascades from users and reports.
- A partial index `reports_status`.

**Server**
- `listReports` gets keyset pagination on `(updated_at DESC, id)`, 100 rows a page, with an opaque cursor.
- Filters: `ownerId`, `status[]`, `datasourceId`, `scheduled`, `favorites`, `folderId` (the folder or its whole subtree), and `q`.
- Folder counts come from a single `GROUP BY` over the readable set.
- Starring a report you can't read is refused.
- Favorites drop out of lists automatically when access is lost.

**UI**
- ☆/★ on each report row and on the report header, toggled optimistically.
- **Favorites** in the left nav.
- A filter bar for owner, status, data source and schedule. Filters live in the URL, so Back and Forward restore them.
- Infinite scroll with a "Load more" fallback.
- On a phone, filters open in a bottom sheet.

**MCP**
- `list_reports` gains the new filters and the cursor.
- New tools `star_report` and `unstar_report`.

**Test:** 2,000 reports, 300 folders and 50 groups. The list must return in under 50 ms, and the query plans must use the indexes.

## Phase 2: simple permissions; folders only group (migration 062)

**Shipped (2026-10-15), migration 062.** As built:
- `reports.owner_id` is kept as the **primary owner** (the creator until they leave the owners, always one of them via triggers, the person scheduled refreshes and the edit agent run as). Dropping it would have rippled through the scheduler, the edit agent, versions, and quotas; owner checks all read `report_owners`.
- `report_folders` is rebuilt without `owner_id` (`created_by`, SET NULL), keeping every report's `folder_id`. Two people's same-named folders are both kept; the nav names the creator beside such siblings (never a merge, which would move reports their owners filed).
- Last owner: removing them is refused (`LAST_OWNER`). Blocking an owner or making them a guest hands reports with no other active owner to an admin (the one acting, else the oldest active admin), audited `reports.owner.handover`; Nook had no ownership-transfer pattern to reuse.
- Admins manage owners of any report but are not owners by role (unchanged: they never were).
- Only admins see, restore, or purge binned folders. **Policy (D502):** deleting a report folder stays in the app; no MCP tool deletes, bins, restores, or purges one (D180). `update_report_folder` renames and moves (admins).
- **Settings → Report owners (D500, T399):** admins find reports nobody can manage (every owner blocked, now a guest or a viewer, or gone) and reports they cannot open, by title, folder, owners and last change, and add an owner from the report's Owners sheet (the same audited owners API). MCP: `list_unmanaged_reports` (admins).
- **Scale (D501):** checked at 50,000 and 200,000 reports with 1,000 folders (`tests/reportListScale.test.ts`, opt-in with `NOOK_PERF=1`). The folder subtree stayed at 0.4–2 ms a page; the Owner filter and Favorites had degraded (98 and 62 ms at 50,000) and now pick, per request, between starting from the set and walking `reports_live_recent`, by the set's size. Every filter is 0.3–14 ms of CPU a page; no migration.

**Operator decision (2026-10-15).** Keep permissions simple:
- Permissions live on the **report**.
- **Folders are only for grouping** and never grant or limit access (no inheritance).
- A report can have **several owners**. An owner or an admin can make someone else an owner.
- An owner can change the report's folder, its sharing, and its other permissions.

**Data**
- `report_owners(report_id, user_id, added_by, created_at)`.
- Migrate every `reports.owner_id` into this table. Keep `owner_id` as the creator, or drop it if that is cleaner.
- `report_folders` becomes a **workspace-wide grouping tree** (confirmed by the operator, 2026-10-15):
  - Every member sees the same folders.
  - A folder shows only the reports that person can read.
  - Empty folders are visible to members; guests see none.
- **Folder rights** (operator decision, 2026-10-15):
  - Any member (not a guest) can **create** a folder.
  - Only **admins** can **rename, move, reorder or delete** folders, so nobody else can reorganize the shared tree.
  - A deleted folder goes to the Bin. Its reports move to Unfiled and return when the folder is restored.
  - Filing a report into a folder stays the report owner's right.
- Folders have no sharing and no levels.

**Access**
- Report sharing stays as it is today (view / comment, people, groups, everyone). The `group_grants` fold (D460) is optional cleanup, not required.
- Everything owner-only today (D455, D459) becomes "any owner of the report".
- An admin can manage the owners of any report, so an orphaned report can always be recovered.
- A report must keep at least one owner. Removing the last owner is refused.
- Blocking or deleting a user who is the last owner hands the report to an admin, or flags it. This uses the existing module's ownership-transfer pattern if one exists.

**UI**
- The Share sheet gets an **Owners** section: add or remove owners, shown to owners and admins.
- Owners can also move the report to another folder. Folder navigation is the same tree for everyone.
- Row badges show the person's level on that report.

**MCP**
- `list_report_owners`.
- Owners and admins can call `add_report_owner` under `reports:write` (audited). Owner removal is app-only (D180): no `remove_report_owner` tool.

**Threats**
| Id | Threat | Mitigation |
|---|---|---|
| T389 | An extra owner gets doc or proposal access | Expected: they are an owner. The audit records who added them. |
| T390 | Removing the last owner orphans the report | Refused. Admin recovery. |
| T391 | Folder titles leak report titles | A folder lists only readable reports, and the counts are per-viewer. |

**Decisions**
- D481: Folders only group and never grant access.
- D482: Reports have several owners, and admins manage owners.
- D483: The workspace-wide folder tree.
- Leftovers, 2026-10-15: D500 (Settings → Report owners), D501 (the list at 50,000 reports), D502 (folder deletion is app-only, by policy); T399.

## Phase 3: report lists (migration 068)

**Built (2026-10-22, lane LISTS), migration 068.** A list groups reports without moving them, in an order its curators choose; a report sits in many lists. "Lists", because Nook already has Collections.

**Data**
- `report_lists(id, owner_id, name, visibility, created_at, updated_at, deleted_at, deleted_by, purge_after, purge_started_at)`: one owner; `visibility` is the reports' own audience (`private`, `selected`, `all_users`).
- `report_list_items(list_id, report_id, position, added_by, added_at)`: primary key on both ids; `report_list_items_order (list_id, position, report_id)` is the list's order and its page's keyset; `report_list_items_report` serves the cascade when a report is purged.
- `report_list_members(list_id, user_id, level)` and `report_list_group_shares(list_id, group_id, level)`, `level` `view` or `edit`.

**Decisions**
- **D550 A list never grants access** (D487 made concrete). Its page is `GET /api/reports?list=` through `readableReportSql`; its counts are per viewer; adding a report needs one the curator can open (the same 404 as a missing one), so no title ever enters a list unseen by the person who put it there. Sharing a list shares no report in it.
- **D551 Sharing in the reports' shape, not `group_grants`.** `group_grants.resource_kind` has a CHECK listing its kinds, and 025's table has never been rebuilt (finding 3 above: the `access_grants_v` view, the 046 trigger, other tables' triggers). Lists copy `report_members` / `report_group_shares` (052) with their own levels: `view` sees the list, `edit` curates it (add, remove, reorder). `all_users` is every person at view, never guests (AUDIENCE_ALL_USERS); a Team viewer is capped at view (D266). Group pages count list shares, and the guest-join rule (T213) treats one as a grant; Team → member access lists a person's list shares (direct and through groups, the name only when the viewer can see the list) beside their report shares, and Reset access removes the direct ones.
- **D552 "N reports you can't open", for curators only.** `hidden` is the live reports in the list the caller can't open, shown to its owner and people at `edit` (who would otherwise wonder why the list looks short, and may remove them by asking the owner), never to readers, never with titles, and never to an MCP key over chosen reports. Binned reports are not counted.
- **D553 Delete goes to the owner's Bin; the owner restores.** A list is a person's, like a report (D419), and may be private, so the owner alone lists, restores, purges, and empties it; admins get no reach into it. This differs from folders (D483), which are the workspace's tree and so the admins'. Its items and shares wait in the Bin with it.
- **D554 Limits:** 300 live lists per owner, 5,000 reports per list, 100 shares per list.
- **D555 Order.** Positions are 0…n; a move splices the whole order and rewrites only the rows whose position changed (a move from the end of a 2,000-report list to its top: 13.7 ms of CPU; an add at its end, with the new counts: 5.7 ms). A curator moves a report they can open just before or after another they can open; the reports they can't open keep their places relative to each other. In the app: drag a row (an insertion line shows where it lands; only without a title search or filters), or Move up / Move down in the row's ⋯ menu (keyboards and phones).
- **D556 Scale.** A list's page starts from `report_list_items_order` and checks the readable set and any filter per row, so it never sorts. The nav's lists come from their indexes (the owner's, `report_lists_audience`, the person's and their groups' shares), and every list's counts from one `GROUP BY` over their items (each item is checked once). Measured by `tests/reportLists.test.ts` (300 lists the viewer sees, one of 2,000 reports, 1,000 lists of others they don't): the nav 14.7 ms, a page of the 2,000-report list 2.0 ms, filtered 1.8 ms of CPU; no full scan.
- **D557 MCP:** `list_report_lists` and `get_report_list` (reports:read) and `add_report_to_list` (reports:write, audited). Removing, reordering, renaming, deleting, and sharing are app-only (D180). None is offered to chat agents: a person's lists are their organisation of the Reports home.
- **D558 UI.** **Lists** in the Reports nav under the folders (a list someone else owns names them), New list for members, and a ⋯ menu for the owner (Rename, Share list, Delete list). Each list is a URL, `/reports/lists/:id`, so Back and Forward step between lists, folders, and views at every width. **Add to list…** in a report row's ⋯ menu and an icon button beside the star on the report's page open a picker of the lists the caller curates (each a toggle, plus a new list's name); a report row dropped on a list in the nav adds it there (with Undo). A list's curators get Remove from list (with Undo) and the reorder above, and New report from inside the list adds the new report to its end (from a list the person only views, New report creates it outside the list). On a phone the lists sit in the folder switcher's sheet; the picker and Share list are full-screen sheets and history layers (Back closes, Forward reopens).
- **D559 Phone rows.** A Reports row at 390 px keeps its facts (status, data source, last change) on one line under the title: the data source ends in an ellipsis and the last change shows as "9m" (its full "9 minutes ago" in the tooltip), instead of wrapping onto a fourth line (TODO "Small fixes").

**Threats:** T415 (a list leaks the reports in it), T416 (a list used to advertise or probe reports), T417 (list names reach people who can't open its reports); see docs/plan/THREAT_MODEL.md.

## Threats and decisions

Phase 2's threats and decisions are listed in its section. Phase 1 adds D486 (Favorites) and T393 (favorites never leak, because they are filtered through `readableReportSql`). Phase 3 adds D487 (Lists never grant access), and as built D550–D559 and T415–T417 (its section above).

## Order and parallelism

- **Phase 1** can run alongside the Files `document_fts` work (060), since they share no tables.
- **Phase 2** follows phase 1. It touches `server/reports/access.ts`, `sharing.ts`, the folder files, the gates that change from `ownedReport` to `editableReport`, `server/team/*`, `server/access/*`, `src/reports/ShareSheet.tsx` and `src/access/*`.
- **Phase 3** shipped on its own (migration 068), after phases 1 and 2.
- Each phase is its own release-sized slice.

## Open questions

None. The operator settled them on 2026-10-15: one shared folder tree, and only admins can rename, move or delete folders.

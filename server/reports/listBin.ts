import { registerBinProvider, SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { audit, db, now } from "../db";
import { logger } from "../log";
import { withResourceLock } from "../storage";
import { REPORT_LISTS_PER_USER } from "../../shared/reports";
import type { ListRow } from "./listAccess";

const slog = logger("reports");

/**
 * Report lists in the Bin (phase 3, D553), registered with server/bin.ts beside reports and report
 * folders. A list is its owner's, like a report (D419), so its owner alone lists, restores, and purges
 * it; admins get no reach into it (unlike the workspace's folders, D483, which admins restore). Its items
 * and sharing wait in the Bin with it and come back on restore. Purging deletes the list and, by cascade,
 * its items and shares; no report is touched.
 */

const providedDefaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;
const FOLDER = "Reports";
const lockKey = (id: string) => `report_lists:${id}`;

function purgeNow(id: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE report_lists SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    db.query("DELETE FROM report_lists WHERE id = ?").run(id);
    audit(options.actorId, null, "reports.list.purge", { id, reason: options.reason });
    return "purged";
  })();
}

registerBinProvider("report_list", {
  list(userId) {
    const rows = db.query("SELECT * FROM report_lists WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id LIMIT 500").all(userId) as ListRow[];
    return rows.map((row): BinItem => ({
      type: "report_list", id: row.id, title: row.name, folder_id: null, folder_name: FOLDER, deleted_at: row.deleted_at!, purge_after: row.purge_after!,
      purging: row.purge_started_at !== null, ...providedDefaults, can_purge: true
    }));
  },
  restore(id, userId) {
    return withResourceLock(lockKey(id), async (): Promise<RestoreOutcome> => db.transaction((): RestoreOutcome => {
      const row = db.query("SELECT * FROM report_lists WHERE id = ?").get(id) as ListRow | null;
      if (!row || row.owner_id !== userId) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: id, folderName: row.name };
      const live = (db.query("SELECT COUNT(*) AS n FROM report_lists WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { n: number }).n;
      if (live >= REPORT_LISTS_PER_USER) return { status: "limit_reached", message: `You can have up to ${REPORT_LISTS_PER_USER} report lists` };
      db.query("UPDATE report_lists SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ?").run(now(), id);
      audit(userId, null, "reports.list.restore", { id });
      return { status: "restored", folderId: id, folderName: row.name, visibility: row.visibility };
    })());
  },
  purge(id, userId) {
    return withResourceLock(lockKey(id), async () => {
      const row = db.query("SELECT owner_id, deleted_at FROM report_lists WHERE id = ?").get(id) as Pick<ListRow, "owner_id" | "deleted_at"> | null;
      if (!row || row.owner_id !== userId) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeNow(id, { reason: "user", actorId: userId });
    });
  },
  async sweep(cutoff) {
    const resumed = db.query("SELECT id FROM report_lists WHERE purge_started_at IS NOT NULL LIMIT ?").all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
    const due = db.query("SELECT id FROM report_lists WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
      for (const { id } of items) {
        try {
          const outcome = await withResourceLock(lockKey(id), async () => purgeNow(id, { reason, actorId: null, dueBy: cutoff }));
          if (outcome === "purged") counts.purged += 1;
        } catch (error) {
          counts.pending += 1;
          slog.error("Bin sweep could not purge a report list", error);
        }
      }
    }
    return counts;
  },
  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    const ids = db.query("SELECT id FROM report_lists WHERE owner_id = ? AND deleted_at IS NOT NULL").all(userId) as Array<{ id: string }>;
    for (const { id } of ids) {
      const outcome = await withResourceLock(lockKey(id), async () => purgeNow(id, { reason: "user", actorId: userId }));
      if (outcome === "purged") counts.purged += 1;
    }
    return counts;
  }
});

import type { Migration } from "./types";

/**
 * W3-WIRE audit fix (C5, D1059b): a goal check-in written from a standup answer names the answer it
 * came from (`source_ref` = the response id), unique per goal, so editing or retrying the answer
 * updates that check-in instead of adding another (and notifying again). Check-ins made in Goals
 * have none.
 */
export const goalCheckinSourceMigration: Migration = {
  id: 111,
  name: "goal_checkin_source",
  up(db) {
    const columns = db.query("PRAGMA table_info(goal_checkins)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "source_ref")) db.exec("ALTER TABLE goal_checkins ADD COLUMN source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 80)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS goal_checkins_source ON goal_checkins(goal_id, source_ref) WHERE source_ref IS NOT NULL;");
  }
};

import { addColumn, type Migration } from "./types";

/**
 * Recognised devices and the welcome mail (the outbound email plan's "later" items #9 and #14,
 * docs/plan/research/2026-09-28-outbound-email.md §A.3 as built). Additive only.
 *
 * - `sign_in_devices`: one row per (account, browser) that signed in. The browser holds a random
 *   32-byte device cookie (`mynotes_device`); the row keeps only SHA-256("device:" + user id + ":" +
 *   cookie), so the same browser used by two accounts gives two unrelated hashes. Besides the hash it
 *   keeps a coarse browser family and OS family (codes from a fixed list in server/signInDevices.ts,
 *   never the User-Agent string) and the first-seen and last-seen times. No IP address is stored.
 *   At most 20 rows per account (the code prunes the least recently seen); the rows go with the
 *   account (ON DELETE CASCADE).
 * - `sessions.legacy_device`: 1 for every session that existed before this migration. Such a session
 *   was signed in before devices were recorded, so the first request it makes without a device
 *   cookie enrols its browser quietly (no mail) instead of the next sign-in there looking new.
 *   Sessions created later are 0 and never enrol themselves: only a sign-in records a device.
 * - `users.welcome_mail`: NULL means the account never gets the welcome mail, which is every account
 *   that exists now (and accounts made outside registration, such as the host CLI). Registration and
 *   invite acceptance set `pending`; the first sign-in moves it to `queued` (the mail is in the
 *   outbox), `waiting` (the address is not verified yet; verifying queues it), or `skipped` (email
 *   off, or more than 7 days went by), so the mail is queued at most once.
 * - `users.device_baseline`: 1 for every account that exists now, 0 (the default) for accounts made
 *   later. An account with the flag and no device rows records the browser of its next sign-in
 *   quietly (no mail, no bell), then the flag is cleared; so someone whose pre-044 session expired,
 *   or who signs in from their usual second browser, is not told about a "new" sign-in once after
 *   the upgrade. Any recorded device (that sign-in, or a legacy session's enrolment) clears it.
 *
 * Needs 001 and 026. Transactional and filesystem-free; re-running changes nothing.
 */
export const signInDevicesMigration: Migration = {
  id: 44,
  name: "sign_in_devices",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sign_in_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
        browser TEXT NOT NULL CHECK (length(browser) BETWEEN 1 AND 20),
        os TEXT NOT NULL CHECK (length(os) BETWEEN 1 AND 20),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (user_id, token_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_sign_in_devices_user ON sign_in_devices(user_id, last_seen_at DESC);
    `);
    const hadColumn = (db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some((column) => column.name === "legacy_device");
    addColumn(db, "sessions", "legacy_device", "INTEGER NOT NULL DEFAULT 0 CHECK (legacy_device IN (0,1))");
    if (!hadColumn) db.exec("UPDATE sessions SET legacy_device = 1");
    addColumn(db, "users", "welcome_mail", "TEXT CHECK (welcome_mail IS NULL OR welcome_mail IN ('pending','waiting','queued','skipped'))");
    const hadBaseline = (db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).some((column) => column.name === "device_baseline");
    addColumn(db, "users", "device_baseline", "INTEGER NOT NULL DEFAULT 0 CHECK (device_baseline IN (0,1))");
    if (!hadBaseline) db.exec("UPDATE users SET device_baseline = 1");
  }
};

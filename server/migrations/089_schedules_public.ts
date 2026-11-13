import type { Migration } from "./types";

/**
 * Schedules and public pages (docs/plan/WORKSPACE_MODULES.md §B.6, §B.8, D808, D810).
 *
 * - `schedules`: everything that fires on a clock for the workspace modules (a standup round opens, a
 *   poll closes, a booking reminder goes out), one dispatcher (server/schedules/dispatcher.ts).
 *   `rule_json` is a shared/schedules.ts rule; `next_fire_at` the next instant; `claimed_at` set while
 *   a fire runs. Purposes are namespaced words (`checkins.open`).
 * - `schedule_fires`: at most one row per schedule and occurrence (primary key), written before the
 *   handler runs, so a crash between claim and finish never runs an occurrence twice (T504).
 * - `public_links`: secret links (tokens hashed with SHA-256, shown once; D362/D66 pattern) for
 *   forms, booking types, a booking's manage page, a time-poll guest, a townhall session.
 * - `public_link_usage`: durable per-link submission counts per hour (the per-link limit).
 * - `public_submissions_log`: every public submission's outcome with a salted IP hash, kept 30 days.
 * - `public_nonces`: used render nonces until they expire (no replay, even across a restart).
 * - `public_verifications`: pending email verifications of public submissions (code hashed).
 * - `external_mail_stops`: outside addresses that asked to hear nothing more about an item.
 * - `user_ui_prefs`: per-person unit preferences (week start, duration format), JSON; the existing
 *   `user_preferences.disabled_modules` is an array with a 512-byte cap, so they live here.
 *
 * Needs only 001. Transactional and filesystem-free; re-running changes nothing.
 */
export const schedulesPublicMigration: Migration = {
  id: 89,
  name: "schedules_public",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 3 AND 64 AND purpose GLOB '[a-z]*.[a-z]*' AND purpose NOT GLOB '*[^a-z0-9_.]*'),
        owner_kind TEXT NOT NULL CHECK (length(owner_kind) BETWEEN 1 AND 32 AND owner_kind NOT GLOB '*[^a-z_]*'),
        owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 64),
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        rule_json TEXT NOT NULL CHECK (json_valid(rule_json) AND length(rule_json) <= 4096),
        tz TEXT NOT NULL DEFAULT 'UTC' CHECK (length(tz) BETWEEN 1 AND 64),
        next_fire_at TEXT,
        claimed_at TEXT,
        last_fired_at TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND length(payload_json) <= 8192),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_fire_at) WHERE enabled = 1 AND claimed_at IS NULL;
      CREATE INDEX IF NOT EXISTS schedules_owner ON schedules(owner_kind, owner_id, purpose);
      CREATE INDEX IF NOT EXISTS schedules_claimed ON schedules(claimed_at) WHERE claimed_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS schedule_fires (
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        fire_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','done','failed','skipped_late')),
        error TEXT CHECK (error IS NULL OR length(error) <= 200),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (schedule_id, fire_at)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS schedule_fires_started ON schedule_fires(started_at);

      CREATE TABLE IF NOT EXISTS public_links (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('form','booking_type','booking_manage','time_poll_guest','townhall_session')),
        item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 64),
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        token_prefix TEXT NOT NULL CHECK (length(token_prefix) BETWEEN 4 AND 8),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        max_uses INTEGER CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 1000000),
        use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
        revoked_at TEXT,
        last_used_at TEXT,
        settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json) AND length(settings_json) <= 4096)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS public_links_item ON public_links(kind, item_id) WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS public_link_usage (
        link_id TEXT NOT NULL REFERENCES public_links(id) ON DELETE CASCADE,
        hour TEXT NOT NULL CHECK (length(hour) = 13),
        submissions INTEGER NOT NULL DEFAULT 0 CHECK (submissions >= 0),
        PRIMARY KEY (link_id, hour)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS public_submissions_log (
        id TEXT PRIMARY KEY,
        link_id TEXT REFERENCES public_links(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32 AND kind NOT GLOB '*[^a-z_]*'),
        item_id TEXT CHECK (item_id IS NULL OR length(item_id) <= 64),
        ip_hash TEXT NOT NULL CHECK (length(ip_hash) = 64),
        email_hash TEXT CHECK (email_hash IS NULL OR length(email_hash) = 64),
        outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rate_limited','honeypot','too_fast','replay','invalid','verification_sent','verified','policy_off')),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS public_submissions_log_created ON public_submissions_log(created_at);
      CREATE INDEX IF NOT EXISTS public_submissions_log_email ON public_submissions_log(kind, item_id, email_hash, created_at) WHERE email_hash IS NOT NULL;

      -- Single-use render nonces (§B.8): a submitted nonce is recorded until it would have expired anyway, so a replay fails even across a restart.
      CREATE TABLE IF NOT EXISTS public_nonces (
        nonce_hash TEXT PRIMARY KEY CHECK (length(nonce_hash) = 64),
        expires_at TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS public_nonces_expiry ON public_nonces(expires_at);

      CREATE TABLE IF NOT EXISTS public_verifications (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32 AND kind NOT GLOB '*[^a-z_]*'),
        item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 64),
        link_id TEXT REFERENCES public_links(id) ON DELETE CASCADE,
        email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
        code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 65536),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        expires_at TEXT NOT NULL,
        verified_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS public_verifications_expiry ON public_verifications(expires_at);

      -- "Stop emails about this booking" (§B.7, T508): an outside address that asked to hear nothing more
      -- about one item; item_id is the item's keyed hash (or '*' for anything), never the id itself.
      CREATE TABLE IF NOT EXISTS external_mail_stops (
        address_hash TEXT NOT NULL CHECK (length(address_hash) = 64),
        item_kind TEXT NOT NULL CHECK (item_kind IN ('item')),
        item_id TEXT NOT NULL CHECK (item_id = '*' OR length(item_id) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY (address_hash, item_kind, item_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS user_ui_prefs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        prefs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(prefs_json) AND json_type(prefs_json) = 'object' AND length(prefs_json) <= 2048),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }
};

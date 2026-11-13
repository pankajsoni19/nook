import type { Migration } from "./types";
import { shortIdSql } from "./083_short_ids";

/**
 * Bookings (docs/plan/WORKSPACE_MODULES.md §D.6, D1000–D1039): booking profiles (public handles),
 * availability schedules and date overrides, booking types (the `booking_type` access container),
 * their hosts, bookings, the events made for them, and each host's outside busy feeds (ICS secret
 * addresses, §G.1 Q1: the URL sealed, a busy cache).
 *
 * - `bookings.type_id` is SET NULL when a binned type is purged; `type_title` keeps its name (D1015).
 * - `bookings_host_slot`: one live (pending or confirmed) booking per host and start (D1001's
 *   backstop; overlaps are refused by the re-check inside the same IMMEDIATE transaction).
 * - Every text column has a length CHECK, every JSON column json_valid and a byte cap.
 *
 * Needs 001, 019 (calendars, events), 083, 085–089. Transactional; re-running changes nothing.
 */
const SHORT_ID = `short_id TEXT NOT NULL DEFAULT (${shortIdSql}) CHECK (length(short_id) = 10 AND short_id GLOB '[0-9]*' AND short_id NOT GLOB '*[^0-9a-z]*')`;
const BIN = `deleted_at TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL, purge_after TEXT, purge_started_at TEXT,
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL))`;
const json = (column: string, max: number, fallback: string) => `${column} TEXT NOT NULL DEFAULT '${fallback}' CHECK (json_valid(${column}) AND length(${column}) <= ${max})`;

export const bookingsMigration: Migration = {
  id: 106,
  name: "bookings",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        handle TEXT NOT NULL UNIQUE CHECK (length(handle) BETWEEN 3 AND 30 AND handle = lower(handle)),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
        welcome_md TEXT NOT NULL DEFAULT '' CHECK (length(welcome_md) <= 2000),
        tz TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND 64),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        ${json("busy_calendar_ids_json", 1024, "[]")},
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS booking_handle_aliases (
        handle TEXT PRIMARY KEY CHECK (length(handle) BETWEEN 3 AND 30),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS availability_schedules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        tz TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND 64),
        ${json("rules_json", 4096, "{}")},
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS availability_schedules_default ON availability_schedules(user_id) WHERE is_default = 1;
      CREATE INDEX IF NOT EXISTS availability_schedules_user ON availability_schedules(user_id, name);

      CREATE TABLE IF NOT EXISTS availability_overrides (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES availability_schedules(id) ON DELETE CASCADE,
        date TEXT NOT NULL CHECK (length(date) = 10),
        ranges_json TEXT CHECK (ranges_json IS NULL OR (json_valid(ranges_json) AND length(ranges_json) <= 1024)),
        note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 100),
        UNIQUE (schedule_id, date)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS booking_types (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        owner_id TEXT NOT NULL REFERENCES users(id),
        slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 60 AND slug = lower(slug)),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        description_md TEXT NOT NULL DEFAULT '' CHECK (length(description_md) <= 4000),
        ${json("durations_json", 128, "[30]")},
        location_kind TEXT NOT NULL DEFAULT 'video_link' CHECK (location_kind IN ('in_person','phone','video_link','custom','ask')),
        location_value TEXT NOT NULL DEFAULT '' CHECK (length(location_value) <= 500),
        assignment TEXT NOT NULL DEFAULT 'single' CHECK (assignment IN ('single','round_robin','collective')),
        schedule_id TEXT REFERENCES availability_schedules(id) ON DELETE SET NULL,
        calendar_id TEXT REFERENCES calendars(id) ON DELETE SET NULL,
        ${json("busy_calendar_ids_json", 1024, "[]")},
        include_all_day_busy INTEGER NOT NULL DEFAULT 0 CHECK (include_all_day_busy IN (0,1)),
        buffer_before_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 240),
        buffer_after_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_min BETWEEN 0 AND 240),
        min_notice_min INTEGER NOT NULL DEFAULT 240 CHECK (min_notice_min BETWEEN 0 AND 43200),
        max_days_ahead INTEGER NOT NULL DEFAULT 60 CHECK (max_days_ahead BETWEEN 1 AND 365),
        date_from TEXT CHECK (date_from IS NULL OR length(date_from) = 10),
        date_to TEXT CHECK (date_to IS NULL OR length(date_to) = 10),
        slot_interval_min INTEGER NOT NULL DEFAULT 30 CHECK (slot_interval_min IN (5,10,15,20,30,60)),
        daily_limit INTEGER CHECK (daily_limit IS NULL OR daily_limit BETWEEN 1 AND 100),
        weekly_limit INTEGER CHECK (weekly_limit IS NULL OR weekly_limit BETWEEN 1 AND 500),
        confirm TEXT NOT NULL DEFAULT 'auto' CHECK (confirm IN ('auto','manual')),
        pending_hours INTEGER NOT NULL DEFAULT 24 CHECK (pending_hours BETWEEN 1 AND 168),
        verify_email INTEGER NOT NULL DEFAULT 0 CHECK (verify_email IN (0,1)),
        hourly_cap INTEGER NOT NULL DEFAULT 20 CHECK (hourly_cap BETWEEN 1 AND 500),
        contact_book_id TEXT REFERENCES contact_books(id) ON DELETE SET NULL,
        card_json TEXT CHECK (card_json IS NULL OR (json_valid(card_json) AND length(card_json) <= 2048)),
        ${json("reminders_json", 512, '{"offsets":[1440,60],"booker":true,"host":true}')},
        color TEXT NOT NULL DEFAULT '#f6c453' CHECK (length(color) <= 9),
        public INTEGER NOT NULL DEFAULT 1 CHECK (public IN (0,1)),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        share_role TEXT NOT NULL DEFAULT 'view' CHECK (share_role IN ('view','comment','edit','manage')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ${BIN}
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS booking_types_short_id ON booking_types(short_id);
      CREATE UNIQUE INDEX IF NOT EXISTS booking_types_slug ON booking_types(owner_id, slug);
      CREATE INDEX IF NOT EXISTS booking_types_owner ON booking_types(owner_id, deleted_at);

      CREATE TABLE IF NOT EXISTS booking_type_hosts (
        type_id TEXT NOT NULL REFERENCES booking_types(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 10),
        calendar_id TEXT REFERENCES calendars(id) ON DELETE SET NULL,
        schedule_id TEXT REFERENCES availability_schedules(id) ON DELETE SET NULL,
        PRIMARY KEY (type_id, user_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS booking_type_hosts_user ON booking_type_hosts(user_id);

      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        type_id TEXT REFERENCES booking_types(id) ON DELETE SET NULL,
        type_title TEXT NOT NULL CHECK (length(type_title) BETWEEN 1 AND 120),
        host_id TEXT NOT NULL REFERENCES users(id),
        start_utc TEXT NOT NULL CHECK (length(start_utc) = 24),
        end_utc TEXT NOT NULL CHECK (length(end_utc) = 24),
        duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 720),
        buffer_before_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 240),
        buffer_after_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_min BETWEEN 0 AND 240),
        booker_tz TEXT NOT NULL CHECK (length(booker_tz) BETWEEN 1 AND 64),
        status TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled','declined','expired','completed','no_show')),
        booker_name TEXT NOT NULL CHECK (length(booker_name) BETWEEN 1 AND 120),
        booker_email TEXT NOT NULL CHECK (length(booker_email) BETWEEN 3 AND 254),
        booker_email_norm TEXT NOT NULL CHECK (length(booker_email_norm) BETWEEN 3 AND 254),
        ${json("guests_json", 2048, "[]")},
        location_kind TEXT NOT NULL CHECK (location_kind IN ('in_person','phone','video_link','custom','ask')),
        location_resolved TEXT NOT NULL DEFAULT '' CHECK (length(location_resolved) <= 500),
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        response_id TEXT REFERENCES responses(id) ON DELETE SET NULL,
        card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
        rescheduled_from_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
        cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
        cancelled_by TEXT CHECK (cancelled_by IS NULL OR cancelled_by IN ('host','booker','system')),
        source TEXT NOT NULL CHECK (source IN ('public','secret_link','internal','mcp')),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS bookings_short_id ON bookings(short_id);
      CREATE UNIQUE INDEX IF NOT EXISTS bookings_host_slot ON bookings(host_id, start_utc) WHERE status IN ('pending','confirmed');
      CREATE INDEX IF NOT EXISTS bookings_host_live ON bookings(host_id, start_utc) WHERE status IN ('pending','confirmed');
      CREATE INDEX IF NOT EXISTS bookings_host_start ON bookings(host_id, start_utc, id);
      CREATE INDEX IF NOT EXISTS bookings_type_start ON bookings(type_id, start_utc);
      CREATE INDEX IF NOT EXISTS bookings_booker ON bookings(booker_email_norm, type_id, status);

      CREATE TABLE IF NOT EXISTS booking_events (
        booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
        PRIMARY KEY (booking_id, host_id)
      ) STRICT;

      -- Collective bookings: every host besides the lead (host_id) holds the slot too.
      CREATE TABLE IF NOT EXISTS booking_cohosts (
        booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (booking_id, user_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS booking_cohosts_user ON booking_cohosts(user_id);

      CREATE TABLE IF NOT EXISTS booking_feeds (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
        url_ct TEXT NOT NULL CHECK (length(url_ct) <= 4096),
        url_hint TEXT NOT NULL CHECK (length(url_hint) <= 120),
        ${json("busy_json", 524288, "[]")},
        last_fetched_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'new' CHECK (last_status IN ('new','ok','error')),
        last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS booking_feeds_user ON booking_feeds(user_id);
    `);
  }
};

import type { Migration } from "./types";

/**
 * Bookings search and purge (D1016): an FTS5 index of booker names and emails and the type title
 * (kept by triggers), and purge triggers that remove what other tables hold about a purged booking
 * type or a deleted booking (work links, item activity and comments, member rows, key grants,
 * public links, schedules).
 */
export const bookingsSearchMigration: Migration = {
  id: 107,
  name: "bookings_fts",
  up(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS bookings_fts USING fts5(booker_name, booker_email, type_title, content='bookings', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS bookings_fts_insert AFTER INSERT ON bookings BEGIN
        INSERT INTO bookings_fts(rowid, booker_name, booker_email, type_title) VALUES (NEW.rowid, NEW.booker_name, NEW.booker_email, NEW.type_title);
      END;
      CREATE TRIGGER IF NOT EXISTS bookings_fts_delete AFTER DELETE ON bookings BEGIN
        INSERT INTO bookings_fts(bookings_fts, rowid, booker_name, booker_email, type_title) VALUES ('delete', OLD.rowid, OLD.booker_name, OLD.booker_email, OLD.type_title);
      END;
      CREATE TRIGGER IF NOT EXISTS bookings_fts_update AFTER UPDATE OF booker_name, booker_email, type_title ON bookings BEGIN
        INSERT INTO bookings_fts(bookings_fts, rowid, booker_name, booker_email, type_title) VALUES ('delete', OLD.rowid, OLD.booker_name, OLD.booker_email, OLD.type_title);
        INSERT INTO bookings_fts(rowid, booker_name, booker_email, type_title) VALUES (NEW.rowid, NEW.booker_name, NEW.booker_email, NEW.type_title);
      END;

      CREATE TRIGGER IF NOT EXISTS booking_types_purge AFTER DELETE ON booking_types BEGIN
        DELETE FROM item_members WHERE item_kind = 'booking_type' AND item_id = OLD.id;
        DELETE FROM item_group_grants WHERE item_kind = 'booking_type' AND item_id = OLD.id;
        DELETE FROM api_key_grants WHERE resource_kind = 'booking_type' AND resource_id = OLD.id;
        DELETE FROM work_links WHERE (a_kind = 'booking_type' AND a_id = OLD.id) OR (b_kind = 'booking_type' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'booking_type' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'booking_type' AND item_id = OLD.id;
        DELETE FROM public_links WHERE kind = 'booking_type' AND item_id = OLD.id;
        DELETE FROM schedules WHERE owner_kind = 'booking_type' AND owner_id = OLD.id;
        DELETE FROM question_sets WHERE host_kind = 'booking_type' AND host_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS bookings_purge AFTER DELETE ON bookings BEGIN
        DELETE FROM work_links WHERE (a_kind = 'booking' AND a_id = OLD.id) OR (b_kind = 'booking' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'booking' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'booking' AND item_id = OLD.id;
        DELETE FROM public_links WHERE kind = 'booking_manage' AND item_id = OLD.id;
        DELETE FROM schedules WHERE owner_kind = 'booking' AND owner_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS booking_feeds_purge AFTER DELETE ON booking_feeds BEGIN
        DELETE FROM schedules WHERE owner_kind = 'booking_feed' AND owner_id = OLD.id;
      END;
    `);
  }
};

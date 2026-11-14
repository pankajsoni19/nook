import type { Migration } from "./types";

/**
 * W3-WIRE (C20, D1058): contact, company, and deal pages list their bookings by `bookings.contact_id`,
 * which 106 left unindexed (bookings were only read by host and type). Partial: most bookings of a
 * workspace without Contacts have no contact.
 */
export const bookingsContactIndexMigration: Migration = {
  id: 112,
  name: "bookings_contact_index",
  up(db) {
    db.exec("CREATE INDEX IF NOT EXISTS bookings_contact ON bookings(contact_id, start_utc) WHERE contact_id IS NOT NULL;");
  }
};

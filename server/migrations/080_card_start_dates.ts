import { addColumn, type Migration } from "./types";

/**
 * Card start dates (D720–D722): `start_on`, an optional `start_time`, and its `start_tz`, shaped and
 * checked exactly like the due columns (migrations 011 and 015): a civil date `YYYY-MM-DD`, an
 * `HH:MM` wall time in the IANA zone the setter's browser sent, both time and zone NULL or both
 * set, and a time only with a date. The API also refuses a start after the due date (D721); the
 * schema does not, since comparing timed values needs the zones. `idx_cards_start` serves the
 * `start:` filter and sort over live dated cards, like `idx_cards_due`.
 *
 * Needs 009, 011, and 015. Transactional and filesystem-free; existing rows stay NULL and pass;
 * re-running changes nothing. (064 and 065 were taken; 079 is board keys, D710–D716.)
 */
export const cardStartDatesMigration: Migration = {
  id: 80,
  name: "card_start_dates",
  up(db) {
    addColumn(db, "cards", "start_on", "TEXT CHECK (start_on IS NULL OR start_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')");
    addColumn(db, "cards", "start_tz", "TEXT CHECK (start_tz IS NULL OR length(start_tz) BETWEEN 1 AND 64)");
    addColumn(db, "cards", "start_time", `TEXT CHECK ((start_time IS NULL AND start_tz IS NULL)
      OR (start_time IS NOT NULL AND start_tz IS NOT NULL AND start_on IS NOT NULL
          AND start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time <= '23:59'))`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_cards_start ON cards(start_on) WHERE deleted_at IS NULL AND start_on IS NOT NULL");
  }
};

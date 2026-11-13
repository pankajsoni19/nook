import type { Migration } from "../types";
import { bookingsMigration } from "../106_bookings";
import { bookingsSearchMigration } from "../107_bookings_fts";

/** Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): Bookings 106–107 (108–109 spare). */
export const bookingsMigrations: Migration[] = [bookingsMigration, bookingsSearchMigration];

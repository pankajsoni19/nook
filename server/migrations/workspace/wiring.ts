import type { Migration } from "../types";
import { goalCheckinSourceMigration } from "../111_goal_checkin_source";
import { bookingsContactIndexMigration } from "../112_bookings_contact_index";

/** Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): the lane appends its migrations here, in id order. */
export const wiringMigrations: Migration[] = [goalCheckinSourceMigration, bookingsContactIndexMigration];

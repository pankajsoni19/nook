import { belongsToTimeProject } from "./time/access";
import type { Role } from "./team/roles";

/**
 * Which role-limited workspace modules this person gets (`/api/auth/me` `features`, UI only, T97),
 * per §G.1 Q8 (D1192): guests log time on the time projects they belong to, so they see Time once
 * they are on one; they never get Contacts or Bookings (their routes answer guests 404). Everyone
 * else gets all three.
 */
export function workspaceRoleFeatures(userId: string, role: Role): { time: boolean; crm: boolean; bookings: boolean } {
  if (role !== "guest") return { time: true, crm: true, bookings: true };
  return { time: belongsToTimeProject(userId), crm: false, bookings: false };
}

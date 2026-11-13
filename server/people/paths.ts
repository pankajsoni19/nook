import { slugSegment } from "../../shared/friendlyUrls";

/**
 * App paths of contacts and companies (friendly URLs, D770–D789, §G.1 Q7: the module reads
 * "Contacts" and lives at `/contacts/...`): `/contacts/<name-slug>-<shortid>` and
 * `/contacts/companies/<name-slug>-<shortid>` (shared/workRefs.ts WORK_KIND_PATHS parses both).
 */
export const contactPath = (name: string, shortId: string) => `/contacts/${slugSegment(name, shortId)}`;
export const companyPath = (name: string, shortId: string) => `/contacts/companies/${slugSegment(name, shortId)}`;
export const contactBookPath = (name: string, shortId: string) => `/contacts/books/${slugSegment(name, shortId)}`;

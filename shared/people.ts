/**
 * People across modules (docs/plan/WORKSPACE_MODULES.md §B.3): team users and contacts, shown and
 * picked one way. Pure types and helpers, shared by the server (server/people/*) and the client
 * (src/ui/people/*).
 */

/** A team user, a contact in a book, or an unsaved outsider (a time-poll voter, a booker before upsert). */
export type PersonRef =
  | { kind: "user"; id: string }
  | { kind: "contact"; id: string }
  | { kind: "guest"; name: string; email: string };

/** What a chip shows. A contact whose book the viewer cannot read is `{ kind: "contact", hidden: true }` ("A contact", T503). */
export type PersonSummary =
  | { kind: "user"; id: string; name: string; email?: string; avatarUrl?: string | null; former?: boolean; integration?: boolean; role?: string }
  | { kind: "group"; id: string; name: string; memberCount?: number }
  | { kind: "contact"; id: string; name: string; email?: string | null; companyId?: string | null; companyName?: string | null; bookId: string; shortId?: string; hidden?: false }
  | { kind: "contact"; id: string; hidden: true }
  | { kind: "guest"; name: string; email: string };

export type ContactSource = "manual" | "import" | "booking" | "form" | "mcp" | "email_domain";
export const CONTACT_SOURCES: readonly ContactSource[] = ["manual", "import", "booking", "form", "mcp", "email_domain"];

export type ContactChannelKind = "email" | "phone" | "url" | "social";

export type ContactSummary = {
  id: string;
  shortId: string;
  bookId: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  companyId: string | null;
  companyName: string | null;
  jobTitle: string | null;
  ownerId: string | null;
  lastInteractionAt: string | null;
  updatedAt: string;
};

export type CompanySummary = { id: string; shortId: string; bookId: string; name: string; domain: string | null; website: string | null; lastInteractionAt: string | null; updatedAt: string };

export type ContactBookSummary = {
  id: string;
  shortId: string;
  name: string;
  color: string | null;
  ownerId: string;
  systemKind: "clients" | null;
  visibility: "private" | "selected" | "all_users";
  level: "view" | "comment" | "edit" | "manage" | "owner";
};

/** The settings JSON of a contact book (`contact_books.settings_json`). */
export type ContactBookSettings = {
  /** Link (or create) a company by the email's domain when it is not free mail. Default true. */
  linkCompaniesByDomain?: boolean;
  /** Lifecycle stages offered for contacts. */
  lifecycles?: string[];
  /** Days without an interaction before a deal shows as rotting. */
  rottingDays?: number;
};

/** `GET /api/people/search?allow=` words. */
export const PEOPLE_ALLOW = ["user", "group", "contact"] as const;
export type PeopleAllow = typeof PEOPLE_ALLOW[number];

/** "Ana Silva" from first/last, else the email's local part, else "Unnamed contact". */
export function contactDisplayName(input: { firstName?: string | null; lastName?: string | null; name?: string | null; email?: string | null }): string {
  const name = input.name?.trim() || [input.firstName?.trim(), input.lastName?.trim()].filter(Boolean).join(" ");
  if (name) return name.slice(0, 160);
  const local = input.email?.split("@")[0]?.trim();
  return local ? local.slice(0, 160) : "Unnamed contact";
}

/** First and last name from one "name" field: the last word is the last name. */
export function splitName(name: string): { firstName: string | null; lastName: string | null } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { firstName: null, lastName: null };
  if (words.length === 1) return { firstName: words[0]!.slice(0, 80), lastName: null };
  return { firstName: words.slice(0, -1).join(" ").slice(0, 80), lastName: words[words.length - 1]!.slice(0, 80) };
}

/** The domain of an email address, lower case, or null. */
export const emailDomain = (email: string | null | undefined): string | null => {
  const at = email?.lastIndexOf("@") ?? -1;
  return email && at > 0 ? email.slice(at + 1).trim().toLowerCase() || null : null;
};

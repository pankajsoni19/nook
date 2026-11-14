import { registerActivityKinds } from "./itemActivity";
import { slugSegment } from "./friendlyUrls";

/**
 * Contacts (module id `crm`, docs/plan/WORKSPACE_MODULES.md §D.5): words, shapes, and paths shared by
 * the server (server/crm/*) and the client (src/crm/*). Pure apart from registering the module's
 * activity kinds, which both sides need.
 */

export const CRM_ENTITIES = ["contact", "company", "deal"] as const;
export type CrmEntity = typeof CRM_ENTITIES[number];
export const isCrmEntity = (value: unknown): value is CrmEntity => typeof value === "string" && (CRM_ENTITIES as readonly string[]).includes(value);

export const STAGE_KINDS = ["open", "won", "lost"] as const;
export type StageKind = typeof STAGE_KINDS[number];

export const INTERACTION_KINDS = ["note", "call", "meeting", "email", "message", "task", "booking", "form", "other"] as const;
export type InteractionKind = typeof INTERACTION_KINDS[number];
export const INTERACTION_LABELS: Record<InteractionKind, string> = {
  note: "Note", call: "Call", meeting: "Meeting", email: "Email", message: "Message", task: "Task", booking: "Booking", form: "Form response", other: "Other"
};
/** What an activity line says after the actor's name when they logged an interaction (D987): "logged a form response", "logged an email". */
export const INTERACTION_LOGGED: Record<InteractionKind, string> = {
  note: "logged a note", call: "logged a call", meeting: "logged a meeting", email: "logged an email", message: "logged a message",
  task: "logged a finished task", booking: "logged a booking", form: "logged a form response", other: "logged an interaction"
};
export const interactionLogged = (kind: unknown) => INTERACTION_LOGGED[(INTERACTION_KINDS as readonly unknown[]).includes(kind) ? kind as InteractionKind : "note"];
export const INTERACTION_SOURCES = ["manual", "booking", "form", "task", "import", "mcp"] as const;
export type InteractionSource = typeof INTERACTION_SOURCES[number];

/** A new book's first pipeline (D962): five stages people rename. */
export const DEFAULT_STAGES: ReadonlyArray<{ name: string; kind: StageKind; probability: number }> = [
  { name: "Lead", kind: "open", probability: 10 },
  { name: "Qualified", kind: "open", probability: 30 },
  { name: "Proposal", kind: "open", probability: 60 },
  { name: "Won", kind: "won", probability: 100 },
  { name: "Lost", kind: "lost", probability: 0 }
];
export const DEFAULT_ROTTING_DAYS = 14;
export const DEFAULT_LIFECYCLES = ["Lead", "Prospect", "Customer", "Partner", "Former customer"] as const;

/** Custom field types (the Collections field engine, D960–D961) a book offers. */
export const CRM_FIELD_TYPES = ["text", "number", "date", "checkbox", "select", "multi_select", "url", "person", "contact"] as const;
export type CrmFieldType = typeof CRM_FIELD_TYPES[number];
export const CRM_FIELD_LABELS: Record<CrmFieldType, string> = {
  text: "Text", number: "Number", date: "Date", checkbox: "Checkbox", select: "Select", multi_select: "Multi-select", url: "Link", person: "Team member", contact: "Contact"
};
export type CrmFieldOption = { id: string; label: string; color: string };
export type CrmFieldDef = { id: string; name: string; type: CrmFieldType; required?: true; number?: { decimals: number; unit: string }; options?: CrmFieldOption[] };
export type CrmFieldValue = string | number | boolean | string[];
/** A book's custom fields per entity (`contact_books.fields_json`). */
export type CrmFields = Record<CrmEntity, CrmFieldDef[]>;
export const emptyCrmFields = (): CrmFields => ({ contact: [], company: [], deal: [] });

/** A filter of a list or saved view: a built-in field (`owner`, `stage`, …) or a custom one (`f_…`). */
export const FILTER_OPS = ["eq", "neq", "contains", "empty", "not_empty", "gt", "lt", "in"] as const;
export type CrmFilterOp = typeof FILTER_OPS[number];
export type CrmFilter = { field: string; op: CrmFilterOp; value?: string | number | boolean | string[] };
export type CrmSort = { field: string; dir: "asc" | "desc" };
export type CrmViewConfig = { filters?: CrmFilter[]; sort?: CrmSort; columns?: string[]; q?: string; listId?: string; pipelineId?: string; layout?: "table" | "board" };

/** Built-in filterable fields per entity (custom field ids are also accepted). */
export const BUILTIN_FILTER_FIELDS: Record<CrmEntity, readonly string[]> = {
  contact: ["name", "email", "company", "owner", "lifecycle", "tag", "source", "last_interaction", "created"],
  company: ["name", "domain", "owner", "tag", "source", "last_interaction", "created"],
  deal: ["title", "pipeline", "stage", "status", "owner", "company", "value", "expected_close", "tag", "last_activity", "created"]
};

export type CrmBook = {
  id: string; shortId: string; name: string; color: string | null; ownerId: string; ownerName: string;
  visibility: "private" | "selected" | "all_users"; level: "view" | "comment" | "edit" | "manage" | "owner";
  settings: { linkCompaniesByDomain: boolean; lifecycles: string[]; rottingDays: number; currency: string | null };
  fields: CrmFields; counts: { contacts: number; companies: number; deals: number };
};

export type CrmChannel = { id: string; kind: "email" | "phone" | "url" | "social"; value: string; label: string | null; isPrimary: boolean };
export type CrmUser = { id: string; name: string };

export type CrmContact = {
  id: string; shortId: string; bookId: string; displayName: string; firstName: string | null; lastName: string | null;
  email: string | null; phone: string | null; jobTitle: string | null; companyId: string | null; companyName: string | null;
  owner: CrmUser | null; lifecycle: string | null; location: string | null; tz: string | null; tags: string[]; source: string;
  custom: Record<string, CrmFieldValue>; lastInteractionAt: string | null; createdAt: string; updatedAt: string; revision: number; href: string;
};
export type CrmContactDetail = CrmContact & { channels: CrmChannel[]; deals: CrmDeal[]; lists: Array<{ id: string; name: string }>; canEdit: boolean; duplicates: Array<{ id: string; displayName: string; reason: string }> };

export type CrmCompany = {
  id: string; shortId: string; bookId: string; name: string; domain: string | null; website: string | null; description: string;
  owner: CrmUser | null; tags: string[]; source: string; custom: Record<string, CrmFieldValue>; contactCount: number; openDeals: number;
  lastInteractionAt: string | null; createdAt: string; updatedAt: string; revision: number; href: string;
};
export type CrmCompanyDetail = CrmCompany & { contacts: CrmContact[]; deals: CrmDeal[]; lists: Array<{ id: string; name: string }>; canEdit: boolean };

export type CrmStage = { id: string; name: string; kind: StageKind; probability: number; rotDays: number | null; color: string | null; position: number };
export type CrmPipeline = { id: string; bookId: string; name: string; currency: string | null; position: number; stages: CrmStage[] };

export type CrmDeal = {
  id: string; shortId: string; bookId: string; pipelineId: string; stageId: string; stageName: string; stageKind: StageKind; probability: number;
  title: string; value: { amount: number; currency: string } | null; currency: string; expectedCloseOn: string | null;
  owner: CrmUser | null; companyId: string | null; companyName: string | null; contacts: Array<{ id: string; name: string; role: string | null }>;
  nextStep: string | null; nextStepOn: string | null; status: StageKind; closedAt: string | null; lostReason: string | null;
  stageEnteredAt: string; lastActivityAt: string; rotting: boolean; position: number; tags: string[]; custom: Record<string, CrmFieldValue>;
  createdAt: string; updatedAt: string; revision: number; href: string;
};
export type CrmDealDetail = CrmDeal & { pipeline: CrmPipeline; canEdit: boolean; lists: Array<{ id: string; name: string }> };

export type CrmBoardColumn = { stage: CrmStage; count: number; sum: number; weighted: number; deals: CrmDeal[] };
export type CrmBoard = { pipeline: CrmPipeline; currency: string; columns: CrmBoardColumn[]; totals: { count: number; sum: number; weighted: number } };

export type CrmInteraction = {
  id: string; bookId: string; kind: InteractionKind; direction: "in" | "out" | "none"; occurredAt: string; durationS: number | null;
  title: string; body: string; author: CrmUser | null; source: InteractionSource; subjects: Array<{ kind: CrmEntity; id: string; title: string | null }>;
  createdAt: string; updatedAt: string; canEdit: boolean;
};

export type CrmFollowup = { id: string; bookId: string; subject: { kind: CrmEntity; id: string; title: string; href: string }; userId: string; dueAt: string; note: string; doneAt: string | null };
export type CrmList = { id: string; shortId: string; bookId: string; name: string; entity: CrmEntity; count: number; createdAt: string };
export type CrmView = { id: string; bookId: string; entity: CrmEntity; name: string; kind: "table" | "board"; config: CrmViewConfig; shared: boolean; mine: boolean; position: number };

/** One timeline row on a record page (§D.5 GET /records/:kind/:id/timeline). */
export type CrmTimelineEntry =
  | { type: "interaction"; at: string; interaction: CrmInteraction }
  | { type: "activity"; at: string; id: string; kind: string; actorName: string; text: string }
  | { type: "link"; at: string; id: string; relation: string; other: { kind: string; title: string; href: string } | { kind: string; hidden: true } }
  | { type: "followup"; at: string; followup: CrmFollowup };

/** CSV import (D966). */
export const IMPORT_FIELDS: Record<"contact" | "company", ReadonlyArray<{ id: string; label: string; aliases: string[] }>> = {
  contact: [
    { id: "name", label: "Full name", aliases: ["name", "full name", "contact", "contact name"] },
    { id: "first_name", label: "First name", aliases: ["first name", "firstname", "given name", "first"] },
    { id: "last_name", label: "Last name", aliases: ["last name", "lastname", "surname", "family name", "last"] },
    { id: "email", label: "Email", aliases: ["email", "e-mail", "email address", "mail"] },
    { id: "phone", label: "Phone", aliases: ["phone", "phone number", "mobile", "telephone", "tel"] },
    { id: "company", label: "Company", aliases: ["company", "organization", "organisation", "account", "company name"] },
    { id: "job_title", label: "Job title", aliases: ["title", "job title", "position", "role"] },
    { id: "lifecycle", label: "Lifecycle", aliases: ["lifecycle", "stage", "status", "lifecycle stage"] },
    { id: "location", label: "Location", aliases: ["location", "city", "address"] },
    { id: "tags", label: "Tags", aliases: ["tags", "labels"] }
  ],
  company: [
    { id: "name", label: "Name", aliases: ["name", "company", "company name", "organization"] },
    { id: "domain", label: "Domain", aliases: ["domain", "website domain"] },
    { id: "website", label: "Website", aliases: ["website", "url", "site", "web"] },
    { id: "description", label: "Description", aliases: ["description", "about", "notes"] },
    { id: "tags", label: "Tags", aliases: ["tags", "labels"] }
  ]
};
export const IMPORT_LIMITS = { bytes: 5 * 1024 * 1024, rows: 10_000, columns: 60, preview: 20, chunk: 500, undoHours: 24 } as const;
export type ImportDecision = "create" | "update" | "skip";
export type ImportPreview = {
  jobId: string; entity: "contact" | "company"; header: string[]; mapping: Record<string, string>; total: number;
  creates: number; duplicates: number; duplicatesInFile: number; invalid: number;
  sample: Array<{ row: number; values: Record<string, string>; match: { id: string; name: string } | null; problem: string | null }>;
};
export type ImportResult = { jobId: string; created: number; updated: number; skipped: number; invalid: number; undoUntil: string };

/** App paths (friendly URLs, D770–D789, §G.1 Q7). */
export const crmContactPath = (name: string, shortId: string) => `/contacts/${slugSegment(name, shortId)}`;
export const crmCompanyPath = (name: string, shortId: string) => `/contacts/companies/${slugSegment(name, shortId)}`;
export const crmDealPath = (title: string, shortId: string) => `/contacts/deals/${slugSegment(title, shortId)}`;

/** Weighted value: amount × probability (rounded to a minor unit). */
export const weightedValue = (amount: number, probability: number) => Math.round(amount * probability / 100);

/** Whether an open deal is rotting (D964): no interaction or stage change for its stage's rot days. */
export function isRotting(deal: { status: StageKind; lastActivityAt: string }, rotDays: number | null, nowMs = Date.now()) {
  if (deal.status !== "open" || !rotDays) return false;
  return nowMs - Date.parse(deal.lastActivityAt) > rotDays * 86_400_000;
}

/** The module's activity kinds (§B.5), registered once for server and client. */
export const CRM_ACTIVITY = registerActivityKinds("crm", {
  crm_updated: { shape: "event", coalesce: false },
  crm_stage: { shape: "change", coalesce: false },
  crm_merged: { shape: "event", coalesce: false },
  crm_interaction: { shape: "item", coalesce: false },
  crm_followup: { shape: "event", coalesce: false },
  crm_imported: { shape: "event", coalesce: false }
});

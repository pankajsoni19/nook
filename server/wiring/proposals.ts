import { db } from "../db";
import { McpToolError, type McpToolSpec } from "../mcpToolKit";
import { registerProposalKind } from "../inbox/kinds";
import { fieldsOf, shown, toolProposalKind } from "../inbox/toolProposals";
import { crmMcpTools } from "../crm/mcpTools";
import { readRecord } from "../crm/interactions";
import { requireBook } from "../crm/core";
import { getContact } from "../crm/records";
import { goalTools } from "../goals/mcp";
import { goalHref, requireGoal } from "../goals/service";
import { goalRow } from "../goals/access";
import { formsMcpTools } from "../forms/mcp";
import { townhallMcpTools } from "../townhall/mcp";
import { levelOn, sessionHref, sessionRow } from "../townhall/service";
import { crmCompanyPath, crmContactPath, crmDealPath } from "../../shared/crm";
import { HEALTH_LABEL } from "../../shared/tones";

/**
 * The missing Inbox proposal kinds (docs/plan/WORKSPACE_MODULES.md §B.7, §B.15, C24, D1047): agents
 * propose, people approve in the Inbox. `contact_create`, `contact_update`, `deal_create`,
 * `deal_update`, `interaction_log` (Contacts), `goal_checkin` (Goals), `form_create` (Forms), and
 * `townhall_question` (Townhall), each made from the module's own MCP write tool (server/inbox/
 * toolProposals.ts), so a person's key keeps calling the tool directly while a chat agent without
 * direct writes gets a proposal. Those tools moved from "never" to "offered" in each module's agent
 * list; everything else the module lanes kept away from agents (merges, bulk writes, public links,
 * moderation, polls, Bin) stays never offered.
 */

const toolNamed = (tools: readonly McpToolSpec[], name: string) => {
  const tool = tools.find((spec) => spec.name === name);
  if (!tool) throw new Error(`Tool ${name} is not registered`);
  return tool;
};
const notFound = (what = "Not found") => new McpToolError("NOT_FOUND", what);
const str = (value: unknown) => typeof value === "string" ? value : "";
const safely = <T>(run: () => T): T | null => { try { return run(); } catch { return null; } };

// --------------------------------------------------------------------------------------- Contacts

const bookOf = (userId: string, ref: unknown) => safely(() => requireBook(str(ref), userId, "view"));
const recordOf = (kind: "contact" | "company" | "deal", userId: string, ref: unknown) => safely(() => readRecord(kind, str(ref), userId));
const CONTACT_FIELDS: Array<[string, string]> = [["name", "Name"], ["firstName", "First name"], ["lastName", "Last name"], ["email", "Email"], ["phone", "Phone"], ["jobTitle", "Job title"],
  ["companyName", "Company"], ["lifecycle", "Lifecycle"], ["location", "Location"], ["tags", "Tags"]];
const DEAL_FIELDS: Array<[string, string]> = [["title", "Title"], ["stage", "Stage"], ["value", "Value (minor units)"], ["currency", "Currency"], ["expectedCloseOn", "Expected close"],
  ["nextStep", "Next step"], ["nextStepOn", "Next step on"], ["lostReason", "Lost reason"], ["tags", "Tags"]];
const contactRef = (result: Record<string, unknown>) => {
  const contact = result.contact as { id: string; shortId: string; displayName: string };
  return { type: "contact" as const, id: contact.id, href: crmContactPath(contact.displayName, contact.shortId) };
};
const dealRef = (result: Record<string, unknown>) => {
  const deal = result.deal as { id: string; shortId: string; title: string };
  return { type: "deal" as const, id: deal.id, href: crmDealPath(deal.title, deal.shortId) };
};

const contactCreate = toolProposalKind({
  tool: toolNamed(crmMcpTools, "create_contact"), scope: "crm:read", label: "Add a contact", target: { field: "bookId", kind: "contact_book" },
  locate: (userId, data) => { const book = bookOf(userId, data.bookId); if (!book) throw notFound("Contact book not found"); return { targetType: "contact_book", targetId: book.id, payload: { ...data, bookId: book.id } }; },
  applied: contactRef,
  fields: (viewerId, payload) => bookOf(viewerId, payload.bookId) ? fieldsOf(payload, CONTACT_FIELDS) : null,
  targetLabel: (viewerId, payload) => bookOf(viewerId, payload.bookId)?.name ?? null,
  digest: (payload) => `Add ${str(payload.name) || [str(payload.firstName), str(payload.lastName)].filter(Boolean).join(" ") || str(payload.email) || "a contact"}`,
  targetHref: (payload) => `/contacts?book=${encodeURIComponent(str(payload.bookId))}`
});

const contactUpdate = toolProposalKind({
  tool: toolNamed(crmMcpTools, "update_contact"), scope: "crm:read", label: "Update a contact", target: { field: "contactId", kind: "contact" },
  locate: (userId, data) => { const record = recordOf("contact", userId, data.contactId); if (!record) throw notFound("Contact not found"); return { targetType: "contact", targetId: record.id, payload: { ...data, contactId: record.id } }; },
  applied: contactRef,
  fields: (viewerId, payload) => {
    const record = recordOf("contact", viewerId, payload.contactId);
    if (!record) return null;
    // Every field the tool can change shows what it is now (D1059d), read as the viewer.
    const contact = safely(() => getContact(record.id, viewerId));
    if (!contact) return null;
    const channels = (kind: "email" | "phone", primary: string | null) => {
      const values = contact.channels.filter((channel) => channel.kind === kind).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).map((channel) => channel.value);
      const all = primary && !values.includes(primary) ? [primary, ...values] : values;
      return all.length ? all.join(", ") : null;
    };
    const before: Record<string, unknown> = {
      name: contact.displayName, firstName: contact.firstName, lastName: contact.lastName, email: channels("email", contact.email), phone: channels("phone", contact.phone),
      jobTitle: contact.jobTitle, companyName: contact.companyName, lifecycle: contact.lifecycle, location: contact.location, tags: contact.tags.length ? contact.tags : null
    };
    return fieldsOf(payload, CONTACT_FIELDS).map((field) => { const key = CONTACT_FIELDS.find(([, label]) => label === field.name)?.[0] ?? ""; return { ...field, before: shown(before[key]) }; });
  },
  targetLabel: (viewerId, payload) => recordOf("contact", viewerId, payload.contactId)?.title ?? null,
  digest: (payload) => `Update ${CONTACT_FIELDS.filter(([key]) => payload[key] !== undefined).map(([, label]) => label).join(", ") || "a contact"}`,
  targetHref: (payload) => {
    const row = db.query("SELECT display_name, short_id FROM contacts WHERE id = ?").get(str(payload.contactId)) as { display_name: string; short_id: string } | null;
    return row ? crmContactPath(row.display_name, row.short_id) : null;
  }
});

const dealCreate = toolProposalKind({
  tool: toolNamed(crmMcpTools, "create_deal"), scope: "crm:read", label: "Add a deal", target: { field: "bookId", kind: "contact_book" },
  locate: (userId, data) => { const book = bookOf(userId, data.bookId); if (!book) throw notFound("Contact book not found"); return { targetType: "contact_book", targetId: book.id, payload: { ...data, bookId: book.id } }; },
  applied: dealRef,
  fields: (viewerId, payload) => bookOf(viewerId, payload.bookId) ? fieldsOf(payload, DEAL_FIELDS) : null,
  targetLabel: (viewerId, payload) => bookOf(viewerId, payload.bookId)?.name ?? null,
  digest: (payload) => `Add the deal ${str(payload.title).slice(0, 80)}`,
  targetHref: (payload) => `/contacts/deals?book=${encodeURIComponent(str(payload.bookId))}`
});

const dealUpdate = toolProposalKind({
  tool: toolNamed(crmMcpTools, "update_deal"), scope: "crm:read", label: "Update a deal", target: { field: "dealId", kind: "deal" },
  locate: (userId, data) => { const record = recordOf("deal", userId, data.dealId); if (!record) throw notFound("Deal not found"); return { targetType: "deal", targetId: record.id, payload: { ...data, dealId: record.id } }; },
  applied: dealRef,
  fields: (viewerId, payload) => {
    const record = recordOf("deal", viewerId, payload.dealId);
    if (!record) return null;
    const row = db.query("SELECT d.title, d.value_minor, d.currency, d.next_step, d.next_step_on, d.expected_close_on, s.name AS stage FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id WHERE d.id = ?").get(record.id) as Record<string, unknown> | null;
    const before: Record<string, unknown> = { title: row?.title, stage: row?.stage, value: row?.value_minor, currency: row?.currency, nextStep: row?.next_step, nextStepOn: row?.next_step_on, expectedCloseOn: row?.expected_close_on };
    return fieldsOf(payload, DEAL_FIELDS).map((field) => { const key = DEAL_FIELDS.find(([, label]) => label === field.name)?.[0] ?? ""; return { ...field, before: shown(before[key]) }; });
  },
  targetLabel: (viewerId, payload) => recordOf("deal", viewerId, payload.dealId)?.title ?? null,
  digest: (payload) => payload.stage !== undefined ? `Move to ${str(payload.stage).slice(0, 60)}` : `Update ${DEAL_FIELDS.filter(([key]) => payload[key] !== undefined).map(([, label]) => label).join(", ") || "a deal"}`,
  targetHref: (payload) => {
    const row = db.query("SELECT title, short_id FROM deals WHERE id = ?").get(str(payload.dealId)) as { title: string; short_id: string } | null;
    return row ? crmDealPath(row.title, row.short_id) : null;
  }
});

/** The first record an interaction names, read as the viewer (its kind, id, and title). */
function firstSubject(viewerId: string, payload: Record<string, unknown>) {
  for (const [kind, field] of [["contact", "contactIds"], ["deal", "dealIds"], ["company", "companyIds"]] as const) {
    const ids = Array.isArray(payload[field]) ? payload[field] as unknown[] : [];
    if (ids.length) { const record = recordOf(kind, viewerId, ids[0]); return record ? { kind, ...record } : null; }
  }
  return null;
}
const interactionLog = toolProposalKind({
  tool: toolNamed(crmMcpTools, "log_interaction"), scope: "crm:read", label: "Log an interaction",
  locate: (userId, data) => {
    const subject = firstSubject(userId, data);
    if (!subject) throw notFound("Contact, company, or deal not found");
    for (const [kind, field] of [["contact", "contactIds"], ["deal", "dealIds"], ["company", "companyIds"]] as const) {
      for (const id of Array.isArray(data[field]) ? data[field] as unknown[] : []) if (!recordOf(kind, userId, id)) throw notFound("Contact, company, or deal not found");
    }
    return { targetType: subject.kind, targetId: subject.id };
  },
  applied: (result) => {
    const interaction = result.interaction as { id: string; subjects?: Array<{ kind: "contact" | "company" | "deal"; id: string }> };
    const subject = interaction.subjects?.[0];
    if (!subject) return { type: "contact", id: interaction.id, href: "/contacts" };
    const table = subject.kind === "contact" ? "contacts" : subject.kind === "company" ? "companies" : "deals";
    const row = db.query(`SELECT ${subject.kind === "contact" ? "display_name" : subject.kind === "company" ? "name" : "title"} AS title, short_id FROM ${table} WHERE id = ?`).get(subject.id) as { title: string; short_id: string } | null;
    const href = !row ? "/contacts" : subject.kind === "contact" ? crmContactPath(row.title, row.short_id) : subject.kind === "company" ? crmCompanyPath(row.title, row.short_id) : crmDealPath(row.title, row.short_id);
    return { type: subject.kind, id: subject.id, href };
  },
  fields: (viewerId, payload) => firstSubject(viewerId, payload) ? fieldsOf(payload, [["kind", "Kind"], ["title", "Title"], ["body", "Notes"], ["occurredAt", "When"], ["durationMinutes", "Minutes"], ["direction", "Direction"]]) : null,
  targetLabel: (viewerId, payload) => firstSubject(viewerId, payload)?.title ?? null,
  digest: (payload) => `Log a ${str(payload.kind) || "note"}${payload.title ? `: ${str(payload.title).slice(0, 60)}` : ""}`,
  targetHref: (payload) => {
    const ids = Array.isArray(payload.contactIds) ? payload.contactIds as unknown[] : [];
    const row = ids.length ? db.query("SELECT display_name, short_id FROM contacts WHERE id = ? OR short_id = ?").get(str(ids[0]), str(ids[0])) as { display_name: string; short_id: string } | null : null;
    return row ? crmContactPath(row.display_name, row.short_id) : "/contacts";
  }
});

// ------------------------------------------------------------------------------------------ Goals

const readableGoal = (userId: string, ref: unknown) => safely(() => requireGoal(str(ref), userId, "view").goal);
const goalCheckin = toolProposalKind({
  tool: toolNamed(goalTools, "check_in_goal"), scope: "goals:read", label: "Check in on a goal", target: { field: "goalId", kind: "goal" },
  locate: (userId, data) => { const goal = readableGoal(userId, data.goalId); if (!goal) throw notFound("Goal not found"); return { targetType: "goal", targetId: goal.id, payload: { ...data, goalId: goal.id } }; },
  applied: (_result, payload) => { const goal = goalRow(str(payload.goalId)); return { type: "goal", id: str(payload.goalId), href: goal ? goalHref(goal) : "/goals" }; },
  fields: (viewerId, payload) => {
    const goal = readableGoal(viewerId, payload.goalId);
    if (!goal) return null;
    const krs = new Map((db.query("SELECT id, title, current_value FROM key_results WHERE goal_id = ?").all(goal.id) as Array<{ id: string; title: string; current_value: number }>).map((kr) => [kr.id, kr]));
    const values = Object.entries((payload.values ?? {}) as Record<string, unknown>).map(([id, value]) => {
      const kr = krs.get(id.toLowerCase());
      return { name: kr?.title ?? "A key result", before: kr ? String(kr.current_value) : null, after: shown(value) };
    });
    return [
      ...(payload.health ? [{ name: "Health", before: HEALTH_LABEL[goal.health as keyof typeof HEALTH_LABEL] ?? goal.health, after: HEALTH_LABEL[str(payload.health) as keyof typeof HEALTH_LABEL] ?? str(payload.health) }] : []),
      ...fieldsOf(payload, [["confidence", "Confidence"], ["note", "Note"]]),
      ...values
    ];
  },
  targetLabel: (viewerId, payload) => readableGoal(viewerId, payload.goalId)?.title ?? null,
  digest: (payload) => `Check in${payload.health ? ` (${HEALTH_LABEL[str(payload.health) as keyof typeof HEALTH_LABEL] ?? str(payload.health)})` : ""}${payload.values ? `, ${Object.keys(payload.values as object).length} value(s)` : ""}`,
  targetHref: (payload) => { const goal = goalRow(str(payload.goalId)); return goal ? goalHref(goal) : null; }
});

// ------------------------------------------------------------------------------------------ Forms

const formCreate = toolProposalKind({
  tool: toolNamed(formsMcpTools, "create_form"), scope: "forms:read", label: "Create a form",
  // A new form has no target yet: like time_log's own time, it is the key owner's (chosen-item keys are refused, fail closed).
  locate: (userId) => ({ targetType: "form", targetId: userId }),
  applied: (result) => { const form = result.form as { id: string; href: string }; return { type: "form", id: form.id, href: form.href }; },
  fields: (_viewerId, payload) => [
    ...fieldsOf(payload, [["kind", "Kind"], ["title", "Title"], ["description", "Description"], ["template", "Template"], ["publish", "Publish now"]]),
    ...(Array.isArray(payload.questions) || (payload.questions && typeof payload.questions === "object")
      ? [{ name: "Questions", before: null, after: (Array.isArray(payload.questions) ? payload.questions as Array<{ title?: unknown }> : ((payload.questions as { questions?: Array<{ title?: unknown }> }).questions ?? [])).map((question) => `• ${str(question.title)}`).join("\n").slice(0, 2000) }]
      : [])
  ],
  targetLabel: () => "A new form",
  digest: (payload) => `Create ${str(payload.kind) || "form"} ${str(payload.title).slice(0, 80)}`.trim(),
  targetHref: () => "/forms"
});

// --------------------------------------------------------------------------------------- Townhall

const readableSession = (userId: string, ref: unknown) => { const row = sessionRow(str(ref)); return row && levelOn(row, userId) !== "none" ? row : null; };
const townhallQuestion = toolProposalKind({
  tool: toolNamed(townhallMcpTools, "ask_townhall_question"), scope: "townhall:read", label: "Ask a townhall question", target: { field: "sessionId", kind: "townhall_session" },
  locate: (userId, data) => { const row = readableSession(userId, data.sessionId); if (!row) throw notFound("Session not found"); return { targetType: "townhall_session", targetId: row.id, payload: { ...data, sessionId: row.id } }; },
  applied: (_result, payload) => { const row = sessionRow(str(payload.sessionId)); return { type: "townhall_session", id: str(payload.sessionId), href: row ? sessionHref(row) : "/townhall" }; },
  fields: (viewerId, payload) => readableSession(viewerId, payload.sessionId) ? fieldsOf(payload, [["text", "Question"], ["anonymous", "Anonymous"]]) : null,
  targetLabel: (viewerId, payload) => readableSession(viewerId, payload.sessionId)?.title ?? null,
  digest: (payload) => `Ask: ${str(payload.text).slice(0, 80)}`,
  targetHref: (payload) => { const row = sessionRow(str(payload.sessionId)); return row ? sessionHref(row) : null; }
});

export const WIRED_PROPOSAL_KINDS = { contact_create: contactCreate, contact_update: contactUpdate, deal_create: dealCreate, deal_update: dealUpdate, interaction_log: interactionLog, goal_checkin: goalCheckin, form_create: formCreate, townhall_question: townhallQuestion } as const;
for (const [kind, def] of Object.entries(WIRED_PROPOSAL_KINDS)) registerProposalKind(kind as keyof typeof WIRED_PROPOSAL_KINDS, def);

/** The tools those kinds come from: each module lists them as offered to chat agents (D1047). */
export const WIRED_AGENT_TOOLS = Object.values(WIRED_PROPOSAL_KINDS).map((def) => def.tool);

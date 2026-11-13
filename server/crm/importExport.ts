import { audit, db, now } from "../db";
import { CsvError, neutralizeFormula, parseCsv, restoreNeutralized, writeCsv } from "../collections/csv";
import { normalizeEmail, isEmail } from "../../shared/questions";
import { minorDigits } from "../../shared/money";
import { IMPORT_FIELDS, IMPORT_LIMITS, type CrmEntity, type CrmFilter, type ImportPreview, type ImportResult } from "../../shared/crm";
import { bookFields, cleanRef, CrmError, invalid, notFound, requireBook } from "./core";
import { createCompany, createContact, listCompanies, listContacts, readContactRow, updateCompany, updateContact } from "./records";
import { listDeals } from "./deals";

/**
 * CSV import and export (§D.5, D966, T561, T564, T565). Import is two steps: upload → a preview job
 * (column mapping auto-matched by header, dedupe against the book by email for contacts and by domain
 * or name for companies, problems counted) → commit with a decision for duplicates (update or skip),
 * written in chunks of 500 rows per transaction, undoable for 24 hours (created records are deleted,
 * updated ones put back). Export writes formula-safe CSV, at most 10,000 rows, 30 exports per person
 * a day (T564), audited.
 */

type Mapping = Array<string | null>;
type JobRow = { id: string; book_id: string; user_id: string; entity: "contact" | "company"; status: string; mapping_json: string; stats_json: string; csv_text: string | null; changes_json: string | null; created_at: string; undo_until: string | null };

function parse(text: string) {
  if (typeof text !== "string" || !text.trim()) throw invalid("Choose a CSV file with a header row");
  if (Buffer.byteLength(text, "utf8") > IMPORT_LIMITS.bytes) throw invalid("A CSV import is at most 5 MB");
  try {
    const records = parseCsv(text, { maxRecords: IMPORT_LIMITS.rows + 1, maxColumns: IMPORT_LIMITS.columns });
    if (records.length < 2) throw invalid("The CSV needs a header row and at least one row");
    return { header: records[0]!.map((cell) => cell.trim().slice(0, 120)), rows: records.slice(1) };
  } catch (error) {
    if (error instanceof CsvError) throw invalid(`${error.message} (line ${error.line})`);
    throw error;
  }
}

/** Field ids a column may map to: built-ins, then `custom:<fieldId>`. */
function targets(entity: "contact" | "company", bookId: string) {
  const book = db.query("SELECT fields_json FROM contact_books WHERE id = ?").get(bookId) as { fields_json: string };
  return [...IMPORT_FIELDS[entity].map((field) => ({ id: field.id, label: field.label, aliases: field.aliases })),
    ...bookFields(book)[entity].filter((field) => !["person", "contact"].includes(field.type)).map((field) => ({ id: `custom:${field.id}`, label: field.name, aliases: [field.name.toLowerCase()] }))];
}

function autoMapping(header: readonly string[], entity: "contact" | "company", bookId: string): Mapping {
  const used = new Set<string>();
  return header.map((name) => {
    const key = name.trim().toLowerCase().replace(/[_-]+/g, " ");
    const match = targets(entity, bookId).find((target) => !used.has(target.id) && (target.aliases.includes(key) || target.label.toLowerCase() === key));
    if (!match) return null;
    used.add(match.id);
    return match.id;
  });
}

function checkMapping(mapping: unknown, header: readonly string[], entity: "contact" | "company", bookId: string): Mapping {
  if (!Array.isArray(mapping) || mapping.length !== header.length) throw invalid("Map each column to a field or skip it");
  const allowed = new Set(targets(entity, bookId).map((target) => target.id));
  const seen = new Set<string>();
  return mapping.map((value) => {
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !allowed.has(value)) throw invalid("Unknown field in the mapping");
    if (seen.has(value)) throw invalid("Two columns map to the same field");
    seen.add(value);
    return value;
  });
}

type RowValues = Record<string, string>;
const valuesOf = (row: readonly string[], mapping: Mapping): RowValues => {
  const values: RowValues = {};
  mapping.forEach((field, index) => { const cell = row[index] === undefined ? undefined : restoreNeutralized(row[index]!.trim()); if (field && cell) values[field] = cell.slice(0, 4000); });
  return values;
};

function rowProblem(entity: "contact" | "company", values: RowValues): string | null {
  if (entity === "contact") {
    if (values.email && !isEmail(normalizeEmail(values.email))) return "The email is not an email address";
    if (!values.email && !values.name && !values.first_name && !values.last_name) return "No name or email";
    return null;
  }
  return values.name ? null : "No name";
}

/** The existing record a row matches (contacts by email; companies by domain, then name). */
function matchOf(entity: "contact" | "company", bookId: string, values: RowValues): { id: string; name: string } | null {
  if (entity === "contact") {
    if (!values.email) return null;
    const row = db.query("SELECT c.id, c.display_name AS name FROM contact_channels ch JOIN contacts c ON c.id = ch.contact_id WHERE ch.book_id = ? AND ch.kind = 'email' AND ch.value_norm = ? AND c.deleted_at IS NULL")
      .get(bookId, normalizeEmail(values.email)) as { id: string; name: string } | null;
    return row;
  }
  const domain = values.domain?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (domain) {
    const row = db.query("SELECT id, name FROM companies WHERE book_id = ? AND domain = ? AND deleted_at IS NULL").get(bookId, domain) as { id: string; name: string } | null;
    if (row) return row;
  }
  return values.name ? db.query("SELECT id, name FROM companies WHERE book_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL").get(bookId, values.name) as { id: string; name: string } | null : null;
}
const fileKey = (entity: "contact" | "company", values: RowValues) => entity === "contact" ? (values.email ? normalizeEmail(values.email) : null) : (values.domain?.toLowerCase() ?? values.name?.toLowerCase() ?? null);

function previewOf(job: { id: string; entity: "contact" | "company"; book_id: string }, header: string[], rows: string[][], mapping: Mapping): ImportPreview {
  let creates = 0, duplicates = 0, duplicatesInFile = 0, invalidRows = 0;
  const seen = new Set<string>();
  const sample: ImportPreview["sample"] = [];
  rows.forEach((row, index) => {
    const values = valuesOf(row, mapping);
    const problem = rowProblem(job.entity, values);
    const match = problem ? null : matchOf(job.entity, job.book_id, values);
    const key = fileKey(job.entity, values);
    if (problem) invalidRows += 1;
    else if (match) duplicates += 1;
    else if (key && seen.has(key)) duplicatesInFile += 1;
    else creates += 1;
    if (key) seen.add(key);
    if (sample.length < IMPORT_LIMITS.preview && (problem || match || sample.length < 10)) sample.push({ row: index + 2, values, match, problem });
  });
  return { jobId: job.id, entity: job.entity, header, mapping: Object.fromEntries(mapping.map((field, index) => [String(index), field ?? ""])), total: rows.length, creates, duplicates, duplicatesInFile, invalid: invalidRows, sample };
}

/** Step 1: reads the CSV and returns the preview of a new job (nothing is written but the job). */
export function previewImport(userId: string, input: { bookId?: string; entity?: unknown; csv?: unknown; mapping?: unknown }): ImportPreview {
  const book = requireBook(input.bookId ?? "", userId, "edit");
  if (input.entity !== "contact" && input.entity !== "company") throw invalid("Import contacts or companies");
  const entity = input.entity;
  const { header, rows } = parse(input.csv as string);
  if (rows.length > IMPORT_LIMITS.rows) throw invalid(`A CSV import is at most ${IMPORT_LIMITS.rows.toLocaleString("en")} rows`);
  const mapping = input.mapping === undefined ? autoMapping(header, entity, book.id) : checkMapping(input.mapping, header, entity, book.id);
  if (!mapping.some(Boolean)) throw invalid("No column matches a field; map at least one");
  return db.transaction(() => {
    db.query("DELETE FROM crm_import_jobs WHERE user_id = ? AND status = 'preview' AND created_at < ?").run(userId, new Date(Date.now() - 86_400_000).toISOString());
    const id = Bun.randomUUIDv7();
    db.query("INSERT INTO crm_import_jobs (id, book_id, user_id, entity, status, mapping_json, csv_text, created_at) VALUES (?, ?, ?, ?, 'preview', ?, ?, ?)").run(id, book.id, userId, entity, JSON.stringify(mapping), input.csv as string, now());
    return previewOf({ id, entity, book_id: book.id }, header, rows, mapping);
  })();
}

function readJob(jobId: string, userId: string): JobRow {
  const job = cleanRef(jobId) ? db.query("SELECT * FROM crm_import_jobs WHERE id = ? AND user_id = ?").get(jobId.toLowerCase(), userId) as JobRow | null : null;
  if (!job) throw notFound("Import not found");
  requireBook(job.book_id, userId, "edit");
  return job;
}

/** Re-checks a preview job with another mapping. */
export function remapImport(jobId: string, userId: string, mapping: unknown): ImportPreview {
  const job = readJob(jobId, userId);
  if (job.status !== "preview") throw new CrmError(409, "IMPORT_DONE", "This import has already run");
  const { header, rows } = parse(job.csv_text ?? "");
  const checked = checkMapping(mapping, header, job.entity, job.book_id);
  db.query("UPDATE crm_import_jobs SET mapping_json = ? WHERE id = ?").run(JSON.stringify(checked), job.id);
  return previewOf(job, header, rows, checked);
}

type Snapshot = { id: string; row: Record<string, unknown>; channels: Array<Record<string, unknown>> };

/** Step 2: writes the job (chunks of 500 rows per transaction). Duplicates are updated or skipped. */
export function commitImport(jobId: string, userId: string, input: { duplicates?: "update" | "skip"; mapping?: unknown } = {}): ImportResult {
  const job = readJob(jobId, userId);
  if (job.status !== "preview") throw new CrmError(409, "IMPORT_DONE", "This import has already run");
  const { header, rows } = parse(job.csv_text ?? "");
  const mapping = input.mapping === undefined ? JSON.parse(job.mapping_json) as Mapping : checkMapping(input.mapping, header, job.entity, job.book_id);
  const decision = input.duplicates === "skip" ? "skip" : "update";
  const started = now();
  const created: string[] = [];
  const updated: Snapshot[] = [];
  let skipped = 0, invalidRows = 0;
  const table = job.entity === "contact" ? "contacts" : "companies";
  for (let start = 0; start < rows.length; start += IMPORT_LIMITS.chunk) {
    db.transaction(() => {
      for (const row of rows.slice(start, start + IMPORT_LIMITS.chunk)) {
        const values = valuesOf(row, mapping);
        if (rowProblem(job.entity, values)) { invalidRows += 1; continue; }
        const custom: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(values)) if (key.startsWith("custom:")) custom[key.slice(7)] = value;
        const fields = bookFields(db.query("SELECT fields_json FROM contact_books WHERE id = ?").get(job.book_id) as { fields_json: string })[job.entity];
        for (const field of fields) {
          const raw = custom[field.id];
          if (raw === undefined) continue;
          if (field.type === "number") custom[field.id] = Number(raw);
          else if (field.type === "checkbox") custom[field.id] = /^(1|true|yes|y|x)$/i.test(String(raw));
          else if (field.type === "select") { const option = field.options?.find((item) => item.label.toLowerCase() === String(raw).toLowerCase()); if (option) custom[field.id] = option.id; else delete custom[field.id]; }
          else if (field.type === "multi_select") custom[field.id] = String(raw).split(";").map((label) => field.options?.find((item) => item.label.toLowerCase() === label.trim().toLowerCase())?.id).filter(Boolean) as unknown as string;
        }
        const tags = values.tags ? values.tags.split(/[;,]/).map((tag) => tag.trim()).filter(Boolean) : undefined;
        const match = matchOf(job.entity, job.book_id, values);
        try {
          if (match) {
            if (decision === "skip") { skipped += 1; continue; }
            if (!created.includes(match.id) && !updated.some((item) => item.id === match.id)) {
              updated.push({ id: match.id, row: db.query(`SELECT * FROM ${table} WHERE id = ?`).get(match.id) as Record<string, unknown>,
                channels: job.entity === "contact" ? db.query("SELECT * FROM contact_channels WHERE contact_id = ?").all(match.id) as Array<Record<string, unknown>> : [] });
            }
            if (job.entity === "contact") {
              updateContact(match.id, userId, {
                ...(values.name || values.first_name || values.last_name ? (values.first_name || values.last_name ? { firstName: values.first_name ?? null, lastName: values.last_name ?? null } : { name: values.name }) : {}),
                ...(values.phone ? { phone: values.phone } : {}), ...(values.company ? { companyName: values.company } : {}), ...(values.job_title ? { jobTitle: values.job_title } : {}),
                ...(values.lifecycle ? { lifecycle: values.lifecycle } : {}), ...(values.location ? { location: values.location } : {}), ...(tags ? { tags } : {}), ...(Object.keys(custom).length ? { custom } : {})
              });
            } else {
              updateCompany(match.id, userId, { ...(values.domain ? { domain: values.domain } : {}), ...(values.website ? { website: values.website } : {}), ...(values.description ? { description: values.description } : {}), ...(tags ? { tags } : {}), ...(Object.keys(custom).length ? { custom } : {}) });
            }
          } else if (job.entity === "contact") {
            created.push(createContact(userId, {
              bookId: job.book_id, ...(values.first_name || values.last_name ? { firstName: values.first_name ?? null, lastName: values.last_name ?? null } : { name: values.name ?? null }),
              email: values.email ?? null, phone: values.phone ?? null, ...(values.company ? { companyName: values.company } : {}), jobTitle: values.job_title ?? null, lifecycle: values.lifecycle ?? null,
              location: values.location ?? null, tags, custom
            }, "import").id);
          } else {
            created.push(createCompany(userId, { bookId: job.book_id, name: values.name, domain: values.domain ?? null, website: values.website ?? null, description: values.description ?? null, tags, custom }, "import").id);
          }
        } catch (error) {
          if (error instanceof CrmError && (error.status === 400 || error.status === 409)) { invalidRows += 1; continue; }
          throw error;
        }
      }
    })();
  }
  const undoUntil = new Date(Date.now() + IMPORT_LIMITS.undoHours * 3_600_000).toISOString();
  const stats = { created: created.length, updated: updated.length, skipped, invalid: invalidRows };
  db.query("UPDATE crm_import_jobs SET status = 'committed', stats_json = ?, csv_text = NULL, changes_json = ?, finished_at = ?, undo_until = ?, mapping_json = ? WHERE id = ?")
    .run(JSON.stringify(stats), JSON.stringify({ created, updated, started }), now(), undoUntil, JSON.stringify(mapping), job.id);
  audit(userId, null, "crm.import_commit", { bookId: job.book_id, jobId: job.id, entity: job.entity, ...stats });
  return { jobId: job.id, ...stats, undoUntil };
}

/** Undoes a committed import within 24 hours: deletes what it created (and companies it made for them) and restores what it updated. */
export function undoImport(jobId: string, userId: string) {
  const job = readJob(jobId, userId);
  if (job.status !== "committed" || !job.undo_until || job.undo_until < now()) throw new CrmError(409, "UNDO_EXPIRED", "This import can no longer be undone");
  const changes = JSON.parse(job.changes_json ?? "{}") as { created: string[]; updated: Snapshot[]; started: string };
  const table = job.entity === "contact" ? "contacts" : "companies";
  return db.transaction(() => {
    for (const id of changes.created) db.query(`DELETE FROM ${table} WHERE id = ?`).run(id);
    for (const snapshot of changes.updated) {
      const columns = Object.keys(snapshot.row).filter((column) => column !== "id" && /^[a-z_]+$/.test(column));
      db.query(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`).run(...columns.map((column) => snapshot.row[column] as string | number | null), snapshot.id);
      if (job.entity === "contact") {
        db.query("DELETE FROM contact_channels WHERE contact_id = ?").run(snapshot.id);
        for (const channel of snapshot.channels) {
          const keys = Object.keys(channel).filter((column) => /^[a-z_]+$/.test(column));
          db.query(`INSERT OR IGNORE INTO contact_channels (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => channel[key] as string | number | null));
        }
      }
    }
    if (job.entity === "contact") {
      db.query(`DELETE FROM companies WHERE book_id = ? AND source = 'import' AND created_by = ? AND created_at >= ? AND created_at <= ?
        AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = companies.id) AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.company_id = companies.id)`).run(job.book_id, userId, changes.started, job.undo_until);
    }
    db.query("UPDATE crm_import_jobs SET status = 'undone', changes_json = NULL WHERE id = ?").run(job.id);
    audit(userId, null, "crm.import_undo", { bookId: job.book_id, jobId: job.id, created: changes.created.length, updated: changes.updated.length });
    return { undone: true, deleted: changes.created.length, restored: changes.updated.length };
  })();
}

// ----------------------------------------------------------------------------- export

const exportCounts = new Map<string, { day: string; count: number }>();
export const EXPORTS_PER_DAY = 30;
export const resetCrmExportLimitForTests = () => exportCounts.clear();

/** Formula-safe CSV of a book's contacts, companies, or deals (T564: 30 a day per person, ≤ 10,000 rows, audited). */
export function exportCsv(userId: string, input: { bookId: string; entity: CrmEntity; q?: string; listId?: string | null; filters?: CrmFilter[] }): { filename: string; csv: string; rows: number } {
  const book = requireBook(input.bookId, userId);
  const day = new Date().toISOString().slice(0, 10);
  const counter = exportCounts.get(userId);
  if (counter?.day === day && counter.count >= EXPORTS_PER_DAY) throw new CrmError(429, "RATE_LIMITED", `Up to ${EXPORTS_PER_DAY} exports a day`);
  exportCounts.set(userId, { day, count: counter?.day === day ? counter.count + 1 : 1 });
  const fields = bookFields(book)[input.entity];
  const custom = (values: Record<string, unknown>) => fields.map((field) => {
    const value = values[field.id];
    if (value === undefined) return "";
    if (field.type === "select") return field.options?.find((option) => option.id === value)?.label ?? "";
    if (field.type === "multi_select" && Array.isArray(value)) return value.map((id) => field.options?.find((option) => option.id === id)?.label ?? "").filter(Boolean).join("; ");
    return String(value);
  });
  const records: string[][] = [];
  const base = { bookIds: [book.id], q: input.q, listId: input.listId, filters: input.filters, limit: 200 };
  let cursor: string | null = null;
  if (input.entity === "contact") {
    records.push(["Name", "First name", "Last name", "Email", "Phone", "Company", "Job title", "Lifecycle", "Owner", "Location", "Tags", "Last interaction", "Created", ...fields.map((field) => field.name)]);
    do {
      const page = listContacts(userId, { ...base, cursor });
      for (const c of page.items) records.push([c.displayName, c.firstName ?? "", c.lastName ?? "", c.email ?? "", c.phone ?? "", c.companyName ?? "", c.jobTitle ?? "", c.lifecycle ?? "", c.owner?.name ?? "", c.location ?? "", c.tags.join("; "), c.lastInteractionAt ?? "", c.createdAt, ...custom(c.custom)]);
      cursor = page.nextCursor;
    } while (cursor && records.length <= IMPORT_LIMITS.rows);
  } else if (input.entity === "company") {
    records.push(["Name", "Domain", "Website", "Owner", "Contacts", "Open deals", "Tags", "Last interaction", "Created", ...fields.map((field) => field.name)]);
    do {
      const page = listCompanies(userId, { ...base, cursor });
      for (const c of page.items) records.push([c.name, c.domain ?? "", c.website ?? "", c.owner?.name ?? "", String(c.contactCount), String(c.openDeals), c.tags.join("; "), c.lastInteractionAt ?? "", c.createdAt, ...custom(c.custom)]);
      cursor = page.nextCursor;
    } while (cursor && records.length <= IMPORT_LIMITS.rows);
  } else {
    records.push(["Title", "Stage", "Status", "Value", "Currency", "Expected close", "Owner", "Company", "Contacts", "Next step", "Next step on", "Lost reason", "Created", ...fields.map((field) => field.name)]);
    do {
      const page = listDeals(userId, { ...base, cursor });
      for (const d of page.items) records.push([d.title, d.stageName, d.status, d.value ? (d.value.amount / 10 ** minorDigits(d.currency)).toFixed(minorDigits(d.currency)) : "", d.currency, d.expectedCloseOn ?? "", d.owner?.name ?? "", d.companyName ?? "",
        d.contacts.map((contact) => contact.name).join("; "), d.nextStep ?? "", d.nextStepOn ?? "", d.lostReason ?? "", d.createdAt, ...custom(d.custom)]);
      cursor = page.nextCursor;
    } while (cursor && records.length <= IMPORT_LIMITS.rows);
  }
  const rows = records.slice(0, IMPORT_LIMITS.rows + 1);
  audit(userId, null, "crm.export", { bookId: book.id, entity: input.entity, rows: rows.length - 1 });
  const slug = book.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "contacts";
  return { filename: `${slug}-${input.entity === "company" ? "companies" : `${input.entity}s`}.csv`, csv: writeCsv(rows.map((record) => record.map(neutralizeFormula))), rows: rows.length - 1 };
}

/** vCard 3.0 of one contact (T565: values escaped, line breaks removed). */
export function contactVcard(ref: string, userId: string): { filename: string; vcard: string } {
  const row = readContactRow(ref, userId);
  const escape = (value: string | null | undefined) => (value ?? "").replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1");
  const channels = db.query("SELECT kind, value FROM contact_channels WHERE contact_id = ? ORDER BY is_primary DESC, position").all(row.id) as Array<{ kind: string; value: string }>;
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:${escape(row.last_name)};${escape(row.first_name)};;;`, `FN:${escape(row.display_name)}`,
    ...(row.company_name ? [`ORG:${escape(row.company_name)}`] : []), ...(row.job_title ? [`TITLE:${escape(row.job_title)}`] : []),
    ...channels.filter((channel) => channel.kind === "email").map((channel) => `EMAIL;TYPE=INTERNET:${escape(channel.value)}`),
    ...channels.filter((channel) => channel.kind === "phone").map((channel) => `TEL:${escape(channel.value)}`),
    ...channels.filter((channel) => channel.kind === "url").map((channel) => `URL:${escape(channel.value)}`),
    ...(row.location ? [`ADR:;;${escape(row.location)};;;;`] : []), "END:VCARD"];
  audit(userId, null, "crm.export", { bookId: row.book_id, entity: "vcard", rows: 1 });
  const slug = row.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "contact";
  return { filename: `${slug}.vcf`, vcard: `${lines.join("\r\n")}\r\n` };
}

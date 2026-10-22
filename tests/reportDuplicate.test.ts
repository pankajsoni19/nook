import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { retireUsersAfterFile } from "./support/retireUsers";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";
import type { ReportSpec } from "../shared/reports";

const refresh = await import("../server/reports/refresh");
const { reportTools } = await import("../server/mcpTools").then(() => import("../server/reports/mcpTools"));
const { copyTitle } = await import("../server/reports/duplicate");
const { NOOK_NEVER_TOOLS } = await import("../server/agents/nookBridge");

/**
 * Duplicate report (D575, D576): anyone who can read a report copies it into a new report they own:
 * the spec, queries, parameters and their options, the latest results, and the model choice; an owner's
 * copy keeps the docs that owner can read (and names the rest); a reader's copy has no docs and nothing
 * else a reader cannot see. Never copied: sharing, owners, schedule, favorites, instructions, versions.
 * Audited; MCP `duplicate_report` (reports:write), never offered to chat agents.
 */

retireUsersAfterFile();
setDefaultTimeout(30_000);

const fake = startFakeClickhouse(0);
fake.state.select = (sql) => sampleAnswer(sql);

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}
async function note(session: Session, markdown: string) {
  const id = (await send(session, "POST", "/notes", { folderId: null })).body.note.id as string;
  expect((await send(session, "PUT", `/notes/${id}/draft`, { markdown, revision: 1 })).status).toBe(200);
  expect((await send(session, "POST", `/notes/${id}/publish`)).status).toBe(200);
  return id;
}
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

let admin: Session;
let owner: Session;
let coOwner: Session;
let viewer: Session;
let teamViewer: Session;
let outsider: Session;
let datasourceId = "";
let providerId = "";
let sourceId = "";
const OPTIONS_SQL = "SELECT DISTINCT country FROM analytics.orders ORDER BY country";

function sourceSpec(): ReportSpec {
  return { ...sampleSpec(), specVersion: 3, sections: [], parameters: [{ id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: OPTIONS_SQL }] } as ReportSpec;
}

beforeAll(async () => {
  admin = await createUser("Duplicate admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("Duplicate owner");
  coOwner = await createUser("Duplicate co-owner");
  viewer = await createUser("Duplicate viewer");
  teamViewer = await createUser("Duplicate team viewer");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(teamViewer.userId);
  outsider = await createUser("Duplicate outsider");
  fake.state.tables = [{ db: "analytics", name: "orders", engine: "MergeTree", columns: [{ name: "day", type: "Date" }, { name: "revenue", type: "Decimal(18, 2)" }, { name: "country", type: "String" }] }];
  const datasource = await send(admin, "POST", "/reports/admin/datasources", { name: `Duplicate DS ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
  datasourceId = datasource.body.datasource.id;
  const provider = await send(admin, "POST", "/agents/admin/providers", { name: `Duplicate model ${crypto.randomUUID().slice(0, 6)}`, baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-test-not-real", defaultModel: "copy-model" });
  expect(provider.status).toBe(201);
  providerId = provider.body.provider.id;

  // The source: the sample spec with a filter, its results and options, two docs, a co-owner, sharing, a schedule, a star, a version note.
  const created = await send(owner, "POST", "/reports", { title: "Revenue", datasourceId });
  sourceId = created.body.report.id;
  db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(sourceSpec()), sourceId);
  await refresh.startRefresh(owner.userId, sourceId, { trigger: "user" }).done;
  db.query("INSERT INTO report_param_options (report_id, param_id, sql, values_json, truncated, created_at) VALUES (?, 'country', ?, ?, 0, ?)").run(sourceId, OPTIONS_SQL, JSON.stringify(["DE", "IN", "US"]), new Date().toISOString());
  db.query("INSERT INTO report_owners (report_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)").run(sourceId, coOwner.userId, owner.userId, new Date().toISOString());
  const ownersNote = await note(owner, "# Owner's private rules\n\nOnly the owner reads this.");
  const coOwnersNote = await note(coOwner, "# Shared metrics\n\nRevenue per day.");
  const docs = [[ownersNote, "Owner's private rules", "Only the owner reads this."], [coOwnersNote, "Shared metrics", "Revenue per day."]] as const;
  docs.forEach(([noteId, title, text], position) => {
    const docId = crypto.randomUUID();
    const markdown = `# ${title}\n\n${text}`;
    db.query("INSERT INTO report_docs (id, report_id, position, source, ref, title, hash, added_by, added_via, created_at) VALUES (?, ?, ?, 'nook', ?, ?, ?, ?, 'create', ?)")
      .run(docId, sourceId, position, `${origin}/notes/${noteId}`, title, sha(markdown), owner.userId, new Date().toISOString());
    db.query("INSERT INTO report_doc_snapshots (id, report_id, sha256, title, markdown, fetched_at, doc_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(crypto.randomUUID(), sourceId, sha(markdown), title, markdown, new Date().toISOString(), docId);
  });
  db.query("UPDATE reports SET doc_source = 'nook', doc_ref = ?, doc_hash = ? WHERE id = ?").run(`${origin}/notes/${ownersNote}`, "a".repeat(64), sourceId);
  expect((await send(owner, "PUT", `/reports/${sourceId}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: viewer.userId, level: "view" }, { kind: "user", id: teamViewer.userId, level: "view" }] })).status).toBe(200);
  db.query("INSERT INTO report_schedules (report_id, cadence, at_time, tz, enabled, created_at, updated_at) VALUES (?, 'daily', '09:00', 'UTC', 1, ?, ?)").run(sourceId, new Date().toISOString(), new Date().toISOString());
  expect((await send(owner, "PUT", `/reports/${sourceId}/favorite`)).status).toBe(200);
  expect((await send(owner, "PUT", `/reports/${sourceId}/model`, { override: { providerId, model: null } })).status).toBe(200);
  // A version whose note is the agent's summary (the owner's only, D459).
  db.query("INSERT INTO report_versions (report_id, version, spec_json, source, note, created_by, created_at) VALUES (?, 3, ?, 'edit', 'Agent summary quoting the private doc', ?, ?)")
    .run(sourceId, (db.query("SELECT spec_json FROM reports WHERE id = ?").get(sourceId) as { spec_json: string }).spec_json, owner.userId, new Date().toISOString());
});
afterAll(() => {
  db.query("DELETE FROM agent_providers WHERE id = ?").run(providerId);
  fake.stop();
});

const resultRows = async (session: Session, reportId: string) => Object.fromEntries(((await send(session, "GET", `/reports/${reportId}/results`)).body.results as Json[]).map((item) => [item.queryKey, [item.result?.rows, item.result?.createdAt]]));

describe("Duplicate report (D575)", () => {
  test("an owner's copy: the spec, queries, filter options, results, model, and the docs they can read; nothing of the sharing, owners, schedule, stars, changes, or versions", async () => {
    const before = db.query("SELECT revision, updated_at FROM reports WHERE id = ?").get(sourceId);
    const copied = await send(coOwner, "POST", `/reports/${sourceId}/duplicate`, {});
    expect(copied.status).toBe(201);
    const copy = copied.body.report as Json;
    expect(copy).toMatchObject({ title: "Copy of Revenue", isOwner: true, ownerId: coOwner.userId, folderId: null, favorite: false, scheduleCadence: null, ownerCount: 1, status: "ready", datasourceId });
    expect(copied.body.duplicate).toEqual({ sourceId, sourceVersion: 3, results: 4, docs: 1, docsLeftOut: [{ title: "Owner's private rules" }], docsHidden: 0, model: "copied" });
    // The spec as it was, every block's provenance the copy's version 1.
    const source = sourceSpec();
    expect(copy.spec).toEqual({ ...source, blocks: source.blocks.map((block) => ({ ...block, provenance: { runId: null, version: 1 } })) });
    expect(db.query("SELECT key, sql FROM report_queries WHERE report_id = ? ORDER BY key").all(copy.id)).toEqual(source.queries.map((query) => ({ key: query.key, sql: query.sql })).sort((a, b) => a.key.localeCompare(b.key)));
    // The latest results, so it renders at once (and their time is the source's).
    expect(await resultRows(coOwner, copy.id)).toEqual(await resultRows(owner, sourceId));
    expect(db.query("SELECT values_json FROM report_param_options WHERE report_id = ? AND param_id = 'country'").get(copy.id)).toEqual({ values_json: JSON.stringify(["DE", "IN", "US"]) });
    expect((await send(coOwner, "GET", `/reports/${copy.id}/model`)).body.model.override).toEqual({ providerId, model: null });
    // Version 1, saying where it came from.
    const versions = (await send(coOwner, "GET", `/reports/${copy.id}/versions`)).body.versions as Json[];
    expect(versions.map((item) => [item.version, item.source, item.current, item.duplicatedFrom])).toEqual([[1, "initial", true, "“Revenue” v3"]]);
    expect(JSON.stringify(versions)).not.toContain("Agent summary");
    // The docs the co-owner can read (theirs), with its snapshot: not "Changed"; the owner's private note stays behind.
    const doc = (await send(coOwner, "GET", `/reports/${copy.id}/doc`)).body.doc;
    expect(doc.docs.map((item: Json) => [item.title, item.changed, item.added, item.addedVia])).toEqual([["Shared metrics", false, false, "create"]]);
    expect(doc.doc).toMatchObject({ serverId: "nook" });
    // Not copied.
    expect((await send(coOwner, "GET", `/reports/${copy.id}/sharing`)).body.sharing).toMatchObject({ visibility: "private" });
    expect(db.query("SELECT user_id FROM report_owners WHERE report_id = ?").all(copy.id)).toEqual([{ user_id: coOwner.userId }]);
    expect(db.query("SELECT COUNT(*) AS count FROM report_schedules WHERE report_id = ?").get(copy.id)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM report_favorites WHERE report_id = ?").get(copy.id)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM report_instructions WHERE report_id = ?").get(copy.id)).toEqual({ count: 0 });
    // Nobody else reaches the copy; the source did not change.
    expect((await send(owner, "GET", `/reports/${copy.id}`)).status).toBe(404);
    expect((await send(viewer, "GET", `/reports/${copy.id}`)).status).toBe(404);
    expect(db.query("SELECT revision, updated_at FROM reports WHERE id = ?").get(sourceId)).toEqual(before);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.report.duplicate' AND metadata_json LIKE ?").get(`%${copy.id}%`) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ id: copy.id, sourceId, sourceVersion: 3, owner: true, results: 4, docs: 1, docsLeftOut: 1, docsHidden: 0, model: "copied" });
    // The copy is a report like any other: its owner refreshes it.
    expect((await refresh.startRefresh(coOwner.userId, copy.id, { trigger: "user" }).done).status).toBe("succeeded");
  });

  test("a viewer's copy reveals nothing they could not see: no docs, no notes; in the folder and title they pick", async () => {
    const folder = await send(viewer, "POST", "/reports/folders", { name: `Copies ${crypto.randomUUID().slice(0, 4)}` });
    expect(folder.status).toBe(201);
    const copied = await send(viewer, "POST", `/reports/${sourceId}/duplicate`, { title: "My revenue", folderId: folder.body.folder.id });
    expect(copied.status).toBe(201);
    const copy = copied.body.report as Json;
    expect(copy).toMatchObject({ title: "My revenue", ownerId: viewer.userId, folderId: folder.body.folder.id, doc: null });
    expect(copied.body.duplicate).toMatchObject({ docs: 0, docsLeftOut: [], docsHidden: 2, results: 4 });
    expect(db.query("SELECT COUNT(*) AS count FROM report_docs WHERE report_id = ?").get(copy.id)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM report_doc_snapshots WHERE report_id = ?").get(copy.id)).toEqual({ count: 0 });
    expect(db.query("SELECT doc_ref, doc_hash, doc_server_id FROM reports WHERE id = ?").get(copy.id)).toEqual({ doc_ref: null, doc_hash: null, doc_server_id: null });
    // Everything stored for the copy is what the viewer reads on the source: no version note, no doc text.
    const stored = JSON.stringify([db.query("SELECT * FROM report_versions WHERE report_id = ?").all(copy.id), db.query("SELECT * FROM reports WHERE id = ?").get(copy.id)]);
    for (const secret of ["Agent summary", "Only the owner reads this", "Owner's private rules", "Shared metrics"]) expect(stored).not.toContain(secret);
    expect(await resultRows(viewer, copy.id)).toEqual(await resultRows(viewer, sourceId));
    // The provenance of a block names no run of the source.
    const provenance = await send(viewer, "GET", `/reports/${copy.id}/provenance?blockId=country-bar`);
    expect(provenance.body.run).toBeNull();
  });

  test("refused: someone who cannot open it (404), a read-only role (403), a folder that is not there, a binned report; the title is cut to fit", async () => {
    expect((await send(outsider, "POST", `/reports/${sourceId}/duplicate`, {})).status).toBe(404);
    const readOnly = await send(teamViewer, "POST", `/reports/${sourceId}/duplicate`, {});
    expect(readOnly.status).toBe(403);
    expect((await send(viewer, "POST", `/reports/${sourceId}/duplicate`, { folderId: crypto.randomUUID() })).status).toBe(404);
    expect((await send(viewer, "POST", `/reports/${sourceId}/duplicate`, { title: "" })).status).toBe(400);
    expect((await send(viewer, "POST", `/reports/${sourceId}/duplicate`, { extra: 1 })).status).toBe(400);
    expect(copyTitle("x".repeat(200))).toHaveLength(200);
    expect(copyTitle("x".repeat(200)).endsWith("…")).toBe(true);
    const binned = await send(owner, "POST", "/reports", { title: "Gone", datasourceId });
    expect((await send(owner, "DELETE", `/reports/${binned.body.report.id}`)).status).toBe(200);
    expect((await send(owner, "POST", `/reports/${binned.body.report.id}/duplicate`, {})).status).toBe(404);
    // An empty report copies too (no version yet).
    const empty = await send(owner, "POST", "/reports", { title: "Empty", datasourceId });
    const copy = await send(owner, "POST", `/reports/${empty.body.report.id}/duplicate`, {});
    expect(copy.status).toBe(201);
    expect(copy.body.duplicate).toMatchObject({ sourceVersion: null, results: 0 });
    expect(copy.body.report.status).toBe("draft");
  });

  test("MCP duplicate_report (reports:write) copies as the key's owner; never offered to chat agents", async () => {
    const tool = reportTools.find((item) => item.name === "duplicate_report")!;
    expect([tool.scopes, tool.write, tool.buckets]).toEqual([["reports:write"], true, ["report_write"]]);
    expect(NOOK_NEVER_TOOLS.has("duplicate_report")).toBe(true);
    const key = (session: Session) => ({ keyId: `k-dup-${session.userId.slice(0, 6)}`, userId: session.userId, name: "k", scopes: ["reports:read", "reports:write"] as never });
    await expect(Promise.resolve(tool.handler({ reportId: sourceId }, key(outsider)))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const result = await tool.handler({ reportId: sourceId, title: "From MCP" }, key(viewer)) as Json;
    expect(result.report).toMatchObject({ title: "From MCP", folderId: null, url: expect.stringContaining(`/reports/${result.report.id}`) });
    expect(result.duplicate).toMatchObject({ sourceId, docsHidden: 2, docs: 0 });
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.report.duplicate' AND metadata_json LIKE ?").get(`%${result.report.id}%`) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ via: "mcp", keyId: `k-dup-${viewer.userId.slice(0, 6)}` });
  });
});

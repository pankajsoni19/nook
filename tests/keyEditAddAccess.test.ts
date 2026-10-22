import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetKeyRouteLimits } = await import("../server/keyRoutes");
const { DEFAULT_POLICIES, policiesRevision, resetPoliciesForTests, writePolicies } = await import("../server/team/policies");

/**
 * Lane KEYS (D585, D586): editing a key may add permission rows. An edit that adds access is checked
 * like a new key's grants before the password (role, team policy, reachable items), then
 * re-authenticated, audited as `keys.update` with the scopes before and after, and keeps the key's
 * secret. Narrowing stays password-free.
 */

beforeEach(() => {
  resetMcpLimits();
  resetKeyRouteLimits();
});
afterEach(() => resetPoliciesForTests());

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function createKey(owner: Session, grants: unknown[]) {
  const created = await api(owner, "POST", "/keys", { name: "Edit me", surfaces: "mcp", expiresInDays: 30, password: owner.password, grants });
  expect(created.status).toBe(201);
  return created.body.key as { id: string; token: string; prefix: string };
}

async function tools(token: string) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return ((JSON.parse(json) as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((tool) => tool.name);
}

const grantRows = (keyId: string) => db.query("SELECT module, permission, resource_id FROM api_key_grants WHERE key_id = ? ORDER BY module, permission").all(keyId) as Array<{ module: string; permission: string; resource_id: string | null }>;
const auditRows = (actorId: string, type: string) => (db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY created_at").all(actorId, type) as Array<{ metadata_json: string }>).map((row) => JSON.parse(row.metadata_json) as Record<string, any>);
const accessActions = (keyId: string) => (db.query("SELECT action FROM access_events WHERE key_id = ? ORDER BY created_at, rowid").all(keyId) as Array<{ action: string }>).map((row) => row.action);

describe("PATCH /api/keys/:id adds access after re-authentication (D585)", () => {
  test("adds a module with the password: same key and secret, new tools, audited as keys.update with scopes before and after", async () => {
    const owner = await createUser("Add owner");
    const key = await createKey(owner, [{ module: "notes", permission: "read" }]);
    expect(await tools(key.token)).not.toContain("list_boards");
    const tokenHash = (db.query("SELECT token_hash FROM mcp_api_keys WHERE id = ?").get(key.id) as { token_hash: string }).token_hash;
    const added = await api(owner, "PATCH", `/keys/${key.id}`, { grants: [{ module: "notes", permission: "read" }, { module: "tasks", permission: "write" }], password: owner.password });
    expect(added.status).toBe(200);
    expect(added.body.changed).toEqual(["grants"]);
    expect(added.body.key.id).toBe(key.id);
    expect(added.body.key.token).toBeUndefined();
    // The secret is never regenerated or shown again; the old token now reaches Tasks.
    expect((db.query("SELECT token_hash FROM mcp_api_keys WHERE id = ?").get(key.id) as { token_hash: string }).token_hash).toBe(tokenHash);
    expect(await tools(key.token)).toContain("list_boards");
    expect(grantRows(key.id).map((row) => `${row.module}:${row.permission}`)).toEqual(["notes:read", "tasks:write"]);
    const [audit] = auditRows(owner.userId, "keys.update");
    expect(audit).toMatchObject({ keyId: key.id, fields: ["grants"], scopesBefore: ["notes:read"], added: ["tasks:write"] });
    expect(audit!.scopesAfter).toEqual(expect.arrayContaining(["notes:read", "tasks:read", "tasks:write"]));
    expect(accessActions(key.id)).toEqual(["key.created", "key.updated"]);
  });

  test("without the password, or with a wrong one, nothing changes and the failure is audited", async () => {
    const owner = await createUser("Add no password");
    const key = await createKey(owner, [{ module: "notes", permission: "read" }]);
    const body = { grants: [{ module: "notes", permission: "read" }, { module: "files", permission: "read" }] };
    expect((await api(owner, "PATCH", `/keys/${key.id}`, body)).status).toBe(401);
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { ...body, password: "not the password" })).body.code).toBe("REAUTH_FAILED");
    expect(grantRows(key.id).map((row) => row.module)).toEqual(["notes"]);
    expect(auditRows(owner.userId, "keys.update_failed").map((meta) => meta.keyId)).toEqual([key.id, key.id]);
    expect(accessActions(key.id)).toEqual(["key.created"]);
  });

  test("a module the owner cannot grant is refused before the password, like a new key's", async () => {
    const owner = await createUser("Add refusals");
    const admin = await createUser("Add refusals admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const key = await createKey(owner, [{ module: "notes", permission: "read" }]);
    const wrong = { password: "not the password" };
    // Team → Read is admins only.
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { ...wrong, grants: [{ module: "notes", permission: "read" }, { module: "team", permission: "read" }] })).body.code).toBe("SCOPE_NOT_ALLOWED");
    // A module team policy turned off for the role.
    writePolicies(admin.userId, { ...DEFAULT_POLICIES, keyModulesByRole: { ...DEFAULT_POLICIES.keyModulesByRole, member: ["notes"] } }, policiesRevision());
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { ...wrong, grants: [{ module: "notes", permission: "read" }, { module: "tasks", permission: "read" }] })).body).toMatchObject({ code: "KEY_POLICY", module: "tasks" });
    resetPoliciesForTests();
    // Someone else's private board looks missing (T205).
    const theirs = (await api(admin, "POST", "/tasks/boards", { name: "Theirs" })).body.board.id as string;
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { ...wrong, grants: [{ module: "notes", permission: "read" }, { module: "tasks", permission: "read", resourceIds: [theirs] }] })).body.code).toBe("RESOURCE_NOT_FOUND");
    // A viewer may add reads, never writes.
    const viewer = await createUser("Add viewer");
    const readKey = await createKey(viewer, [{ module: "notes", permission: "read" }]);
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    expect((await api(viewer, "PATCH", `/keys/${readKey.id}`, { ...wrong, grants: [{ module: "notes", permission: "read" }, { module: "tasks", permission: "write" }] })).body.code).toBe("SCOPE_NOT_ALLOWED");
    expect((await api(viewer, "PATCH", `/keys/${readKey.id}`, { password: viewer.password, grants: [{ module: "notes", permission: "read" }, { module: "tasks", permission: "read" }] })).status).toBe(200);
    // None of the refusals reached the password check.
    expect(auditRows(owner.userId, "keys.update_failed")).toEqual([]);
    expect(grantRows(key.id).map((row) => row.module)).toEqual(["notes"]);
  });

  test("removing rows and narrowing still need no password and stay key.narrowed; vault keys and surfaces still only narrow", async () => {
    const owner = await createUser("Add narrow");
    const key = await createKey(owner, [{ module: "notes", permission: "read" }, { module: "tasks", permission: "write" }]);
    const narrowed = await api(owner, "PATCH", `/keys/${key.id}`, { grants: [{ module: "tasks", permission: "read" }] });
    expect(narrowed.status).toBe(200);
    expect(accessActions(key.id)).toEqual(["key.created", "key.narrowed"]);
    expect(auditRows(owner.userId, "keys.update")).toEqual([]);
    // Adding a row and removing another in one save: one keys.update.
    const swapped = await api(owner, "PATCH", `/keys/${key.id}`, { grants: [{ module: "files", permission: "read" }], password: owner.password });
    expect(swapped.status).toBe(200);
    expect(auditRows(owner.userId, "keys.update")[0]).toMatchObject({ scopesBefore: ["tasks:read"], scopesAfter: ["files:read"], added: ["files:read"] });
    // Surfaces still only narrow, even with the password.
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { surfaces: "both", password: owner.password })).body.code).toBe("WIDENING_NOT_ALLOWED");
  });

  test("an integration's key: the admin adds a module with their password; Inbox and Team stay refused", async () => {
    const admin = await createUser("Add integration admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const bot = (await api(admin, "POST", "/team/integrations", { name: `Add bot ${crypto.randomUUID().slice(0, 6)}`, role: "member" })).body.integration as { id: string };
    const created = await api(admin, "POST", `/team/integrations/${bot.id}/keys`, { name: "Bot key", surfaces: "mcp", expiresInDays: 30, password: admin.password, grants: [{ module: "notes", permission: "read" }] });
    expect(created.status).toBe(201);
    const keyId = created.body.key.id as string;
    const path = `/team/integrations/${bot.id}/keys/${keyId}`;
    expect((await api(admin, "PATCH", path, { grants: [{ module: "notes", permission: "read" }, { module: "files", permission: "read" }] })).status).toBe(401);
    expect((await api(admin, "PATCH", path, { password: "not the password", grants: [{ module: "notes", permission: "read" }, { module: "inbox", permission: "read" }] })).body.code).toBe("KEY_POLICY");
    const added = await api(admin, "PATCH", path, { password: admin.password, grants: [{ module: "notes", permission: "read" }, { module: "files", permission: "read" }] });
    expect(added.status).toBe(200);
    expect(grantRows(keyId).map((row) => row.module)).toEqual(["files", "notes"]);
    expect(auditRows(admin.userId, "keys.update")[0]).toMatchObject({ keyId, added: ["files:read"] });
    // Narrowing needs no password here either.
    expect((await api(admin, "PATCH", path, { grants: [{ module: "files", permission: "read" }] })).status).toBe(200);
  });
});

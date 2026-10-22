import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { newSecret, newVault, resetVaultLimits, share } from "./support/vault";

const { resetKeyRouteLimits } = await import("../server/keyRoutes");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetKeyAlertsForTests } = await import("../server/vault/keyApi");
const { addedVaultEntries, describeAddedVaultGrants, describeKeyAdditions } = await import("../server/keyGrants");

/**
 * Lane VAULTKEY (D620–D624): editing a vault key may add access, as general keys may (D585). An
 * added vault or environment, or read → write, is checked against the owner's current vault access
 * before the password (404 when they cannot read it), then re-authenticated, audited as
 * `vault.keys.update` with the grants before and after, recorded in each vault's Activity, and told
 * to the owner by a security mail and a bell line with counts only. Narrowing stays password-free;
 * the vault settings turn on with the password too (D625), values over MCP after its own confirmation.
 */

beforeEach(() => {
  resetVaultLimits();
  resetMcpLimits();
  resetKeyRouteLimits();
  resetKeyAlertsForTests();
});

type VaultGrantBody = { module: "vault"; permission: "read" | "write"; vaultId: string; envId?: string | null };

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}

async function vaultKey(session: Session, grants: VaultGrantBody[], extra: Record<string, unknown> = {}) {
  const created = await api(session, "POST", "/keys", { name: "Deploy", kind: "vault", surfaces: "rest", grants, password: session.password, ...extra });
  if (created.status !== 201) throw new Error(`vault key refused: ${JSON.stringify(created.body)}`);
  return { id: created.body.key.id as string, token: created.body.key.token as string };
}

const grantRows = (keyId: string) => (db.query("SELECT permission, resource_id, env_id FROM api_key_grants WHERE key_id = ? ORDER BY resource_id, env_id, permission").all(keyId) as Array<{ permission: string; resource_id: string; env_id: string | null }>)
  .map((row) => `${row.permission}:${row.resource_id}:${row.env_id ?? "*"}`).sort();
const auditRows = (actorId: string, type: string) => (db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY created_at, rowid").all(actorId, type) as Array<{ metadata_json: string }>).map((row) => JSON.parse(row.metadata_json) as Record<string, any>);
const accessActions = (keyId: string) => (db.query("SELECT action FROM access_events WHERE key_id = ? ORDER BY created_at, rowid").all(keyId) as Array<{ action: string }>).map((row) => row.action);
const vaultEvents = (vaultId: string, keyId: string) => (db.query("SELECT event FROM vault_events WHERE vault_id = ? AND key_id = ? ORDER BY created_at, rowid").all(vaultId, keyId) as Array<{ event: string }>).map((row) => row.event);

async function readValue(token: string, vaultId: string, secretId: string, envId: string) {
  const response = await fetch(`${origin}/api/v1/vault/vaults/${vaultId}/secrets/${secretId}/values/${envId}`, { headers: { Authorization: `Bearer ${token}` } });
  return response.status;
}

describe("PATCH /api/keys/:id adds vault access after re-authentication (D620)", () => {
  test("adds another vault and raises read to write with the password: same secret, audited, in the vault's Activity", async () => {
    const owner = await createUser("VKE add owner");
    const first = await newVault(owner);
    const second = await newVault(owner);
    const secret = await newSecret(owner, second, "API_TOKEN", { dev: "abc" });
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: first.id, envId: first.envs.dev }]);
    const tokenHash = (db.query("SELECT token_hash FROM mcp_api_keys WHERE id = ?").get(key.id) as { token_hash: string }).token_hash;
    expect(await readValue(key.token, second.id, secret.id, second.envs.dev!)).toBe(404);
    const grants: VaultGrantBody[] = [
      { module: "vault", permission: "write", vaultId: first.id, envId: first.envs.dev },
      { module: "vault", permission: "read", vaultId: second.id }
    ];
    // Without the password nothing changes, and the failure is audited.
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { grants })).status).toBe(401);
    expect(auditRows(owner.userId, "vault.keys.update_failed").map((meta) => meta.keyId)).toEqual([key.id]);
    expect(grantRows(key.id)).toEqual([`read:${first.id}:${first.envs.dev}`]);
    const saved = await api(owner, "PATCH", `/keys/${key.id}`, { grants, password: owner.password });
    expect(saved.status).toBe(200);
    expect(saved.body.changed).toEqual(["grants"]);
    expect(saved.body.key.token).toBeUndefined();
    expect((db.query("SELECT token_hash FROM mcp_api_keys WHERE id = ?").get(key.id) as { token_hash: string }).token_hash).toBe(tokenHash);
    expect(grantRows(key.id)).toEqual([`read:${second.id}:*`, `write:${first.id}:${first.envs.dev}`].sort());
    // The same secret now reads the second vault.
    expect(await readValue(key.token, second.id, secret.id, second.envs.dev!)).toBe(200);
    const [audit] = auditRows(owner.userId, "vault.keys.update");
    expect(audit).toMatchObject({ keyId: key.id, fields: ["grants"], grantsBefore: [`read:${first.id}:${first.envs.dev}`], added: ["vault:read@1v", "vault:write@1e"] });
    expect([...audit!.grantsAfter].sort()).toEqual([`read:${second.id}:*`, `write:${first.id}:${first.envs.dev}`].sort());
    expect(JSON.stringify(audit)).not.toContain("API_TOKEN");
    expect(auditRows(owner.userId, "keys.update")).toEqual([]);
    expect(accessActions(key.id)).toEqual(["key.created", "key.updated"]);
    expect(vaultEvents(second.id, key.id)).toEqual(["apikey.update", "value.read"]);
    expect(vaultEvents(first.id, key.id)).toEqual(["apikey.create", "apikey.update"]);
  });

  test("a vault or environment the owner cannot reach is refused before the password: 404 when unreadable, 403 above their level", async () => {
    const owner = await createUser("VKE refuse owner");
    const member = await createUser("VKE refuse member");
    const shared = await newVault(owner);
    const hidden = await newVault(owner);
    await share(owner, shared, [{ session: member, levels: { dev: "read", staging: "write" } }]);
    const own = await newVault(member);
    const key = await vaultKey(member, [{ module: "vault", permission: "read", vaultId: own.id }]);
    const wrong = { password: "not the password" };
    const base: VaultGrantBody = { module: "vault", permission: "read", vaultId: own.id };
    // A vault the member cannot read looks missing (T205).
    expect((await api(member, "PATCH", `/keys/${key.id}`, { ...wrong, grants: [base, { module: "vault", permission: "read", vaultId: hidden.id }] })).body.code).toBe("RESOURCE_NOT_FOUND");
    expect((await api(member, "PATCH", `/keys/${key.id}`, { ...wrong, grants: [base, { module: "vault", permission: "read", vaultId: crypto.randomUUID() }] })).status).toBe(404);
    // An environment they cannot read in a vault they can.
    expect((await api(member, "PATCH", `/keys/${key.id}`, { ...wrong, grants: [base, { module: "vault", permission: "read", vaultId: shared.id, envId: shared.envs.prod }] })).status).toBe(404);
    // Write where they only read.
    expect((await api(member, "PATCH", `/keys/${key.id}`, { ...wrong, grants: [base, { module: "vault", permission: "write", vaultId: shared.id, envId: shared.envs.dev }] })).body.code).toBe("GRANT_EXCEEDS_ACCESS");
    // None reached the password check.
    expect(auditRows(member.userId, "vault.keys.update_failed")).toEqual([]);
    // What they hold may be added.
    expect((await api(member, "PATCH", `/keys/${key.id}`, { password: member.password, grants: [base, { module: "vault", permission: "write", vaultId: shared.id, envId: shared.envs.staging }] })).status).toBe(200);
    expect(grantRows(key.id)).toContain(`write:${shared.id}:${shared.envs.staging}`);
  });

  test("Edit turns on protected environments with the password, in the same save as the protected grant (D625)", async () => {
    const owner = await createUser("VKE protected owner");
    const vault = await newVault(owner);
    const plain = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const prod: VaultGrantBody = { module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.prod };
    const every: VaultGrantBody = { module: "vault", permission: "read", vaultId: vault.id };
    // A protected grant without the setting is refused before the password.
    expect((await api(owner, "PATCH", `/keys/${plain.id}`, { password: "wrong", grants: [every, prod] })).body.code).toBe("PROTECTED_ACCESS_REQUIRED");
    // With the setting, it asks for the password.
    expect((await api(owner, "PATCH", `/keys/${plain.id}`, { protectedAccess: true, grants: [every, prod] })).status).toBe(401);
    expect(auditRows(owner.userId, "vault.keys.update_failed").map((meta) => meta.keyId)).toEqual([plain.id]);
    const added = await api(owner, "PATCH", `/keys/${plain.id}`, { password: owner.password, protectedAccess: true, grants: [every, prod] });
    expect(added.status).toBe(200);
    expect(added.body.changed).toEqual(["grants", "vaultFlags"]);
    expect(added.body.key.vault).toEqual({ allowMcpValueReads: false, protectedAccess: true });
    expect(db.query("SELECT protected_at_grant FROM api_key_grants WHERE key_id = ? AND env_id = ?").get(plain.id, vault.envs.prod)).toEqual({ protected_at_grant: 1 });
    const [audit] = auditRows(owner.userId, "vault.keys.update");
    expect(audit).toMatchObject({ added: ["vault:write@1p", "vault:flag:protected"], flagsBefore: { protectedAccess: false }, flagsAfter: { protectedAccess: true } });
    // The confirmation row never outlives the save.
    expect(db.query("SELECT COUNT(*) AS n FROM vault_key_flag_confirmations").get()).toEqual({ n: 0 });
    // Narrowing back to an unprotected environment needs no password (D626) and turns the setting off (nothing needs it).
    const narrowed = await api(owner, "PATCH", `/keys/${plain.id}`, { grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.staging }] });
    expect(narrowed.body.changed).toEqual(["grants", "vaultFlags"]);
    expect(narrowed.body.key.vault.protectedAccess).toBe(false);
  });

  test("Edit turns on values over MCP with its own confirmation and the password; mail and bell say so (D625)", async () => {
    const owner = await createUser("VKE mcp owner");
    const vault = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id }]);
    const mail = await import("../server/mail");
    const { listAccessNotices } = await import("../server/access/notices");
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { password: owner.password, allowMcpValueReads: true })).body.code).toBe("MCP_VALUES_CONFIRM_REQUIRED");
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { allowMcpValueReads: true, confirmMcpValueReads: true })).status).toBe(401);
    mail.setMailTransportForTests(async () => ({ id: "msg_1" }));
    try {
      const saved = await api(owner, "PATCH", `/keys/${key.id}`, { password: owner.password, allowMcpValueReads: true, confirmMcpValueReads: true });
      expect(saved.status).toBe(200);
      expect(saved.body.key.vault.allowMcpValueReads).toBe(true);
    } finally {
      mail.setMailTransportForTests(null);
    }
    expect(auditRows(owner.userId, "vault.keys.update").at(-1)).toMatchObject({ fields: ["vaultFlags"], added: ["vault:flag:mcp_values"], flagsAfter: { allowMcpValueReads: true } });
    expect(accessActions(key.id)).toEqual(["key.created", "key.updated"]);
    const queued = db.query("SELECT payload FROM mail_outbox WHERE user_id = ? AND template = 'security.api_key_access_added'").all(owner.userId) as Array<{ payload: string }>;
    expect(JSON.parse(queued[0]!.payload).added).toEqual(["vault:flag:mcp_values"]);
    const bell = listAccessNotices(owner.userId, { unread: false, limit: 20 }).map((notice) => notice.title).filter((title) => title.includes("key"));
    expect(bell).toEqual(["Access was added to your vault key “Deploy”: MCP clients may read values. If this wasn't you, revoke it in Settings → API keys."]);
    // Turning it off needs nothing.
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { allowMcpValueReads: false })).body.key.vault.allowMcpValueReads).toBe(false);
  });

  test("narrowing needs no password, stays key.narrowed, and sends no mail or bell", async () => {
    const owner = await createUser("VKE narrow owner");
    const vault = await newVault(owner);
    const other = await newVault(owner);
    const key = await vaultKey(owner, [{ module: "vault", permission: "write", vaultId: vault.id }, { module: "vault", permission: "read", vaultId: other.id }]);
    const narrowed = await api(owner, "PATCH", `/keys/${key.id}`, { grants: [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }] });
    expect(narrowed.status).toBe(200);
    expect(accessActions(key.id)).toEqual(["key.created", "key.narrowed"]);
    expect(auditRows(owner.userId, "vault.keys.update")).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM mail_outbox WHERE user_id = ? AND template = 'security.api_key_access_added'").get(owner.userId)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM access_notices WHERE user_id = ? AND kind = 'key_access_added'").get(owner.userId)).toEqual({ n: 0 });
    // Expiry still only comes closer on Edit; a vault key always expires.
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { expiresInDays: null })).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await api(owner, "PATCH", `/keys/${key.id}`, { expiresInDays: 365, password: owner.password })).body.code).toBe("WIDENING_NOT_ALLOWED");
  });

  test("adding access queues a security mail and a bell line for a vault key, counts only (D622)", async () => {
    const owner = await createUser("VKE mail owner");
    const mail = await import("../server/mail");
    const { resolvePayload } = await import("../server/mail/resolve");
    const { renderTemplate } = await import("../server/mail/registry");
    const { listAccessNotices } = await import("../server/access/notices");
    const vault = await newVault(owner, "Payments secret vault");
    const other = await newVault(owner, "Billing secret vault");
    const key = await vaultKey(owner, [{ module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev }]);
    mail.setMailTransportForTests(async () => ({ id: "msg_1" }));
    try {
      const saved = await api(owner, "PATCH", `/keys/${key.id}`, { password: owner.password, grants: [
        { module: "vault", permission: "read", vaultId: vault.id, envId: vault.envs.dev },
        { module: "vault", permission: "write", vaultId: vault.id, envId: vault.envs.staging },
        { module: "vault", permission: "write", vaultId: other.id, envId: other.envs.dev },
        { module: "vault", permission: "read", vaultId: other.id }
      ] });
      expect(saved.status).toBe(200);
    } finally {
      mail.setMailTransportForTests(null);
    }
    const queued = db.query("SELECT payload FROM mail_outbox WHERE user_id = ? AND template = 'security.api_key_access_added'").all(owner.userId) as Array<{ payload: string }>;
    expect(queued.length).toBe(1);
    const payload = JSON.parse(queued[0]!.payload) as { keyId: string; added: string[] };
    expect(payload).toMatchObject({ keyId: key.id, added: ["vault:read@1v", "vault:write@2e"] });
    for (const hidden of [vault.id, other.id, vault.envs.staging!, "Payments", "Billing"]) expect(queued[0]!.payload).not.toContain(hidden);
    const resolved = resolvePayload("security.api_key_access_added", payload, { id: owner.userId, email: "x@example.test", displayName: "Owner", role: "member", tz: "UTC" }, Date.now()) as { data: { keyName: string; added: string; vault?: boolean } };
    expect(resolved.data).toMatchObject({ keyName: "Deploy", added: "Read values: 1 vault (every environment) · Read and write values: 2 environments", vault: true });
    const rendered = renderTemplate("security.api_key_access_added", resolved.data, { instanceName: "Nook", tz: "UTC" } as never);
    expect(rendered.subject).toContain("Access added to vault key “Deploy”");
    expect(rendered.html).not.toContain("Payments");
    const bell = listAccessNotices(owner.userId, { unread: false, limit: 20 }).map((notice) => notice.title).filter((title) => title.includes("key"));
    expect(bell).toEqual(["Access was added to your vault key “Deploy”: Read values: 1 vault (every environment) · Read and write values: 2 environments. If this wasn't you, revoke it in Settings → API keys."]);
  });

  test("the added entries are bounded counts, and either kind describes itself", () => {
    const grants = Array.from({ length: 40 }, (_, index) => ({ permission: "read" as const, resourceId: `v${index % 4}`, envId: `e${index}`, protectedAtGrant: index % 10 === 0 }));
    const entries = addedVaultEntries(grants);
    expect(entries).toEqual(["vault:read@36e", "vault:read@4p"]);
    expect(describeAddedVaultGrants(entries)).toBe("Read values: 36 environments · Read values: 4 protected environments");
    expect(describeKeyAdditions(["tasks:write@2", "files:read"])).toBe("Tasks: write (2 chosen items) · Files: read");
    expect(describeKeyAdditions(["vault:write@1v"])).toBe("Read and write values: 1 vault (every environment)");
    expect(describeAddedVaultGrants(["vault:admin@1v", "nonsense"])).toBe("");
  });
});

import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits, share } from "./support/vault";

/**
 * 2026-10-06 operator: protected environments ask for the password to read values, not to change
 * them. Every write path (create with values, PUT, "Also save in", clear, restore a version, import
 * preview and write, delete to the Bin, restore from the Bin) succeeds without the session's window
 * and still needs write access; every read path (a value, reveal, a version, export) still answers
 * 403 `REAUTH_REQUIRED`. No write answers with a value, and writes never open the window.
 * Vault keys keep their own rules (tests/vaultKeys*.test.ts, unchanged).
 */

beforeEach(() => resetVaultLimits());

const OLD = "prod-old-7f3a9c";
const NEW = "prod-new-2b8e41";
const BATCH = "prod-batch-c55d0e";
const IMPORTED = "prod-import-91aa07";
const CREATED = "prod-created-44e1b2";
const plaintexts = [OLD, NEW, BATCH, IMPORTED, CREATED];

function expectNoPlaintext(response: { text: string }) {
  for (const plain of plaintexts) expect(response.text).not.toContain(plain);
}

const windowOf = (sessionUserId: string) =>
  (db.query("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND vault_reauth_at IS NOT NULL").get(sessionUserId) as { count: number }).count;

describe("protected environments: writes need no window, reads still do", () => {
  test("each write path succeeds without the window and never answers with a value; each read path is refused", async () => {
    const owner = await createUser("PW owner");
    const writer = await createUser("PW writer");
    const vault = await newVault(owner);
    const prod = vault.envs.prod!;
    const dev = vault.envs.dev!;
    const secret = await newSecret(owner, vault, "PW_DB", { dev: "dev-db", prod: OLD });
    await share(owner, vault, [{ session: writer, levels: { dev: "write", prod: "write" } }]);
    const base = `/vaults/${vault.id}`;
    const value = `${base}/secrets/${secret.id}/values/${prod}`;
    expect((await call(writer, "GET", "/reauth")).body.reauthUntil).toBeNull();

    // Create a secret with a prod value.
    const created = await call(writer, "POST", `${base}/secrets`, { name: "PW_CREATED", values: { [prod]: { value: CREATED } } });
    expect(created.status).toBe(201);
    expect(created.body.secret.values[prod]).toMatchObject({ status: "set", version: 1 });
    expectNoPlaintext(created);

    // PUT a value.
    const put = await call(writer, "PUT", value, { value: NEW, expectedVersion: 1 });
    expect(put.status).toBe(200);
    expect(put.body.value).toMatchObject({ secretId: secret.id, envId: prod, version: 2 });
    expect(Object.keys(put.body.value).sort()).toEqual(["envId", "secretId", "updatedAt", "updatedBy", "version"]);
    expectNoPlaintext(put);

    // "Also save in" (batch) with prod.
    const batch = await call(writer, "PUT", `${base}/secrets/${secret.id}/values`, { values: [{ envId: dev, value: BATCH, expectedVersion: 1 }, { envId: prod, value: BATCH, expectedVersion: 2 }] });
    expect(batch.status).toBe(200);
    expect(batch.body.values.map((item: { envId: string; version: number }) => [item.envId, item.version])).toEqual([[dev, 2], [prod, 3]]);
    expectNoPlaintext(batch);

    // Restore a version (writes version 1's value as version 4).
    const restored = await call(writer, "POST", `${value}/versions/1/restore`, { expectedVersion: 3 });
    expect(restored.status).toBe(200);
    expect(restored.body.value).toMatchObject({ envId: prod, version: 4 });
    expectNoPlaintext(restored);

    // Clear the value.
    const cleared = await call(writer, "DELETE", `${value}?expectedVersion=4`);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ ok: true, version: 5 });

    // Import: the preview and the write.
    const entries = [{ name: "PW_DB", value: IMPORTED }, { name: "PW_CREATED", value: CREATED }, { name: "PW_FRESH", value: IMPORTED }];
    const preview = await call(writer, "POST", `${base}/environments/${prod}/import`, { entries, mode: "overwrite", dryRun: true });
    expect(preview.status).toBe(200);
    // Without the window the preview does not compare with prod's values: PW_CREATED holds the same
    // value, yet it is "update", never "same" (no equality oracle on values the session cannot read).
    expect(preview.body.entries.map((entry: { name: string; status: string }) => [entry.name, entry.status])).toEqual([["PW_DB", "set"], ["PW_CREATED", "update"], ["PW_FRESH", "create"]]);
    expectNoPlaintext(preview);
    const skipPreview = await call(writer, "POST", `${base}/environments/${prod}/import`, { entries, dryRun: true });
    expect(skipPreview.body.entries[1]).toMatchObject({ name: "PW_CREATED", status: "skip" });
    const imported = await call(writer, "POST", `${base}/environments/${prod}/import`, { entries, mode: "overwrite" });
    expect(imported.status).toBe(200);
    expect(imported.body.counts).toMatchObject({ create: 1, set: 1, update: 1 });
    expectNoPlaintext(imported);

    // Delete to the Bin, and restore from it.
    const deleted = await call(writer, "DELETE", `${base}/secrets/${secret.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true, binned: true });
    const fromBin = await request(`/bin/vault_secret/${secret.id}/restore`, { method: "POST", body: "{}" }, writer);
    expect(fromBin.status).toBe(200);
    expectNoPlaintext({ text: await fromBin.text() });

    // Every read path is still refused, naming prod, without a value.
    const reads = [
      await call(writer, "GET", value),
      await call(writer, "GET", `${value}/versions/1`),
      await call(writer, "POST", `${base}/reveal`, { cells: [{ secretId: secret.id, envId: prod }] }),
      await call(writer, "GET", `${base}/environments/${prod}/export?format=dotenv`)
    ];
    for (const response of reads) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "REAUTH_REQUIRED", envIds: [prod] });
      expectNoPlaintext(response);
    }

    // The writes did not open the window.
    expect((await call(writer, "GET", "/reauth")).body.reauthUntil).toBeNull();
    expect(windowOf(writer.userId)).toBe(0);
    // They are recorded (ids and counts only).
    const events = (db.query("SELECT event FROM vault_events WHERE vault_id = ? AND actor_id = ? ORDER BY created_at").all(vault.id, writer.userId) as Array<{ event: string }>).map((row) => row.event);
    for (const event of ["secret.create", "value.write", "value.restore", "value.clear", "import", "secret.delete", "secret.restore"]) expect(events).toContain(event);

    // The owner, inside the window, reads what was written.
    expect((await call(owner, "GET", value)).body.value.value).toBe(IMPORTED);
  });

  test("inside the window an import preview compares again (\"same\")", async () => {
    const owner = await createUser("PW window owner");
    const vault = await newVault(owner);
    await newSecret(owner, vault, "PW_SAME", { prod: OLD });
    const preview = await call(owner, "POST", `/vaults/${vault.id}/environments/${vault.envs.prod}/import`, { entries: [{ name: "PW_SAME", value: OLD }], dryRun: true });
    expect(preview.body.entries[0]).toMatchObject({ name: "PW_SAME", status: "same" });
  });

  test("write access is still required: a member who only reads prod gets 403 on every write", async () => {
    const owner = await createUser("PW ro owner");
    const reader = await createUser("PW ro reader");
    const vault = await newVault(owner);
    const prod = vault.envs.prod!;
    const secret = await newSecret(owner, vault, "PW_RO", { dev: "d", prod: OLD });
    await share(owner, vault, [{ session: reader, levels: { dev: "write", prod: "read" } }]);
    const base = `/vaults/${vault.id}`;
    const value = `${base}/secrets/${secret.id}/values/${prod}`;
    const refused = [
      await call(reader, "POST", `${base}/secrets`, { name: "PW_RO_NEW", values: { [prod]: { value: NEW } } }),
      await call(reader, "PUT", value, { value: NEW, expectedVersion: 1 }),
      await call(reader, "PUT", `${base}/secrets/${secret.id}/values`, { values: [{ envId: prod, value: NEW, expectedVersion: 1 }] }),
      await call(reader, "DELETE", `${value}?expectedVersion=1`),
      await call(reader, "POST", `${value}/versions/1/restore`, { expectedVersion: 1 }),
      await call(reader, "POST", `${base}/environments/${prod}/import`, { entries: [{ name: "PW_RO", value: NEW }], dryRun: true }),
      await call(reader, "POST", `${base}/environments/${prod}/import`, { entries: [{ name: "PW_RO", value: NEW }], mode: "overwrite" }),
      await call(reader, "DELETE", `${base}/secrets/${secret.id}`)
    ];
    for (const response of refused) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("VAULT_LEVEL");
      expectNoPlaintext(response);
    }
    // Nothing changed.
    expect((db.query("SELECT version FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secret.id, prod) as { version: number }).version).toBe(1);
  });

  test("CSRF and CAS still apply to writes without the window", async () => {
    const owner = await createUser("PW cas owner");
    const writer = await createUser("PW cas writer");
    const vault = await newVault(owner);
    const prod = vault.envs.prod!;
    const secret = await newSecret(owner, vault, "PW_CAS", { prod: OLD });
    await share(owner, vault, [{ session: writer, levels: { prod: "write" } }]);
    const value = `/vaults/${vault.id}/secrets/${secret.id}/values/${prod}`;
    const stale = await call(writer, "PUT", value, { value: NEW, expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "VALUE_CHANGED", currentVersion: 1 });
    expectNoPlaintext(stale);
    const noCsrf = await request(`/vault${value}`, { method: "PUT", body: JSON.stringify({ value: NEW, expectedVersion: 1 }) }, { ...writer, csrf: "wrong" });
    expect(noCsrf.status).toBe(403);
    expect((db.query("SELECT version FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secret.id, prod) as { version: number }).version).toBe(1);
  });

  test("not changed: lifting protection and deleting a protected environment still need the window", async () => {
    const owner = await createUser("PW lift owner");
    const vault = await newVault(owner, undefined, { unlock: false });
    const prod = vault.envs.prod!;
    expect((await call(owner, "PATCH", `/vaults/${vault.id}/environments/${prod}`, { protected: false })).body.code).toBe("REAUTH_REQUIRED");
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/environments/${prod}`)).body.code).toBe("REAUTH_REQUIRED");
  });
});

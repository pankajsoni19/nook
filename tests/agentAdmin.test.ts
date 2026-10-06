import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `server/agent-admin.ts` (Wave 40 review M3): verify-key and rotate-key against a database of their
 * own, in child processes with the CLI's real environment handling. Every child runs with
 * `--no-env-file` so a developer's `.env` never leaks in. The output is checked for fingerprints and
 * counts, and for the absence of both keys.
 */

const root = join(import.meta.dir, "..");
const dataDir = mkdtempSync(join(tmpdir(), "mynotes-agent-admin-"));
const totpKey = Buffer.alloc(32, 1).toString("base64");
const keyA = Buffer.alloc(32, 21).toString("base64");
const keyB = Buffer.alloc(32, 22).toString("base64");
const fingerprint = (key: string) => createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 8);
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: dataDir, TOTP_ENCRYPTION_KEY: totpKey, APP_ORIGIN: "http://localhost:24449", PORT: "24449" };

function run(args: string[], env: Record<string, string>) {
  const result = Bun.spawnSync(["bun", "--no-env-file", ...args], { cwd: root, env: { ...baseEnv, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
const admin = (command: string, env: Record<string, string>, flags: string[] = []) => run([join("server", "agent-admin.ts"), command, ...flags], env);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("agent-admin", () => {
  test("verify-key, a refused inline rotation, rotate-key with --key-saved, and verify-key under both keys", () => {
    // Seed: two providers sealed under key A, one without a key.
    const seed = run(["--eval", `
      const { db } = await import(${JSON.stringify(join(root, "server", "db.ts"))});
      const { sealSecret } = await import(${JSON.stringify(join(root, "server", "agents", "secrets.ts"))});
      const now = new Date().toISOString();
      const insert = db.query("INSERT INTO agent_providers (id, name, base_url, api_key_ct, api_key_hint, default_model, is_default, created_at, updated_at) VALUES (?, ?, 'https://api.example.test/v1', ?, ?, 'gpt-6-luna', ?, ?, ?)");
      insert.run("p1", "One", sealSecret("provider", "p1", "sk-test-one-aaaaaaaaaaaa"), "sk-…aaaa", 1, now, now);
      insert.run("p2", "Two", sealSecret("provider", "p2", "sk-test-two-bbbbbbbbbbbb"), "sk-…bbbb", 0, now, now);
      insert.run("p3", "Three", null, null, 0, now, now);
      console.log("SEEDED");
    `], { AGENT_SECRETS_KEY: keyA });
    expect({ code: seed.code, stderr: seed.stderr }).toEqual({ code: 0, stderr: "" });
    expect(seed.stdout).toContain("SEEDED");

    expect(admin("nonsense", { AGENT_SECRETS_KEY: keyA }).code).toBe(2);
    expect(admin("verify-key", {}).code).toBe(2);

    const verifyA = admin("verify-key", { AGENT_SECRETS_KEY: keyA });
    expect({ code: verifyA.code, stderr: verifyA.stderr }).toEqual({ code: 0, stderr: "" });
    expect(verifyA.stdout).toContain(`Key fingerprint: ${fingerprint(keyA)}`);
    expect(verifyA.stdout).toContain("opens all 2 stored provider secrets");

    const wrong = admin("verify-key", { AGENT_SECRETS_KEY: keyB });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("does not open 2 of 2");

    const inline = admin("rotate-key", { AGENT_SECRETS_KEY: keyA, AGENT_SECRETS_KEY_NEW: keyB });
    expect(inline.code).toBe(2);
    expect(inline.stderr).toContain("--key-saved");
    expect(admin("rotate-key", { AGENT_SECRETS_KEY: keyA, AGENT_SECRETS_KEY_NEW: keyA }, ["--key-saved"]).code).toBe(2);
    expect(admin("rotate-key", { AGENT_SECRETS_KEY: keyA, AGENT_SECRETS_KEY_NEW: totpKey }, ["--key-saved"]).stderr).toContain("AGENT_SECRETS_KEY_NEW must differ from TOTP_ENCRYPTION_KEY");
    expect(admin("rotate-key", { AGENT_SECRETS_KEY: keyA }).stderr).toContain("AGENT_SECRETS_KEY_NEW_FILE");

    const rotated = admin("rotate-key", { AGENT_SECRETS_KEY: keyA, AGENT_SECRETS_KEY_NEW: keyB }, ["--key-saved"]);
    expect({ code: rotated.code, stderr: rotated.stderr }).toEqual({ code: 0, stderr: "" });
    expect(rotated.stdout).toContain(`Current key fingerprint: ${fingerprint(keyA)}`);
    expect(rotated.stdout).toContain(`New key fingerprint:     ${fingerprint(keyB)}`);
    expect(rotated.stdout).toContain("Re-sealed 2 provider secrets");
    for (const output of [seed, verifyA, wrong, inline, rotated]) {
      expect(output.stdout + output.stderr).not.toContain(keyA);
      expect(output.stdout + output.stderr).not.toContain(keyB);
      expect(output.stdout + output.stderr).not.toContain("sk-test");
    }

    const verifyB = admin("verify-key", { AGENT_SECRETS_KEY: keyB });
    expect(verifyB.code).toBe(0);
    expect(verifyB.stdout).toContain(`Key fingerprint: ${fingerprint(keyB)}`);
    expect(admin("verify-key", { AGENT_SECRETS_KEY: keyA }).code).toBe(1);

    // The plaintexts survived the rotation, and the rotation was audited with counts only.
    const check = run(["--eval", `
      const { db } = await import(${JSON.stringify(join(root, "server", "db.ts"))});
      const { openSecret } = await import(${JSON.stringify(join(root, "server", "agents", "secrets.ts"))});
      const rows = db.query("SELECT id, api_key_ct FROM agent_providers WHERE api_key_ct IS NOT NULL ORDER BY id").all();
      const opened = rows.map((row) => openSecret("provider", row.id, row.api_key_ct));
      const audit = db.query("SELECT metadata_json AS metadata FROM audit_log WHERE event_type = 'agents.key_rotated'").all();
      console.log("PROBE " + JSON.stringify({ opened: opened.map((text) => text.slice(-4)), audit: audit.map((row) => row.metadata) }));
    `], { AGENT_SECRETS_KEY: keyB });
    expect(check.code).toBe(0);
    const probe = JSON.parse(check.stdout.split("\n").find((line) => line.startsWith("PROBE "))!.slice(6)) as { opened: string[]; audit: string[] };
    expect(probe.opened).toEqual(["aaaa", "bbbb"]);
    expect(probe.audit).toHaveLength(1);
    expect(JSON.parse(probe.audit[0]!)).toMatchObject({ providers: 2, servers: 0 });
  }, 120_000);
});

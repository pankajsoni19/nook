import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/api";
import { FRESH_VALUE_NOTE, opensFresh, protectedHint, ValueFields } from "../src/vault/VaultDialogs";
import { DEFAULT_ENVIRONMENTS } from "../shared/vault";

/**
 * 2026-10-06 operator: the value editor in a protected environment outside the window opens with an
 * empty "New value" field and saves without asking; Show (the current value) still asks. Writes
 * elsewhere in the client (New secret, "Also save in", Clear, Restore, Import, Delete) no longer go
 * through the re-authentication runner.
 */

const root = join(import.meta.dir, "..", "src", "vault");
const source = (name: string) => readFileSync(join(root, name), "utf8");
const noop = () => undefined;
const emptyLogin = { username: "", password: "", url: "" };

describe("the value editor's empty \"New value\" mode", () => {
  test("opens fresh only when its first read was refused for the window", () => {
    expect(opensFresh(new ApiError("protected", 403, { code: "REAUTH_REQUIRED", envIds: ["e"] }))).toBe(true);
    expect(opensFresh(new ApiError("level", 403, { code: "VAULT_LEVEL" }))).toBe(false);
    expect(opensFresh(new ApiError("gone", 404, { code: "VALUE_NOT_SET" }))).toBe(false);
    expect(opensFresh(new Error("network"))).toBe(false);
  });

  test("the note says what to do", () => {
    expect(FRESH_VALUE_NOTE).toBe("This environment is protected; enter the new value. Showing the current value asks for your password.");
  });

  test("fresh: an empty, visible \"New value\" field with Show (not masked) and Generate", () => {
    const html = renderToStaticMarkup(<ValueFields type="value" value="" login={emptyLogin} onValue={noop} onLogin={noop} valueId="v" onGenerate={noop} disabled={false}
      mask={{ masked: true, show: noop, mask: noop, touch: noop }} onShowCurrent={noop} />);
    expect(html).toContain(">New value</label>");
    expect(html).toContain("<textarea");
    expect(html).toContain('aria-label="Show the current value"');
    expect(html).toContain("Generate");
    expect(html).not.toContain("vault-secret-masked");
    expect(html).not.toContain("Hide");
  });

  test("fresh login: the password is \"New password\" and shown as typed", () => {
    const html = renderToStaticMarkup(<ValueFields type="login" value="" login={emptyLogin} onValue={noop} onLogin={noop} valueId="v" onGenerate={noop} disabled={false}
      mask={{ masked: true, show: noop, mask: noop, touch: noop }} onShowCurrent={noop} />);
    expect(html).toContain(">New password</label>");
    expect(html).not.toContain('type="password"');
  });

  test("inside the window: today's editor (the current value masked, with Show)", () => {
    const html = renderToStaticMarkup(<ValueFields type="value" value="current" login={emptyLogin} onValue={noop} onLogin={noop} valueId="v" onGenerate={noop} disabled={false}
      mask={{ masked: true, show: noop, mask: noop, touch: noop }} />);
    expect(html).toContain(">Value</label>");
    expect(html).toContain("vault-secret-masked");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Show the current value");
  });

  test("the editor reads without asking first, and saves without the runner", () => {
    const dialogs = source("VaultDialogs.tsx");
    expect(dialogs).toContain("void loadCurrent(false)");
    expect(dialogs).toContain("await setValue(vault.id, secret.id, env.id,");
    expect(dialogs).toContain("await setValues(vault.id, secret.id, [");
    expect(dialogs).not.toMatch(/run\(\(\) => setValues?\(/);
    expect(dialogs).not.toMatch(/run\(\(\) => createSecret\(/);
  });
});

describe("other writes no longer ask; reads still do", () => {
  test("Clear, Delete, Restore, and Import call the API directly; Reveal, Copy, a version's Show, and Export ask", () => {
    const app = source("VaultApp.tsx");
    const history = source("VaultHistory.tsx");
    const transfer = source("VaultTransfer.tsx");
    expect(app).toContain("await clearValue(vaultId,");
    expect(app).toContain("await deleteSecret(vaultId, secretId)");
    expect(app).not.toMatch(/run\(\(\) => (clearValue|deleteSecret)\(/);
    expect(history).toContain("await restoreVersion(vaultId,");
    expect(history).not.toMatch(/run\(\(\) => restoreVersion\(/);
    expect(transfer).not.toMatch(/run\(\(\) => importEntries\(/);
    expect(app).toMatch(/run\(\(\) => readValue\(vaultId, secret\.id, env\.id\)\)/);
    expect(history).toMatch(/run\(\(\) => readVersion\(/);
    expect(transfer).toMatch(/run\(\(\) => exportEnvironment\(/);
  });

  test("the copy says seeing values asks, saving does not", () => {
    expect(source("VaultDialogs.tsx")).toContain("A checked shield marks a protected environment: seeing or exporting its values asks you to confirm it's you (valid 15 minutes). Saving and importing values does not.");
    expect(protectedHint(DEFAULT_ENVIRONMENTS)).toContain("seeing its values asks for your password again");
    for (const name of ["VaultDialogs.tsx", "VaultTransfer.tsx", "VaultHistory.tsx", "VaultApp.tsx"]) {
      expect(source(name)).not.toMatch(/(revealing, editing|editing, importing)[^"]*confirm it's you/);
    }
  });
});

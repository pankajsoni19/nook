/**
 * Lane VAULTKEY (D620, D623), rendered with happy-dom: Settings → API keys → Vault → Edit. Every
 * row's dropdowns open (the Vault one too), Add vault access adds a row, the trash removes one, and
 * Save sends the whole set through PATCH; the password is asked only when the rows add access. Read
 * as the only level (an environment the owner only reads) is text with its reason.
 */
import { describe, expect, test } from "bun:test";
import { installDom, mockApi, render, type ApiCall } from "./support/dom";
import type { ApiKey, KeyGrantView } from "../src/keys/keysApi";

installDom("http://nook.test/settings/keys/vault");

const { KeysSettings } = await import("../src/keys/KeysSettings");
const { fixedAccessReason, vaultRowsAddingAccess } = await import("../src/keys/vaultKeyGrants");
const { act } = await import("react");

const PAY = "0b8f7c2e-1111-4111-8111-000000000001";
const BILL = "0b8f7c2e-1111-4111-8111-000000000002";
const env = (id: string, slug: string, name: string, level: "read" | "write" | "admin", isProtected = false) => ({ id, slug, name, protected: isProtected, level });
const vaults = [
  { id: PAY, name: "Payments", environments: [env("e-pay-dev", "dev", "Development", "write"), env("e-pay-stg", "staging", "Staging", "read"), env("e-pay-prod", "prod", "Production", "write", true)] },
  { id: BILL, name: "Billing", environments: [env("e-bill-dev", "dev", "Development", "write"), env("e-bill-stg", "staging", "Staging", "write")] }
];
const KEY_ID = "0b8f7c2e-5555-4555-8555-000000000002";
const grant = (vaultId: string, name: string, permission: string, envId: string | null, envName: string | null): KeyGrantView =>
  ({ module: "vault", permission, resource: { kind: "vault", id: vaultId, name }, env: envId ? { id: envId, name: envName, protected: false } : null, active: true, inactiveReason: null }) as unknown as KeyGrantView;
const key: ApiKey = {
  id: KEY_ID, name: "Deploy", description: null, prefix: "nkv_Ab3", kind: "vault", surfaces: "rest",
  createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, expiresAt: "2026-12-01T00:00:00.000Z", revokeAfter: null, revokedAt: null,
  rotatedFrom: null, state: "active", blockedBy: null, blockedMessage: null, revokedBy: null, revokeReason: null,
  grants: [grant(PAY, "Payments", "write", "e-pay-dev", "Development"), grant(PAY, "Payments", "read", "e-pay-stg", "Staging")],
  scopes: [], effectiveScopes: [], limits: {}, usage14d: Array(14).fill(0), vault: { allowMcpValueReads: false, protectedAccess: false }
} as ApiKey;
const policy = { keyMaxDays: 365, keyDefaultDays: 90, keyRequireExpiry: false, keysPerUser: 10, modules: ["notes", "vault"], mcpAllowed: true, restAllowed: true };

function routes(patches: ApiCall[]) {
  return mockApi({
    "GET /keys": () => ({ keys: [key], policy, liveCount: 1 }),
    "GET /vault/vaults": () => ({ vaults }),
    [`PATCH /keys/${KEY_ID}`]: (call) => { patches.push(call); return { changed: ["grants"], key }; }
  });
}

async function openEdit() {
  const view = await render(<KeysSettings onPendingChange={() => undefined} totpEnabled={false} role="member" vaultAvailable tab="vault" agentsAvailable={false} />);
  const edit = await view.waitFor(() => view.button("Edit"));
  await view.click(edit);
  await view.waitFor(() => document.querySelectorAll(".keys-dialog .grant-row").length === 2);
  return view;
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".keys-dialog .grant-row")];
const combos = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>("button[role=\"combobox\"]")];
const password = () => document.querySelector<HTMLInputElement>(".keys-dialog input[type=\"password\"]");
const typePassword = async (value: string) => {
  const field = password()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("Edit vault key: rows (D620, D623)", () => {
  test("the Vault and Environment dropdowns are enabled; read as the only level is text with its reason", async () => {
    routes([]);
    await openEdit();
    const [dev, staging] = rows();
    // Development: you write there, so Access is a dropdown too.
    expect(combos(dev!)).toHaveLength(3);
    expect(combos(dev!).every((button) => !button.disabled)).toBe(true);
    // Staging: you only read there, so Access is text with the reason; Vault and Environment still open.
    expect(combos(staging!)).toHaveLength(2);
    expect(combos(staging!).every((button) => !button.disabled)).toBe(true);
    const fixed = staging!.querySelector<HTMLElement>(".grant-fixed")!;
    expect(fixed.textContent).toContain("Read values");
    expect(fixed.title).toBe("Read only: you can only read here yourself");
    expect(document.querySelector(".keys-dialog .grant-add")).not.toBeNull();
    expect(password()).toBeNull();
    expect(document.querySelector(".keys-dialog")?.textContent).not.toContain("Editing can only remove access");
  });

  test("Add vault access adds a row and asks for the password; Save sends the full set with it", async () => {
    const patches: ApiCall[] = [];
    routes(patches);
    const view = await openEdit();
    await view.click(view.button("Add vault access")!);
    expect(rows()).toHaveLength(3);
    expect(combos(rows()[2]!).every((button) => !button.disabled)).toBe(true);
    expect(document.querySelector(".keys-adding-note")?.textContent).toContain("Vault access 3 adds access");
    expect(password()).not.toBeNull();
    // Remove the Staging row: still adding (row 3 is now row 2).
    await view.click(document.querySelector<HTMLButtonElement>("button[aria-label=\"Remove vault access 2\"]")!);
    expect(rows()).toHaveLength(2);
    expect(document.querySelector(".keys-adding-note")?.textContent).toContain("Vault access 2 adds access");
    await view.click(view.button("Save")!);
    expect(document.querySelector(".keys-dialog .form-error, .keys-dialog [role=\"alert\"]")?.textContent).toContain("Enter your password");
    expect(patches).toHaveLength(0);
    await typePassword("my password");
    await view.click(view.button("Save")!);
    await view.waitFor(() => patches.length === 1);
    expect(patches[0]!.body).toEqual({
      grants: [
        { module: "vault", permission: "write", vaultId: PAY, envId: "e-pay-dev" },
        { module: "vault", permission: "read", vaultId: PAY, envId: null }
      ],
      password: "my password"
    });
  });

  test("removing a row only narrows: saved without a password", async () => {
    const patches: ApiCall[] = [];
    routes(patches);
    const view = await openEdit();
    await view.click(document.querySelector<HTMLButtonElement>("button[aria-label=\"Remove vault access 2\"]")!);
    expect(password()).toBeNull();
    await view.click(view.button("Save")!);
    await view.waitFor(() => patches.length === 1);
    expect(patches[0]!.body).toEqual({ grants: [{ module: "vault", permission: "write", vaultId: PAY, envId: "e-pay-dev" }] });
  });

  test("vaultRowsAddingAccess mirrors the server's rule; fixedAccessReason only for a read row with no write to give", () => {
    const row = (vaultId: string, envId: string, permission: "read" | "write") => ({ key: `${vaultId}-${envId}-${permission}`, vaultId, envId, permission });
    const held = [row(PAY, "all", "write"), row(BILL, "e-bill-dev", "read")];
    expect(vaultRowsAddingAccess(held, [row(PAY, "e-pay-dev", "read")], false)).toEqual([]);
    expect(vaultRowsAddingAccess(held, [row(PAY, "e-pay-dev", "read")], true)).toHaveLength(1);
    expect(vaultRowsAddingAccess(held, [row(BILL, "e-bill-dev", "write")], false)).toHaveLength(1);
    expect(vaultRowsAddingAccess(held, [row(BILL, "all", "read")], false)).toHaveLength(1);
    expect(fixedAccessReason(vaults[0], { envId: "e-pay-stg", permission: "read" }, "member")).toBe("Read only: you can only read here yourself");
    expect(fixedAccessReason(vaults[0], { envId: "e-pay-dev", permission: "read" }, "member")).toBeNull();
    expect(fixedAccessReason(vaults[0], { envId: "e-pay-dev", permission: "read" }, "viewer")).toBe("Read only: your team role can only read");
    expect(fixedAccessReason(vaults[0], { envId: "e-pay-stg", permission: "write" }, "member")).toBeNull();
  });
});

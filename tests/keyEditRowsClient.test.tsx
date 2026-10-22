/**
 * Lane KEYS (D585, D587), rendered with happy-dom: Settings → API keys → Edit. Every row's dropdowns
 * open (none is a dead control), a module with one level shows it as text with its reason, Add
 * permission adds a row, the trash removes one, and Save sends the whole set through PATCH; the
 * password is asked only when the rows add access.
 */
import { describe, expect, test } from "bun:test";
import { installDom, mockApi, render, type ApiCall } from "./support/dom";
import type { ApiKey, KeyGrantView } from "../src/keys/keysApi";

installDom("http://nook.test/settings/keys/general");

const { KeysSettings } = await import("../src/keys/KeysSettings");
const { fixedLevelReason, rowsAddingAccess } = await import("../src/keys/keyGrants");
const { act } = await import("react");

const BOARD = "0b8f7c2e-4444-4444-8444-000000000001";
const KEY_ID = "0b8f7c2e-5555-4555-8555-000000000001";
const grant = (module: string, permission: string, resource: KeyGrantView["resource"] = null): KeyGrantView => ({ module, permission, resource, active: true, inactiveReason: null }) as KeyGrantView;
const key: ApiKey = {
  id: KEY_ID, name: "Laptop", description: null, prefix: "mynotes_Ab3", kind: "general", surfaces: "mcp",
  createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, expiresAt: "2026-12-01T00:00:00.000Z", revokeAfter: null, revokedAt: null,
  rotatedFrom: null, state: "active", blockedBy: null, blockedMessage: null, revokedBy: null, revokeReason: null,
  grants: [grant("notes", "read"), grant("today", "read"), grant("tasks", "write", { kind: "board", id: BOARD, name: "Sprint" }), grant("reports", "read")],
  scopes: [], effectiveScopes: [], limits: {}, usage14d: Array(14).fill(0)
};
const policy = { keyMaxDays: 365, keyDefaultDays: 90, keyRequireExpiry: false, keysPerUser: 10, modules: ["notes", "files", "tasks", "today", "calendar", "collections", "team", "inbox", "bin", "whiteboards", "agents", "reports"], mcpAllowed: true, restAllowed: true };

function routes(patches: ApiCall[]) {
  return mockApi({
    "GET /keys": () => ({ keys: [key], policy, liveCount: 1 }),
    "GET /tasks/boards": () => ({ boards: [{ id: BOARD, name: "Sprint", owner_name: "Me", is_owner: 1 }] }),
    "GET /tasks/views": () => ({ mine: [], shared: [], everyone: [] }),
    [`PATCH /keys/${KEY_ID}`]: (call) => { patches.push(call); return { changed: ["grants"], key }; }
  });
}

async function openEdit() {
  const view = await render(<KeysSettings onPendingChange={() => undefined} totpEnabled={false} role="member" vaultAvailable={false} agentsAvailable={false} />);
  const edit = await view.waitFor(() => view.button("Edit"));
  await view.click(edit);
  await view.waitFor(() => document.querySelectorAll(".keys-dialog .grant-row").length === 4);
  return view;
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".keys-dialog .grant-row")];
const combos = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>("button[role=\"combobox\"]")];
const typePassword = async (value: string) => {
  const field = document.querySelector<HTMLInputElement>(".keys-dialog input[type=\"password\"]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("Edit key: rows (D585, D587)", () => {
  test("every dropdown is enabled; Today's one level is text with its reason", async () => {
    routes([]);
    await openEdit();
    const [notes, today, tasks, reports] = rows();
    for (const row of [notes!, tasks!, reports!]) {
      expect(combos(row).length).toBeGreaterThanOrEqual(2);
      expect(combos(row).every((button) => !button.disabled)).toBe(true);
    }
    // Today: the Module dropdown works, the level is plain text with the reason on hover.
    expect(combos(today!).map((button) => button.getAttribute("aria-label") ?? button.textContent)).toHaveLength(1);
    expect(combos(today!)[0]!.disabled).toBe(false);
    const fixed = today!.querySelector<HTMLElement>(".grant-fixed")!;
    expect(fixed.title).toBe("Today has one level: read today");
    expect(fixed.textContent).toContain("Read Today");
    expect(fixedLevelReason("today")).toBe(fixed.title);
    expect(fixedLevelReason("notes")).toBeNull();
    // Chosen boards use the full picker (no remove-only chips).
    expect(tasks!.querySelector(".ui-combobox-input")).not.toBeNull();
    // A narrowing-only edit asks for no password.
    expect(document.querySelector(".keys-dialog input[type=\"password\"]")).toBeNull();
  });

  test("Add permission adds a row; removing a row works; Save sends the full set with the password", async () => {
    const patches: ApiCall[] = [];
    routes(patches);
    const view = await openEdit();
    await view.click(view.button("Add permission")!);
    expect(rows()).toHaveLength(5);
    // The new row is editable and starts on a free permission (Notes → Write drafts: Read is in row 1).
    const added = rows()[4]!;
    expect(combos(added).every((button) => !button.disabled)).toBe(true);
    expect(combos(added)[1]!.textContent).toContain("Write drafts");
    // It adds access: the dialog says which row and asks for the password.
    expect(document.querySelector(".keys-adding-note")?.textContent).toContain("Permission 5 adds access");
    expect(document.querySelector(".keys-dialog input[type=\"password\"]")).not.toBeNull();
    // Remove Today.
    const trash = document.querySelector<HTMLButtonElement>("button[aria-label=\"Remove Today: Read Today\"]")!;
    await view.click(trash);
    expect(rows()).toHaveLength(4);
    await view.click(view.button("Save")!);
    expect(document.querySelector(".keys-dialog .form-error, .keys-dialog [role=\"alert\"]")?.textContent).toContain("Enter your password");
    expect(patches).toHaveLength(0);
    await typePassword("my password");
    await view.click(view.button("Save")!);
    await view.waitFor(() => patches.length === 1);
    expect(patches[0]!.body).toEqual({
      grants: [
        { module: "notes", permission: "read" },
        { module: "tasks", permission: "write", resources: [{ kind: "board", id: BOARD }] },
        { module: "reports", permission: "read" },
        { module: "notes", permission: "draft" }
      ],
      password: "my password"
    });
  });

  test("removing a row only narrows: saved without a password", async () => {
    const patches: ApiCall[] = [];
    routes(patches);
    const view = await openEdit();
    await view.click(document.querySelector<HTMLButtonElement>("button[aria-label=\"Remove Reports: Read reports\"]")!);
    expect(document.querySelector(".keys-dialog input[type=\"password\"]")).toBeNull();
    await view.click(view.button("Save")!);
    await view.waitFor(() => patches.length === 1);
    expect(patches[0]!.body).toEqual({ grants: [{ module: "notes", permission: "read" }, { module: "today", permission: "read" }, { module: "tasks", permission: "write", resources: [{ kind: "board", id: BOARD }] }] });
  });

  test("rowsAddingAccess mirrors the server's narrowing rule", () => {
    const row = (module: string, permission: string, applies: "all" | "chosen" = "all", resourceIds: string[] = []) => ({ key: `${module}-${permission}-${applies}`, module, permission, applies, resourceIds }) as Parameters<typeof rowsAddingAccess>[0][number];
    const held = [row("notes", "draft"), row("tasks", "write", "chosen", ["board:a", "board:b"])];
    expect(rowsAddingAccess(held, [row("notes", "read")])).toEqual([]);
    expect(rowsAddingAccess(held, [row("tasks", "read", "chosen", ["board:a"])])).toEqual([]);
    expect(rowsAddingAccess(held, [row("tasks", "write", "chosen", ["board:c"])])).toHaveLength(1);
    expect(rowsAddingAccess(held, [row("tasks", "write")])).toHaveLength(1);
    expect(rowsAddingAccess(held, [row("notes", "publish")])).toHaveLength(1);
    expect(rowsAddingAccess(held, [row("files", "read")])).toHaveLength(1);
  });
});

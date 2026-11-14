import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessSheet } from "../src/access/AccessSheet";
import { WorkspaceAccess } from "../src/access/WorkspaceAccess";
import { accessPath, type ItemAccess } from "../src/access/accessApi";
import { accessSummary, audienceOptions, defaultLevelFor } from "../src/access/accessModel";
import { isWorkspaceAccessKind, levelDescription, WORKSPACE_ACCESS, type Level } from "../src/access/accessLevels";
import { WORKSPACE_CONTAINER_KINDS } from "../shared/workspaceModules";

/**
 * The shared Access sheet for every workspace container (D1050): one table of words per kind, the
 * generic `/api/access/:kind/:id` path, the one-line summary, and the modules' screens using the
 * shared control instead of their own sharing panels (D861, D891, D917, D949, D984).
 */

const id = "0190b7a0-0000-7000-8000-000000000001";
const LEVELS: Level[] = ["view", "comment", "edit", "manage"];

const access = (overrides: Partial<ItemAccess> = {}): ItemAccess => ({
  etag: "\"e\"", kind: "goal", title: "Grow MRR", owner: { id: "u-olive", displayName: "Olive" }, audience: "private", audienceLevel: "view", audienceLevels: ["view", "comment", "edit"],
  people: [], groups: [], levels: LEVELS, yourLevel: "owner", shareWithGuests: true, inheritable: false, ...overrides
});

describe("workspace kinds in the Access sheet", () => {
  test("every container kind has words, a level line per level, and the generic path", () => {
    for (const kind of WORKSPACE_CONTAINER_KINDS) {
      expect(isWorkspaceAccessKind(kind)).toBe(true);
      expect(WORKSPACE_ACCESS[kind].noun.length).toBeGreaterThan(0);
      for (const level of LEVELS) expect(levelDescription(kind, level).length).toBeGreaterThan(0);
      expect(accessPath(kind, id)).toBe(`/access/${kind}/${id}`);
    }
    // Existing kinds keep their own paths (byte-identical behaviour).
    expect(accessPath("board", id)).toBe(`/tasks/boards/${id}/access`);
    expect(isWorkspaceAccessKind("note")).toBe(false);
  });

  test("audience hints name the module's noun, and the module's own readers where it adds them", () => {
    expect(audienceOptions(access({ kind: "form" })).find((option) => option.value === "private")!.hint).toBe("Nobody else can open this form");
    expect(audienceOptions(access({ kind: "checkin" })).find((option) => option.value === "private")!.hint).toBe("Only you and the people taking part can open this standup");
    expect(audienceOptions(access({ kind: "note" })).find((option) => option.value === "private")!.hint).toBe("Nobody else can open this note");
  });

  test("time projects add people at Can edit (they log time); the rest at Can view", () => {
    expect(defaultLevelFor(access({ kind: "time_project" }))).toBe("edit");
    expect(defaultLevelFor(access({ kind: "contact_book" }))).toBe("view");
  });

  test("the summary line", () => {
    expect(accessSummary(access({ audience: "all_users", audienceLevel: "comment" }))).toBe("Everyone signed in · Can comment");
    expect(accessSummary(access({ kind: "form" }))).toBe("Only Olive");
    expect(accessSummary(access({ kind: "checkin" }))).toBe("Only Olive and the people taking part");
    const person = (name: string) => ({ id: name, displayName: name, teamRole: "member" as const, kind: "person" as const, level: "view" as const, via: "direct" as const, blocked: false });
    expect(accessSummary(access({ audience: "selected", people: [person("Ana")] }))).toBe("Olive and Ana");
    expect(accessSummary(access({ audience: "selected", people: ["Ana", "Ben", "Cy", "Di"].map(person), groups: [{ id: "g", name: "Ops", memberCount: 3, guestCount: 0, selfAddedCount: 0, level: "edit" }] })))
      .toBe("Olive and Ana, Ben, Cy, 1 more person, and 1 group");
  });

  test("the sheet renders a workspace kind with its level lines", () => {
    const html = renderToStaticMarkup(<AccessSheet kind="contact_book" id={id} title="Clients" onClose={() => {}} onSaved={() => {}} initial={{ access: access({ kind: "contact_book", audience: "all_users" }) }} />);
    expect(html).toContain("Nobody else can open this contact book");
    expect(html).toContain("Everyone signed in");
  });

  test("the control shows nothing to people who cannot change access, unless the module says something", () => {
    expect(renderToStaticMarkup(<WorkspaceAccess kind="form" id={id} title="Survey" canManage={false} />)).toBe("");
    expect(renderToStaticMarkup(<WorkspaceAccess kind="form" id={id} title="Survey" canManage={false} readOnlyText="Ask the owner" />)).toContain("Ask the owner");
    expect(renderToStaticMarkup(<WorkspaceAccess kind="form" id={id} title="Survey" canManage />)).toContain("Change who has access");
  });

  test("the modules use the shared control, not their own sharing panels", () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
    expect(read("src/forms/FormEditor.tsx")).toContain("<WorkspaceAccess kind=\"form\"");
    expect(read("src/checkins/StandupSettings.tsx")).toContain("<WorkspaceAccess kind=\"checkin\"");
    expect(read("src/crm/SettingsView.tsx")).toContain("<WorkspaceAccess kind=\"contact_book\"");
    expect(read("src/time/ProjectsTab.tsx")).toContain("<WorkspaceAccess kind=\"time_project\"");
    expect(read("src/bookings/TypeEditor.tsx")).toContain("<WorkspaceAccess kind=\"booking_type\"");
    expect(read("src/goals/GoalPage.tsx")).toContain("<AccessSheet kind=\"goal\"");
    expect(read("src/townhall/SessionPage.tsx")).toContain("<AccessSheet kind=\"townhall_session\"");
    for (const path of ["src/forms/FormEditor.tsx", "src/checkins/StandupSettings.tsx", "src/crm/SettingsView.tsx", "src/time/ProjectsTab.tsx"]) {
      expect(read(path)).not.toMatch(/method: "PUT"[^\n]*\/access\//);
    }
    expect(read("src/crm/crmApi.ts")).not.toContain("putBookAccess");
    expect(read("src/checkins/api.ts")).not.toContain("putStandupAccess");
  });
});

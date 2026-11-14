import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import "../src/workspaceModules";
import { parseRoute } from "../src/router";
import { settingsModulesFor, unavailableModules, unavailableText } from "../src/modules";
import { parseTimeRoute } from "../src/time/module";
import { answersAudienceText, StandupSettings } from "../src/checkins/StandupSettings";
import type { CheckinDetail } from "../shared/checkins";

/** Audit 2 plan/docs gaps, client side (docs/plan/WORKSPACE_MODULES.md §D.9, D1190–D1192). */

describe("module links (D1190)", () => {
  test("/contacts/followups opens Contacts' Follow-ups tab; the old ?tab= form never did", () => {
    expect(parseRoute("/contacts/followups")).toMatchObject({ app: "crm", path: ["followups"] });
    expect(parseRoute("/contacts?tab=followups")).toMatchObject({ app: "crm", path: [] });
  });

  test("a time project's ?tab= survives the route parser (team and approvals only)", () => {
    expect(parseTimeRoute(["projects", "site-abc1234567"], "?tab=approvals")).toEqual({ path: ["projects", "site-abc1234567"], search: "?tab=approvals" });
    expect(parseTimeRoute(["projects", "site-abc1234567"], "?tab=team")).toEqual({ path: ["projects", "site-abc1234567"], search: "?tab=team" });
    expect(parseTimeRoute(["projects", "site-abc1234567"], "?tab=evil")).toEqual({ path: ["projects", "site-abc1234567"] });
  });
});

describe("guests and role-limited modules (D1192)", () => {
  test("a guest's Settings lists Time when the server offers it, never Contacts or Bookings", () => {
    const onProject = unavailableModules({ time: true, crm: false, bookings: false });
    expect(onProject).toEqual(["crm", "bookings"]);
    const ids = settingsModulesFor("guest", onProject).map((module) => module.id);
    expect(ids).toContain("time");
    expect(ids).not.toContain("crm");
    expect(ids).not.toContain("bookings");
    const noProject = unavailableModules({ time: false, crm: false, bookings: false });
    expect(settingsModulesFor("guest", noProject).map((module) => module.id)).not.toContain("time");
    expect(unavailableModules({ vault: true, agents: true, reports: true, time: true, crm: true, bookings: true })).toEqual([]);
  });

  test("the route gate says why a role-limited module does not open", () => {
    expect(unavailableText("time")).toBe("Time opens once someone adds you to a time project.");
    expect(unavailableText("crm")).toBe("Contacts is not available to guests.");
    expect(unavailableText("vault")).toContain("not available on this server");
  });
});

const detail = (patch: Partial<CheckinDetail> = {}): CheckinDetail => ({
  id: "c1", shortId: "abc1234567", name: "Daily standup", template: "standup", anonymous: false, status: "active", level: "owner", revision: 1,
  schedule: { weekdays: [1, 2, 3, 4, 5], at: "09:30", everyNWeeks: 1, zoneMode: "each", tz: "UTC" }, deadlineMinutes: 240, participantCount: 0,
  description: "", privateAnswers: false, tz: "UTC", reminderMinutesBefore: null, summary: { notifyParticipants: false, email: false }, ownerId: "u1",
  groups: [], people: [], you: null, questions: { questions: [] }, questionsVersion: 1, hasDraft: false, createdAt: "2026-11-01T00:00:00Z",
  ...patch
} as unknown as CheckinDetail);

describe("standup private answers switch (D1191)", () => {
  const render = (value: CheckinDetail) => renderToStaticMarkup(<StandupSettings detail={value} canEdit onChanged={() => undefined} onDeleted={() => undefined} flash={() => undefined} role="member" {...({} as never)} />);

  test("managers get a Private answers switch that says who sees what", () => {
    const off = render(detail());
    expect(off).toContain("Private answers");
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*><span>Private answers/);
    expect(off).toContain(answersAudienceText({ anonymous: false, privateAnswers: false }));
    const on = render(detail({ privateAnswers: true }));
    expect(on).toMatch(/aria-checked="true"[^>]*><span>Private answers/);
    expect(on).toContain("each person sees only their own answers");
  });

  test("editors below manage and anonymous standups get no switch", () => {
    expect(render(detail({ level: "edit" } as Partial<CheckinDetail>))).not.toContain("Private answers");
    const anonymous = render(detail({ anonymous: true }));
    expect(anonymous).not.toContain("Private answers");
    expect(anonymous).toContain("only ever shown without names");
  });
});

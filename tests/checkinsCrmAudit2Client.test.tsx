import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionRow } from "../src/crm/RecordPage";
import { StandupRow } from "../src/checkins/StandupsApp";
import type { CrmInteraction } from "../shared/crm";
import type { CheckinSummary } from "../shared/checkins";

/** Audit 2 UI fixes for Standups and Contacts (docs/plan/WORKSPACE_MODULES.md §D.9, D1168–D1170). */

const interaction = (title: string): CrmInteraction => ({
  id: "i1", bookId: "b1", kind: "note", direction: "none", occurredAt: "2026-11-14T10:00:00.000Z", durationS: null, title, body: "Called back", author: { id: "u1", name: "Pat" } as never,
  source: "manual" as never, subjects: [], createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:00:00.000Z", canEdit: false
});

describe("contacts", () => {
  test("UI5: Contacts sheets keep the phone full-screen sheet; their width applies from 761 px (D1168)", () => {
    const css = readFileSync("src/crm/crm.css", "utf8") + readFileSync("src/crm/crmPanels.css", "utf8");
    expect(css).toContain("@media (min-width: 761px) { .crm-sheet { width:");
    expect(css).toContain("@media (min-width: 761px) { .file-dialog.crm-import { width:");
    expect(css).not.toMatch(/^\.crm-sheet \{ width/m);
    expect(css).not.toMatch(/^\.file-dialog\.crm-import \{ width/m);
  });

  test("an interaction without a title names its kind once, not 'Note · Note' (D1169)", () => {
    const untitled = renderToStaticMarkup(<InteractionRow interaction={interaction("")} onDelete={() => {}} self="contact" />);
    expect(untitled).toContain("<strong>Note</strong>");
    expect(untitled).not.toContain(" · Note");
    expect(untitled).toContain(" · Pat · ");
    const titled = renderToStaticMarkup(<InteractionRow interaction={interaction("Renewal")} onDelete={() => {}} self="contact" />);
    expect(titled).toContain("<strong>Renewal</strong>");
    expect(titled).toContain(" · Note");
  });
});

describe("standups", () => {
  test("UI10: a standup with no round yet shows when its first round opens (D1170)", () => {
    const item = {
      id: "c1", shortId: "abc", href: "/standups/daily-abc", name: "Daily", template: "standup", anonymous: false, status: "active",
      schedule: { weekdays: [1, 2, 3, 4, 5], at: "09:30", everyNWeeks: 1, zoneMode: "each", tz: "UTC" }, deadlineMinutes: 360, participantCount: 2, participants: [],
      level: "comment", youParticipate: true, streak: 0, lastRound: null, nextOpensAt: "2026-11-16T09:30:00.000Z", revision: 1
    } as unknown as CheckinSummary;
    expect(renderToStaticMarkup(<StandupRow item={item} onOpen={() => {}} />)).toContain("First round ");
    expect(renderToStaticMarkup(<StandupRow item={{ ...item, status: "paused", nextOpensAt: null } as CheckinSummary} onOpen={() => {}} />)).toContain("No rounds yet");
  });
});

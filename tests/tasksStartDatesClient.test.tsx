import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardFields } from "../src/tasks/CardFields";
import { changeAsStart, dateOrderError, DuePicker, startAsDue, startChange, startTriggerLabel } from "../src/tasks/DuePicker";
import { displayedStartDay, shiftedStartOn, spanningDays } from "../src/tasks/calendarPlacement";
import { cardDateStatus, startChipLabel } from "../src/tasks/taskActions";
import { chipLabel } from "../src/tasks/FilterBar";
import type { CardDetail } from "../src/tasks/tasksApi";

/** Card start dates in the app (D720, D721, D723, D724): the picker, the range chip, and the calendar span. */

const zone = "Europe/Berlin";
const card: CardDetail = {
  id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Launch", has_description: 0, revision: 3, created_by: "u1", creator_name: "Ann",
  due_on: "2026-11-15", due_time: null, due_tz: null, due_at: null, start_on: "2026-11-12", start_time: null, start_tz: null, start_at: null,
  assignees: [], assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", description: ""
};

test("the start reuses the due picker's rules under its own names", () => {
  expect(startAsDue(card)).toEqual({ due_on: "2026-11-12", due_time: null, due_tz: null, due_at: null });
  expect(changeAsStart({ dueOn: "2026-11-13", dueTime: "09:00", dueTz: zone })).toEqual({ startOn: "2026-11-13", startTime: "09:00", startTz: zone });
  expect(startChange(card, { date: "2026-11-13", time: "09:00", withTime: true }, zone))
    .toEqual({ change: { startOn: "2026-11-13", startTime: "09:00", startTz: zone }, success: "Start date and time saved" });
  expect(startChange(card, { date: "", time: "", withTime: false }, zone)).toEqual({ change: { startOn: null }, success: "Start date removed" });
  expect(startChange(card, { date: "2026-11-12", time: "", withTime: false }, zone)).toBeNull();
  expect(startTriggerLabel({ start_on: null }, "2026-11-13", zone)).toBe("No start date");
  expect(startTriggerLabel(card, "2026-11-13", zone)).toMatch(/12/);
});

test("the picker refuses a start after the due date, and a due date before the start (civil dates)", () => {
  expect(dateOrderError("start", card, { date: "2026-11-15", time: "", withTime: false })).toBeNull();
  expect(dateOrderError("start", card, { date: "2026-11-16", time: "", withTime: false })).toBe("The start must be on or before the due date.");
  expect(dateOrderError("due", card, { date: "2026-11-11", time: "", withTime: false })).toBe("The due date must be on or after the start.");
  expect(dateOrderError("due", card, { date: "", time: "", withTime: false })).toBeNull();
  expect(dateOrderError("start", { ...card, due_on: null }, { date: "2030-01-01", time: "", withTime: false })).toBeNull();
});

test("the card fields show Start before Due, as a picker or as text", () => {
  const html = renderToStaticMarkup(<CardFields card={card} userId="u1" idPrefix="card" done={false} saving={false} onSave={async () => true} />);
  expect(html.indexOf("card-start-input")).toBeGreaterThan(-1);
  expect(html.indexOf("card-start-input")).toBeLessThan(html.indexOf("card-due-input"));
  const readOnly = renderToStaticMarkup(<CardFields card={card} userId="u1" idPrefix="card" done={false} saving={false} onSave={async () => true} readOnly />);
  expect(readOnly).toContain("Start");
  expect(readOnly).toContain("2026-11-12");
  expect(renderToStaticMarkup(<CardFields card={{ ...card, start_on: null }} userId="u1" idPrefix="card" done={false} saving={false} onSave={async () => true} readOnly />)).toContain("No start date");
  const open = renderToStaticMarkup(<DuePicker kind="start" card={card} idPrefix="p" done={false} disabled={false} onApply={async () => true} presentation="popover" defaultOpen />);
  expect(open).toContain('id="p-start-date"');
  expect(open).toContain('aria-label="Start date"');
});

test("the date chip shows the range, toned by the due date", () => {
  const today = "2026-11-13";
  const range = cardDateStatus(card, today, false, { timeZone: zone });
  expect(range?.label).toMatch(/→/);
  expect(range?.label.endsWith("→")).toBe(false);
  expect(range?.description).toMatch(/^Starts .+, due /);
  expect(range?.tone).toBe("soon");
  // A start alone; done cards show nothing; no start is the plain due chip.
  expect(cardDateStatus({ ...card, due_on: null }, today, false, { timeZone: zone })).toMatchObject({ tone: "later", description: expect.stringMatching(/^Starts /) });
  expect(cardDateStatus({ ...card, due_on: null }, today, false, { timeZone: zone })?.label.endsWith("→")).toBe(true);
  expect(cardDateStatus(card, today, true)).toBeNull();
  expect(cardDateStatus({ ...card, start_on: null }, today, false, { timeZone: zone })?.label).not.toMatch(/→/);
  // A timed start reads in the viewer's zone, as the due chip does.
  const timed = { start_on: "2026-11-13", start_time: "09:00", start_at: "2026-11-13T08:00:00.000Z" };
  expect(startChipLabel(timed, today, zone)).toBe("Today 09:00");
  expect(startChipLabel(timed, today, "America/New_York")).toBe("Today 03:00");
  expect(cardDateStatus({ ...timed, due_on: null }, today, false, { timeZone: zone })?.description).toBe("Starts today 09:00");
});

test("the calendar spans a card from its start to the day before its due day, clipped to the grid", () => {
  const cards = [
    { id: "range", due_on: "2026-11-15", start_on: "2026-11-12" },
    { id: "same", due_on: "2026-11-15", start_on: "2026-11-15" },
    { id: "plain", due_on: "2026-11-15" },
    { id: "unscheduled", due_on: null, start_on: "2026-11-12" },
    { id: "long", due_on: "2026-12-02", start_on: "2026-01-01" }
  ];
  const spans = spanningDays(cards, "UTC", "2026-10-26", "2026-12-06");
  expect([...spans.keys()].filter((day) => spans.get(day)!.some((item) => item.id === "range"))).toEqual(["2026-11-12", "2026-11-13", "2026-11-14"]);
  const ids = new Set([...spans.values()].flat().map((item) => item.id));
  expect(ids.has("same") || ids.has("plain") || ids.has("unscheduled")).toBe(false);
  // A year-long range costs only the grid's days.
  const long = [...spans.entries()].filter(([, items]) => items.some((item) => item.id === "long")).map(([day]) => day).sort();
  expect(long[0]).toBe("2026-10-26");
  expect(long[long.length - 1]).toBe("2026-12-01");
  // A timed start shows on the viewer's local day.
  expect(displayedStartDay({ start_on: "2026-11-12", start_time: "23:30", start_at: "2026-11-12T22:30:00.000Z" }, "Asia/Tokyo")).toBe("2026-11-13");
});

test("a drag or Alt+Arrow moves the start by as many days as the due date", () => {
  expect(shiftedStartOn({ start_on: "2026-11-12", due_on: "2026-11-15" }, "2026-11-18")).toBe("2026-11-15");
  expect(shiftedStartOn({ start_on: "2026-11-12", due_on: "2026-11-15" }, "2026-11-10")).toBe("2026-11-07");
  expect(shiftedStartOn({ start_on: null, due_on: "2026-11-15" }, "2026-11-18")).toBeUndefined();
  expect(shiftedStartOn({ start_on: "2026-11-12", due_on: "2026-11-15" }, null)).toBeUndefined();
});

test("start: chips read in words", () => {
  const board = { board: { id: "b1" }, columns: [], cards: [], tags: [] } as unknown as Parameters<typeof chipLabel>[1];
  const context = { userId: "u1", today: "2026-11-13" } as Parameters<typeof chipLabel>[2];
  expect(chipLabel({ key: "start", negate: false, values: ["week", "none"] }, board, context)).toBe("Starts in the next 7 days or No start date");
  expect(chipLabel({ key: "start", negate: false, values: ["<2026-12-01"] }, board, context)).toMatch(/^Starts before /);
});

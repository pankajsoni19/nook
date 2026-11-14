import { describe, expect, test } from "bun:test";
import { durationMinutes, icsBusy, parseProps, zoneFor } from "../server/bookings/icsParse";

/** Outside busy feeds (§G.1 Q1): the ICS reader on Google- and Outlook-shaped calendars. Pure. */

const ics = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "X-WR-TIMEZONE:Europe/Berlin", ...events, "END:VCALENDAR"].join("\r\n");
const event = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", "END:VALARM", "END:VEVENT"].join("\r\n");
const iso = (intervals: Array<{ start: number; end: number }>) => intervals.map((item) => [new Date(item.start).toISOString(), new Date(item.end).toISOString()]);
const FROM = Date.parse("2026-03-01T00:00:00Z");
const TO = Date.parse("2026-05-01T00:00:00Z");

describe("ICS busy", () => {
  test("properties: folding, params, quoted colons", () => {
    const props = parseProps("BEGIN:VEVENT\r\nDESCRIPTION:a long\r\n  line\r\nDTSTART;TZID=\"Europe/Berlin\":20260302T090000\r\nEND:VEVENT");
    expect(props.find((prop) => prop.name === "DESCRIPTION")?.value).toBe("a long line");
    expect(props.find((prop) => prop.name === "DTSTART")?.params.TZID).toBe("Europe/Berlin");
    expect(durationMinutes("PT1H30M")).toBe(90);
    expect(durationMinutes("P1W")).toBe(10080);
    expect(zoneFor("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(zoneFor("/mozilla.org/20070129_1/Europe/Paris")).toBe("Europe/Paris");
  });
  test("a single UTC event, a TZID event, and a floating one", () => {
    const { intervals } = icsBusy(ics(
      event("UID:a", "DTSTART:20260302T100000Z", "DTEND:20260302T110000Z"),
      event("UID:b", "DTSTART;TZID=America/New_York:20260302T090000", "DURATION:PT30M"),
      event("UID:c", "DTSTART:20260303T090000", "DTEND:20260303T093000")
    ), FROM, TO, "UTC");
    expect(iso(intervals)).toEqual([
      ["2026-03-02T10:00:00.000Z", "2026-03-02T11:00:00.000Z"],
      ["2026-03-02T14:00:00.000Z", "2026-03-02T14:30:00.000Z"],
      ["2026-03-03T08:00:00.000Z", "2026-03-03T08:30:00.000Z"] // floating → the calendar's X-WR-TIMEZONE (Berlin, CET)
    ]);
  });
  test("cancelled and transparent (free) events are not busy", () => {
    const { intervals } = icsBusy(ics(
      event("UID:a", "DTSTART:20260302T100000Z", "DTEND:20260302T110000Z", "STATUS:CANCELLED"),
      event("UID:b", "DTSTART:20260302T120000Z", "DTEND:20260302T130000Z", "TRANSP:TRANSPARENT")
    ), FROM, TO, "UTC");
    expect(intervals).toEqual([]);
  });
  test("weekly recurrence across the DST change keeps 09:00 Berlin, with EXDATE and an overridden instance", () => {
    const { intervals } = icsBusy(ics(
      event("UID:standup", "DTSTART;TZID=Europe/Berlin:20260323T090000", "DTEND;TZID=Europe/Berlin:20260323T091500", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4",
        "EXDATE;TZID=Europe/Berlin:20260406T090000"),
      event("UID:standup", "RECURRENCE-ID;TZID=Europe/Berlin:20260330T090000", "DTSTART;TZID=Europe/Berlin:20260330T150000", "DTEND;TZID=Europe/Berlin:20260330T151500")
    ), FROM, TO, "UTC");
    expect(iso(intervals)).toEqual([
      ["2026-03-23T08:00:00.000Z", "2026-03-23T08:15:00.000Z"], // CET
      ["2026-03-30T13:00:00.000Z", "2026-03-30T13:15:00.000Z"], // moved to 15:00 CEST
      ["2026-04-13T07:00:00.000Z", "2026-04-13T07:15:00.000Z"] // CEST; 6 April skipped
    ]);
  });
  test("daily with UNTIL, monthly on the second Tuesday, Outlook's Windows zone", () => {
    const daily = icsBusy(ics(event("UID:d", "DTSTART;TZID=W. Europe Standard Time:20260310T120000", "DTEND;TZID=W. Europe Standard Time:20260310T130000", "RRULE:FREQ=DAILY;UNTIL=20260312T235959Z")), FROM, TO, "UTC");
    expect(daily.intervals.length).toBe(3);
    expect(new Date(daily.intervals[0]!.start).toISOString()).toBe("2026-03-10T11:00:00.000Z");
    const monthly = icsBusy(ics(event("UID:m", "DTSTART;TZID=Europe/Berlin:20260310T100000", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=2TU")), FROM, TO, "UTC");
    expect(iso(monthly.intervals).map(([start]) => start)).toEqual(["2026-03-10T09:00:00.000Z", "2026-04-14T08:00:00.000Z"]);
  });
  test("all-day events become whole days in the host's zone, flagged", () => {
    const { intervals } = icsBusy(ics(event("UID:h", "DTSTART;VALUE=DATE:20260305", "DTEND;VALUE=DATE:20260307")), FROM, TO, "Asia/Tokyo");
    expect(intervals).toEqual([{ start: Date.parse("2026-03-04T15:00:00Z"), end: Date.parse("2026-03-06T15:00:00Z"), allDay: true, dates: ["2026-03-05", "2026-03-07"] }]);
  });
  test("only the window is returned, and garbage is ignored", () => {
    const { intervals } = icsBusy(ics(event("UID:x", "DTSTART:garbage"), event("UID:y", "DTSTART:20250101T100000Z", "DTEND:20250101T110000Z")), FROM, TO, "UTC");
    expect(intervals).toEqual([]);
    expect(icsBusy("not a calendar", FROM, TO, "UTC").intervals).toEqual([]);
  });
});

describe("RRULE expansion (audit 2, D1120)", () => {
  const NOV = Date.parse("2026-11-01T00:00:00Z");
  const JAN = Date.parse("2027-01-01T00:00:00Z");
  const starts = (...lines: string[]) => icsBusy(ics(event("UID:r", ...lines)), NOV, JAN, "UTC").intervals.map((item) => new Date(item.start).toISOString().slice(0, 16));
  test("weekly BYDAY not including DTSTART's weekday: DTSTART is the first instance and COUNT is not spent on invented ones (BK1)", () => {
    expect(starts("DTSTART:20261102T150000Z", "DTEND:20261102T160000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4"))
      .toEqual(["2026-11-02T15:00", "2026-11-03T15:00", "2026-11-05T15:00", "2026-11-10T15:00"]);
    // Daily on weekdays, starting on a Sunday: no extra Sundays.
    expect(starts("DTSTART:20261101T150000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;BYDAY=MO,WE;COUNT=4"))
      .toEqual(["2026-11-01T15:00", "2026-11-02T15:00", "2026-11-04T15:00", "2026-11-09T15:00"]);
    // Every other week on Tuesday and Thursday.
    expect(starts("DTSTART:20261103T150000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=4"))
      .toEqual(["2026-11-03T15:00", "2026-11-05T15:00", "2026-11-17T15:00", "2026-11-19T15:00"]);
  });
  test("monthly BYMONTHDAY and monthly BYDAY without an ordinal are expanded (BK2)", () => {
    expect(starts("DTSTART:20261101T150000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15"))
      .toEqual(["2026-11-01T15:00", "2026-11-15T15:00", "2026-12-01T15:00", "2026-12-15T15:00"]);
    expect(starts("DTSTART:20261102T150000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=MO;COUNT=6"))
      .toEqual(["2026-11-02T15:00", "2026-11-09T15:00", "2026-11-16T15:00", "2026-11-23T15:00", "2026-11-30T15:00", "2026-12-07T15:00"]);
    expect(starts("DTSTART:20261130T150000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1")).toEqual(["2026-11-30T15:00", "2026-12-31T15:00"]);
    // The 31st skips months without one; yearly in a month on its 4th Thursday.
    expect(starts("DTSTART:20261031T150000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY")).toEqual(["2026-12-31T15:00"]);
    expect(starts("DTSTART:20201126T150000Z", "DURATION:PT1H", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH")).toEqual(["2026-11-26T15:00"]);
    expect(icsBusy(ics(event("UID:r", "DTSTART:20261101T150000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYMONTHDAY=1")), NOV, JAN, "UTC").unsupported).toBe(0);
  });
  test("a UTC UNTIL is compared as an instant: no extra day west of UTC (BK3)", () => {
    // Daily 19:00 Los Angeles through 30 November (Google writes the end of that local day in UTC).
    expect(starts("DTSTART;TZID=America/Los_Angeles:20261126T190000", "DTEND;TZID=America/Los_Angeles:20261126T200000", "RRULE:FREQ=DAILY;UNTIL=20261201T075959Z"))
      .toEqual(["2026-11-27T03:00", "2026-11-28T03:00", "2026-11-29T03:00", "2026-11-30T03:00", "2026-12-01T03:00"]);
    // A date UNTIL includes that date.
    expect(starts("DTSTART:20261128T100000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;UNTIL=20261130")).toEqual(["2026-11-28T10:00", "2026-11-29T10:00", "2026-11-30T10:00"]);
  });
  test("a long-running series without COUNT finds the window's instances", () => {
    const daily = starts("DTSTART;TZID=Europe/Berlin:20150105T090000", "DURATION:PT15M", "RRULE:FREQ=DAILY;INTERVAL=3");
    expect(daily.length).toBe(20);
    expect(daily[0]).toBe("2026-11-03T08:00"); // 2015-01-05 + 4320 days (3 × 1440), 09:00 CET
    expect(starts("DTSTART:20100215T100000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;INTERVAL=2")).toEqual(["2026-12-15T10:00"]); // 202 months on
  });
});

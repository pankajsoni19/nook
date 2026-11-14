import { expect, test } from "bun:test";
import { formatDuration, hoursOf, MAX_DURATION_SECONDS, parseDuration, roundDuration } from "../shared/duration";

/** shared/duration.ts (docs/plan/WORKSPACE_MODULES.md §B.16). */

test("parses what people type", () => {
  const cases: Array<[string, number | null]> = [
    ["1h30", 5400], ["1h 30m", 5400], ["1.5h", 5400], ["1,5h", 5400], ["90m", 5400], ["1:30", 5400], ["1:30:15", 5415], ["45", 2700], ["2h", 7200],
    ["2 hrs 5 mins", 7500], ["45s", 45], ["1h30m15s", 5415], ["0", 0], ["", null], ["abc", null], ["1h30x", null], ["-5", null], ["1000h", null], ["30 apples", null]
  ];
  for (const [text, seconds] of cases) expect({ text, seconds: parseDuration(text) }).toEqual({ text, seconds });
  expect(parseDuration("2", { bare: "hours" })).toBe(7200);
  expect(parseDuration("999h")).toBe(MAX_DURATION_SECONDS);
});

test("formats as 1h 30m or 1:30, and rounds for reports", () => {
  expect(formatDuration(5400)).toBe("1h 30m");
  expect(formatDuration(3600)).toBe("1h");
  expect(formatDuration(0)).toBe("0m");
  expect(formatDuration(2700)).toBe("45m");
  expect(formatDuration(5400, "colon")).toBe("1:30");
  expect(formatDuration(5415, "colon", { seconds: true })).toBe("1:30:15");
  expect(roundDuration(7 * 60, 15)).toBe(0);
  expect(roundDuration(8 * 60, 15)).toBe(15 * 60);
  expect(roundDuration(61, 6, "up")).toBe(6 * 60);
  expect(roundDuration(1234, 0)).toBe(1234);
  expect(hoursOf(5400)).toBe(1.5);
});

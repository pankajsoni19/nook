import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BinSection } from "../src/bin/BinSection";
import { binFolderLabel, binItemLabel, filterBinItems, restoredCalendarMessage } from "../src/bin/binFormat";
import type { BinItem } from "../src/types";

const base = { folder_id: null, folder_name: null, size_bytes: null, deleted_at: "2026-05-01T00:00:00.000Z", purge_after: "2026-05-31T00:00:00.000Z", purging: false };
const items: BinItem[] = [
  { ...base, type: "note", id: "n", title: "Note" },
  { ...base, type: "calendar", id: "c", title: "Family" },
  { ...base, type: "event", id: "e", title: "", folder_id: "c", folder_name: "Family", can_purge: false }
];

test("the Calendar filter shows calendars and events, with calendar-aware labels", () => {
  expect(filterBinItems(items, "calendar").map((item) => item.id)).toEqual(["c", "e"]);
  expect(filterBinItems(items, "note").map((item) => item.id)).toEqual(["n"]);
  expect(binFolderLabel(items[1]!)).toBe("Calendar");
  expect(binFolderLabel(items[2]!)).toBe("Family");
  expect(binFolderLabel({ type: "event", folder_name: null })).toBe("Calendar");
  expect(binFolderLabel({ folder_name: null })).toBe("Default");
  expect(binItemLabel(items[2]!)).toBe("Untitled event");
  expect(restoredCalendarMessage(items[1]!, "Family", false)).toBe("Restored “Family”");
  expect(restoredCalendarMessage(items[2]!, "Family", false)).toBe("Restored to Family");
  expect(restoredCalendarMessage(items[2]!, "Family", true)).toBe("Already restored to Family");
});

test("Settings → Bin offers a Calendar filter chip", () => {
  const markup = renderToStaticMarkup(<BinSection flash={() => undefined} />);
  for (const label of ["All", "Notes", "Files", "Calendar"]) expect(markup).toContain(`>${label}</button>`);
});

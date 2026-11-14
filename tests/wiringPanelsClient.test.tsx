import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { ModulesContext } from "../src/modules";
import "../src/workspaceModules";
import { itemSections } from "../src/ui/itemSlots";
import { ItemSectionsOutlet } from "../src/ui/ItemSlotOutlet";
import { embedKindForPath, registeredSlashItems } from "../src/editor/moduleEmbedRegistry";

/**
 * W3-WIRE client wiring (D1056, D1059): item sections registered by Time and Bookings on other
 * modules' pages (hidden while their module is off), the goal and townhall embeds and the `/` items
 * for goals, townhall sessions, and booking links, and Today's quiet line wrapping as one sentence.
 */

describe("item sections (D1056)", () => {
  test("Time registers on goals, contacts, companies, deals, bookings; Bookings on contacts, companies, deals", () => {
    const ids = (kind: string, disabled: string[] = []) => itemSections(kind, disabled).map((section) => section.id);
    expect(ids("goal")).toEqual(["time.item"]);
    expect(ids("contact")).toEqual(["time.item", "bookings.record"]);
    expect(ids("deal")).toEqual(["time.item", "bookings.record"]);
    expect(ids("booking")).toEqual(["time.item"]);
    expect(ids("card")).toEqual([]);
    expect(ids("contact", ["time"])).toEqual(["bookings.record"]);
    expect(ids("contact", ["time", "bookings"])).toEqual([]);
  });

  test("the outlet renders nothing when every section's module is off", () => {
    const markup = renderToStaticMarkup(<ModulesContext.Provider value={["time", "bookings"] as never}>
      <ItemSectionsOutlet kind="contact" id="00000000-0000-7000-8000-000000000000" readOnly={false} frameClassName="frame" />
    </ModulesContext.Provider>);
    expect(markup).toBe("");
  });
});

describe("embeds and slash items (D1059)", () => {
  test("goal and townhall paths are claimed by their kinds; the neutral word decides", () => {
    expect(embedKindForPath("/goals/grow-mrr-3f9x2ab01k", "Goal")?.kind).toBe("goal");
    expect(embedKindForPath("/townhall/all-hands-3f9x2ab01k", "Townhall")?.kind).toBe("townhall_session");
    expect(embedKindForPath("/townhall/insights", "Townhall")).toBeNull();
    expect(embedKindForPath("/bookings/types/intro-call-3f9x2ab01k", "Booking link")?.kind).toBe("booking_type");
  });

  test("`/` offers Goal, Townhall, and Booking link (a picker each)", () => {
    const labels = registeredSlashItems().map((item) => item.label);
    for (const label of ["Goal", "Townhall", "Booking link"]) expect(labels).toContain(label);
  });
});

describe("Today's quiet line (D1059)", () => {
  test("is a block of text, not a flex row, so a long line wraps as one sentence", () => {
    const css = readFileSync(new URL("../src/today/today.css", import.meta.url), "utf8");
    const rule = /\n\.today-quiet \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("display: block");
    expect(rule).not.toContain("display: flex");
    expect(rule).toContain("min-height: 32px");
  });
});

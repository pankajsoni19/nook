import { describe, expect, test } from "bun:test";
import { activityPlain } from "../src/crm/activityText";
import { INTERACTION_KINDS, INTERACTION_LOGGED } from "../shared/crm";
import type { ItemActivityEntry } from "../shared/itemActivity";

/** Contacts' activity words for logged interactions (D987): every kind reads as a phrase, with a or an. */

const entry = (kind: string): ItemActivityEntry => ({ id: "a", kind: "crm_interaction", payload: { extra: { kind } }, createdAt: "2026-11-14T00:00:00Z" } as unknown as ItemActivityEntry);

describe("interaction activity words (D987)", () => {
  test("a form response, an email, an interaction; no bare kind names", () => {
    expect(activityPlain(entry("form"))).toBe("logged a form response");
    expect(activityPlain(entry("email"))).toBe("logged an email");
    expect(activityPlain(entry("other"))).toBe("logged an interaction");
    expect(activityPlain(entry("task"))).toBe("logged a finished task");
    expect(activityPlain(entry("unknown"))).toBe("logged a note");
    for (const kind of INTERACTION_KINDS) {
      expect(INTERACTION_LOGGED[kind]).toMatch(/^logged (a [^aeiou]|an [aeiou])/);
    }
  });
});

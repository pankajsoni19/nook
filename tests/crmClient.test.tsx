import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "./support/dom";
import { module as crmModule } from "../src/crm/module";
import { DealCard } from "../src/crm/DealsView";
import { activityPlain, CRM_ACTIVITY_RENDERERS } from "../src/crm/activityText";
import { fieldText, initials, money, relative } from "../src/crm/format";
import { filterLabel } from "../src/crm/Sheets";
import { crmContactPath, crmDealPath, isRotting, weightedValue, type CrmBook, type CrmDeal } from "../shared/crm";
import type { ItemActivityEntry } from "../shared/itemActivity";

/** The Contacts client (docs/plan/WORKSPACE_MODULES.md §D.5): module registration, deal cards, activity text, formatting. */
installDom("http://nook.test/contacts");

const deal = (patch: Partial<CrmDeal> = {}): CrmDeal => ({
  id: "d1", shortId: "0abcdefghi", bookId: "b1", pipelineId: "p1", stageId: "s1", stageName: "Proposal", stageKind: "open", probability: 60, title: "Acme renewal",
  value: { amount: 1_200_000, currency: "USD" }, currency: "USD", expectedCloseOn: null, owner: { id: "u1", name: "Ana Silva" }, companyId: "c1", companyName: "Acme",
  contacts: [{ id: "k1", name: "Ben Okafor", role: null }, { id: "k2", name: "Chen Wei", role: null }], nextStep: "Send proposal", nextStepOn: "2020-01-02", status: "open", closedAt: null, lostReason: null,
  stageEnteredAt: "2026-01-01T00:00:00Z", lastActivityAt: "2026-01-01T00:00:00Z", rotting: true, position: 1, tags: [], custom: {}, createdAt: "", updatedAt: "", revision: 1, href: "/contacts/deals/acme-renewal-0abcdefghi", ...patch
});

describe("module registration", () => {
  test("Contacts is ready at /contacts with a launcher, Today section, quick actions, and search", () => {
    expect(crmModule).toMatchObject({ id: "crm", segment: "contacts", label: "Contacts", ready: true, launcher: true });
    expect(crmModule.app).not.toBeNull();
    expect(crmModule.parseRoute!(["deals", "acme-renewal-0abcdefghi", "x", "y"], "?book=b1")).toEqual({ path: ["deals", "acme-renewal-0abcdefghi", "x"], search: "?book=b1" });
    const row = crmModule.todaySections!.crmFollowups!.row!({ id: "f1", title: "Follow up: Ana", detail: "Call her", due: "2020-01-01T09:00:00Z", href: "/contacts/ana-0abcdefghi" }, "2026-11-13");
    expect(row).toMatchObject({ key: "f1", label: "Follow up: Ana", tone: "overdue", route: { app: "crm", path: ["ana-0abcdefghi"] } });
    expect(crmModule.quickActions!.map((action) => action.label)).toEqual(["New contact", "Log a call"]);
    expect(crmModule.searchRenderer!.row({ kind: "deal", id: "d1", title: "Acme", href: "/contacts/deals/acme-0abcdefghi" })).toMatchObject({ title: "Acme", meta: "Deal", href: "/contacts/deals/acme-0abcdefghi" });
  });
});

describe("deal cards", () => {
  test("value, company, first contact and the rest, an overdue next step, the owner, and the rotting dot", () => {
    const markup = renderToStaticMarkup(<DealCard deal={deal()} />);
    expect(markup).toContain("Acme renewal");
    expect(markup).toContain("$12,000.00");
    expect(markup).toContain("Ben Okafor +1");
    expect(markup).toContain("crm-deal-next overdue");
    expect(markup).toContain("crm-rot");
    expect(markup).toContain('aria-label="Owner Ana Silva"');
    const quiet = renderToStaticMarkup(<DealCard deal={deal({ rotting: false, value: null, contacts: [], nextStepOn: null, owner: null })} />);
    expect(quiet).toContain("No value");
    expect(quiet).not.toContain("crm-rot");
  });
});

describe("activity text and formatting", () => {
  const entry = (kind: string, payload: ItemActivityEntry["payload"] = {}): ItemActivityEntry => ({ id: "a", itemKind: "deal", itemId: "d", kind, actorId: null, actorName: "Ana", via: null, payload, createdAt: "" });
  test("stage moves, merges, and field changes read in plain words", () => {
    expect(activityPlain(entry("crm_stage", { from: { label: "Lead" }, to: { label: "Won" } }))).toBe("moved it from Lead to Won");
    expect(activityPlain(entry("crm_merged", { extra: { merged_from: "Ana S." } }))).toBe("merged Ana S. into this");
    expect(activityPlain(entry("crm_updated", { extra: { fields: "Name, Owner" } }))).toBe("changed name, owner");
    expect(renderToStaticMarkup(<>{CRM_ACTIVITY_RENDERERS.crm_stage!(entry("crm_stage", { from: { label: "Lead" }, to: { label: "Won" } }))}</>)).toBe("moved it from <strong>Lead</strong> to <strong>Won</strong>");
  });
  test("money, initials, relative time, custom field values, filter labels", () => {
    expect(money(123_456, "USD")).toBe("$1,234.56");
    expect(money(null, "USD")).toBe("—");
    expect(initials("Ana Maria Silva")).toBe("AM");
    expect(relative(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe("3 days ago");
    expect(fieldText({ id: "f_aaaaaaaa", name: "Tier", type: "select", options: [{ id: "o_aaaaaa", label: "Gold", color: "yellow" }] }, "o_aaaaaa")).toBe("Gold");
    expect(fieldText({ id: "f_bbbbbbbb", name: "Seats", type: "number", number: { decimals: 0, unit: "seats" } }, 12)).toBe("12 seats");
    const book = { fields: { contact: [{ id: "f_aaaaaaaa", name: "Tier", type: "select", options: [{ id: "o_aaaaaa", label: "Gold", color: "yellow" }] }], company: [], deal: [] } } as unknown as CrmBook;
    expect(filterLabel({ field: "f_aaaaaaaa", op: "eq", value: "o_aaaaaa" }, book, "contact")).toBe("Tier is Gold");
    expect(filterLabel({ field: "owner", op: "eq", value: "me" }, book, "contact")).toBe("Owner is me");
  });
  test("shared helpers: paths, weighted value, rotting", () => {
    expect(crmContactPath("Ana Silva", "0abcdefghi")).toBe("/contacts/ana-silva-0abcdefghi");
    expect(crmDealPath("Acme renewal", "0abcdefghi")).toBe("/contacts/deals/acme-renewal-0abcdefghi");
    expect(weightedValue(10_000, 35)).toBe(3_500);
    expect(isRotting({ status: "open", lastActivityAt: "2026-01-01T00:00:00Z" }, 14, Date.parse("2026-01-20T00:00:00Z"))).toBe(true);
    expect(isRotting({ status: "won", lastActivityAt: "2026-01-01T00:00:00Z" }, 14, Date.parse("2026-01-20T00:00:00Z"))).toBe(false);
  });
});

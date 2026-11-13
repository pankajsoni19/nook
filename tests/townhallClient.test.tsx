import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import "../src/workspaceModules";
import { module as townhall } from "../src/townhall/module";
import { PollView } from "../src/townhall/PollView";
import { QaList, orderQuestions, type QaQuestion } from "../src/ui/live/QaList";
import { parseRoute, formatRoute } from "../src/router";
import type { TownhallPollView } from "../shared/townhall";

/** Townhall's client (§D.7 Townhall): routes, the poll views on the shared live widgets, and QaList's additions (D1084). */

const poll = (patch: Partial<TownhallPollView>): TownhallPollView => ({
  id: "p1", kind: "single", title: "Lunch?", options: [{ id: "a", label: "Ramen" }, { id: "b", label: "Tacos" }], status: "live", resultsHidden: false,
  counts: { a: 2, b: 1 }, total: 3, myVote: [], words: [], entries: [], average: null, distribution: {}, myRating: null, myWords: [], max: 5, ...patch
});

describe("routes", () => {
  test("the module is ready, with a launcher, a public page, and its Today section", () => {
    expect(townhall.ready).toBe(true);
    expect(townhall.launcher).toBe(true);
    expect(townhall.publicPages?.map((page) => page.prefix)).toEqual(["/p/t/"]);
    expect(Object.keys(townhall.todaySections ?? {})).toEqual(["townhallLive"]);
  });

  test("parses home, insights, a session (kept query words only), and the presenter", () => {
    expect(parseRoute("/townhall")).toEqual({ app: "townhall", path: [], search: "" });
    expect(parseRoute("/townhall/insights")).toEqual({ app: "townhall", path: ["insights"], search: "" });
    expect(parseRoute("/townhall/all-hands-k7f3q2ab01", "?tab=polls&evil=<x>")).toEqual({ app: "townhall", path: ["all-hands-k7f3q2ab01"], search: "?tab=polls" });
    expect(parseRoute("/townhall/all-hands-k7f3q2ab01/present")).toEqual({ app: "townhall", path: ["all-hands-k7f3q2ab01", "present"], search: "" });
    expect(parseRoute("/townhall/<script>").app).not.toBe("townhall-session");
    expect(parseRoute("/townhall/%3Cscript%3E")).not.toMatchObject({ path: ["%3cscript%3e"] });
    expect(formatRoute({ app: "townhall", path: ["all-hands-k7f3q2ab01"], search: "?tab=recap" } as never)).toBe("/townhall/all-hands-k7f3q2ab01?tab=recap");
  });
});

describe("polls", () => {
  test("a choice poll votes until answered, then shows results; hidden results say when they show", () => {
    const voting = renderToStaticMarkup(<PollView poll={poll({})} onVote={async () => undefined} />);
    expect(voting).toContain('type="radio"');
    const voted = renderToStaticMarkup(<PollView poll={poll({ myVote: ["a"] })} onVote={async () => undefined} />);
    expect(voted).toContain("Ramen (your vote)");
    const hidden = renderToStaticMarkup(<PollView poll={poll({ myVote: ["a"], counts: null, resultsHidden: true })} onVote={async () => undefined} />);
    expect(hidden).toContain("Results show when the poll closes.");
  });

  test("rating, word cloud (with the per-person cap), and open text", () => {
    expect(renderToStaticMarkup(<PollView poll={poll({ kind: "rating", average: 4.5, total: 2, distribution: { 4: 1, 5: 1 }, counts: {} })} />)).toContain("4.5");
    const cloud = renderToStaticMarkup(<PollView poll={poll({ kind: "word_cloud", words: [{ text: "focus", count: 2 }], myWords: ["a", "b", "c"], counts: {} })} onVote={async () => undefined} />);
    expect(cloud).toContain("focus");
    expect(cloud).not.toContain("Add a word or two");
    expect(cloud).toContain("Your words: a, b, c");
    const open = renderToStaticMarkup(<PollView poll={poll({ kind: "open_text", entries: ["More demos"], total: 1, counts: {} })} onVote={async () => undefined} />);
    expect(open).toContain("More demos");
    expect(open).toContain("Your answer");
  });
});

describe("QaList additions (D1084)", () => {
  const list: QaQuestion[] = [
    { id: "q1", text: "First", author: "Ana", votes: 3, voted: false, status: "approved", createdAt: "2026-11-13T10:00:00.000Z", starred: true, commentCount: 2, mergedCount: 1 },
    { id: "q2", text: "Mine", author: null, votes: 0, voted: false, status: "pending", createdAt: "2026-11-13T10:01:00.000Z", mine: true }
  ];
  test("replies, withdraw, merged count, and the star show only where wired", () => {
    const plain = renderToStaticMarkup(<QaList questions={list} sort="top" onSort={() => undefined} />);
    expect(plain).not.toContain("Withdraw");
    expect(plain).not.toContain("Starred");
    const wired = renderToStaticMarkup(<QaList questions={list} sort="top" onSort={() => undefined} moderator onModerate={() => undefined} onOpen={() => undefined} onWithdraw={() => undefined} askNote="Your name shows." onAsk={async () => undefined} />);
    expect(wired).toContain("2 replies");
    expect(wired).toContain("1 merged");
    expect(wired).toContain("Withdraw");
    expect(wired).toContain("Starred");
    expect(wired).toContain("Your name shows.");
    expect(orderQuestions(list, "top", false).map((question) => question.id)).toEqual(["q1", "q2"]);
  });
});

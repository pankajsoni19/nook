import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "./support/dom";
import { FORM_TEMPLATES, formTemplate, kindProblem, pollSet, timePollSet, type RespondView } from "../shared/forms";
import { questionSetProblems } from "../shared/questions";

installDom("http://nook.test/forms");
const { module } = await import("../src/forms/module");
const { PollCard, TimePollGrid, closesText } = await import("../src/forms/PollViews");

/** The Forms client (lane FORMS, §D.1 UI): registration, routes, the poll card, and the time-poll grid. */

describe("module registration", () => {
  test("ready, at /forms, with Today sections, quick actions, embeds, slash items, and the public page", () => {
    expect(module).toMatchObject({ id: "forms", segment: "forms", ready: true, launcher: true });
    expect(Object.keys(module.todaySections ?? {})).toEqual(["formsResponses", "pollsToVote"]);
    expect(module.quickActions?.map((action) => action.id)).toEqual(["new-poll", "find-time"]);
    expect(module.embedRenderers?.map((embed) => embed.kind)).toEqual(["poll", "time_poll", "form"]);
    expect(module.embedRenderers?.[0]!.match?.("/forms/team-lunch-4k2m9x0a1b")).toBe(true);
    expect(module.embedRenderers?.[0]!.match?.("/forms/insights")).toBe(false);
    expect(module.slashItems?.map((item) => item.label)).toEqual(["Poll", "Form"]);
    expect(module.publicPages?.[0]!.prefix).toBe("/p/f/");
  });

  test("routes keep their segments and only the known query keys", () => {
    expect(module.parseRoute!(["team-lunch-4k2m9x0a1b", "results"], "?response=abc&evil=1")).toEqual({ path: ["team-lunch-4k2m9x0a1b", "results"], search: "?response=abc" });
    expect(module.parseRoute!([], "")).toEqual({ path: [], search: "" });
  });
});

describe("templates and kinds", () => {
  test("every template is a valid set of its kind", () => {
    for (const template of FORM_TEMPLATES) {
      const made = formTemplate(template);
      expect({ template, problems: questionSetProblems(made.set) }).toEqual({ template, problems: [] });
      expect({ template, kind: kindProblem(made.kind, made.set) }).toEqual({ template, kind: null });
    }
    expect(kindProblem("poll", timePollSet("x", [{ start: "2026-12-01T09:00:00Z", end: "2026-12-01T10:00:00Z" }]))).toMatch(/one single or multiple choice/);
  });

});

const pollView = (overrides: Partial<RespondView> = {}): RespondView => {
  const set = pollSet("Lunch?", ["Thai", "Pizza"], false);
  const [thai, pizza] = set.questions[0]!.options!;
  return {
    form: { id: "f", shortId: "0abcdefghi", kind: "poll", title: "Lunch?", description: "", status: "open", accepting: true, display: "page", anonymous: false, allowEdit: false, limitPer: "person", closesAt: null,
      theme: { accent: null }, ending: { title: "Thanks", body: "" }, settings: { notifyOnResponse: true, showProgress: true, allowAnother: false }, resultsVisibility: "live", finalizedSlotId: null,
      owner: { id: "o", name: "Olivia" }, responseCount: 3, href: "/forms/lunch-0abcdefghi", level: null, canRespond: true },
    version: 1, set, mine: { id: "r", answers: { [set.questions[0]!.id]: thai!.id }, submittedAt: "2026-11-13T10:00:00Z", revision: 1 }, closedReason: null,
    results: { total: 3, summary: { questionId: set.questions[0]!.id, kind: "choice", answered: 3, options: [{ optionId: thai!.id, label: "Thai", count: 2 }, { optionId: pizza!.id, label: "Pizza", count: 1 }], other: 0 }, voters: [{ optionId: thai!.id, people: [{ id: "a", name: "Ana" }, { id: "b", name: "Ben" }] }], participants: [] },
    ...overrides
  };
};

describe("poll card and time-poll grid", () => {
  test("a voter sees results with their vote and the named voters", () => {
    const markup = renderToStaticMarkup(<PollCard view={pollView()} onVote={async () => undefined} />);
    expect(markup).toContain("Thai (your vote)");
    expect(markup).toContain("2 · 67%");
    expect(markup).toContain("Ana, Ben");
  });

  test("an anonymous poll shows no voters and no own choice", () => {
    const view = pollView({ form: { ...pollView().form, anonymous: true }, results: { ...pollView().results!, voters: [] } });
    const markup = renderToStaticMarkup(<PollCard view={view} />);
    expect(markup).not.toContain("your vote");
    expect(markup).toContain("Anonymous");
  });

  test("the grid marks the best slot, lists participants, and offers the viewer's row", () => {
    const set = timePollSet("When?", [{ start: "2026-12-01T09:00:00Z", end: "2026-12-01T10:00:00Z" }, { start: "2026-12-02T09:00:00Z", end: "2026-12-02T10:00:00Z" }]);
    const question = set.questions[0]!;
    const [first, second] = question.slots!;
    const markup = renderToStaticMarkup(<TimePollGrid question={question} editable votes={{ [first!.id]: "yes" }} onChange={() => undefined} finalizedSlotId={null} tz="UTC"
      results={{ total: 1, summary: { questionId: question.id, kind: "slots", answered: 1, slots: [{ slotId: first!.id, yes: 0, maybe: 1, no: 0 }, { slotId: second!.id, yes: 1, maybe: 0, no: 0 }], best: second!.id }, voters: [], participants: [{ key: "x", name: "Ravi", you: false, votes: { [second!.id]: "yes" } }] }} />);
    expect(markup).toContain("Ravi");
    expect(markup).toContain("Best");
    expect(markup).toContain(">You<");
    expect(markup).toContain("Times in UTC");
  });

  test("closing words", () => {
    expect(closesText(null, false)).toBe("Closed");
    expect(closesText(new Date(Date.now() + 30 * 60_000).toISOString(), true)).toMatch(/closes in 3\d min|closes in 30 min/);
  });
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { module } from "../src/checkins/module";
import { AnswerCard, cadenceText, RefText, StateBadge, relativeDeadline } from "../src/checkins/parts";
import { CHECKIN_TEMPLATE_DEFS, CHECKIN_TEMPLATES, answerText, type AnswerView } from "../shared/checkins";
import { validateQuestionSet } from "../shared/questions";

/** Standups' client pieces (docs/plan/WORKSPACE_MODULES.md §D.4 UI): the module registration, cadence words, answers with card chips, states. */

const card = { kind: "card" as const, id: "0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11", key: "KAN-1", title: "Payments API", href: "/tasks/KAN/card/KAN-1", icon: "square-check" };

describe("module", () => {
  test("is ready at /standups with its Today section, quick action, search, and activity words", () => {
    expect(module).toMatchObject({ id: "checkins", segment: "standups", label: "Standups", ready: true });
    expect(Object.keys(module.todaySections ?? {})).toEqual(["checkinsDue"]);
    const row = module.todaySections!.checkinsDue!.row!({ id: "r1", title: "Daily standup", deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), href: "/standups/daily-standup-0abc123def/2026-11-13/answer" }, "2026-11-13");
    expect(row.route).toEqual({ app: "checkins", path: ["daily-standup-0abc123def", "2026-11-13", "answer"], search: "" } as never);
    expect(module.quickActions?.map((action) => action.label)).toEqual(["Answer standup"]);
    expect(module.searchRenderer?.scope).toBe("standups");
  });
});

describe("templates", () => {
  test("every template's questions are a valid set and the standup roles are where they should be", () => {
    for (const key of CHECKIN_TEMPLATES) expect({ key, ok: validateQuestionSet(CHECKIN_TEMPLATE_DEFS[key].questions()).ok }).toEqual({ key, ok: true });
    expect(CHECKIN_TEMPLATE_DEFS.standup.questions().questions.map((question) => question.role)).toEqual(["done", "plan", "blockers", "mood"]);
    expect(CHECKIN_TEMPLATE_DEFS.pulse.anonymous).toBe(true);
    expect(answerText(CHECKIN_TEMPLATE_DEFS.standup.questions(), { done: "a", plan: "b", mood: 4 })).toBe("a\nb");
  });
});

describe("words", () => {
  test("cadence and deadlines read plainly", () => {
    expect(cadenceText({ weekdays: [1, 2, 3, 4, 5], at: "09:30", everyNWeeks: 1, zoneMode: "each", tz: "UTC" })).toBe("Weekdays at 09:30 · your time");
    expect(cadenceText({ weekdays: [5], at: "15:00", everyNWeeks: 2, zoneMode: "fixed", tz: "Europe/Lisbon" })).toBe("Fri at 15:00 · Europe/Lisbon, every 2 weeks");
    expect(relativeDeadline(new Date(Date.now() - 1000).toISOString())).toBe("Past the deadline");
    expect(relativeDeadline(new Date(Date.now() + 20 * 60_000).toISOString())).toMatch(/^Due in (19|20) min$/);
  });

  test("a pending person in a closed round reads 'No answer'", () => {
    expect(renderToStaticMarkup(<StateBadge state="pending" closed />)).toContain("No answer");
    expect(renderToStaticMarkup(<StateBadge state="late" />)).toContain("tone-warning");
  });
});

describe("answers", () => {
  test("card keys in text become chips; text around them stays", () => {
    const markup = renderToStaticMarkup(<RefText text={"Waiting on KAN-1\nfor the sandbox"} refs={[{ text: "KAN-1", summary: card }]} onOpen={() => undefined} />);
    expect(markup).toContain("Waiting on ");
    expect(markup).toContain("Payments API");
    expect(markup).toContain("for the sandbox");
  });

  test("an answer card shows the person, each question, mood as a face, and the thread toggle", () => {
    const answer: AnswerView = {
      id: "1b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11", person: { id: "u1", name: "Ana Silva", avatarUrl: null }, late: true, submittedAt: "2026-11-13T09:40:00Z", updatedAt: "2026-11-13T09:40:00Z", setVersion: 1,
      answers: { done: "Shipped KAN-1", blockers: "None", mood: 5 }, refs: [{ text: "KAN-1", summary: card }], reactions: [{ emoji: "thumbs_up", count: 2, reacted: true, names: ["Ben"] }], commentCount: 3, mine: false
    };
    const markup = renderToStaticMarkup(<AnswerCard answer={answer} set={CHECKIN_TEMPLATE_DEFS.standup.questions()} onOpen={() => undefined} canComment />);
    expect(markup).toContain("Ana Silva");
    expect(markup).toContain("Late");
    expect(markup).toContain("What did you get done since last time?");
    expect(markup).toContain("standup-qa blockers");
    expect(markup).toContain("😄");
    expect(markup).toContain("3 comments");
    expect(markup).toContain('aria-pressed="true"');
    // Anonymous answers: no header, no reactions or thread.
    const anonymous = renderToStaticMarkup(<AnswerCard answer={{ ...answer, id: null, person: null, submittedAt: null }} set={CHECKIN_TEMPLATE_DEFS.standup.questions()} onOpen={() => undefined} canComment />);
    expect(anonymous).not.toContain("Ana Silva");
    expect(anonymous).not.toContain("comment");
  });
});

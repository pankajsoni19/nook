import { describe, expect, test } from "bun:test";
import {
  checkAnswer, emptyQuestionSet, evaluateLogic, newQuestionItemId, QUESTION_TYPE_NAMES, QUESTION_TYPES, scoreResponse, validateAnswers, validateQuestionSet,
  type Question, type QuestionSet
} from "../shared/questions";

/** The shared question engine (docs/plan/WORKSPACE_MODULES.md §B.2, D802): types, validation, logic, scoring. Pure. */

const q = (question: Partial<Question> & Pick<Question, "id" | "type">): Question => ({ title: `Question ${question.id}`, ...question });
const set = (questions: Question[], extra: Partial<QuestionSet> = {}): QuestionSet => ({ ...emptyQuestionSet(), questions, ...extra });

const options = [{ id: "a", label: "Alpha", score: 1 }, { id: "b", label: "Beta", score: 3 }, { id: "c", label: "Gamma" }];

/** One question of every type, each with a valid answer and an invalid one. */
const EVERY_TYPE: Array<{ question: Question; good: unknown; normalized?: unknown; bad: unknown }> = [
  { question: q({ id: "st", type: "short_text", validation: { maxLength: 10 } }), good: "  hello ", normalized: "hello", bad: "x".repeat(11) },
  { question: q({ id: "lt", type: "long_text" }), good: "Long answer", bad: 42 },
  { question: q({ id: "sc", type: "single_choice", options, allowOther: true }), good: { other: "Delta" }, bad: "zzz" },
  { question: q({ id: "dd", type: "dropdown", options }), good: "b", bad: { other: "no other" } },
  { question: q({ id: "yn", type: "yes_no" }), good: "yes", bad: "maybe" },
  { question: q({ id: "mc", type: "multi_choice", options, maxSelect: 2 }), good: ["a", "b"], normalized: { options: ["a", "b"] }, bad: ["a", "b", "c"] },
  { question: q({ id: "rk", type: "ranking", options }), good: ["c", "a", "b"], bad: ["a", "a"] },
  { question: q({ id: "rt", type: "rating", scale: { min: 1, max: 5 } }), good: 4, bad: 6 },
  { question: q({ id: "sl", type: "scale", scale: { min: 0, max: 10 } }), good: "7", normalized: 7, bad: 3.5 },
  { question: q({ id: "np", type: "nps" }), good: 10, bad: 11 },
  { question: q({ id: "nu", type: "number", validation: { min: 0, max: 100, step: 0.5 } }), good: 12.5, bad: 12.3 },
  { question: q({ id: "em", type: "email" }), good: " Ana@Example.COM ", normalized: "ana@example.com", bad: "not-an-email" },
  { question: q({ id: "ph", type: "phone" }), good: "+1 (555) 010-9999", normalized: "+15550109999", bad: "12" },
  { question: q({ id: "ur", type: "url" }), good: "example.com/x", normalized: "https://example.com/x", bad: "javascript:alert(1)" },
  { question: q({ id: "da", type: "date" }), good: "2026-02-28", bad: "2026-02-30" },
  { question: q({ id: "ti", type: "time" }), good: "09:30", bad: "25:00" },
  { question: q({ id: "dt", type: "datetime" }), good: "2026-03-01T09:30:00+01:00", normalized: "2026-03-01T08:30:00.000Z", bad: "tomorrow" },
  { question: q({ id: "mx", type: "matrix", matrix: { rows: [{ id: "r1", label: "Speed" }], columns: [{ id: "c1", label: "Good" }, { id: "c2", label: "Bad" }] } }), good: { r1: "c2" }, bad: { r9: "c1" } },
  { question: q({ id: "ts", type: "time_slots", allowMaybe: false, slots: [{ id: "s1", start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" }] }), good: { s1: "yes" }, bad: { s1: "maybe" } },
  { question: q({ id: "co", type: "contact" }), good: { name: "Ana Silva", email: "ANA@acme.test" }, normalized: { name: "Ana Silva", email: "ana@acme.test" }, bad: { email: "a@b.test" } },
  { question: q({ id: "hi", type: "hidden", hiddenKey: "source", title: "" }), good: "newsletter", bad: 5 },
  { question: q({ id: "fi", type: "file" }), good: ["6a1d6b7f-2c3e-4d4f-9a5b-222222222222"], bad: ["../etc"] },
  { question: q({ id: "pe", type: "person" }), good: ["6a1d6b7f-2c3e-4d4f-9a5b-222222222222"], bad: ["ana"] },
  { question: q({ id: "ca", type: "card" }), good: ["MYT-12"], bad: ["MYT-0"] }
];

describe("question types", () => {
  test("the type table covers every type, and every type but statement takes answers", () => {
    expect(QUESTION_TYPE_NAMES.length).toBe(25);
    for (const name of QUESTION_TYPE_NAMES) expect(QUESTION_TYPES[name].answers).toBe(name !== "statement");
    expect(QUESTION_TYPE_NAMES.filter((name) => !QUESTION_TYPES[name].public).sort()).toEqual(["card", "file", "person"]);
    expect(new Set(EVERY_TYPE.map((entry) => entry.question.type)).size).toBe(24);
  });

  test("every type accepts a valid answer (normalized) and refuses an invalid one", () => {
    for (const entry of EVERY_TYPE) {
      const good = checkAnswer(entry.question, entry.good);
      expect({ type: entry.question.type, good }).toEqual({ type: entry.question.type, good: { value: (entry.normalized ?? entry.good) as never } });
      const bad = checkAnswer(entry.question, entry.bad);
      expect({ type: entry.question.type, error: "error" in bad }).toEqual({ type: entry.question.type, error: true });
    }
  });

  test("a set with one question of every type is valid; ids are 8 characters", () => {
    expect(validateQuestionSet(set(EVERY_TYPE.map((entry) => entry.question)))).toMatchObject({ ok: true });
    expect(newQuestionItemId()).toMatch(/^[0-9a-z]{8}$/);
  });
});

describe("validateQuestionSet", () => {
  test("refuses duplicates, unknown types, missing options, bad slots, and over-size sets", () => {
    const problems = (input: unknown, audience?: "public") => {
      const result = validateQuestionSet(input, { audience });
      return result.ok ? [] : result.problems.map((problem) => problem.path);
    };
    expect(problems({ version: 1 })).toEqual(["questions", "sections", "logic", "endings"]);
    expect(problems(set([q({ id: "a", type: "short_text" }), q({ id: "a", type: "long_text" })]))).toEqual(["questions.1.id"]);
    expect(problems(set([q({ id: "a", type: "nope" as never })]))).toEqual(["questions.0.type"]);
    expect(problems(set([q({ id: "a", type: "single_choice" })]))).toEqual(["questions.0.options"]);
    expect(problems(set([q({ id: "a", type: "time_slots", slots: [{ id: "s", start: "2026-01-02T10:00:00Z", end: "2026-01-02T09:00:00Z" }] })]))).toEqual(["questions.0.slots.0"]);
    expect(problems(set(Array.from({ length: 201 }, (_, index) => q({ id: `q${index}`, type: "short_text" }))))).toContain("questions");
    // Members-only types cannot be on a public form (T516).
    expect(problems(set([q({ id: "f", type: "file" })]), "public")).toEqual(["questions.0.type"]);
  });

  test("logic reads earlier questions only, and jumps go forward to a later section or an ending", () => {
    const base = [q({ id: "a", type: "yes_no", sectionId: "s1" }), q({ id: "b", type: "short_text", sectionId: "s2" })];
    const sections = [{ id: "s1" }, { id: "s2" }];
    const endings = [{ id: "end", title: "Thanks" }];
    const valid = set(base, { sections, endings, logic: [{ id: "r1", when: { all: [{ questionId: "a", op: "eq", value: "no" }] }, then: { jumpTo: "end" } }] });
    expect(validateQuestionSet(valid).ok).toBe(true);
    const backwards = set(base, { sections, logic: [{ id: "r1", when: { all: [{ questionId: "b", op: "answered" }] }, then: { show: ["a"] } }] });
    expect(validateQuestionSet(backwards).ok).toBe(false);
    const jumpBack = set(base, { sections, logic: [{ id: "r1", when: { all: [{ questionId: "b", op: "answered" }] }, then: { jumpTo: "s1" } }] });
    expect(validateQuestionSet(jumpBack).ok).toBe(false);
  });
});

describe("logic and answers", () => {
  const form = set([
    q({ id: "role", type: "single_choice", options: [{ id: "dev", label: "Developer" }, { id: "pm", label: "PM" }], required: true, sectionId: "s1" }),
    q({ id: "lang", type: "short_text", required: true, sectionId: "s1" }),
    q({ id: "years", type: "number", sectionId: "s1" }),
    q({ id: "senior", type: "yes_no", required: true, sectionId: "s2" }),
    q({ id: "why", type: "long_text", required: true, sectionId: "s3" })
  ], {
    sections: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    endings: [{ id: "bye", title: "Thanks" }],
    logic: [
      { id: "show-lang", when: { all: [{ questionId: "role", op: "eq", value: "dev" }] }, then: { show: ["lang"] } },
      { id: "skip", when: { any: [{ questionId: "years", op: "lt", value: 2 }] }, then: { jumpTo: "s3" } },
      { id: "end", when: { all: [{ questionId: "senior", op: "eq", value: "no" }] }, then: { jumpTo: "bye" } }
    ]
  });

  test("show-if: a question named by a show rule stays hidden until its rule matches", () => {
    expect(evaluateLogic(form, { role: "pm" }).visible).toEqual(["role", "years", "senior", "why"]);
    expect(evaluateLogic(form, { role: "dev" }).visible).toEqual(["role", "lang", "years", "senior", "why"]);
  });

  test("jumps skip sections forward; an ending skips the rest", () => {
    expect(evaluateLogic(form, { role: "pm", years: 1 })).toEqual({ visible: ["role", "years", "why"], skippedSections: ["s2"], ending: null });
    expect(evaluateLogic(form, { role: "pm", years: 5, senior: "no" })).toEqual({ visible: ["role", "years", "senior"], skippedSections: ["s3"], ending: "bye" });
  });

  test("validateAnswers drops hidden answers, requires visible questions only, and refuses members-only types on public submissions", () => {
    const pm = validateAnswers(form, { role: "pm", lang: "Rust", years: 1, why: "Because" }, { audience: "member" });
    expect(pm).toMatchObject({ ok: true, answers: { role: "pm", years: 1, why: "Because" } });
    expect("lang" in pm.answers).toBe(false);
    const missing = validateAnswers(form, { role: "dev", years: 4 }, { audience: "member" });
    expect(missing.ok).toBe(false);
    expect(Object.keys(missing.errors).sort()).toEqual(["lang", "senior", "why"]);
    const files = set([q({ id: "f", type: "file" }), q({ id: "n", type: "short_text" })]);
    const publicFile = validateAnswers(files, { f: ["6a1d6b7f-2c3e-4d4f-9a5b-222222222222"], n: "x" }, { audience: "public" });
    expect(publicFile).toMatchObject({ ok: false, errors: { f: "Not available here" } });
    expect(validateAnswers(files, { n: "x", stray: "ignored" }, { audience: "public" })).toMatchObject({ ok: true, answers: { n: "x" } });
  });

  test("hidden fields take their value from the URL parameters only", () => {
    const tracked = set([q({ id: "src", type: "hidden", hiddenKey: "utm", title: "" }), q({ id: "n", type: "short_text" })]);
    expect(validateAnswers(tracked, { src: "forged", n: "x" }, { audience: "public", hidden: { utm: "mail" } }).answers).toEqual({ src: "mail", n: "x" });
    expect(validateAnswers(tracked, { src: "forged", n: "x" }, { audience: "public", hidden: {} }).answers).toEqual({ n: "x" });
  });

  test("scoring sums chosen options' scores and scored numbers; null when nothing scores", () => {
    const quiz = set([q({ id: "one", type: "single_choice", options }), q({ id: "many", type: "multi_choice", options }), q({ id: "n", type: "number", scored: true })]);
    expect(scoreResponse(quiz, { one: "b", many: { options: ["a", "b", "c"] }, n: 2.5 })).toBe(9.5);
    expect(scoreResponse(set([q({ id: "t", type: "short_text" })]), { t: "x" })).toBeNull();
  });
});

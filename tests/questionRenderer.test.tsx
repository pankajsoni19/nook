import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom, render } from "./support/dom";
import { QuestionRenderer, questionError } from "../src/ui/questions/QuestionRenderer";
import { pickByKey, scaleValues, toggleMulti } from "../src/ui/questions/QuestionInput";
import { answerText, ResponseViewer } from "../src/ui/questions/ResponseViewer";
import { QuestionSummary } from "../src/ui/questions/QuestionSummary";
import { inlineText, plainText } from "../src/ui/questions/inline";
import { QUESTION_TYPE_NAMES, type Answers, type Question, type QuestionSet } from "../shared/questions";

/** The question renderer, viewer, and summary (D839, docs/plan/WORKSPACE_MODULES.md §B.2). */
installDom("http://nook.test/forms");

const set = (questions: Question[], extra: Partial<QuestionSet> = {}): QuestionSet => ({ version: 1, questions, sections: [], logic: [], endings: [], ...extra });
const q = (id: string, type: Question["type"], more: Partial<Question> = {}): Question => ({ id, type, title: `Question ${id}`, ...more });
const options = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }, { id: "c", label: "Gamma" }];

describe("every type renders", () => {
  test("each QUESTION_TYPES row has a control (or none for display-only and hidden)", () => {
    for (const type of QUESTION_TYPE_NAMES) {
      const question: Question = q("x", type, {
        ...(type === "single_choice" || type === "dropdown" || type === "multi_choice" || type === "ranking" ? { options } : {}),
        ...(type === "rating" || type === "scale" ? { scale: { min: 1, max: 5 } } : {}),
        ...(type === "matrix" ? { matrix: { rows: [{ id: "r", label: "Row" }], columns: [{ id: "c", label: "Col" }] } } : {}),
        ...(type === "time_slots" ? { slots: [{ id: "s", start: "2026-11-16T09:00:00Z", end: "2026-11-16T09:30:00Z" }] } : {}),
        ...(type === "hidden" ? { hiddenKey: "src" } : {})
      });
      const markup = renderToStaticMarkup(<QuestionRenderer set={set([question])} answers={{}} onChange={() => undefined} onSubmit={() => undefined} timeZone="UTC" />);
      if (type === "hidden") expect(markup).not.toContain("Question x");
      else expect(markup).toContain("Question x");
      if (type === "file" || type === "person" || type === "card") expect(markup).toContain("only be answered inside the workspace");
    }
  });

  test("titles keep **bold**, _italic_, and safe links only; never HTML", () => {
    expect(renderToStaticMarkup(<p>{inlineText("A **big** _deal_ [docs](https://x.test/a) <b>no</b> [bad](javascript:alert(1))")}</p>))
      .toBe('<p>A <strong>big</strong> <em>deal</em> <a href="https://x.test/a" target="_blank" rel="noopener noreferrer nofollow">docs</a> &lt;b&gt;no&lt;/b&gt; [bad](javascript:alert(1))</p>');
    expect(plainText("A **big** [docs](/notes)")).toBe("A big docs");
  });

  test("public theme and members-only types", () => {
    const markup = renderToStaticMarkup(<QuestionRenderer set={set([q("p", "person")])} theme="public" audience="public" answers={{}} onChange={() => undefined} onSubmit={() => undefined} />);
    expect(markup).toContain('data-theme="public"');
  });
});

describe("pure helpers", () => {
  test("scales, NPS, multi-choice limits, and number keys", () => {
    expect(scaleValues(q("r", "rating", { scale: { min: 1, max: 5 } }))).toEqual([1, 2, 3, 4, 5]);
    expect(scaleValues(q("n", "nps"))).toHaveLength(11);
    const multi = q("m", "multi_choice", { options, maxSelect: 2 });
    let value = toggleMulti(multi, undefined, "a");
    value = toggleMulti(multi, value, "b");
    expect(toggleMulti(multi, value, "c")).toEqual({ options: ["a", "b"] });
    expect(toggleMulti(multi, { options: ["a"] }, "a")).toBeUndefined();
    let picked: unknown;
    expect(pickByKey(q("s", "single_choice", { options }), undefined, "2", (next) => { picked = next; })).toBe(true);
    expect(picked).toBe("b");
    expect(pickByKey(q("s", "single_choice", { options }), undefined, "7", () => undefined)).toBe(false);
    expect(pickByKey(q("t", "short_text"), undefined, "1", () => undefined)).toBe(false);
  });

  test("questionError: required, then the shared check", () => {
    expect(questionError(q("a", "short_text", { required: true }), undefined)).toBe("This question is required");
    expect(questionError(q("a", "short_text"), undefined)).toBeNull();
    expect(questionError(q("e", "email"), "not-an-email")).not.toBeNull();
    expect(questionError(q("e", "email"), "ana@example.com")).toBeNull();
  });

  test("answers read as words", () => {
    expect(answerText(q("y", "yes_no"), "no")).toBe("No");
    expect(answerText(q("s", "single_choice", { options }), "zzz")).toBe("Removed option");
    expect(answerText(q("s", "single_choice", { options }), { other: "Delta" })).toBe("Other: Delta");
    expect(answerText(q("m", "multi_choice", { options }), { options: ["a", "c"], other: "x" })).toBe("Alpha, Gamma, Other: x");
    expect(answerText(q("r", "rating", { scale: { min: 1, max: 5 } }), 4)).toBe("4 of 5");
    expect(answerText(q("k", "ranking", { options }), ["c", "a", "b"])).toBe("1. Gamma  2. Alpha  3. Beta");
    expect(answerText(q("c", "contact"), { name: "Jo", email: "jo@x.test" })).toBe("Jo · jo@x.test");
    expect(answerText(q("f", "file"), ["a", "b"])).toBe("2 files");
  });
});

function Harness({ questions, initial = {}, mode = "page", onSubmit, logic = [] }: { questions: Question[]; initial?: Answers; mode?: "page" | "stepper"; onSubmit: (answers: Answers) => void; logic?: QuestionSet["logic"] }) {
  const [answers, setAnswers] = useState<Answers>(initial);
  return <QuestionRenderer set={set(questions, { logic })} answers={answers} onChange={setAnswers} onSubmit={(value) => onSubmit(value)} mode={mode} />;
}

describe("answering (rendered)", () => {
  test("logic shows a question only when its condition holds, and required errors block submit", async () => {
    const submitted: Answers[] = [];
    const view = await render(<Harness onSubmit={(value) => submitted.push(value)} questions={[q("a", "yes_no", { required: true }), q("b", "short_text", { title: "Why not?" })]}
      logic={[{ id: "l", when: { all: [{ questionId: "a", op: "eq", value: "no" }] }, then: { show: ["b"] } }]} />);
    expect(view.container.textContent).not.toContain("Why not?");
    await view.click(view.button("Submit")!);
    expect(submitted).toHaveLength(0);
    expect(view.container.textContent).toContain("One answer needs a look.");
    const no = [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.value === "no")!;
    await view.click(no);
    expect(view.container.textContent).toContain("Why not?");
    await view.click(view.button("Submit")!);
    expect(submitted).toEqual([{ a: "no" }]);
  });

  test("the stepper goes on with Next only when the question is answered, then submits", async () => {
    const submitted: Answers[] = [];
    const view = await render(<Harness mode="stepper" onSubmit={(value) => submitted.push(value)} questions={[q("a", "single_choice", { options, required: true }), q("b", "nps")]} />);
    expect(view.container.textContent).toContain("Question 1 of 2");
    await view.click(view.button("Next")!);
    expect(view.container.textContent).toContain("This question is required");
    await view.click([...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.value === "b")!);
    await view.click(view.button("Next")!);
    expect(view.container.textContent).toContain("Question 2 of 2");
    await view.click([...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.value === "9")!);
    await view.click(view.container.querySelector<HTMLButtonElement>(".ui-q-submit")!);
    expect(submitted).toEqual([{ a: "b", b: 9 }]);
  });
});

describe("viewer and summary", () => {
  test("ResponseViewer lists every question with its answer or No answer", () => {
    const markup = renderToStaticMarkup(<ResponseViewer set={set([q("a", "yes_no"), q("b", "short_text"), q("s", "statement")])} position={2} total={9}
      response={{ id: "r", hostKind: "form", hostId: "f", setVersion: 1, status: "submitted", score: null, revision: 1, submittedAt: "2026-11-13T09:00:00Z", updatedAt: "2026-11-13T09:00:00Z", respondent: { kind: "anonymous" }, answers: { a: "yes" } }} />);
    expect(markup).toContain("Anonymous");
    expect(markup).toContain("2 of 9");
    expect(markup).toContain("<dd>Yes</dd>");
    expect(markup).toContain('<dd class="empty">No answer</dd>');
    expect(markup).not.toContain("Question s");
  });

  test("QuestionSummary draws choice bars with counts and percents, and NPS", () => {
    const markup = renderToStaticMarkup(<QuestionSummary set={set([q("a", "single_choice", { options }), q("n", "nps")])} summary={{ responses: 10, questions: [
      { questionId: "a", kind: "choice", answered: 10, other: 0, options: [{ optionId: "a", label: "Alpha", count: 6 }, { optionId: "b", label: "Beta", count: 4 }, { optionId: "c", label: "Gamma", count: 0, removed: true }] },
      { questionId: "n", kind: "nps", answered: 10, promoters: 5, passives: 3, detractors: 2, score: 30, distribution: [] }
    ] }} />);
    expect(markup).toContain("10 responses");
    expect(markup).toContain("6 · 60%");
    expect(markup).toContain("Removed option");
    expect(markup).toContain('class="lead"');
    expect(markup).toContain(">30<");
  });
});

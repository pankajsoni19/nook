import type { AnswerValue, Answers, Condition, LogicRule, Question, QuestionSet } from "./types";

/**
 * Show-if logic and jumps (§B.2). Pure: the client runs it live while someone answers, and the server
 * runs it again on submission (authoritative: answers to questions the logic hides are dropped, and
 * `required` applies to visible questions only).
 *
 * - **Show / hide**: a question named by any `show` rule is hidden until one of those rules matches;
 *   a matching `hide` rule hides it. Conditions only read questions before the one they show or hide
 *   (validateQuestionSet enforces it), so one pass in order settles everything.
 * - **Sections and jumps**: questions without a section belong to an implicit first section. A jump
 *   rule fires at the end of the section holding the last question its conditions read; the first
 *   matching jump in rule order wins. It goes to a later section (skipping the ones between) or to an
 *   ending (skipping the rest). Jumps only go forward, so there are no cycles.
 * - A condition on a question that is hidden or skipped sees it as unanswered.
 */

export const DEFAULT_SECTION = "";

export type LogicResult = {
  /** Visible question ids, in order (statements included). */
  visible: string[];
  /** Sections skipped by a jump. */
  skippedSections: string[];
  /** The ending a jump went to, or null for the default ending. */
  ending: string | null;
};

/** The section ids in display order, the implicit first section first. */
export function sectionOrder(set: QuestionSet): string[] {
  return [DEFAULT_SECTION, ...set.sections.map((section) => section.id)];
}

export const sectionOf = (question: Question, set: QuestionSet) =>
  question.sectionId && set.sections.some((section) => section.id === question.sectionId) ? question.sectionId : DEFAULT_SECTION;

/** Whether an answer counts as given (empty strings, arrays, and objects do not). */
export function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    if ("other" in value && typeof value.other === "string" && !("options" in value)) return value.other.trim() !== "";
    if ("options" in value && Array.isArray(value.options)) return value.options.length > 0 || Boolean((value as { other?: string }).other?.trim());
    return Object.keys(value).length > 0;
  }
  return false;
}

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** The plain values an answer holds, for eq/includes: option ids, texts, numbers as text. */
function answerTokens(value: AnswerValue): string[] {
  if (typeof value === "string" || typeof value === "number") return [lower(value)];
  if (Array.isArray(value)) return value.map(lower);
  if (typeof value === "object" && value !== null) {
    if ("options" in value && Array.isArray(value.options)) return [...value.options.map(lower), ...(typeof value.other === "string" ? ["other", lower(value.other)] : [])];
    if ("other" in value && typeof value.other === "string") return ["other", lower(value.other)];
    if ("name" in value) return [lower((value as { name: string }).name), lower((value as { email?: string }).email)];
    return Object.values(value).flatMap((entry) => Array.isArray(entry) ? entry.map(lower) : [lower(entry)]);
  }
  return [];
}

const numeric = (value: AnswerValue | undefined) => typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

export function conditionMatches(condition: Condition, answers: Answers): boolean {
  const value = answers[condition.questionId];
  const answered = isAnswered(value);
  switch (condition.op) {
    case "answered": return answered;
    case "not_answered": return !answered;
    // A single value (an option id, a text, a number); "other" for an "Other" answer.
    case "eq": return answered && answerTokens(value!)[0] === lower(condition.value);
    case "neq": return !answered || answerTokens(value!)[0] !== lower(condition.value);
    case "includes": {
      if (!answered) return false;
      const needle = lower(condition.value);
      const tokens = answerTokens(value!);
      return typeof value === "string" ? tokens[0]!.includes(needle) : tokens.includes(needle);
    }
    case "gt": { const number = numeric(value); return number !== null && typeof condition.value === "number" && number > condition.value; }
    case "lt": { const number = numeric(value); return number !== null && typeof condition.value === "number" && number < condition.value; }
    case "between": {
      const number = numeric(value);
      return number !== null && Array.isArray(condition.value) && number >= condition.value[0] && number <= condition.value[1];
    }
  }
}

export function ruleMatches(rule: LogicRule, answers: Answers): boolean {
  const all = rule.when.all ?? [];
  const any = rule.when.any ?? [];
  if (!all.length && !any.length) return false;
  return all.every((condition) => conditionMatches(condition, answers)) && (!any.length || any.some((condition) => conditionMatches(condition, answers)));
}

export const ruleConditions = (rule: LogicRule) => [...(rule.when.all ?? []), ...(rule.when.any ?? [])];

/** Runs the logic over the answers given so far. */
export function evaluateLogic(set: QuestionSet, answers: Answers): LogicResult {
  const order = sectionOrder(set);
  const index = new Map(set.questions.map((question, position) => [question.id, position]));
  const shownBy = new Map<string, LogicRule[]>();
  const hiddenBy = new Map<string, LogicRule[]>();
  const jumps: Array<{ rule: LogicRule; section: string }> = [];
  for (const rule of set.logic) {
    if ("show" in rule.then) for (const id of rule.then.show) shownBy.set(id, [...(shownBy.get(id) ?? []), rule]);
    else if ("hide" in rule.then) for (const id of rule.then.hide) hiddenBy.set(id, [...(hiddenBy.get(id) ?? []), rule]);
    else {
      const last = ruleConditions(rule).map((condition) => index.get(condition.questionId) ?? -1).reduce((max, position) => Math.max(max, position), -1);
      jumps.push({ rule, section: last >= 0 ? sectionOf(set.questions[last]!, set) : DEFAULT_SECTION });
    }
  }
  // Answers the logic can see: only questions already settled as visible.
  const seen: Answers = {};
  const visible: string[] = [];
  const skippedSections: string[] = [];
  let ending: string | null = null;
  let skipUntil: string | null = null;
  for (const section of order) {
    if (ending !== null) { if (section !== DEFAULT_SECTION || set.questions.some((question) => sectionOf(question, set) === section)) skippedSections.push(section); continue; }
    if (skipUntil !== null) {
      if (section !== skipUntil) { skippedSections.push(section); continue; }
      skipUntil = null;
    }
    for (const question of set.questions) {
      if (sectionOf(question, set) !== section) continue;
      const shows = shownBy.get(question.id);
      const hides = hiddenBy.get(question.id);
      const shown = !shows || shows.some((rule) => ruleMatches(rule, seen));
      const hidden = Boolean(hides?.some((rule) => ruleMatches(rule, seen)));
      if (!shown || hidden) continue;
      visible.push(question.id);
      if (answers[question.id] !== undefined) seen[question.id] = answers[question.id]!;
    }
    const jump: { rule: LogicRule; section: string } | undefined = jumps.find((entry) => entry.section === section && ruleMatches(entry.rule, seen));
    const then: LogicRule["then"] | undefined = jump?.rule.then;
    if (then && "jumpTo" in then) {
      const target: string = then.jumpTo;
      if (set.endings.some((item) => item.id === target)) ending = target;
      else if (order.indexOf(target) > order.indexOf(section)) skipUntil = target;
    }
  }
  return { visible, skippedSections, ending };
}

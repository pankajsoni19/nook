import { evaluateLogic, isAnswered, ruleConditions, sectionOf, sectionOrder } from "./logic";
import { isQuestionType, QUESTION_TYPES, YES_NO_OPTIONS } from "./questionTypes";
import {
  HELP_MAX, ITEM_ID_PATTERN, LONG_TEXT_MAX, MAX_CARDS, MAX_ENDINGS, MAX_FILES, MAX_LOGIC_RULES, MAX_MATRIX_COLUMNS, MAX_MATRIX_ROWS, MAX_OPTIONS,
  MAX_PEOPLE, MAX_QUESTIONS, MAX_SECTIONS, MAX_SET_BYTES, MAX_SLOTS, OPTION_LABEL_MAX, OTHER_TEXT_MAX, QUESTION_SET_VERSION, SHORT_TEXT_MAX, TITLE_MAX,
  type AnswerValue, type Answers, type Audience, type Question, type QuestionSet, type SetProblem
} from "./types";

/**
 * Validation of question sets (at save and publish) and of answers (at submit), §B.2. Pure.
 */

const CONDITION_OPS = new Set(["answered", "not_answered", "eq", "neq", "includes", "gt", "lt", "between"]);
const ROLES = new Set(["done", "plan", "blockers", "mood", "goal_update", "contact_name", "contact_email", "contact_phone", "company"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const textOk = (value: unknown, max: number, min = 0) => typeof value === "string" && value.length >= min && value.length <= max;

/**
 * Checks a set's shape and limits. `audience: "public"` also refuses members-only types (file, person,
 * card). Returns the problems, empty when the set is valid.
 */
export function questionSetProblems(input: unknown, options: { audience?: Audience } = {}): SetProblem[] {
  const problems: SetProblem[] = [];
  const add = (path: string, message: string) => { if (problems.length < 100) problems.push({ path, message }); };
  if (!input || typeof input !== "object") return [{ path: "", message: "A question set must be an object" }];
  const set = input as QuestionSet;
  if (set.version !== QUESTION_SET_VERSION) add("version", `version must be ${QUESTION_SET_VERSION}`);
  for (const key of ["questions", "sections", "logic", "endings"] as const) if (!Array.isArray(set[key])) add(key, `${key} must be a list`);
  if (problems.length) return problems;
  let bytes = 0;
  try { bytes = new TextEncoder().encode(JSON.stringify(set)).length; } catch { add("", "The question set cannot be stored"); }
  if (bytes > MAX_SET_BYTES) add("", `A question set is at most ${MAX_SET_BYTES} bytes`);
  if (set.questions.length > MAX_QUESTIONS) add("questions", `At most ${MAX_QUESTIONS} questions`);
  if (set.sections.length > MAX_SECTIONS) add("sections", `At most ${MAX_SECTIONS} sections`);
  if (set.logic.length > MAX_LOGIC_RULES) add("logic", `At most ${MAX_LOGIC_RULES} rules`);
  if (set.endings.length > MAX_ENDINGS) add("endings", `At most ${MAX_ENDINGS} endings`);
  const ids = new Set<string>();
  const unique = (id: unknown, path: string) => {
    if (typeof id !== "string" || !ITEM_ID_PATTERN.test(id)) { add(path, "Invalid id"); return; }
    if (ids.has(id)) add(path, "Duplicate id");
    ids.add(id);
  };
  set.sections.forEach((section, index) => {
    unique(section?.id, `sections.${index}.id`);
    if (section?.title !== undefined && !textOk(section.title, TITLE_MAX)) add(`sections.${index}.title`, `At most ${TITLE_MAX} characters`);
    if (section?.description !== undefined && !textOk(section.description, HELP_MAX)) add(`sections.${index}.description`, `At most ${HELP_MAX} characters`);
  });
  set.endings.forEach((ending, index) => {
    unique(ending?.id, `endings.${index}.id`);
    if (!textOk(ending?.title, TITLE_MAX, 1)) add(`endings.${index}.title`, "An ending needs a title");
    if (ending?.body !== undefined && !textOk(ending.body, 5000)) add(`endings.${index}.body`, "At most 5000 characters");
    if (ending?.redirectUrl !== undefined && !(textOk(ending.redirectUrl, 2048) && /^https:\/\//.test(ending.redirectUrl))) add(`endings.${index}.redirectUrl`, "Use an https:// link");
  });
  const sectionIds = new Set(set.sections.map((section) => section?.id));
  set.questions.forEach((question, index) => {
    const path = `questions.${index}`;
    if (!question || typeof question !== "object") { add(path, "Invalid question"); return; }
    unique(question.id, `${path}.id`);
    if (!isQuestionType(question.type)) { add(`${path}.type`, "Unknown question type"); return; }
    const def = QUESTION_TYPES[question.type];
    if (!textOk(question.title, TITLE_MAX, question.type === "hidden" ? 0 : 1)) add(`${path}.title`, `A question needs a title of at most ${TITLE_MAX} characters`);
    if (question.help !== undefined && !textOk(question.help, HELP_MAX)) add(`${path}.help`, `At most ${HELP_MAX} characters`);
    if (question.sectionId !== undefined && !sectionIds.has(question.sectionId)) add(`${path}.sectionId`, "Unknown section");
    if (question.role !== undefined && !ROLES.has(question.role)) add(`${path}.role`, "Unknown role");
    if (options.audience === "public" && !def.public) add(`${path}.type`, `${def.label} questions are for members only and cannot be on a public form`);
    if (def.options) {
      if (!Array.isArray(question.options) || question.options.length === 0) add(`${path}.options`, "Add at least one option");
      else if (question.options.length > MAX_OPTIONS) add(`${path}.options`, `At most ${MAX_OPTIONS} options`);
      else {
        const optionIds = new Set<string>();
        question.options.forEach((option, optionIndex) => {
          if (typeof option?.id !== "string" || !ITEM_ID_PATTERN.test(option.id) || option.id === "other") add(`${path}.options.${optionIndex}.id`, "Invalid option id");
          else if (optionIds.has(option.id)) add(`${path}.options.${optionIndex}.id`, "Duplicate option id");
          optionIds.add(option?.id);
          if (!textOk(option?.label, OPTION_LABEL_MAX, 1)) add(`${path}.options.${optionIndex}.label`, `An option needs a label of at most ${OPTION_LABEL_MAX} characters`);
          if (option?.score !== undefined && !(typeof option.score === "number" && Number.isFinite(option.score) && Math.abs(option.score) <= 1_000_000)) add(`${path}.options.${optionIndex}.score`, "A score is a number");
          if (option?.color !== undefined && !(typeof option.color === "string" && /^[a-z0-9-]{1,24}$/.test(option.color))) add(`${path}.options.${optionIndex}.color`, "Use a palette colour name");
        });
      }
    } else if (question.options !== undefined && question.type !== "yes_no") add(`${path}.options`, "This type has no options");
    if (question.minSelect !== undefined && !(Number.isInteger(question.minSelect) && question.minSelect >= 0)) add(`${path}.minSelect`, "A whole number");
    if (question.maxSelect !== undefined && !(Number.isInteger(question.maxSelect) && question.maxSelect >= 1)) add(`${path}.maxSelect`, "A whole number from 1");
    if (question.type === "rating" || question.type === "scale") {
      const scale = question.scale;
      if (scale && !((scale.min === 0 || scale.min === 1) && Number.isInteger(scale.max) && scale.max > scale.min && scale.max <= 10)) add(`${path}.scale`, "A scale runs from 0 or 1 to at most 10");
    }
    if (question.type === "matrix") {
      const matrix = question.matrix;
      if (!matrix || !Array.isArray(matrix.rows) || !Array.isArray(matrix.columns) || !matrix.rows.length || !matrix.columns.length) add(`${path}.matrix`, "A grid needs rows and columns");
      else if (matrix.rows.length > MAX_MATRIX_ROWS || matrix.columns.length > MAX_MATRIX_COLUMNS) add(`${path}.matrix`, `At most ${MAX_MATRIX_ROWS} rows and ${MAX_MATRIX_COLUMNS} columns`);
      else for (const [kind, list] of [["rows", matrix.rows], ["columns", matrix.columns]] as const) {
        const seen = new Set<string>();
        list.forEach((entry, entryIndex) => {
          if (typeof entry?.id !== "string" || !ITEM_ID_PATTERN.test(entry.id) || seen.has(entry.id)) add(`${path}.matrix.${kind}.${entryIndex}.id`, "Invalid or duplicate id");
          seen.add(entry?.id);
          if (!textOk(entry?.label, OPTION_LABEL_MAX, 1)) add(`${path}.matrix.${kind}.${entryIndex}.label`, "A label is needed");
        });
      }
    }
    if (question.type === "time_slots") {
      if (!Array.isArray(question.slots) || !question.slots.length) add(`${path}.slots`, "Add at least one time slot");
      else if (question.slots.length > MAX_SLOTS) add(`${path}.slots`, `At most ${MAX_SLOTS} slots`);
      else {
        const seen = new Set<string>();
        question.slots.forEach((slot, slotIndex) => {
          if (typeof slot?.id !== "string" || !ITEM_ID_PATTERN.test(slot.id) || seen.has(slot.id)) add(`${path}.slots.${slotIndex}.id`, "Invalid or duplicate id");
          seen.add(slot?.id);
          if (!(typeof slot?.start === "string" && ISO_INSTANT.test(slot.start) && typeof slot.end === "string" && ISO_INSTANT.test(slot.end) && Date.parse(slot.end) > Date.parse(slot.start))) add(`${path}.slots.${slotIndex}`, "A slot needs a start and a later end");
        });
      }
    }
    if (question.type === "hidden" && !(typeof question.hiddenKey === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(question.hiddenKey))) add(`${path}.hiddenKey`, "A hidden field needs a URL parameter name");
    const validation = question.validation;
    if (validation) {
      for (const field of ["minLength", "maxLength"] as const) if (validation[field] !== undefined && !(Number.isInteger(validation[field]) && validation[field]! >= 0 && validation[field]! <= LONG_TEXT_MAX)) add(`${path}.validation.${field}`, "A whole number");
      for (const field of ["min", "max", "step"] as const) if (validation[field] !== undefined && !(typeof validation[field] === "number" && Number.isFinite(validation[field]))) add(`${path}.validation.${field}`, "A number");
      if (validation.step !== undefined && !(validation.step > 0)) add(`${path}.validation.step`, "A step is more than 0");
      if (validation.pattern !== undefined && !["email", "url", "phone", "integer"].includes(validation.pattern)) add(`${path}.validation.pattern`, "Unknown pattern");
    }
  });
  // Logic: rules name known questions; show/hide conditions read earlier questions; jumps go forward.
  const position = new Map(set.questions.map((question, index) => [question?.id, index]));
  const order = sectionOrder(set);
  set.logic.forEach((rule, index) => {
    const path = `logic.${index}`;
    unique(rule?.id, `${path}.id`);
    const conditions = rule?.when ? ruleConditions(rule) : [];
    if (!conditions.length) add(`${path}.when`, "A rule needs at least one condition");
    let last = -1;
    for (const condition of conditions) {
      const at = position.get(condition?.questionId);
      if (at === undefined) add(`${path}.when`, "A condition names an unknown question");
      else last = Math.max(last, at);
      if (!CONDITION_OPS.has(condition?.op)) add(`${path}.when`, "Unknown condition");
      if (condition?.op === "between" && !(Array.isArray(condition.value) && condition.value.length === 2 && condition.value.every((item) => typeof item === "number"))) add(`${path}.when`, "between needs two numbers");
      if ((condition?.op === "gt" || condition?.op === "lt") && typeof condition.value !== "number") add(`${path}.when`, `${condition.op} needs a number`);
    }
    const then = rule?.then;
    if (!then || typeof then !== "object") { add(`${path}.then`, "A rule needs an action"); return; }
    if ("show" in then || "hide" in then) {
      const targets = "show" in then ? then.show : then.hide;
      if (!Array.isArray(targets) || !targets.length) { add(`${path}.then`, "Name the questions to show or hide"); return; }
      for (const target of targets) {
        const at = position.get(target);
        if (at === undefined) add(`${path}.then`, "The rule names an unknown question");
        else if (at <= last) add(`${path}.then`, "A rule can only show or hide questions after the ones it reads");
      }
    } else if ("jumpTo" in then) {
      const isEnding = set.endings.some((ending) => ending?.id === then.jumpTo);
      const target = order.indexOf(then.jumpTo);
      const from = last >= 0 && set.questions[last] ? order.indexOf(sectionOf(set.questions[last]!, set)) : 0;
      if (!isEnding && target <= from) add(`${path}.then`, "A jump goes to a later section or an ending");
    } else add(`${path}.then`, "Unknown action");
  });
  return problems;
}

export function validateQuestionSet(input: unknown, options: { audience?: Audience } = {}): { ok: true; set: QuestionSet } | { ok: false; problems: SetProblem[] } {
  const problems = questionSetProblems(input, options);
  return problems.length ? { ok: false, problems } : { ok: true, set: input as QuestionSet };
}

// ---------------------------------------------------------------- answers

const EMAIL = /^[^\s@<>()[\],;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_REF = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8})$/;

export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export const isEmail = (value: string) => value.length <= 254 && EMAIL.test(value);

/** Digits with an optional leading +; null when it is not a phone number (5–20 digits). */
export function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > 40 || !/^\+?[0-9 ()./-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length < 5 || digits.length > 20) return null;
  return `${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > 2048) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type Checked = { value: AnswerValue } | { error: string };

function optionIds(question: Question): string[] {
  if (question.type === "yes_no") return YES_NO_OPTIONS.map((option) => option.id);
  return (question.options ?? []).map((option) => option.id);
}

function checkText(question: Question, raw: unknown, max: number): Checked {
  if (typeof raw !== "string") return { error: "Enter text" };
  const value = raw.trim();
  const validation = question.validation ?? {};
  const limit = Math.min(validation.maxLength ?? max, max);
  if (value.length > limit) return { error: `At most ${limit} characters` };
  if (validation.minLength !== undefined && value.length < validation.minLength) return { error: `At least ${validation.minLength} characters` };
  if (validation.pattern === "email" && !isEmail(normalizeEmail(value))) return { error: "Enter an email address" };
  if (validation.pattern === "url" && !normalizeUrl(value)) return { error: "Enter a link" };
  if (validation.pattern === "phone" && !normalizePhone(value)) return { error: "Enter a phone number" };
  if (validation.pattern === "integer" && !/^-?\d+$/.test(value)) return { error: "Enter a whole number" };
  return { value };
}

function checkNumber(question: Question, raw: unknown, range: { min: number; max: number; integer: boolean }): Checked {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return { error: "Enter a number" };
  if (range.integer && !Number.isInteger(value)) return { error: "Enter a whole number" };
  if (value < range.min || value > range.max) return { error: `Enter a number from ${range.min} to ${range.max}` };
  const step = question.validation?.step;
  if (step && Math.abs((value - range.min) / step - Math.round((value - range.min) / step)) > 1e-9) return { error: `Use steps of ${step}` };
  return { value };
}

function checkOther(question: Question, raw: unknown): string | { error: string } {
  if (!question.allowOther) return { error: "Choose one of the options" };
  if (typeof raw !== "string" || !raw.trim()) return { error: "Say what “Other” is" };
  if (raw.trim().length > OTHER_TEXT_MAX) return { error: `At most ${OTHER_TEXT_MAX} characters` };
  return raw.trim();
}

function checkIds(raw: unknown, max: number, pattern: RegExp, what: string): Checked {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || !pattern.test(item))) return { error: `Choose ${what}` };
  const unique = [...new Set(raw as string[])];
  if (unique.length > max) return { error: `At most ${max}` };
  return { value: unique };
}

/** Checks and normalizes one answer for its question. */
export function checkAnswer(question: Question, raw: unknown): Checked {
  switch (question.type) {
    case "short_text": return checkText(question, raw, SHORT_TEXT_MAX);
    case "long_text": return checkText(question, raw, LONG_TEXT_MAX);
    case "hidden": return typeof raw === "string" && raw.length <= SHORT_TEXT_MAX ? { value: raw } : { error: "Invalid value" };
    case "email": {
      const value = typeof raw === "string" ? normalizeEmail(raw) : "";
      return isEmail(value) ? { value } : { error: "Enter an email address" };
    }
    case "phone": { const value = typeof raw === "string" ? normalizePhone(raw) : null; return value ? { value } : { error: "Enter a phone number" }; }
    case "url": { const value = typeof raw === "string" ? normalizeUrl(raw) : null; return value ? { value } : { error: "Enter a link" }; }
    case "single_choice": case "dropdown": case "yes_no": {
      if (typeof raw === "string") return optionIds(question).includes(raw) ? { value: raw } : { error: "Choose one of the options" };
      if (raw && typeof raw === "object" && "other" in raw) {
        const other = checkOther(question, (raw as { other: unknown }).other);
        return typeof other === "string" ? { value: { other } } : other;
      }
      return { error: "Choose one of the options" };
    }
    case "multi_choice": {
      const input = Array.isArray(raw) ? { options: raw } : raw as { options?: unknown; other?: unknown } | null;
      if (!input || typeof input !== "object" || !Array.isArray(input.options)) return { error: "Choose options" };
      const allowed = optionIds(question);
      if (input.options.some((id) => typeof id !== "string" || !allowed.includes(id))) return { error: "Choose from the options" };
      const options = [...new Set(input.options as string[])];
      let other: string | undefined;
      if (input.other !== undefined && input.other !== null && input.other !== "") {
        const checked = checkOther(question, input.other);
        if (typeof checked !== "string") return checked;
        other = checked;
      }
      const count = options.length + (other ? 1 : 0);
      if (question.minSelect !== undefined && count < question.minSelect) return { error: `Choose at least ${question.minSelect}` };
      if (question.maxSelect !== undefined && count > question.maxSelect) return { error: `Choose at most ${question.maxSelect}` };
      return { value: other ? { options, other } : { options } };
    }
    case "ranking": {
      const allowed = optionIds(question);
      if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || !allowed.includes(id)) || new Set(raw).size !== raw.length) return { error: "Rank the options" };
      return { value: raw as string[] };
    }
    case "rating": case "scale": {
      const scale = question.scale ?? { min: 1 as const, max: question.type === "rating" ? 5 : 5 };
      return checkNumber(question, raw, { min: scale.min, max: scale.max, integer: true });
    }
    case "nps": return checkNumber(question, raw, { min: 0, max: 10, integer: true });
    case "number": return checkNumber(question, raw, {
      min: question.validation?.min ?? -1e15, max: question.validation?.max ?? 1e15, integer: question.validation?.pattern === "integer"
    });
    case "date": {
      if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: "Enter a date" };
      const date = new Date(`${raw}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? { value: raw } : { error: "Enter a date" };
    }
    case "time": return typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? { value: raw } : { error: "Enter a time (HH:MM)" };
    case "datetime": return typeof raw === "string" && ISO_INSTANT.test(raw) && !Number.isNaN(Date.parse(raw)) ? { value: new Date(raw).toISOString() } : { error: "Enter a date and time" };
    case "matrix": {
      const matrix = question.matrix;
      if (!matrix || !raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Answer the grid" };
      const rows = new Set(matrix.rows.map((row) => row.id));
      const columns = new Set(matrix.columns.map((column) => column.id));
      const value: Record<string, string | string[]> = {};
      for (const [rowId, cell] of Object.entries(raw as Record<string, unknown>)) {
        if (!rows.has(rowId)) return { error: "Answer the grid" };
        if (matrix.multiple) {
          if (!Array.isArray(cell) || cell.some((id) => typeof id !== "string" || !columns.has(id))) return { error: "Answer the grid" };
          if (cell.length) value[rowId] = [...new Set(cell as string[])];
        } else {
          if (typeof cell !== "string" || !columns.has(cell)) return { error: "Answer the grid" };
          value[rowId] = cell;
        }
      }
      if (question.required && Object.keys(value).length < matrix.rows.length) return { error: "Answer every row" };
      return { value };
    }
    case "time_slots": {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Vote on the times" };
      const slots = new Set((question.slots ?? []).map((slot) => slot.id));
      const value: Record<string, string> = {};
      for (const [slotId, vote] of Object.entries(raw as Record<string, unknown>)) {
        if (!slots.has(slotId) || !(vote === "yes" || vote === "no" || (vote === "maybe" && question.allowMaybe))) return { error: "Vote on the times" };
        value[slotId] = vote;
      }
      return { value };
    }
    case "contact": {
      const input = raw as { name?: unknown; email?: unknown; phone?: unknown; company?: unknown } | null;
      if (!input || typeof input !== "object" || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 120) return { error: "Enter a name" };
      const value: { name: string; email?: string; phone?: string; company?: string } = { name: input.name.trim() };
      if (typeof input.email === "string" && input.email.trim()) {
        const email = normalizeEmail(input.email);
        if (!isEmail(email)) return { error: "Enter an email address" };
        value.email = email;
      }
      if (typeof input.phone === "string" && input.phone.trim()) {
        const phone = normalizePhone(input.phone);
        if (!phone) return { error: "Enter a phone number" };
        value.phone = phone;
      }
      if (typeof input.company === "string" && input.company.trim()) {
        if (input.company.trim().length > 120) return { error: "At most 120 characters" };
        value.company = input.company.trim();
      }
      return { value };
    }
    case "file": return checkIds(raw, MAX_FILES, UUID, "files");
    case "person": return checkIds(raw, MAX_PEOPLE, UUID, "people");
    case "card": return checkIds(raw, MAX_CARDS, CARD_REF, "cards");
    case "statement": return { error: "Nothing to answer" };
  }
}

export type AnswerCheck = {
  ok: boolean;
  /** Messages by question id. */
  errors: Record<string, string>;
  /** The normalized answers to visible questions only (hidden and unknown ones dropped). */
  answers: Answers;
  visible: string[];
  ending: string | null;
};

/**
 * Validates answers against a set (§B.2): normalizes each, drops answers to unknown questions and to
 * questions the logic hides, applies `required` to visible questions only, and on public submissions
 * refuses members-only types. Hidden fields take their value from `hidden` (the URL parameters) when
 * given; anything a respondent sent for them is ignored then.
 */
export function validateAnswers(set: QuestionSet, input: Record<string, unknown>, options: { audience: Audience; hidden?: Record<string, string> }): AnswerCheck {
  const errors: Record<string, string> = {};
  const normalized: Answers = {};
  const byId = new Map(set.questions.map((question) => [question.id, question]));
  const raw: Record<string, unknown> = input && typeof input === "object" ? { ...input } : {};
  if (options.hidden) {
    for (const question of set.questions) {
      if (question.type !== "hidden" || !question.hiddenKey) continue;
      const value = options.hidden[question.hiddenKey];
      if (typeof value === "string" && value.length) raw[question.id] = value.slice(0, SHORT_TEXT_MAX);
      else delete raw[question.id];
    }
  }
  for (const [id, value] of Object.entries(raw)) {
    const question = byId.get(id);
    if (!question || !QUESTION_TYPES[question.type].answers || value === undefined || value === null) continue;
    if (!isAnswered(value as AnswerValue) && !(question.type === "matrix" || question.type === "time_slots")) continue;
    if (options.audience === "public" && !QUESTION_TYPES[question.type].public) { errors[id] = "Not available here"; continue; }
    const checked = checkAnswer(question, value);
    if ("error" in checked) errors[id] = checked.error;
    else if (isAnswered(checked.value)) normalized[id] = checked.value;
  }
  const logic = evaluateLogic(set, normalized);
  const visible = new Set(logic.visible);
  const answers: Answers = {};
  for (const [id, value] of Object.entries(normalized)) if (visible.has(id)) answers[id] = value;
  for (const id of Object.keys(errors)) if (!visible.has(id)) delete errors[id];
  for (const question of set.questions) {
    if (!visible.has(question.id) || !question.required || !QUESTION_TYPES[question.type].answers || errors[question.id]) continue;
    if (options.audience === "public" && !QUESTION_TYPES[question.type].public) continue;
    if (!isAnswered(answers[question.id])) errors[question.id] = "This question is required";
  }
  return { ok: Object.keys(errors).length === 0, errors, answers, visible: logic.visible, ending: logic.ending };
}

/**
 * The response's score (§B.2): the sum of the chosen options' scores plus the values of numeric
 * questions marked `scored`; null when nothing in the set scores.
 */
export function scoreResponse(set: QuestionSet, answers: Answers): number | null {
  let scores = false;
  let total = 0;
  for (const question of set.questions) {
    const scoredOptions = (question.options ?? []).some((option) => typeof option.score === "number");
    if (scoredOptions) scores = true;
    if (question.scored && ["number", "rating", "scale", "nps"].includes(question.type)) scores = true;
    const value = answers[question.id];
    if (value === undefined) continue;
    const scoreOf = (id: string) => question.options?.find((option) => option.id === id)?.score ?? 0;
    if (typeof value === "string" && scoredOptions) total += scoreOf(value);
    else if (typeof value === "object" && value !== null && "options" in value && Array.isArray(value.options)) total += value.options.reduce((sum, id) => sum + scoreOf(id), 0);
    else if (typeof value === "number" && question.scored) total += value;
  }
  return scores ? Math.round(total * 1000) / 1000 : null;
}

/** The question engine's public surface (§F.2): types, the type table, logic, validation, and scoring. */
export * from "./types";
export { QUESTION_TYPES, QUESTION_TYPE_NAMES, YES_NO_OPTIONS, isQuestionType, newQuestionItemId, type QuestionTypeDef } from "./questionTypes";
export { DEFAULT_SECTION, conditionMatches, evaluateLogic, isAnswered, ruleMatches, sectionOf, sectionOrder, type LogicResult } from "./logic";
export { checkAnswer, isEmail, normalizeEmail, normalizePhone, questionSetProblems, scoreResponse, validateAnswers, validateQuestionSet, type AnswerCheck } from "./validate";

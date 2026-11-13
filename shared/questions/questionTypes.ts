import type { QuestionSummary, QuestionType } from "./types";

/**
 * The question types, table-driven (§B.2, like CARD_ACTIVITY_KINDS): a type is one row here, one
 * renderer (src/ui/questions), and one aggregator (server/questions/summarize.ts). The database stores
 * the type inside the set's JSON and answers as normalized rows, so a new type needs no migration.
 *
 * - `summary`: which aggregate `summarize` returns for it.
 * - `public`: allowed on public pages; members-only types (files, people, cards) are refused on a
 *   public submission (T516) and a set with one cannot be published to a public audience.
 * - `options`: needs `options` (choice types). `answers`: false for display-only blocks.
 */
export type QuestionTypeDef = {
  label: string;
  summary: QuestionSummary["kind"] | null;
  public: boolean;
  options: boolean;
  answers: boolean;
};

export const QUESTION_TYPES = {
  short_text: { label: "Short text", summary: "text", public: true, options: false, answers: true },
  long_text: { label: "Long text", summary: "text", public: true, options: false, answers: true },
  single_choice: { label: "Single choice", summary: "choice", public: true, options: true, answers: true },
  dropdown: { label: "Dropdown", summary: "choice", public: true, options: true, answers: true },
  yes_no: { label: "Yes / No", summary: "choice", public: true, options: false, answers: true },
  multi_choice: { label: "Multiple choice", summary: "choice", public: true, options: true, answers: true },
  ranking: { label: "Ranking", summary: "ranking", public: true, options: true, answers: true },
  rating: { label: "Rating", summary: "numeric", public: true, options: false, answers: true },
  scale: { label: "Linear scale", summary: "numeric", public: true, options: false, answers: true },
  nps: { label: "Net Promoter Score", summary: "nps", public: true, options: false, answers: true },
  number: { label: "Number", summary: "numeric", public: true, options: false, answers: true },
  email: { label: "Email", summary: "count", public: true, options: false, answers: true },
  phone: { label: "Phone", summary: "count", public: true, options: false, answers: true },
  url: { label: "Link", summary: "count", public: true, options: false, answers: true },
  date: { label: "Date", summary: "dates", public: true, options: false, answers: true },
  time: { label: "Time", summary: "count", public: true, options: false, answers: true },
  datetime: { label: "Date and time", summary: "dates", public: true, options: false, answers: true },
  matrix: { label: "Grid", summary: "matrix", public: true, options: false, answers: true },
  time_slots: { label: "Time slots", summary: "slots", public: true, options: false, answers: true },
  contact: { label: "Contact details", summary: "count", public: true, options: false, answers: true },
  hidden: { label: "Hidden field", summary: "choice", public: true, options: false, answers: true },
  file: { label: "File upload", summary: "count", public: false, options: false, answers: true },
  person: { label: "Person", summary: "choice", public: false, options: false, answers: true },
  card: { label: "Card", summary: "choice", public: false, options: false, answers: true },
  statement: { label: "Statement", summary: null, public: true, options: false, answers: false }
} as const satisfies Record<QuestionType, QuestionTypeDef>;

export const QUESTION_TYPE_NAMES = Object.keys(QUESTION_TYPES) as QuestionType[];
export const isQuestionType = (value: unknown): value is QuestionType => typeof value === "string" && Object.hasOwn(QUESTION_TYPES, value);

/** The fixed options of a yes/no question. */
export const YES_NO_OPTIONS = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] as const;

/** A fresh 8-character id for a question, option, section, rule, or ending (CSPRNG, base36). */
export function newQuestionItemId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    if (byte < 252) out += alphabet[byte % 36];
    if (out.length === 8) break;
  }
  return out.length === 8 ? out : newQuestionItemId();
}

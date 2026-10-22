/**
 * "Turn into a report" from a chat's query result (lane AGENTSQL, D598): the chat hands Reports the
 * chat, the result, its data source, and a title through sessionStorage (never the URL; no SQL or rows:
 * the server reads the stored result itself, under the same access rule as the chat's table). Reports
 * opens New report → Blank on that data source; Create makes the report with the query, a table, and a
 * fitting chart (`POST /api/reports/from-chat`). The hand-off is read once; a copy per result stays for
 * Forward, which reopens the sheet after Back closed it (layer key `reports.fromChat:<resultId>`), until
 * the report is created. Every access is in try/catch: with storage off the hand-off does not happen.
 */

export const REPORT_FROM_CHAT_KEY = "mynotes:reports-from-chat";
const SEED_PREFIX = "mynotes:reports-from-chat:";
const ID = /^[0-9a-f-]{36}$/i;

export type ReportFromChat = { chatId: string; resultId: string; datasourceId: string; title: string };

function parse(raw: string | null): ReportFromChat | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<ReportFromChat>;
    if (typeof value.chatId !== "string" || !ID.test(value.chatId) || typeof value.resultId !== "string" || !ID.test(value.resultId) || typeof value.datasourceId !== "string") return null;
    return { chatId: value.chatId, resultId: value.resultId, datasourceId: value.datasourceId, title: typeof value.title === "string" ? value.title.slice(0, 120) : "" };
  } catch {
    return null;
  }
}

export function writeReportFromChat(seed: ReportFromChat): boolean {
  try {
    sessionStorage.setItem(REPORT_FROM_CHAT_KEY, JSON.stringify(seed));
    sessionStorage.setItem(`${SEED_PREFIX}${seed.resultId}`, JSON.stringify(seed));
    return true;
  } catch {
    return false;
  }
}

/** The chat's hand-off (null when there is none or it is malformed); read in a state initializer, so it does not remove it. */
export function peekReportFromChat(): ReportFromChat | null {
  try {
    return parse(sessionStorage.getItem(REPORT_FROM_CHAT_KEY));
  } catch {
    return null;
  }
}

/** Forgets the hand-off once Reports has opened the sheet (the per-result copy stays for Forward). */
export function dropReportFromChat() {
  try { sessionStorage.removeItem(REPORT_FROM_CHAT_KEY); } catch { /* storage off */ }
}

/** The per-result copy Forward reopens the sheet with (null once the report was created). */
export function recallReportFromChat(resultId: string): ReportFromChat | null {
  try {
    return parse(sessionStorage.getItem(`${SEED_PREFIX}${resultId}`));
  } catch {
    return null;
  }
}

/** Forgets the per-result copy (the report exists now). */
export function forgetReportFromChat(resultId: string) {
  try { sessionStorage.removeItem(`${SEED_PREFIX}${resultId}`); } catch { /* storage off */ }
}

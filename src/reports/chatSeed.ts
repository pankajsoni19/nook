/**
 * "Turn into a report" from a chat's query result (lane AGENTSQL, D598): the chat hands Reports the
 * data source and the SQL through sessionStorage (never the URL), Reports opens New report → Blank on
 * that data source, and once the report exists its console opens with the query. Every access is in
 * try/catch: storage may be off (a private window), and then the hand-off simply does not happen.
 */

export const REPORT_FROM_CHAT_KEY = "mynotes:reports-from-chat";
const CONSOLE_SEED_PREFIX = "mynotes:reports-console-seed:";

export type ReportFromChat = { datasourceId: string; sql: string; title: string };

export function writeReportFromChat(seed: ReportFromChat): boolean {
  try {
    sessionStorage.setItem(REPORT_FROM_CHAT_KEY, JSON.stringify(seed));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the chat's hand-off once Reports has acted on it. */
export function dropReportFromChat() {
  try { sessionStorage.removeItem(REPORT_FROM_CHAT_KEY); } catch { /* storage off */ }
}

/** The chat's hand-off (null when there is none or it is malformed); read in a state initializer, so it does not remove it. */
export function peekReportFromChat(): ReportFromChat | null {
  try {
    const raw = sessionStorage.getItem(REPORT_FROM_CHAT_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<ReportFromChat>;
    if (typeof value.datasourceId !== "string" || typeof value.sql !== "string" || !value.sql.trim()) return null;
    return { datasourceId: value.datasourceId, sql: value.sql.slice(0, 20_000), title: typeof value.title === "string" ? value.title.slice(0, 120) : "" };
  } catch {
    return null;
  }
}

/** Remembers the SQL the new report's console opens with. */
export function writeConsoleSeed(reportId: string, sql: string) {
  try { sessionStorage.setItem(`${CONSOLE_SEED_PREFIX}${reportId}`, sql); } catch { /* storage off: the console opens empty */ }
}

/** The SQL a report's console opens with (null when none); read in a state initializer, so it does not remove it. */
export function peekConsoleSeed(reportId: string): string | null {
  try {
    return sessionStorage.getItem(`${CONSOLE_SEED_PREFIX}${reportId}`);
  } catch {
    return null;
  }
}

/** Forgets the seed once the console holds it (its draft keeps the text from then on). */
export function dropConsoleSeed(reportId: string) {
  try { sessionStorage.removeItem(`${CONSOLE_SEED_PREFIX}${reportId}`); } catch { /* storage off */ }
}

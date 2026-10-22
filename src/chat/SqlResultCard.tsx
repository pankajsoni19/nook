import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download, FilePlus2, Table2 } from "lucide-react";
import type { SqlResultDetail, SqlResultRef, ToolCallView } from "../../shared/agents";
import { getSqlResult } from "./chatApi";
import type { ReportFromChat } from "../reports/chatSeed";
import "./chat.css";

/**
 * A data-source query's result in a chat (lane AGENTSQL, D594, D595): a compact table that scrolls
 * (both ways; at most 1,000 rows), "rows truncated" when the run or the store cut it, the SQL behind
 * a disclosure, CSV export, and "Turn into a report" (New report → Blank on the same data source,
 * with the query opened in its console). The rows are read with the reader's session: someone who
 * may not use the data source through agents sees only that the result is hidden.
 */

export { writeReportFromChat, type ReportFromChat } from "../reports/chatSeed";

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  // A leading = + - @ would run as a formula in a spreadsheet: quoted with a ' first.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The result as CSV (RFC 4180, a header row of the column names). */
export function resultCsv(result: Pick<SqlResultDetail, "columns" | "rows">): string {
  return [result.columns.map((column) => csvCell(column.name)).join(","), ...result.rows.map((row) => row.map(csvCell).join(","))].join("\r\n");
}

const cellText = (value: unknown) => value === null || value === undefined ? "NULL" : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
const numeric = (type: string) => /^(Nullable\()?(U?Int|Float|Decimal)/.test(type);

export function SqlResultCard({ chatId, result, canMakeReport, onTurnIntoReport }: { chatId: string; result: SqlResultRef; canMakeReport: boolean; onTurnIntoReport?: (seed: ReportFromChat) => void }) {
  const [detail, setDetail] = useState<SqlResultDetail | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  // A failed query shows its SQL at once: it is what the person came to see (D594).
  const [showSql, setShowSql] = useState(result.failed === true);
  useEffect(() => {
    let live = true;
    getSqlResult(chatId, result.id).then(({ result: loaded }) => { if (live) setDetail(loaded); }, (reason: unknown) => {
      if (live) setHidden(reason instanceof Error && reason.message ? reason.message : "This result could not be loaded");
    });
    return () => { live = false; };
  }, [chatId, result.id]);
  const rows = `${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? "row" : "rows"}`;
  const exportCsv = () => {
    if (!detail) return;
    const url = URL.createObjectURL(new Blob([resultCsv(detail)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${result.datasourceName.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "result"}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const failed = result.failed === true || Boolean(detail?.error);
  return <section className={`chat-sql${failed ? " chat-sql-failed" : ""}`} aria-label={`${failed ? "Failed query" : "Query result"} from ${result.datasourceName}`}>
    <header className="chat-sql-head">
      <span className="chat-sql-title"><Table2 aria-hidden="true" />{result.datasourceName}<small>{failed ? "query failed" : `${rows}${result.truncated ? " · rows truncated" : ""}`}</small></span>
      {detail && <span className="chat-sql-actions">
        <button type="button" className="chat-action chat-sql-action" aria-expanded={showSql} onClick={() => setShowSql(!showSql)}>{showSql ? <ChevronDown /> : <ChevronRight />}SQL</button>
        {!failed && <button type="button" className="chat-action chat-sql-action" onClick={exportCsv}><Download />CSV</button>}
        {!failed && canMakeReport && onTurnIntoReport && <button type="button" className="chat-action chat-sql-action" onClick={() => onTurnIntoReport({ chatId, resultId: result.id, datasourceId: detail.datasource.id, title: "" })}><FilePlus2 />Turn into a report</button>}
      </span>}
    </header>
    {hidden !== null ? <p className="chat-muted chat-sql-note">{hidden}</p>
      : !detail ? <p className="chat-muted chat-sql-note">Loading the result…</p>
      : <>
        {showSql && <pre className="chat-sql-text">{detail.sql}</pre>}
        {detail.error ? <p className="chat-sql-note chat-sql-error" role="note">{detail.error.message}</p> : detail.columns.length === 0 ? <p className="chat-muted chat-sql-note">No columns.</p> : <div className="chat-sql-scroll" tabIndex={0} role="region" aria-label={`${result.datasourceName} result, ${rows}`}>
          <table className="chat-sql-table">
            <thead><tr>{detail.columns.map((column, index) => <th key={`${column.name}-${index}`} scope="col"><span>{column.name}</span><small>{column.type}</small></th>)}</tr></thead>
            <tbody>{detail.rows.map((row, rowIndex) => <tr key={rowIndex}>{detail.columns.map((column, index) => {
              const cell = row[index];
              return <td key={index} className={[cell === null || cell === undefined ? "chat-sql-null" : "", numeric(column.type) ? "chat-sql-num" : ""].filter(Boolean).join(" ") || undefined}>{cellText(cell)}</td>;
            })}</tr>)}</tbody>
          </table>
        </div>}
        {detail.truncated && <p className="chat-muted chat-sql-note">Rows truncated: the table shows the first {detail.rows.length.toLocaleString()}. Aggregate in SQL, or open it as a report for more.</p>}
      </>}
  </section>;
}

/** The result tables of a reply's run_sql calls, in call order. */
export function SqlResults({ calls = [], chatId, canMakeReport, onTurnIntoReport }: { calls?: ToolCallView[]; chatId: string | undefined; canMakeReport: boolean; onTurnIntoReport?: (seed: ReportFromChat) => void }) {
  if (!chatId) return null;
  const results = calls.flatMap((call) => call.sqlResult ? [call.sqlResult] : []);
  if (!results.length) return null;
  return <div className="chat-sql-list">{results.map((result) => <SqlResultCard key={result.id} chatId={chatId} result={result} canMakeReport={canMakeReport} onTurnIntoReport={onTurnIntoReport} />)}</div>;
}

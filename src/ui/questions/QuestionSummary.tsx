import type { Question, QuestionSet, QuestionSummary as Summary, SetSummary } from "../../../shared/questions";
import { InsightChart, KpiTile, ratingBuckets } from "../insights/Insights";
import { inlineText } from "./inline";
import "./questions.css";

/**
 * Results per question (§B.2, §E.3, D839), one view per aggregate family of `summarize`: choices and
 * rankings as labelled bars with counts and percents (the same bars as live polls), numbers and
 * dates as charts (the Reports wrapper, with their table), NPS as its score and three groups, text as
 * the latest answers and top words, time slots with the best slot marked. Numbers are tabular.
 */
const percent = (count: number, of: number) => of > 0 ? Math.round((count / of) * 100) : 0;

/** Horizontal result bars: label, bar, count and percent. Shared with LivePoll. */
export function ResultBars({ rows, total, highlight, label }: { rows: ReadonlyArray<{ id: string; label: string; count: number; muted?: boolean }>; total: number; highlight?: string | null; label: string }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return <ul className="ui-result-bars" aria-label={label}>
    {rows.map((row) => <li key={row.id} className={`${row.id === highlight ? "lead" : ""}${row.muted ? " muted" : ""}`}>
      <span className="ui-result-label">{row.label}</span>
      <span className="ui-result-track" aria-hidden="true"><span style={{ width: `${(row.count / max) * 100}%` }} /></span>
      <span className="ui-result-count ui-tabular">{row.count} · {percent(row.count, total)}%</span>
    </li>)}
  </ul>;
}

function SummaryBody({ question, summary }: { question: Question; summary: Summary }) {
  switch (summary.kind) {
    case "choice": {
      const lead = summary.options.reduce<{ id: string | null; count: number }>((best, option) => option.count > best.count ? { id: option.optionId, count: option.count } : best, { id: null, count: 0 }).id;
      const rows = [...summary.options.map((option) => ({ id: option.optionId, label: option.removed ? "Removed option" : option.label, count: option.count, muted: option.removed })), ...(summary.other ? [{ id: "__other", label: "Other", count: summary.other }] : [])];
      return <ResultBars rows={rows} total={summary.answered} highlight={lead} label="Answers by option" />;
    }
    case "ranking":
      return <ol className="ui-summary-ranking">{[...summary.options].sort((a, b) => b.borda - a.borda).map((option) => <li key={option.optionId}>
        <span>{option.removed ? "Removed option" : option.label}</span><span className="ui-tabular">{option.averageRank !== null ? `average rank ${option.averageRank.toFixed(1)}` : "not ranked"}</span>
      </li>)}</ol>;
    case "numeric": {
      // A rating or scale shows every bucket of its scale, zeros included (D1182); a number its values.
      const min = question.scale?.min ?? 1;
      const distribution = question.type === "rating" || question.type === "scale"
        ? ratingBuckets(summary.distribution, min, Math.min(10, Math.max(min + 1, question.scale?.max ?? 5)))
        : summary.distribution;
      return <>
        <div className="ui-kpis">
          <KpiTile label="Average" value={summary.mean} />
          <KpiTile label="Median" value={summary.median} />
          <KpiTile label="Range" value={null} text={summary.min !== null && summary.max !== null ? `${summary.min}–${summary.max}` : undefined} />
        </div>
        {distribution.length > 0 && <InsightChart title={`${question.type === "number" ? "Values" : "Ratings"}`} kind="bar" categories={distribution.map((entry) => String(entry.value))} series={[{ name: "Answers", values: distribution.map((entry) => entry.count) }]} height={180} />}
      </>;
    }
    case "nps":
      return <>
        <div className="ui-kpis">
          <KpiTile label="NPS" value={summary.score} />
          <KpiTile label="Promoters (9–10)" value={summary.promoters} />
          <KpiTile label="Passives (7–8)" value={summary.passives} />
          <KpiTile label="Detractors (0–6)" value={summary.detractors} />
        </div>
        <ResultBars rows={[{ id: "p", label: "Promoters", count: summary.promoters }, { id: "s", label: "Passives", count: summary.passives }, { id: "d", label: "Detractors", count: summary.detractors }]} total={summary.answered} label="NPS groups" />
      </>;
    case "text":
      return <div className="ui-summary-text">
        {summary.topWords.length > 0 && <p className="ui-summary-words">{summary.topWords.slice(0, 12).map((word) => <span key={word.word}>{word.word} <b className="ui-tabular">{word.count}</b></span>)}</p>}
        <ul className="ui-summary-latest" aria-label="Latest answers">{summary.latest.slice(0, 8).map((text, index) => <li key={index}>{text}</li>)}</ul>
      </div>;
    case "dates":
      return summary.byDay.length ? <InsightChart title="Answers by day" kind="bar" categories={summary.byDay.map((entry) => entry.day)} series={[{ name: "Answers", values: summary.byDay.map((entry) => entry.count) }]} height={180} /> : null;
    case "matrix": {
      const grid = question.matrix ?? { rows: [], columns: [] };
      const max = Math.max(1, ...summary.cells.map((cell) => cell.count));
      const count = (rowId: string, columnId: string) => summary.cells.find((cell) => cell.rowId === rowId && cell.columnId === columnId)?.count ?? 0;
      return <div className="ui-q-matrix-wrap"><table className="ui-q-matrix ui-summary-heat">
        <thead><tr><td />{grid.columns.map((column) => <th key={column.id} scope="col">{column.label}</th>)}</tr></thead>
        <tbody>{grid.rows.map((row) => <tr key={row.id}><th scope="row">{row.label}</th>{grid.columns.map((column) => {
          const value = count(row.id, column.id);
          return <td key={column.id} className="ui-tabular" style={{ background: `rgb(246 196 83 / ${(value / max) * 0.45})` }}>{value}</td>;
        })}</tr>)}</tbody>
      </table></div>;
    }
    case "slots": {
      const format = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      return <ul className="ui-summary-slots">{(question.slots ?? []).map((slot) => {
        const counts = summary.slots.find((entry) => entry.slotId === slot.id) ?? { yes: 0, maybe: 0, no: 0 };
        return <li key={slot.id} className={summary.best === slot.id ? "best" : undefined}>
          <span className="ui-tabular">{format.format(Date.parse(slot.start))}</span>
          <span className="ui-tabular">{counts.yes} yes{question.allowMaybe ? ` · ${counts.maybe} if needed` : ""} · {counts.no} no</span>
          {summary.best === slot.id && <strong className="ui-health" data-tone="success">Best</strong>}
        </li>;
      })}</ul>;
    }
    case "count":
      return <p className="ui-summary-count ui-tabular">{summary.answered} {summary.answered === 1 ? "answer" : "answers"}</p>;
  }
}

export function QuestionSummary({ set, summary }: { set: QuestionSet; summary: SetSummary }) {
  const byId = new Map(summary.questions.map((entry) => [entry.questionId, entry]));
  return <div className="ui-summary">
    <p className="ui-summary-total ui-tabular">{summary.responses} {summary.responses === 1 ? "response" : "responses"}</p>
    {set.questions.filter((question) => byId.has(question.id)).map((question, index) => {
      const entry = byId.get(question.id)!;
      return <section key={question.id} className="ui-summary-question" aria-labelledby={`summary-${question.id}`}>
        <header><h3 id={`summary-${question.id}`}><span className="ui-q-number ui-tabular" aria-hidden="true">{index + 1}</span>{inlineText(question.title)}</h3><span className="ui-tabular">{entry.answered} answered</span></header>
        <SummaryBody question={question} summary={entry} />
      </section>;
    })}
  </div>;
}

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { checkEstimate, estimateBadge, estimateTotal, estimateWords, FIBONACCI_POINTS, type EstimateKind, type EstimateSettings } from "../../shared/estimates";
import type { CardChange, CardDetail } from "./tasksApi";

/**
 * Card estimates in the app (lane ESTIMATES, docs/plan/TASK_ESTIMATES.md, D750–D757): the compact
 * badge on card faces, rows, and column headers, and the card dialog's Estimate field. Everything
 * reads the board's settings; with estimates off nothing renders.
 */

/** "5 pts" or "3h" as a small chip, read as "5 points" (D754). Nothing without a value or with estimates off. */
export function EstimateBadge({ kind, value, className = "" }: { kind: EstimateKind; value: number | null | undefined; className?: string }) {
  const text = estimateBadge(kind, value);
  if (!text) return null;
  return <span className={`task-estimate-chip${className ? ` ${className}` : ""}`} title={`Estimate: ${estimateWords(kind, value)}`}><Gauge aria-hidden="true" />{text}</span>;
}

/**
 * A column's total in its header (D754): "13 pts" over the cards it lists, or null when estimates are
 * off or no listed card has one. `label` is for screen readers: "13 points estimated on 4 cards".
 */
export function columnEstimate(kind: EstimateKind, cards: ReadonlyArray<{ estimate?: number | null }>) {
  if (kind === "none") return null;
  const total = estimateTotal(cards.map((card) => card.estimate));
  if (!total.counted) return null;
  return { text: estimateBadge(kind, total.sum), label: `${estimateWords(kind, total.sum)} estimated on ${total.counted === 1 ? "1 card" : `${total.counted} cards`}` };
}

type CardEstimateFieldProps = {
  card: Pick<CardDetail, "estimate">;
  settings: EstimateSettings;
  idPrefix: string;
  saving: boolean;
  onSave: (change: Pick<CardChange, "estimate">, success: string) => Promise<boolean>;
  /** A read-only role: the value shows as text. */
  readOnly?: boolean;
};

const saved = (kind: EstimateKind, value: number | null) => value === null ? "Estimate cleared" : `Estimated at ${estimateWords(kind, value)}`;

/**
 * The card dialog's Estimate field (D754): on a Fibonacci points board a row of chips (0, 1, 2, 3, 5,
 * 8, 13, 21) that save on a click, and a click on the chosen one clears it; on a free points board or
 * an hours board a number input with its unit ("pts", "h") that saves on Enter or when it loses
 * focus, empty clearing it. A value off the scale (kept from a free scale, D752) is shown and stays
 * until someone picks another. Hidden while the board has estimates off.
 */
export function CardEstimateField({ card, settings, idPrefix, saving, onSave, readOnly = false }: CardEstimateFieldProps) {
  const value = card.estimate ?? null;
  const labelId = `${idPrefix}-estimate-label`;
  if (settings.kind === "none") return null;
  const label = <span id={labelId} className="task-card-field-label"><Gauge aria-hidden="true" />Estimate</span>;
  if (readOnly) {
    return <div className="task-card-field">
      {label}
      <p className="task-card-static" aria-labelledby={labelId}>{value === null ? "No estimate" : estimateWords(settings.kind, value)}</p>
    </div>;
  }
  if (settings.kind === "points" && settings.scale === "fibonacci") {
    const offScale = value !== null && !(FIBONACCI_POINTS as readonly number[]).includes(value);
    return <div className="task-card-field task-card-field-wide">
      {label}
      <div className="task-estimate-scale" role="radiogroup" aria-labelledby={labelId}>
        {FIBONACCI_POINTS.map((point) => {
          const checked = value === point;
          return <button key={point} type="button" role="radio" aria-checked={checked} className={`task-estimate-option${checked ? " active" : ""}`} disabled={saving}
            aria-label={`${estimateWords("points", point)}${checked ? ", click to clear" : ""}`}
            onClick={() => { void onSave({ estimate: checked ? null : point }, saved("points", checked ? null : point)); }}>{point}</button>;
        })}
      </div>
      {offScale && <small className="task-due-text">Now {estimateWords("points", value)}, from before the board used the Fibonacci scale. Pick a value to replace it.</small>}
    </div>;
  }
  return <NumberEstimate value={value} settings={settings} labelId={labelId} inputId={`${idPrefix}-estimate`} saving={saving} onSave={onSave} />;
}

function NumberEstimate({ value, settings, labelId, inputId, saving, onSave }: { value: number | null; settings: EstimateSettings; labelId: string; inputId: string; saving: boolean; onSave: CardEstimateFieldProps["onSave"] }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  // Another save (or another person's change) moved the value: follow it.
  useEffect(() => { setDraft(value === null ? "" : String(value)); setError(null); }, [value]);
  const unit = settings.kind === "hours" ? "h" : "pts";

  async function commit() {
    const text = draft.trim();
    const next = text === "" ? null : Number(text.replace(",", "."));
    if (next !== null && Number.isNaN(next)) {
      setError("Use a number, like 3 or 1.5");
      return;
    }
    const checked = checkEstimate(settings, next);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    if (checked.value === value) {
      setDraft(value === null ? "" : String(value));
      return;
    }
    await onSave({ estimate: checked.value }, saved(settings.kind, checked.value));
  }

  return <div className="task-card-field">
    <label htmlFor={inputId} id={labelId} className="task-card-field-label"><Gauge aria-hidden="true" />Estimate</label>
    <span className="task-estimate-input">
      <input id={inputId} type="text" inputMode="decimal" value={draft} placeholder="None" disabled={saving} aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        onChange={(event) => { setDraft(event.target.value); setError(null); }}
        onBlur={() => { void commit(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void commit(); }
          if (event.key === "Escape" && draft !== (value === null ? "" : String(value))) { event.preventDefault(); event.stopPropagation(); setDraft(value === null ? "" : String(value)); setError(null); }
        }} />
      <span className="task-estimate-unit" aria-hidden="true">{unit}</span>
    </span>
    {error && <small id={`${inputId}-error`} className="task-due-text overdue" role="alert">{error}</small>}
  </div>;
}

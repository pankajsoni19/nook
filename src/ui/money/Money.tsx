import { useEffect, useId, useRef, useState } from "react";
import { COMMON_CURRENCIES, formatMoney, isCurrency, minorDigits, parseMoney, type Money } from "../../../shared/money";
import { Select } from "../Select";
import { useWorkspaceSettings } from "../units";
import "../workspace.css";

/**
 * Money (§E.3, D838; shared/money.ts): integer minor units and an ISO 4217 code, formatted with Intl,
 * never converted. The currency defaults to the workspace's (Settings → Workspace).
 */

/** "$1,234.50", tabular; `compact` for tight places ("$1.2K"). */
export function MoneyText({ money, compact = false }: { money: Money; compact?: boolean }) {
  const text = formatMoney(money, undefined, { compact });
  return <span className="ui-money ui-tabular" title={compact ? formatMoney(money) : undefined}>{text}</span>;
}

const plain = (money: Money) => (money.amount / 10 ** minorDigits(money.currency)).toFixed(minorDigits(money.currency));

/**
 * An amount and, when `currencyEditable`, its currency. Typing "1,234.5" reads as 123450 minor units
 * in a 2-digit currency; too many decimals or anything else is an error, never a guess.
 */
export function MoneyInput({ label, value, onChange, currencyEditable = false, required = false, disabled = false, id }: {
  label: string;
  value: Money | null;
  /** The amount in minor units (null when empty) and the currency. */
  onChange: (money: Money | null, currency: string) => void;
  currencyEditable?: boolean;
  required?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const workspace = useWorkspaceSettings();
  const currency = value?.currency ?? workspace.defaultCurrency;
  const autoId = useId();
  const inputId = id ?? `${autoId}-money`;
  const [text, setText] = useState(() => value ? plain(value) : "");
  const [error, setError] = useState<string | null>(null);
  const last = useRef(value);
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    setText(value ? plain(value) : "");
    setError(null);
  }, [value]);

  const commit = (nextCurrency = currency) => {
    if (!text.trim()) { setError(required ? "Enter an amount" : null); last.current = null; onChange(null, nextCurrency); return; }
    const amount = parseMoney(text, nextCurrency);
    if (amount === null) { setError(minorDigits(nextCurrency) === 0 ? `Enter a whole amount in ${nextCurrency}` : `Enter an amount like 1,234.50`); return; }
    setError(null);
    const money = { amount, currency: nextCurrency };
    last.current = money;
    setText(plain(money));
    onChange(money, nextCurrency);
  };
  const currencies = [...new Set([currency, ...COMMON_CURRENCIES])].filter(isCurrency);
  return <div className="ui-field ui-money-field">
    <label htmlFor={inputId}>{label}</label>
    <span className="ui-money-input">
      {currencyEditable
        ? <Select label={`${label} currency`} value={currency} disabled={disabled} options={currencies.map((code) => ({ value: code, label: code }))} onChange={(next) => commit(next)} />
        : <span className="ui-money-code" aria-hidden="true">{currency}</span>}
      <input id={inputId} type="text" inputMode="decimal" autoComplete="off" value={text} disabled={disabled} required={required} placeholder="0.00"
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${inputId}-error` : undefined} aria-label={currencyEditable ? undefined : `${label} (${currency})`}
        onChange={(event) => { setText(event.target.value); if (error) setError(null); }} onBlur={() => commit()}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />
    </span>
    {error && <small id={`${inputId}-error`} className="ui-field-error" role="alert">{error}</small>}
  </div>;
}

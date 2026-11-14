/**
 * Money (§B.16): integer minor units plus an ISO 4217 code, formatted with Intl, never converted.
 * The workspace default currency is `team_settings.default_currency` (085; Settings → Workspace).
 */

export type Money = { amount: number; currency: string };

/** Minor-unit digits for the currencies that are not 2 (ISO 4217). */
const MINOR_DIGITS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3
};

/** Currencies offered in pickers (any valid 3-letter code is accepted). */
export const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "INR", "JPY", "AUD", "CAD", "CHF", "CNY", "SGD", "AED", "BRL", "MXN", "ZAR", "SEK", "NOK", "DKK", "NZD", "HKD", "KRW"] as const;
export const DEFAULT_CURRENCY = "USD";

/** The largest amount in minor units (about 90 trillion in a 2-digit currency): safely inside a double. */
export const MONEY_MAX_MINOR = 9_000_000_000_000_000;

export function isCurrency(code: unknown): code is string {
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

export const minorDigits = (currency: string) => MINOR_DIGITS[currency] ?? 2;

/** Minor units from a typed amount ("1,234.50", "1234.5", "12") in `currency`, or null. */
export function parseMoney(text: string, currency: string): number | null {
  const cleaned = text.trim().replace(/[\s,_]/g, "").replace(/^[^\d.-]+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const digits = minorDigits(currency);
  const [whole, fraction = ""] = cleaned.replace("-", "").split(".");
  if (fraction.length > digits) return null;
  const minor = Number(whole) * 10 ** digits + Number((fraction + "0".repeat(digits)).slice(0, digits) || 0);
  if (!Number.isSafeInteger(minor) || minor > MONEY_MAX_MINOR) return null;
  return cleaned.startsWith("-") ? -minor : minor;
}

/** "$1,234.50" for `{ amount: 123450, currency: "USD" }`. */
export function formatMoney(money: Money, locale?: string, options: { compact?: boolean } = {}): string {
  const value = money.amount / 10 ** minorDigits(money.currency);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: money.currency, ...(options.compact ? { notation: "compact", maximumFractionDigits: 1 } : {}) }).format(value);
  } catch {
    return `${value.toFixed(minorDigits(money.currency))} ${money.currency}`;
  }
}

/** Sums amounts of one currency; null when they mix currencies (no conversion, ever). */
export function sumMoney(values: readonly Money[]): Money | null {
  if (!values.length) return null;
  const currency = values[0]!.currency;
  if (values.some((value) => value.currency !== currency)) return null;
  return { amount: values.reduce((sum, value) => sum + value.amount, 0), currency };
}

/** amount × hours for a rate in minor units per hour, rounded to a minor unit. */
export const moneyForSeconds = (ratePerHour: number, seconds: number) => Math.round((ratePerHour * seconds) / 3600);

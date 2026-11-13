import { formatMoney } from "../../shared/money";
import type { CrmFieldDef, CrmFieldValue } from "../../shared/crm";

/** Small display helpers shared by the Contacts screens. */

export const money = (amount: number | null | undefined, currency: string, compact = false) => amount === null || amount === undefined ? "—" : formatMoney({ amount, currency }, undefined, { compact });

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dateYearFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "Mar 4" this year, "Mar 4, 2025" otherwise; for YYYY-MM-DD or an ISO instant. */
export function shortDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.getFullYear() === new Date().getFullYear() ? dateFormat.format(date) : dateYearFormat.format(date);
}
export const dateTime = (value: string | null | undefined) => value ? timeFormat.format(new Date(value)) : "—";

/** "3 days ago", "in 2 hours". */
export function relative(value: string | null | undefined, nowMs = Date.now()) {
  if (!value) return "never";
  const ms = (/^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T12:00:00`) : Date.parse(value)) - nowMs;
  const abs = Math.abs(ms);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000_000], ["month", 2_592_000_000], ["week", 604_800_000], ["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) if (abs >= size) return format.format(Math.round(ms / size), unit);
  return "just now";
}

/** Today as YYYY-MM-DD in the viewer's zone. */
export const todayLocal = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; };
export const isPast = (date: string | null | undefined) => Boolean(date && date < todayLocal());

/** A custom field's value as text. */
export function fieldText(field: CrmFieldDef, value: CrmFieldValue | undefined, people: ReadonlyMap<string, string> = new Map()) {
  if (value === undefined || value === null || value === "") return "";
  if (field.type === "select") return field.options?.find((option) => option.id === value)?.label ?? "";
  if (field.type === "multi_select" && Array.isArray(value)) return value.map((id) => field.options?.find((option) => option.id === id)?.label).filter(Boolean).join(", ");
  if (field.type === "checkbox") return value === true ? "Yes" : "";
  if (field.type === "person" || field.type === "contact") return people.get(String(value)) ?? (field.type === "person" ? "Team member" : "Contact");
  if (field.type === "date") return shortDate(String(value));
  if (field.type === "number") return `${new Intl.NumberFormat().format(Number(value))}${field.number?.unit ? ` ${field.number.unit}` : ""}`;
  return String(value);
}

/** The initials avatar text of a name. */
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";

import { db } from "../db";
import { runDatasetQuery, type DatasetDef } from "../datasets/registry";
import type { Role } from "../team/roles";
import { isValidTimeZone } from "../../shared/calendarRecurrence";
import { readableBookingSql } from "./model";

/**
 * Bookings Insights (§B.10): the `bookings.bookings` dataset (no booker PII: type, host, status,
 * start, duration, lead time, source) with the T583 predicate always applied, and the Insights tab's
 * preset queries run through runDatasetQuery so they are the same numbers Reports will see (W3).
 */

export const bookingsDataset: DatasetDef = {
  id: "bookings.bookings",
  module: "bookings",
  label: "Bookings",
  description: "Bookings you host or manage: type, host, status, start, duration, lead time, and source. No booker details.",
  readScope: "bookings:read",
  from: "bookings b LEFT JOIN users hu ON hu.id = b.host_id",
  scope: () => ({ sql: readableBookingSql("b") }),
  timeColumn: "start",
  columns: [
    { name: "type", sql: "b.type_title", type: "string", label: "Type", dimension: true },
    { name: "host", sql: "COALESCE(hu.display_name, 'Former member')", type: "string", label: "Host", dimension: true },
    { name: "status", sql: "b.status", type: "string", label: "Status", dimension: true },
    { name: "source", sql: "b.source", type: "string", label: "Source", dimension: true },
    { name: "start", sql: "b.start_utc", type: "datetime", label: "Start", dimension: true, measures: ["min", "max"] },
    { name: "duration_min", sql: "b.duration_min", type: "number", label: "Duration (minutes)", dimension: true, measures: ["sum", "avg", "min", "max"] },
    { name: "lead_time_hours", sql: "ROUND((julianday(b.start_utc) - julianday(b.created_at)) * 24, 1)", type: "number", label: "Lead time (hours)", measures: ["avg", "min", "max"] },
    { name: "rescheduled", sql: "(b.rescheduled_from_id IS NOT NULL)", type: "bool", label: "Rescheduled", dimension: true },
    // The old row of a reschedule (cancelled, with a successor): one meeting, which Insights counts once (D1125).
    { name: "moved", sql: "(b.id IN (SELECT rescheduled_from_id FROM bookings WHERE rescheduled_from_id IS NOT NULL))", type: "bool", label: "Moved to a new time", dimension: true },
    { name: "created_at", sql: "b.created_at", type: "datetime", label: "Booked at", dimension: true, measures: ["min", "max"] }
  ]
};

export function bookingsInsights(userId: string, options: { days: number; tz: string }) {
  const role = (db.query("SELECT role FROM users WHERE id = ?").get(userId) as { role: Role } | null)?.role ?? "member";
  const days = Math.min(365, Math.max(7, Math.floor(options.days) || 90));
  const tz = isValidTimeZone(options.tz) ? options.tz : "UTC";
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const viewer = { userId, role };
  // A rescheduled booking's old row is left out: a move is neither a second booking nor a cancellation (D1125).
  const base = { dataset: "bookings.bookings", timeRange: { from, to }, tz, filters: [{ column: "moved", op: "eq" as const, value: false }] };
  const byStatus = runDatasetQuery({ ...base, measures: [{ fn: "count" }], dimensions: ["status"] }, viewer);
  const byWeek = runDatasetQuery({ ...base, measures: [{ fn: "count" }], timeBucket: "week", sort: [{ column: "bucket", dir: "asc" }] }, viewer);
  const byType = runDatasetQuery({ ...base, measures: [{ fn: "count" }, { fn: "sum", column: "duration_min", as: "minutes" }], dimensions: ["type"], sort: [{ column: "count", dir: "desc" }], limit: 12 }, viewer);
  const byHost = runDatasetQuery({ ...base, measures: [{ fn: "count" }], dimensions: ["host"], sort: [{ column: "count", dir: "desc" }], limit: 12 }, viewer);
  const lead = runDatasetQuery({ ...base, measures: [{ fn: "avg", column: "lead_time_hours", as: "lead" }] }, viewer);
  const statusCounts = Object.fromEntries(byStatus.rows.map((row) => [String(row[0]), Number(row[1])]));
  const total = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
  return {
    days, tz, total, statusCounts,
    cancelRate: total ? ((statusCounts.cancelled ?? 0) + (statusCounts.declined ?? 0)) / total : null,
    noShowRate: total ? (statusCounts.no_show ?? 0) / total : null,
    avgLeadHours: lead.rows[0]?.[0] === null || lead.rows[0]?.[0] === undefined ? null : Number(lead.rows[0][0]),
    weeks: byWeek.rows.map((row) => ({ week: String(row[0]), count: Number(row[1]) })),
    types: byType.rows.map((row) => ({ type: String(row[0]), count: Number(row[1]), minutes: Number(row[2] ?? 0) })),
    hosts: byHost.rows.map((row) => ({ host: String(row[0]), count: Number(row[1]) }))
  };
}

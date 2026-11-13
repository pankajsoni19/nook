import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { AppEnv } from "./auth";
import { audit, db } from "./db";

/**
 * Undo for fine-grained deletes (docs/plan/WORKSPACE_MODULES.md §B.13, D813, T512), generalizing
 * server/attachments/undoTickets.ts: time entries, responses, interactions, item comments, and key
 * results are deleted at once with an Undo toast. The service captures the rows it is about to delete
 * (`captureUndo`, inside the delete's transaction); `POST /api/undo/:ticket` puts them back.
 *
 * - A ticket is bound to the person who deleted (another person's ticket is NOT_FOUND) and expires
 *   after 10 minutes; it works once.
 * - Restoring refuses (409 UNDO_CONFLICT) when any captured row's primary key exists again or a row it
 *   needs is gone (a foreign key fails): nothing another person did since is overwritten.
 * - Tickets live in memory (one replica); a restart ends them, like the toast.
 * - `registerUndoKind(kind, { restored })` lets a module redo derived state after a restore (counters,
 *   activity, search) in the same transaction.
 */

export const UNDO_TTL_MS = 10 * 60_000;
const MAX_TICKETS = 5_000;

/** `update`: the row stays (a soft delete) and is put back as it was; `insert` (default): it is deleted and re-inserted. */
type CapturedRow = { table: string; row: Record<string, unknown>; restore: "insert" | "update"; where: Record<string, string | number> };
type Ticket = { actorId: string; kind: string; label: string; rows: CapturedRow[]; expiresAt: number };
const tickets = new Map<string, Ticket>();
const kinds = new Map<string, { restored?: (rows: CapturedRow[], actorId: string) => void }>();

export function registerUndoKind(kind: string, def: { restored?: (rows: CapturedRow[], actorId: string) => void }) {
  if (kinds.has(kind)) throw new Error(`Undo kind ${kind} is already registered`);
  kinds.set(kind, def);
  return () => { kinds.delete(kind); };
}

const knownTable = (table: string) => /^[a-z_]+$/.test(table) && db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;

/**
 * Captures rows before they are deleted; returns the ticket the client sends back. `rows` are listed
 * parents first (they are re-inserted in order). Call inside the delete's transaction.
 */
export function captureUndo(input: { actorId: string; kind: string; label: string; rows: Array<{ table: string; where: Record<string, string | number>; restore?: "insert" | "update" }>; nowMs?: number }): string {
  const captured: CapturedRow[] = [];
  for (const spec of input.rows) {
    if (!knownTable(spec.table)) throw new Error(`Unknown table ${spec.table}`);
    const columns = Object.keys(spec.where);
    if (!columns.length || columns.some((column) => !/^[a-z_]+$/.test(column))) throw new Error("Invalid undo selector");
    const rows = db.query(`SELECT * FROM ${spec.table} WHERE ${columns.map((column) => `${column} = ?`).join(" AND ")}`).all(...columns.map((column) => spec.where[column]!)) as Array<Record<string, unknown>>;
    for (const row of rows) captured.push({ table: spec.table, row, restore: spec.restore ?? "insert", where: spec.where });
  }
  const nowMs = input.nowMs ?? Date.now();
  for (const [id, ticket] of tickets) if (ticket.expiresAt <= nowMs) tickets.delete(id);
  if (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
  const id = randomBytes(18).toString("base64url");
  tickets.set(id, { actorId: input.actorId, kind: input.kind, label: input.label, rows: captured, expiresAt: nowMs + UNDO_TTL_MS });
  return id;
}

export class UndoError extends Error {
  constructor(readonly status: 404 | 409, readonly code: "NOT_FOUND" | "UNDO_CONFLICT", message: string) {
    super(message);
  }
}

/** Puts a ticket's rows back, as `actorId`, once. */
export function restoreUndo(ticketId: string, actorId: string, nowMs = Date.now()) {
  const ticket = tickets.get(ticketId);
  if (!ticket || ticket.actorId !== actorId || ticket.expiresAt <= nowMs) throw new UndoError(404, "NOT_FOUND", "This can no longer be undone");
  try {
    db.transaction(() => {
      for (const { table, row, restore, where } of ticket.rows) {
        const columns = Object.keys(row);
        if (restore === "update") {
          const keys = Object.keys(where);
          const changed = db.query(`UPDATE ${table} SET ${columns.map((column) => `"${column}" = ?`).join(", ")} WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")}`)
            .run(...columns.map((column) => row[column] as string | number | null), ...keys.map((key) => where[key]!)).changes;
          if (changed !== 1) throw new UndoError(409, "UNDO_CONFLICT", "This changed since it was deleted and cannot be put back");
          continue;
        }
        db.query(`INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
          .run(...columns.map((column) => row[column] as string | number | null));
      }
      kinds.get(ticket.kind)?.restored?.(ticket.rows, actorId);
      audit(actorId, null, "undo.restored", { kind: ticket.kind, rows: ticket.rows.length });
    })();
  } catch (error) {
    if (error instanceof Error && /constraint/i.test(error.message)) throw new UndoError(409, "UNDO_CONFLICT", "This changed since it was deleted and cannot be put back");
    throw error;
  }
  tickets.delete(ticketId);
  return { restored: ticket.rows.length, kind: ticket.kind, label: ticket.label };
}

/** Test hook. */
export const resetUndoForTests = () => tickets.clear();

export function registerUndoRoutes(app: Hono<AppEnv>) {
  app.post("/api/undo/:ticket", (c) => {
    try {
      return c.json(restoreUndo(c.req.param("ticket"), c.get("user").id));
    } catch (error) {
      if (error instanceof UndoError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  });
}

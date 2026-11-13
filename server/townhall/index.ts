import { registerWorkspaceModule } from "../workspaceModules";
import { db } from "../db";
import { readableContainerSql } from "../access/workspaceItems";
import { page as todayPage, sectionScope } from "../today/registry";
import { WORK_KIND_ICONS, type WorkSummary } from "../../shared/workRefs";
import { levelOn, readQuestion, runReminder, sessionHref, sessionRow, type SessionRow } from "./service";
import { registerTownhallRoutes, TOWNHALL_READ_ONLY_WRITES } from "./routes";
import { registerTownhallPublicRoutes } from "./publicRoutes";
import { townhallMcpTools, TOWNHALL_AGENT_TOOLS } from "./mcp";
import { townhallBinProvider } from "./bin";
import type { ItemLevel } from "../access/levels";

/**
 * Townhall: the module entry (docs/plan/WORKSPACE_MODULES.md §G.1, §D.7 Townhall). Everything the
 * module adds to the shared registries is here: routes and the audience link's public routes, MCP
 * tools, the `townhall_session` access container, item and work kinds, the Bin, Today, search,
 * datasets, the reminder schedule, and the read-only writes (guests and viewers ask and vote, D817).
 * Migrations 115 (116–117 unused), decisions D1070–D1099, threats T610–T619.
 */

const STATE_WORDS = { upcoming: { label: "Upcoming", tone: "info" as const }, live: { label: "Live", tone: "danger" as const }, ended: { label: "Ended", tone: "neutral" as const } };

function sessionSummary(row: SessionRow): WorkSummary {
  return { kind: "townhall_session", id: row.id, shortId: row.short_id, title: row.title, subtitle: "Townhall", href: sessionHref(row), icon: WORK_KIND_ICONS.townhall_session, status: STATE_WORDS[row.state], ...(row.starts_at ? { due: row.starts_at } : {}) };
}

/** A question's level: the session's, raised to comment for readers while comments are on (asking is not access, §B.9). */
function questionLevel(id: string, userId: string): ItemLevel {
  try {
    const { session, level } = readQuestion(id, userId);
    if (level === "view" && session.allow_comments === 1) return "comment";
    return level;
  } catch {
    return "none";
  }
}

registerWorkspaceModule({
  id: "townhall",
  routes: registerTownhallRoutes,
  publicRoutes: registerTownhallPublicRoutes,
  readOnlyWrites: TOWNHALL_READ_ONLY_WRITES,
  accessContainer: { kind: "townhall_session", table: "townhall_sessions", nameColumn: "title" },
  itemKinds: [
    { kind: "townhall_session", anchors: (id) => { const row = sessionRow(id); return row ? [{ kind: "townhall_session", id: row.id }] : null; } },
    { kind: "townhall_question", anchors: (id) => {
      const row = /^[0-9a-f-]{36}$/i.test(id) ? db.query("SELECT session_id FROM townhall_questions WHERE id = ?").get(id.toLowerCase()) as { session_id: string } | null : null;
      return row ? [{ kind: "townhall_session", id: row.session_id }] : null;
    } }
  ],
  workKinds: [
    {
      kind: "townhall_session", itemKind: "townhall_session", scopes: { read: "townhall:read", write: "townhall:write" },
      lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "short_id" ? sessionRow(ref.ref)?.id ?? null : null,
      level: (id, viewer) => levelOn(sessionRow(id), viewer.userId),
      resolve: (ids, viewer) => new Map(ids.map((id) => {
        const row = sessionRow(id);
        return [id, row && levelOn(row, viewer.userId) !== "none" ? sessionSummary(row) : null];
      }))
    },
    {
      kind: "townhall_question", itemKind: "townhall_question", scopes: { read: "townhall:read", write: "townhall:write" },
      level: (id, viewer) => questionLevel(id, viewer.userId),
      resolve: (ids, viewer) => new Map(ids.map((id) => {
        try {
          const { question, session } = readQuestion(id, viewer.userId);
          const title = question.body.length > 120 ? `${question.body.slice(0, 119)}…` : question.body;
          return [id, { kind: "townhall_question" as const, id, title, subtitle: session.title, href: `${sessionHref(session)}?q=${question.id}`, icon: WORK_KIND_ICONS.townhall_question,
            ...(question.status === "answered" ? { status: { label: "Answered", tone: "success" as const } } : {}) }];
        } catch {
          return [id, null];
        }
      }))
    }
  ],
  mcpTools: townhallMcpTools,
  agentTools: TOWNHALL_AGENT_TOOLS,
  binProviders: [{ type: "townhall_session", provider: townhallBinProvider }],
  scheduleHandlers: {
    // A reminder before the start (D1081); a late one (the server was down) is skipped after the start.
    "townhall.remind": { run: (schedule) => { if (typeof schedule.payload.sessionId === "string") runReminder(schedule.payload.sessionId); }, skipIfLateMs: 30 * 60_000 }
  },
  todayProviders: [{
    name: "townhallLive", provider: { href: "/townhall", mcpScope: "townhall:read",
    load: (context) => {
      const filter = sectionScope(context, "townhall:read", { townhall_session: "s.id" });
      const soon = new Date(context.now.getTime() + 24 * 3_600_000).toISOString();
      const rows = db.query(`SELECT s.id, s.short_id, s.title, s.state, s.starts_at FROM townhall_sessions s
        WHERE ${readableContainerSql("townhall_session", "s")} AND ${filter.sql}
          AND (s.state = 'live' OR (s.state = 'upcoming' AND s.starts_at IS NOT NULL AND s.starts_at <= $soon AND s.starts_at >= $since))
        ORDER BY CASE s.state WHEN 'live' THEN 0 ELSE 1 END, s.starts_at, s.id LIMIT 11`)
        .all({ ...filter.params, userId: context.userId, soon, since: new Date(context.now.getTime() - 3_600_000).toISOString() }) as Array<{ id: string; short_id: string; title: string; state: string; starts_at: string | null }>;
      return todayPage(rows.map((row) => ({ id: row.id, title: row.title, state: row.state, startsAt: row.starts_at, href: sessionHref({ title: row.title, short_id: row.short_id }) })));
    } }
  }],
  searchScopes: [{
    scope: "townhall", label: "Townhall", module: "townhall",
    search: ({ userId, q, limit }) => {
      const rows = db.query(`SELECT s.id, s.short_id, s.title, s.updated_at FROM townhall_sessions s WHERE ${readableContainerSql("townhall_session", "s")}
        AND instr(lower(s.title), lower($q)) > 0 ORDER BY s.updated_at DESC, s.id LIMIT $limit`).all({ userId, q: q.slice(0, 200), limit: limit + 1 }) as Array<{ id: string; short_id: string; title: string; updated_at: string }>;
      return { results: rows.slice(0, limit).map((row) => ({ kind: "townhall_session" as const, id: row.id, title: row.title, href: sessionHref(row), updatedAt: row.updated_at })), truncated: rows.length > limit };
    }
  }],
  datasets: [
    {
      id: "townhall.questions", module: "townhall", label: "Townhall questions", description: "Questions asked in townhall sessions you can open (hosts also see pending and hidden ones).", readScope: "townhall:read",
      from: "townhall_questions q JOIN townhall_sessions s ON s.id = q.session_id",
      scope: () => ({ sql: `(${readableContainerSql("townhall_session", "s")} AND q.merged_into IS NULL AND (q.status IN ('approved','answered') OR ${readableContainerSql("townhall_session", "s", { minLevel: "edit" })}))` }),
      timeColumn: "asked_at",
      columns: [
        { name: "session", sql: "s.title", type: "string", label: "Session", dimension: true },
        { name: "status", sql: "q.status", type: "string", label: "Status", dimension: true },
        { name: "anonymous", sql: "q.anonymous", type: "bool", label: "Anonymous", dimension: true },
        { name: "via", sql: "q.via", type: "string", label: "Asked through", dimension: true },
        { name: "upvotes", sql: "q.vote_count", type: "number", label: "Upvotes", measures: ["sum", "avg", "max"] },
        { name: "asked_at", sql: "q.created_at", type: "datetime", label: "Asked", dimension: true }
      ]
    },
    {
      id: "townhall.attendance", module: "townhall", label: "Townhall attendance", description: "People who joined townhall sessions you can open (members and audience-link participants), one row each.", readScope: "townhall:read",
      from: "townhall_attendance a JOIN townhall_sessions s ON s.id = a.session_id",
      scope: () => ({ sql: readableContainerSql("townhall_session", "s") }),
      timeColumn: "joined_at",
      columns: [
        { name: "session", sql: "s.title", type: "string", label: "Session", dimension: true },
        { name: "via", sql: "a.via", type: "string", label: "Joined through", dimension: true },
        { name: "joined_at", sql: "a.first_seen_at", type: "datetime", label: "Joined", dimension: true }
      ]
    }
  ]
});


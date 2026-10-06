import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, locationUrl, parseRoute, type Route } from "../src/router";
import { auditRoute, chatBackAction, chatRoute } from "../src/chatRoute";
import { activeFilterCount, auditCardMeta, auditStatus, filterChoices, formatDay, formatDuration, formatWhen, STATUS_FILTERS } from "../src/chat/AuditLog";
import { AgentApiRuns, apiRunsSummary, LINK_DEAD_SENTENCE } from "../src/chat/AgentsSettings";
import { auditExportUrl } from "../src/chat/chatApi";
import { grantChips, grantSummary, permissionChoices, rowsToGrants, selectorFor, SELECTOR_KINDS, type GrantRow } from "../src/keys/keyGrants";
import { MEMBER_ONLY_MCP_SCOPES, offeredMcpPermissions } from "../src/mcpPermissions";
import type { AuditRunSummary } from "../shared/agents";

/**
 * The Audit log and the Agents grant on the client (Wave 42 "AC-C", agent chat plan §7.3, §13.3,
 * §15 item 13): the /chat/audit routes and their in-app Back (the 390 px list → run model), the
 * card and status text, the filter choices, the export URL, the grant builder's Agents rows (run on
 * all agents or chosen ones; read always on all), counts in key chips, and the manager's counts.
 */

const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
const runId = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const agentId = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const keyId = "b1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5e";

const summary = (patch: Partial<AuditRunSummary> = {}): AuditRunSummary => ({
  id: runId, via: "api", agentId, agentName: "Runner", key: { id: keyId, name: "CI", prefix: "mynotes_ab12" }, owner: { id: "u1", displayName: "Ana" },
  status: "ok", errorCode: null, model: "gpt-6-luna", steps: 2, toolCalls: 1, promptTokens: 1200, completionTokens: 34, estimated: false,
  queuedAt: "2026-10-06T10:00:00.000Z", startedAt: "2026-10-06T10:00:00.010Z", firstTokenAt: "2026-10-06T10:00:00.400Z", finishedAt: "2026-10-06T10:00:01.234Z", durationMs: 1234,
  label: null, full: true, ...patch
});

describe("routes and Back (§13.3)", () => {
  test("/chat/audit and /chat/audit/:runId round-trip; malformed ids open the list", () => {
    const rows: Array<[string, Route]> = [
      ["/chat/audit", { app: "chat", chatId: null, audit: true }],
      [`/chat/audit/${runId}`, { app: "chat", chatId: null, audit: true, runId }]
    ];
    for (const [path, route] of rows) {
      expect(parseRoute(path)).toEqual(route);
      expect(formatRoute(route)).toBe(path);
    }
    expect(parseRoute(`/chat/audit/${runId.toUpperCase()}`)).toEqual({ app: "chat", chatId: null, audit: true, runId });
    for (const path of ["/chat/audit/nope", `/chat/audit/${runId}/extra`]) expect(parseRoute(path)).toEqual({ app: "chat", chatId: null, audit: true });
    expect(auditRoute(runId)).toEqual({ app: "chat", chatId: null, audit: true, runId });
  });

  test("390 px: list → run pushes, Back returns; a deep link to a run backs to the list, the list to the chats", () => {
    // After list → card (one pushed entry), in-app Back is the browser's Back.
    expect(chatBackAction(auditRoute(runId), 1)).toEqual({ kind: "history" });
    expect(chatBackAction(auditRoute(), 1)).toEqual({ kind: "history" });
    // Opened directly: the run backs to the Audit log, the Audit log to the chats, never out of Nook.
    expect(chatBackAction(auditRoute(runId), 0)).toEqual({ kind: "replace", route: auditRoute() });
    expect(chatBackAction(auditRoute(), 0)).toEqual({ kind: "replace", route: chatRoute() });
    // The chats list itself still goes Home.
    expect(chatBackAction(chatRoute(), 0)).toEqual({ kind: "home" });
  });

  test("the filter sheet closes on Back first (the history guard); cards push; no native select", () => {
    const source = read("chat/AuditLog.tsx");
    expect(source).toMatch(/function AuditFilterSheet[\s\S]*useHistoryDialogGuard\(true, onClose\)/);
    expect(source).toContain("go(auditRoute(run.id, filter))");
    expect(source).not.toMatch(/<select/);
    const chat = read("chat/ChatApp.tsx");
    // The run screen is the "detail" screen on phones, so the list hides behind it (chat.css).
    expect(chat).toContain("route.audit && route.runId");
    expect(chat).toContain("status?.auditVisible");
  });
});

describe("cards, status, and filters", () => {
  test("status chips and the card line", () => {
    expect(auditStatus({ status: "ok", errorCode: null })).toEqual({ label: "Finished", tone: "ok" });
    expect(auditStatus({ status: "error", errorCode: "KEY_INACTIVE" })).toEqual({ label: "Key no longer valid", tone: "danger" });
    expect(auditStatus({ status: "cancelled", errorCode: null }).tone).toBe("warn");
    expect(auditStatus({ status: "running", errorCode: null }).tone).toBe("muted");
    expect(formatDuration(340)).toBe("340 ms");
    expect(formatDuration(1234)).toBe("1.2 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(null)).toBe("—");
    expect(auditCardMeta(summary())).toBe("CI (mynotes_ab12…) · API · 2 steps · 1 tool call · 1,234 tokens · 1.2 s");
    expect(auditCardMeta(summary({ key: null, via: "mcp", toolCalls: 0, steps: 1, estimated: true }))).toBe("Key removed · MCP · 1 step · 1,234 tokens (est.) · 1.2 s");
  });

  test("filter choices come from the loaded runs and keep the current choice; the export URL carries the filters", () => {
    const choices = filterChoices(null, [summary(), summary({ id: "x", agentId: "y", agentName: null, key: null })], { key: "other-key" });
    expect(choices.keys.map((option) => option.label)).toEqual(["Any key", "CI (mynotes_ab12…)", "The chosen key"]);
    expect(choices.agents.map((option) => option.label)).toEqual(["Any agent", "Runner", "(removed agent)"]);
    expect(activeFilterCount({ key: "k", status: "ok", from: null })).toBe(2);
    expect(STATUS_FILTERS.map((option) => option.value)).toEqual(["", "ok", "failed", "cancelled", "step_limit", "running"]);
    expect(auditExportUrl({ status: "failed", from: "2026-10-01", key: null })).toBe("/api/agents/audit/export?status=failed&from=2026-10-01");
    expect(auditExportUrl({}, runId)).toBe(`/api/agents/audit/export?runId=${runId}`);
  });

  test("the manager's counts read as counts", () => {
    expect(apiRunsSummary({ days: [], totals: { runs: 12, errors: 1, promptTokens: 30_000, completionTokens: 4_567 } })).toBe("12 runs, 1 failed, 34,567 tokens");
    expect(renderToStaticMarkup(<AgentApiRuns agentId={agentId} />)).toContain("Loading…");
  });
});

describe("the key builder's Agents section (D364)", () => {
  const row = (patch: Partial<GrantRow>): GrantRow => ({ key: "r", module: "agents", permission: "run", applies: "all", resourceIds: [], ...patch });

  test("Run offers all agents or chosen ones; Read always covers all", () => {
    expect(SELECTOR_KINDS.agents).toEqual({ kinds: ["agent"], one: "agent", many: "agents" });
    expect(selectorFor("agents", "run")?.many).toBe("agents");
    expect(selectorFor("agents", "read")).toBeUndefined();
    expect(rowsToGrants([row({ applies: "chosen", resourceIds: [`agent:${agentId}`] })])).toEqual({ grants: [{ module: "agents", permission: "run", resources: [{ kind: "agent", id: agentId }] }], error: null });
    expect(rowsToGrants([row({ applies: "chosen" })]).error).toBe("Choose at least one agent for Chat, or pick All agents.");
    expect(rowsToGrants([row({ permission: "read", applies: "chosen", resourceIds: [`agent:${agentId}`] })]).grants).toEqual([{ module: "agents", permission: "read" }]);
    expect(grantSummary([row({ applies: "chosen", resourceIds: [`agent:${agentId}`, `agent:${runId}`] })])).toBe("Chat: run agents on 2 agents. Never shares, never manages access or keys, and never deletes forever.");
    expect(grantSummary([row({ permission: "read" })])).toBe("Chat: read agents and chats. Never shares, never manages access or keys, and never deletes forever.");
  });

  test("members may run agents; viewers may not (member-only)", () => {
    expect(MEMBER_ONLY_MCP_SCOPES).toContain("agents:run");
    expect(permissionChoices("agents", "member", null).map((choice) => [choice.value, choice.disabled])).toEqual([["read", false], ["run", false]]);
    expect(permissionChoices("agents", "viewer", null).find((choice) => choice.value === "run")).toMatchObject({ disabled: true, reason: "Your team role reads only" });
    expect(offeredMcpPermissions("viewer").some((permission) => permission.scope === "agents:run")).toBe(false);
  });

  test("Team → Keys shows agent grants as counts (names hidden there)", () => {
    const grants = [agentId, runId].map((id) => ({ module: "agents" as const, permission: "run" as const, resource: { kind: "agent" as const, id, name: null }, active: true, inactiveReason: null }));
    expect(grantChips(grants)).toEqual([{ id: "agents:run:chosen", label: "Chat: run agents · 2 agents", active: true }]);
    expect(grantChips([{ ...grants[0]!, resource: { kind: "agent", id: agentId, name: "Runner" } }])[0]!.label).toBe("Chat: run agents · Runner");
    expect(grantChips([{ module: "agents", permission: "run", resource: null, active: true, inactiveReason: null }])[0]!.label).toBe("Chat: run agents");
  });
});

describe("Wave 42 fixes on the client (QA M3, L4, L5; AC-B verification L1)", () => {
  test("the filters ride in the URL on the list and on a run; malformed values drop; Back from a deep run keeps them", () => {
    const filtered = `/chat/audit?key=${keyId}&agent=${agentId}&status=failed&from=2026-10-01&to=2026-10-06`;
    const route = parseRoute("/chat/audit", `?key=${keyId}&agent=${agentId}&status=failed&from=2026-10-01&to=2026-10-06`);
    expect(route).toEqual({ app: "chat", chatId: null, audit: true, auditFilter: { key: keyId, agent: agentId, status: "failed", from: "2026-10-01", to: "2026-10-06" } });
    expect(formatRoute(route)).toBe(filtered);
    const run = parseRoute(`/chat/audit/${runId}`, "?status=ok");
    expect(run).toEqual({ app: "chat", chatId: null, audit: true, runId, auditFilter: { status: "ok" } });
    expect(formatRoute(run)).toBe(`/chat/audit/${runId}?status=ok`);
    expect(parseRoute("/chat/audit", "?key=nope&status=weird&from=yesterday")).toEqual({ app: "chat", chatId: null, audit: true });
    expect(auditRoute(runId, { status: "ok", key: null })).toEqual({ app: "chat", chatId: null, audit: true, runId, auditFilter: { status: "ok" } });
    expect(chatBackAction(auditRoute(runId, { status: "ok" }), 0)).toEqual({ kind: "replace", route: auditRoute(null, { status: "ok" }) });
    expect(locationUrl({ pathname: "/chat/audit", search: "?status=ok" })).toBe("/chat/audit?status=ok");
    const source = read("chat/AuditLog.tsx");
    // Applying filters pushes an entry (Back restores the previous filters); they are never local state only.
    expect(source).toContain("go(auditRoute(runId, next))");
    expect(source).not.toContain("setFilter(");
  });

  test("filter choices come from the facets, so a key or agent with no loaded run can be chosen", () => {
    const facets = { keys: [{ id: "k-idle", name: "Idle", prefix: "mynotes_zz", own: true, ownerName: null }, { id: "k-other", name: "Theirs", prefix: "mynotes_yy", own: false, ownerName: "Bo" }], agents: [{ id: "a-idle", name: "Quiet", own: true }] };
    const choices = filterChoices(facets, [summary()], {});
    expect(choices.keys.map((option) => option.label)).toEqual(["Any key", "Idle (mynotes_zz…)", "Theirs (mynotes_yy…) · Bo", "CI (mynotes_ab12…)"]);
    expect(choices.agents.map((option) => option.label)).toEqual(["Any agent", "Quiet", "Runner"]);
  });

  test("the run and the cards format dates the same way, with the year", () => {
    const source = read("chat/AuditLog.tsx");
    expect(source).toContain("<dd>{formatWhen(run.queuedAt)}</dd>");
    expect(source).toContain("{formatWhen(run.queuedAt)}{!run.full");
    expect(source).not.toContain("new Date(run.queuedAt).toLocaleString()");
    expect(formatWhen("2026-10-06T11:41:00.000Z")).toContain("2026");
    expect(formatDay("2026-11-05T00:00:00.000Z")).toContain("2026");
  });

  test("a dead link's hint reads as a sentence", () => {
    expect(LINK_DEAD_SENTENCE).toMatchObject({ revoked: "The linked key was revoked", expired: "The linked key has expired", inactive: "The linked key is inactive" });
    expect(read("chat/AgentsSettings.tsx")).not.toContain("LINK_DEAD[linkState].toLowerCase()");
  });
});

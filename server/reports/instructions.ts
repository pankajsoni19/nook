import { audit, db, now } from "../db";
import { upgradeSpec } from "../../shared/reports";
import { INSTRUCTION_LIMITS, type InstructionDocView, type InstructionKind, type InstructionsView, type ProposalView, type ReportInstruction } from "../../shared/reportsEdit";
import { REPORT_DOC_LIMITS, type DocInput } from "../../shared/reportsGenerate";
import { joinInstructionDocs, readAllDocs, releaseInstructionDocs, resolveDocInputs } from "./reportDocs";
import { NOOK_SOURCE_ID, nookSourceName } from "./nookSource";
import type { QueryResultView } from "../../shared/reportsView";
import { commentableReport, isReportOwner, ownedReport, readableReport, reportLevel } from "./access";
import { cancelLiveEdit, instructionRow, liveEdits, startEdit, type InstructionRow, type StoredProposal } from "./edit";
import { ReportError } from "./errors";
import { changedQueryKeys, diffSpecs } from "./patch";
import { queryResults, runRow } from "./refresh";
import { onReportBinned, parseSpec } from "./service";
import { commitSpec, refuseWhileRunning } from "./versions";
import { datasourceRow } from "./datasources";
import { assertRunnableNow, specHash } from "./specCheck";
import { liveGenerations } from "./generate";
import type { ReportBlock } from "../../shared/reports";
import { logger } from "../log";
import { promoteSuggestion } from "./querySuggest";

const slog = logger("reports");

/**
 * Instructions to the edit agent (plan wave 48, D450, D453): a comment on the page or a block becomes a
 * `report_instructions` row, processed strictly FIFO and one at a time per report. The queue moves when
 * an instruction is added, when one settles (proposed and then applied or rejected, failed, cancelled),
 * and on a sweep every few seconds that picks up instructions a busy run lock left waiting. While a
 * proposal waits for review the queue waits too (052's one-active index), so the next instruction is
 * made against the spec the person accepted. The owner may turn on auto-apply: a proposal from the
 * owner's own instruction is then applied as soon as it is made.
 */

type Actor = { userId: string; role: string; keyId?: string | null };
type Row = InstructionRow & { author_name: string | null; /** 065 (D527): a person's suggested query edit. */ suggested_query?: string | null };
type DocRow = { id: string; instruction_id: string; source: "nook" | "server"; server_id: string | null; ref: string; title: string | null; bytes: number; joined_doc_id: string | null; join_note: string | null; server_name: string | null };

const DOC_SELECT = `SELECT d.id, d.instruction_id, d.source, d.server_id, d.ref, d.title, d.bytes, d.joined_doc_id, d.join_note, s.name AS server_name
  FROM report_instruction_docs d LEFT JOIN agent_tool_servers s ON s.id = d.server_id`;

/** D517: the attached docs of these instructions, by instruction (never their text). */
function docsOf(where: string, ...params: string[]): Map<string, DocRow[]> {
  const out = new Map<string, DocRow[]>();
  for (const row of db.query(`${DOC_SELECT} WHERE ${where} ORDER BY d.instruction_id, d.position`).all(...params) as DocRow[]) out.set(row.instruction_id, [...(out.get(row.instruction_id) ?? []), row]);
  return out;
}

const docView = (row: DocRow): InstructionDocView => ({
  id: row.id, title: row.title, source: row.source, serverName: row.source === "nook" ? nookSourceName() : row.server_name, ref: row.ref, bytes: row.bytes, joined: row.joined_doc_id !== null, joinNote: row.join_note
});

const SELECT = "SELECT i.*, u.display_name AS author_name FROM report_instructions i LEFT JOIN users u ON u.id = i.author_id";

function view(row: Row, userId: string, owner: boolean, docs: readonly DocRow[] = []): ReportInstruction {
  // D517: the attached docs are the owner's and the author's to see (titles and links, never text).
  const seesDocs = owner || row.author_id === userId;
  return {
    id: row.id, reportId: row.report_id, blockId: row.block_id, text: row.text, status: row.status as ReportInstruction["status"], position: row.position,
    kind: (row.kind === "add" ? "add" : "change") as InstructionKind, afterBlockId: row.after_block_id ?? null,
    docs: seesDocs ? docs.map(docView) : [], docCount: docs.length,
    authorName: row.author_name, isMine: row.author_id === userId, via: row.via, runId: row.run_id,
    // The run, its live events, and its steps are the owner's (review M1a: the prompt carries the doc);
    // the agent's own summary too, which may quote it. Others see the status and the outcome.
    agentRunId: owner ? row.agent_run_id : null,
    // D527: a suggestion's summary is its author's own note to the owner.
    summary: owner || row.suggested_query ? row.summary : null, error: row.error, appliedVersion: row.applied_version, autoApplied: row.auto_applied === 1,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, decidedAt: row.decided_at,
    suggestedQuery: row.suggested_query ?? null
  };
}

const ORDER = "ORDER BY CASE i.status WHEN 'queued' THEN 1 ELSE 0 END, CASE WHEN i.status = 'queued' THEN i.position END, i.created_at, i.rowid";

/** The thread (oldest first, the queue last in its order), the caller's rights, and auto-apply. */
export function listInstructions(reportId: string, userId: string, role: string): InstructionsView {
  const report = readableReport(reportId, userId);
  const level = reportLevel(report, userId);
  const rows = db.query(`${SELECT} WHERE i.report_id = ? ${ORDER} LIMIT 200`).all(reportId) as Row[];
  const docs = docsOf("d.instruction_id IN (SELECT id FROM report_instructions WHERE report_id = ?)", reportId);
  return {
    instructions: rows.map((row) => view(row, userId, level === "owner", docs.get(row.id))),
    level,
    canComment: (level === "owner" || level === "comment") && role !== "viewer" && role !== "guest",
    canApply: level === "owner",
    autoApply: (db.query("SELECT auto_apply FROM reports WHERE id = ?").get(reportId) as { auto_apply: number }).auto_apply === 1
  };
}

export function getInstruction(reportId: string, instructionId: string, userId: string): ReportInstruction {
  const report = readableReport(reportId, userId);
  const row = db.query(`${SELECT} WHERE i.id = ? AND i.report_id = ?`).get(instructionId, reportId) as Row | null;
  if (!row) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  return view(row, userId, isReportOwner(report.id, userId), docsOf("d.instruction_id = ?", row.id).get(row.id));
}

export type InstructionInput = {
  text: string; blockId?: string | null;
  /** D516: `add` asks for a new section after `afterBlockId` (null: at the end). */
  kind?: InstructionKind; afterBlockId?: string | null;
  /** D517: docs the edit agent reads with the report's docs (at most 4), read now with the author's access. */
  docs?: DocInput[] | null;
};

/**
 * Adds an instruction at the end of the queue and kicks the queue. Attached docs are read first, as the
 * author (a Nook doc they can read, a tool server their role may use; 404 otherwise), so the author
 * can only attach what they can read; their text is kept on the instruction for the edit agent.
 */
export async function addInstruction(actor: Actor, reportId: string, input: InstructionInput, signal?: AbortSignal): Promise<ReportInstruction> {
  const { row: report } = commentableReport(reportId, actor.userId);
  if (actor.role === "viewer" || actor.role === "guest") throw new ReportError(403, "ROLE_READ_ONLY", "Your role cannot ask for changes");
  const text = input.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, INSTRUCTION_LIMITS.text);
  if (!text) throw new ReportError(400, "INVALID", "Write what to change");
  const kind: InstructionKind = input.kind === "add" ? "add" : "change";
  const blockId = kind === "add" ? null : input.blockId ?? null;
  if (kind === "add" && input.blockId) throw new ReportError(400, "INVALID", "A new section is placed with afterBlockId, not blockId");
  if (kind === "change" && input.afterBlockId) throw new ReportError(400, "INVALID", "afterBlockId is for a new section (kind add)");
  const afterBlockId = kind === "add" ? input.afterBlockId ?? null : null;
  const blocks = parseSpec(report.spec_json).blocks;
  if (blockId && !blocks.some((block) => block.id === blockId)) throw new ReportError(404, "NOT_FOUND", "That block is not in the report");
  if (afterBlockId && !blocks.some((block) => block.id === afterBlockId)) throw new ReportError(404, "NOT_FOUND", "That block is not in the report");
  const queuedNow = () => (db.query("SELECT COUNT(*) AS count FROM report_instructions WHERE report_id = ? AND status = 'queued'").get(reportId) as { count: number }).count;
  if (queuedNow() >= INSTRUCTION_LIMITS.queued) throw new ReportError(429, "LIMIT_REACHED", `At most ${INSTRUCTION_LIMITS.queued} instructions can wait at once`);
  // D517: checked (source, server, tool) before anything is read, then read as the author, three at a time.
  const docInputs = input.docs ?? [];
  if (docInputs.length > REPORT_DOC_LIMITS.instructionDocs) throw new ReportError(400, "INVALID", `Attach at most ${REPORT_DOC_LIMITS.instructionDocs} docs to one instruction`);
  const resolved = docInputs.length ? resolveDocInputs(actor.role, docInputs, REPORT_DOC_LIMITS.instructionDocs) : [];
  const read = resolved.length ? await readAllDocs(actor.userId, resolved, signal) : [];
  const id = crypto.randomUUID();
  const at = now();
  db.transaction(() => {
    if (queuedNow() >= INSTRUCTION_LIMITS.queued) throw new ReportError(429, "LIMIT_REACHED", `At most ${INSTRUCTION_LIMITS.queued} instructions can wait at once`);
    const position = ((db.query("SELECT max(position) AS position FROM report_instructions WHERE report_id = ?").get(reportId) as { position: number | null }).position ?? 0) + 1;
    db.query(`INSERT INTO report_instructions (id, report_id, block_id, text, author_id, via, key_id, status, position, kind, after_block_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`).run(id, reportId, blockId, text, actor.userId, actor.keyId ? "mcp" : "web", actor.keyId ?? null, position, kind, afterBlockId, at, at);
    resolved.forEach((doc, index) => {
      const fetched = read[index]!;
      db.query(`INSERT INTO report_instruction_docs (id, instruction_id, position, source, server_id, tool, arg, ref, title, sha256, bytes, markdown, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), id, index, doc.nook ? "nook" : "server", doc.server?.id ?? null, doc.nook ? fetched.tool : doc.tool, doc.arg,
        doc.ref.slice(0, 2048), fetched.title?.slice(0, 500) ?? null, fetched.sha256, fetched.bytes, fetched.markdown, at);
    });
  })();
  // Never the text (T380: it is the person's words, and it may quote warehouse data), nor the docs' (ids, hashes, and sizes only).
  audit(actor.userId, null, "reports.instruction.add", {
    reportId, instructionId: id, blockId, chars: text.length, ...(kind === "add" ? { kind, afterBlockId } : {}),
    ...(read.length ? { docs: read.map((doc, index) => ({ serverId: resolved[index]!.sourceId, tool: doc.tool, sha256: doc.sha256, bytes: doc.bytes })) } : {}),
    ...(actor.keyId ? { via: "mcp", keyId: actor.keyId } : {})
  });
  kick(reportId);
  return getInstruction(reportId, id, actor.userId);
}

/** Reorders the queued instructions (the owner): `ids` in their new order; others keep theirs after them. */
export function reorderInstructions(userId: string, reportId: string, ids: readonly string[]): InstructionsView {
  ownedReport(reportId, userId);
  db.transaction(() => {
    const queued = (db.query("SELECT id FROM report_instructions WHERE report_id = ? AND status = 'queued' ORDER BY position, rowid").all(reportId) as Array<{ id: string }>).map((row) => row.id);
    const wanted = ids.filter((id) => queued.includes(id));
    const order = [...new Set([...wanted, ...queued])];
    const base = (db.query("SELECT max(position) AS position FROM report_instructions WHERE report_id = ?").get(reportId) as { position: number | null }).position ?? 0;
    order.forEach((id, index) => db.query("UPDATE report_instructions SET position = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(base + 1 + index, now(), id));
  })();
  audit(userId, null, "reports.instruction.reorder", { reportId, count: ids.length });
  const role = (db.query("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | null)?.role ?? "member";
  return listInstructions(reportId, userId, role);
}

/** Cancels a queued or running instruction (its author or the owner). */
export function cancelInstruction(userId: string, reportId: string, instructionId: string, via: { keyId?: string } = {}): ReportInstruction {
  const report = readableReport(reportId, userId);
  const row = instructionRow(instructionId);
  if (!row || row.report_id !== reportId) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  if (row.author_id !== userId && !isReportOwner(report.id, userId)) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  if (row.status === "queued") {
    const at = now();
    db.query("UPDATE report_instructions SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(at, at, instructionId);
  } else if (row.status === "running") {
    if (!cancelLiveEdit(instructionId)) {
      const at = now();
      db.query("UPDATE report_instructions SET status = 'cancelled', error = 'Cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(at, at, instructionId);
      if (row.run_id) db.query("UPDATE report_runs SET status = 'failed', error = 'Cancelled', finished_at = ?, lease_until = NULL WHERE id = ? AND status = 'running'").run(at, row.run_id);
    }
  } else throw new ReportError(409, "INVALID", row.status === "proposed" ? "Reject the proposal instead" : "This instruction has already finished");
  releaseInstructionDocs(instructionId);
  audit(userId, null, "reports.instruction.cancel", { reportId, instructionId, ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) });
  kick(reportId);
  return getInstruction(reportId, instructionId, userId);
}

// ----------------------------------------------------------------------------------- proposals

function storedProposal(row: InstructionRow): StoredProposal {
  if (row.status !== "proposed" || !row.proposal_json) throw new ReportError(409, "INVALID", "This instruction has no proposal to review");
  const stored = JSON.parse(row.proposal_json) as StoredProposal;
  // A proposal stored before spec v2 holds a v1 spec: read it upgraded, as every stored spec.
  return { ...stored, spec: upgradeSpec(stored.spec) };
}

function proposedRow(reportId: string, instructionId: string): InstructionRow {
  const row = instructionRow(instructionId);
  if (!row || row.report_id !== reportId) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  return row;
}

/**
 * Why a proposal can no longer be applied (review H2, M3), or null: the spec it was made from changed
 * (by its SHA-256, so a rename does not strand it), or the report's data source is another one, was
 * changed (its allowlist among others), or is off.
 */
export function proposalStaleReason(row: Pick<InstructionRow, "base_spec_sha256" | "base_datasource_id" | "base_datasource_revision">, report: { spec_json: string; datasource_id: string | null }): string | null {
  if (row.base_spec_sha256 && row.base_spec_sha256 !== specHash(report.spec_json)) return "The report changed since this was proposed";
  if (!report.datasource_id || report.datasource_id !== row.base_datasource_id) return "The report's data source changed since this was proposed";
  let source;
  try { source = datasourceRow(report.datasource_id); } catch { return "The report's data source is gone"; }
  if (source.enabled !== 1) return "An admin turned the report's data source off";
  if (source.revision !== row.base_datasource_revision) return "The data source changed (its allowlist or settings) since this was proposed";
  return null;
}

/** Rejects a proposal that is out of date, with its reason, so the queue moves on. True when it did. */
function rejectStale(row: InstructionRow, reason: string): boolean {
  const at = now();
  const changed = db.query("UPDATE report_instructions SET status = 'rejected', error = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
    .run(reason.slice(0, 1000), at, at, row.id).changes;
  if (changed) audit(null, null, "reports.instruction.stale", { reportId: row.report_id, instructionId: row.id });
  return changed === 1;
}

/** Every proposal of a report that is out of date is rejected (the kick and the sweep run this). */
export function rejectStaleProposals(reportId: string): number {
  const report = db.query("SELECT spec_json, datasource_id FROM reports WHERE id = ?").get(reportId) as { spec_json: string; datasource_id: string | null } | null;
  if (!report) return 0;
  let count = 0;
  for (const row of db.query("SELECT * FROM report_instructions WHERE report_id = ? AND status = 'proposed'").all(reportId) as InstructionRow[]) {
    const reason = proposalStaleReason(row, report);
    if (reason && rejectStale(row, reason)) count += 1;
  }
  return count;
}

const redactedMarkdown = (block: ReportBlock | null): ReportBlock | null => block && block.type === "markdown" ? { ...block, markdown: "" } : block;

/**
 * The proposal as the review shows it: only to the owner and the instruction's author (review M1);
 * other readers get 404. The author who is not the owner sees status only (`redacted`): the edit agent
 * read the doc, which only the owner sees, so every new or changed text field (titles, labels,
 * compareLabel, markdown, section titles), any new or changed SQL, and the proposal's rows stay hidden
 * until the owner applies it. A proposal that is out of date shows no stored rows.
 */
export function proposalView(reportId: string, instructionId: string, userId: string): ProposalView {
  const report = readableReport(reportId, userId);
  const owner = isReportOwner(report.id, userId);
  const row = proposedRow(reportId, instructionId);
  if (!owner && row.author_id !== userId) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  const proposal = storedProposal(row);
  const current = parseSpec(report.spec_json);
  const stale = proposalStaleReason(row, report);
  const diff = diffSpecs(current, proposal.spec);
  // D527: a suggested query edit is its author's own SQL and rows (no agent read the doc): they see it whole.
  const suggestion = Boolean((row as Row).suggested_query);
  if (!owner && !suggestion) {
    return {
      instructionId, spec: current, blocks: [], queries: [], results: [], currentResults: [], summary: null, outOfDate: stale !== null, ...(stale ? { staleReason: stale } : {}),
      redacted: { blocks: diff.blocks.length, queries: diff.queries.length }
    };
  }
  const currentBlocks = new Map(current.blocks.map((block) => [block.id, block]));
  const hide = (block: ReportBlock) => {
    const before = currentBlocks.get(block.id);
    return !owner && block.type === "markdown" && (before?.type !== "markdown" || before.markdown !== block.markdown);
  };
  const spec = owner ? proposal.spec : { ...proposal.spec, blocks: proposal.spec.blocks.map((block) => hide(block) ? redactedMarkdown(block)! : block) };
  const blocks = diff.blocks.map((change) => {
    if (owner || !change.after || !hide(change.after)) return change;
    return { ...change, after: redactedMarkdown(change.after), textHidden: true };
  });
  const currentResults = queryResults(reportId, current);
  const byKey = new Map(currentResults.map((item) => [item.queryKey, item]));
  const results: QueryResultView[] = proposal.spec.queries.map((query) => {
    const fresh = stale ? null : proposal.results[query.key];
    if (fresh) {
      return {
        queryKey: query.key, failed: null, stale: false,
        result: { runId: row.run_id ?? "", queryKey: query.key, sql: query.sql, sentSql: fresh.sentSql, columns: fresh.columns, rows: fresh.rows, rowCount: fresh.rows.length, truncated: fresh.truncated, rowsRead: fresh.rowsRead, bytesRead: fresh.bytesRead, chQueryId: fresh.chQueryId, ms: fresh.ms, error: null, errorCode: null, createdAt: row.finished_at ?? row.updated_at }
      };
    }
    return byKey.get(query.key) ?? { queryKey: query.key, result: null, failed: null, stale: false };
  });
  return { instructionId, spec, blocks, queries: diff.queries, results, currentResults, summary: owner || suggestion ? proposal.summary : null, outOfDate: stale !== null, ...(stale ? { staleReason: stale } : {}) };
}

/**
 * Apply (the owner; also auto-apply): re-checked first (review H2, TOCTOU): the spec it was made from
 * (by hash), the data source (the same one, on, unchanged), and every query statically through the
 * guard and today's allowlist. Anything changed rejects it with its reason and answers 409
 * `STALE_PROPOSAL`: its stored rows are never published. Otherwise the proposed spec becomes a new
 * version, its touched blocks stamped `{runId, instructionId, version}`, its new results saved under
 * the edit run.
 */
export function applyProposal(userId: string, reportId: string, instructionId: string, options: { auto?: boolean; keyId?: string } = {}): ReportInstruction {
  const report = ownedReport(reportId, userId);
  const row = proposedRow(reportId, instructionId);
  const proposal = storedProposal(row);
  refuseWhileRunning(reportId);
  const stale = (reason: string): never => {
    rejectStale(row, reason);
    kick(reportId);
    throw new ReportError(409, "STALE_PROPOSAL", `${reason}; it was rejected. Ask again.`);
  };
  const reason = proposalStaleReason(row, report);
  if (reason) stale(reason);
  try {
    assertRunnableNow(datasourceRow(report.datasource_id!), proposal.spec, "STALE_PROPOSAL");
  } catch (error) {
    if (error instanceof ReportError && error.code === "STALE_PROPOSAL") stale(error.message);
    throw error;
  }
  const current = parseSpec(report.spec_json);
  const diff = diffSpecs(current, proposal.spec);
  const stamp = new Set(diff.blocks.filter((change) => change.change === "added" || change.change === "updated").map((change) => change.blockId));
  const changed = changedQueryKeys(diff);
  // The results need their run; one pruned since (wave 47 keeps 20) is recorded again, finished.
  let runId = row.run_id && runRow(row.run_id) ? row.run_id : null;
  if (!runId) {
    runId = crypto.randomUUID();
    db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, created_by, started_at, finished_at) VALUES (?, ?, 'edit', ?, 'succeeded', ?, ?, ?)")
      .run(runId, reportId, row.via === "mcp" ? "mcp" : "user", userId, row.started_at ?? now(), row.finished_at ?? now());
  }
  const results = new Map(Object.entries(proposal.results).filter(([key]) => changed.has(key)));
  const saved = db.transaction(() => {
    const live = db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string };
    if (row.base_spec_sha256 && specHash(live.spec_json) !== row.base_spec_sha256) throw new ReportError(409, "STALE_PROPOSAL", "The report changed since this was proposed");
    const committed = commitSpec({
      // D527: a person's suggested SQL is a hand edit, not the agent's.
      reportId, userId, spec: proposal.spec, source: (row as Row).suggested_query ? "manual" : "edit", instructionId, stamp, runId,
      docSnapshotId: proposal.docSnapshotId, results, note: row.summary
    });
    // D517: the docs the instruction carried join the report's docs (before it is marked applied, which clears their text).
    const docs = joinInstructionDocs(reportId, instructionId, row.author_id);
    const at = now();
    const marked = db.query("UPDATE report_instructions SET status = 'applied', applied_version = ?, auto_applied = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .run(committed.version, options.auto ? 1 : 0, userId, at, at, instructionId);
    if (marked.changes !== 1) throw new ReportError(409, "INVALID", "This proposal was already decided");
    return { ...committed, docs };
  })();
  releaseInstructionDocs(instructionId);
  audit(userId, null, "reports.instruction.apply", { reportId, instructionId, version: saved.version, auto: Boolean(options.auto), blocks: stamp.size, queries: results.size, ...(saved.docs.joined || saved.docs.skipped ? { docsJoined: saved.docs.joined, docsSkipped: saved.docs.skipped } : {}), ...(options.keyId ? { via: "mcp", keyId: options.keyId } : {}) });
  kick(reportId);
  return getInstruction(reportId, instructionId, userId);
}

/** Reject (the owner, or the instruction's author): the spec stays as it is; the queue moves on. */
export function rejectProposal(userId: string, reportId: string, instructionId: string, via: { keyId?: string } = {}): ReportInstruction {
  const report = readableReport(reportId, userId);
  const row = proposedRow(reportId, instructionId);
  if (!isReportOwner(report.id, userId) && row.author_id !== userId) throw new ReportError(404, "NOT_FOUND", "Instruction not found");
  storedProposal(row);
  const at = now();
  const marked = db.query("UPDATE report_instructions SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'").run(userId, at, at, instructionId);
  if (marked.changes !== 1) throw new ReportError(409, "INVALID", "This proposal was already decided");
  releaseInstructionDocs(instructionId);
  audit(userId, null, "reports.instruction.reject", { reportId, instructionId, ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) });
  kick(reportId);
  return getInstruction(reportId, instructionId, userId);
}

/** The owner's auto-apply switch. */
export function setAutoApply(userId: string, reportId: string, on: boolean): { autoApply: boolean } {
  ownedReport(reportId, userId);
  db.query("UPDATE reports SET auto_apply = ? WHERE id = ?").run(on ? 1 : 0, reportId);
  audit(userId, null, "reports.instruction.auto_apply", { reportId, on });
  return { autoApply: on };
}

// --------------------------------------------------------------------------------------- the queue

const kicking = new Set<string>();

/** After an instruction settles: auto-apply a proposal when the owner asked for it, then move the queue. */
function settled(row: InstructionRow) {
  if (row.status === "proposed") {
    const report = db.query("SELECT auto_apply FROM reports WHERE id = ? AND deleted_at IS NULL").get(row.report_id) as { auto_apply: number } | null;
    // Only an owner's own instructions apply themselves (D453; phase 2: any owner, applied as them): a commenter's always waits for review.
    if (report?.auto_apply === 1 && row.author_id && isReportOwner(row.report_id, row.author_id)) {
      try {
        applyProposal(row.author_id, row.report_id, row.id, { auto: true, keyId: row.key_id ?? undefined });
        return;
      } catch (error) {
        // Left proposed for the owner to look at (a refresh started meanwhile, or the report changed).
        audit(row.author_id, null, "reports.instruction.auto_apply_failed", { reportId: row.report_id, instructionId: row.id, code: error instanceof ReportError ? error.code : "INTERNAL" });
      }
    }
    return;
  }
  kick(row.report_id);
}

/**
 * Moves a report's queue: when nothing runs or waits for review, the head instruction starts. A run
 * lock held by a refresh or generation leaves it queued for the sweep.
 */
export function kick(reportId: string) {
  if (kicking.has(reportId)) return;
  kicking.add(reportId);
  try {
    for (let guard = 0; guard < INSTRUCTION_LIMITS.queued + 1; guard += 1) {
      const live = db.query("SELECT 1 FROM reports WHERE id = ? AND deleted_at IS NULL").get(reportId);
      if (!live) return;
      // A proposal that is out of date never blocks the queue (review M3).
      rejectStaleProposals(reportId);
      if (db.query("SELECT 1 FROM report_instructions WHERE report_id = ? AND status IN ('running','proposed')").get(reportId)) return;
      const head = db.query("SELECT id, suggested_query FROM report_instructions WHERE report_id = ? AND status = 'queued' ORDER BY position, rowid LIMIT 1").get(reportId) as { id: string; suggested_query: string | null } | null;
      if (!head) return;
      // D527: a suggested query edit holds its proposal already: it becomes proposed (or fails) with no agent run.
      if (head.suggested_query) { promoteSuggestion(instructionRow(head.id)!); continue; }
      if (startEdit(head.id, { settled })) return;
      // Not started: still queued (the lock is busy: wait), or failed at once (try the next one).
      if (instructionRow(head.id)?.status === "queued") return;
    }
  } finally {
    kicking.delete(reportId);
  }
}

/**
 * The sweep (every few seconds): instructions left `running` without a live edit (their run was
 * abandoned) fail, and every report with a queued head and nothing active is kicked.
 */
export function sweepInstructions(): number {
  const liveIds = new Set(liveEdits().map((entry) => entry.instructionId));
  const stuck = db.query(`SELECT i.id, i.run_id FROM report_instructions i LEFT JOIN report_runs r ON r.id = i.run_id
    WHERE i.status = 'running' AND (r.id IS NULL OR r.status <> 'running')`).all() as Array<{ id: string; run_id: string | null }>;
  const at = now();
  for (const row of stuck) {
    if (liveIds.has(row.id)) continue;
    db.query("UPDATE report_instructions SET status = 'failed', error = 'The edit stopped before it finished', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(at, at, row.id);
  }
  for (const { report_id } of db.query("SELECT DISTINCT report_id FROM report_instructions WHERE status = 'proposed'").all() as Array<{ report_id: string }>) {
    try { rejectStaleProposals(report_id); } catch (error) { slog.error("Reports: a stale proposal check failed", error); }
  }
  const waiting = db.query(`SELECT DISTINCT i.report_id FROM report_instructions i JOIN reports r ON r.id = i.report_id AND r.deleted_at IS NULL
    WHERE i.status = 'queued' AND NOT EXISTS (SELECT 1 FROM report_instructions a WHERE a.report_id = i.report_id AND a.status IN ('running','proposed'))`).all() as Array<{ report_id: string }>;
  for (const { report_id } of waiting) {
    try { kick(report_id); } catch (error) { slog.error("Reports: an instruction queue could not move", error); }
  }
  try { releaseInstructionDocs(); } catch (error) { slog.error("Reports: instruction docs could not be released", error); }
  return waiting.length;
}

/** Boot: instructions a stopped server left running fail (their runs are abandoned by wave 47's boot pass). */
export function failInstructionsAtBoot(): number {
  const at = now();
  return db.query("UPDATE report_instructions SET status = 'failed', error = 'The server restarted during the edit', finished_at = ?, updated_at = ? WHERE status = 'running'").run(at, at).changes;
}

/**
 * Moving a report to the Bin stops its work (review L4): queued instructions are cancelled, a running
 * edit and a running generation are stopped.
 */
onReportBinned((reportId) => {
  const at = now();
  db.query("UPDATE report_instructions SET status = 'cancelled', error = 'The report was moved to the Bin', finished_at = ?, updated_at = ? WHERE report_id = ? AND status = 'queued'").run(at, at, reportId);
  for (const entry of liveEdits()) if (entry.reportId === reportId) cancelLiveEdit(entry.instructionId);
  for (const entry of liveGenerations()) if (entry.reportId === reportId) entry.controller.abort("stop");
});

export const INSTRUCTION_SWEEP_MS = 5_000;
let timer: ReturnType<typeof setInterval> | null = null;
export function startInstructionSweep() {
  if (timer) return;
  timer = setInterval(() => {
    try { sweepInstructions(); } catch (error) { slog.error("Reports: the instruction sweep failed", error); }
  }, INSTRUCTION_SWEEP_MS);
  (timer as { unref?: () => void }).unref?.();
}


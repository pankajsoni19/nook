import { api } from "../api";
import type { DocInput } from "../../shared/reportsGenerate";
import type { FilterColumnsView, FilterKind, FilterPreview, InstructionKind, InstructionsView, PatchOp, ProposalView, ReportInstruction, OwnerReview, OwnerReviewScope, ReportOwners, ReportSharing, SharingInput } from "../../shared/reportsEdit";
import type { VersionDiff, VersionHistoryItem, VersionSnapshot } from "../../shared/reportVersions";
import type { QueryEditPreview } from "../../shared/reportsQueryEdit";
import type { ParamValues } from "../../shared/reportParams";

/** The Wave 48 report routes (server/reports/editRoutes.ts): instructions, proposals, versions, manual edits, sharing. */

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const listInstructions = (id: string) => api<InstructionsView>(`/reports/${id}/instructions`);
/** D516, D517: `extra` asks for a new section (kind add, after a block or at the end) and attaches docs. */
export const addInstruction = (id: string, text: string, blockId: string | null, extra: { kind?: InstructionKind; afterBlockId?: string | null; docs?: DocInput[] } = {}) =>
  api<{ instruction: ReportInstruction }>(`/reports/${id}/instructions`, json("POST", { text, blockId, ...(extra.kind === "add" ? { kind: "add", afterBlockId: extra.afterBlockId ?? null, blockId: null } : {}), ...(extra.docs?.length ? { docs: extra.docs } : {}) }));
export const reorderInstructions = (id: string, ids: string[]) => api<InstructionsView>(`/reports/${id}/instructions/reorder`, json("POST", { ids }));
export const cancelInstruction = (id: string, instructionId: string) => api<{ instruction: ReportInstruction }>(`/reports/${id}/instructions/${instructionId}/cancel`, json("POST", {}));
export const getProposal = (id: string, instructionId: string) => api<{ proposal: ProposalView }>(`/reports/${id}/instructions/${instructionId}/proposal`);
export const applyProposal = (id: string, instructionId: string) => api<{ instruction: ReportInstruction }>(`/reports/${id}/instructions/${instructionId}/apply`, json("POST", {}));
export const rejectProposal = (id: string, instructionId: string) => api<{ instruction: ReportInstruction }>(`/reports/${id}/instructions/${instructionId}/reject`, json("POST", {}));
export const setAutoApply = (id: string, autoApply: boolean) => api<{ autoApply: boolean }>(`/reports/${id}/auto-apply`, json("PUT", { autoApply }));

export const listVersions = (id: string) => api<{ versions: VersionHistoryItem[] }>(`/reports/${id}/versions`);
/** The owner: one version's spec and its stored results (the read-only view). */
export const getVersion = (id: string, version: number) => api<VersionSnapshot>(`/reports/${id}/versions/${version}`);
/** The owner: what changed from `from` (default: the version before) to `to`. */
export const getVersionDiff = (id: string, to: number, from?: number | null) => api<{ diff: VersionDiff }>(`/reports/${id}/version-diff?to=${to}${from ? `&from=${from}` : ""}`);
/** The owner: "Run with today's data" on a version (a run in Runs; the report is unchanged). */
export const previewVersion = (id: string, version: number) => api<{ runId: string; status: string; results: VersionSnapshot["results"] }>(`/reports/${id}/versions/${version}/preview`, json("POST", {}));
export const restoreVersion = (id: string, version: number) => api<{ version: number; refreshRunId: string | null }>(`/reports/${id}/versions/${version}/restore`, json("POST", {}));

export const editSpec = (id: string, ops: PatchOp[], expectedRevision: number) => api<{ version: number; revision: number; warnings?: string[] }>(`/reports/${id}/spec/edit`, json("POST", { ops, expectedRevision }));
/** Lane EDIT (D528): Run preview of a saved query's new SQL with the parameter values on screen (the owner and the comment level). */
export const previewQuery = (id: string, queryKey: string, sql: string, values: ParamValues | null, signal?: AbortSignal) =>
  api<{ preview: QueryEditPreview }>(`/reports/${id}/queries/${queryKey}/preview`, { ...json("POST", { sql, values }), signal });
/** D527: the comment level suggests the new SQL to the owner (a proposal in Changes). */
export const suggestQuery = (id: string, queryKey: string, input: { sql: string; note: string | null; blockId: string | null; expectedRevision: number }) =>
  api<{ instruction: ReportInstruction; warnings?: string[] }>(`/reports/${id}/queries/${queryKey}/suggest`, json("POST", input));

/** D534 (the owner): Add filter's columns, the options a column would give, the request, and Remove filter. */
export const filterColumns = (id: string) => api<FilterColumnsView>(`/reports/${id}/filters/columns`);
export const previewFilter = (id: string, table: string, column: string, narrowBy: readonly string[] = [], kind?: FilterKind) => api<{ preview: FilterPreview }>(`/reports/${id}/filters/preview`, json("POST", { table, column, ...(narrowBy.length ? { narrowBy } : {}), ...(kind && kind !== "multi_select" ? { kind } : {}) }));
export const requestFilter = (id: string, input: { table: string; column: string; label: string; narrowBy?: string[]; kind?: FilterKind; exclude?: boolean; preset?: string }) => api<{ instruction: ReportInstruction }>(`/reports/${id}/filters`, json("POST", input));
export const requestFilterRemoval = (id: string, paramId: string) => api<{ instruction: ReportInstruction }>(`/reports/${id}/filters/${paramId}`, { method: "DELETE", body: "{}" });
export const proposeZoneFix = (id: string) => api<{ instruction: ReportInstruction | null }>(`/reports/${id}/filters/zone-fix`, json("POST", {}));

export const getSharing = (id: string) => api<{ sharing: ReportSharing }>(`/reports/${id}/sharing`);
export const saveSharing = (id: string, input: SharingInput) => api<{ sharing: ReportSharing }>(`/reports/${id}/sharing`, json("PUT", input));

/** Whether any instruction is still moving (queued or running): the panel polls while it is. */
export const threadMoving = (instructions: readonly Pick<ReportInstruction, "status">[]) => instructions.some((item) => item.status === "queued" || item.status === "running");

/** Phase 2 (D482): a report's owners; owners and admins add and remove them (never the last one). */
export const getOwners = (id: string) => api<ReportOwners>(`/reports/${id}/owners`);
export const addOwner = (id: string, userId: string) => api<ReportOwners>(`/reports/${id}/owners`, json("POST", { userId }));
export const removeOwner = (id: string, userId: string) => api<ReportOwners>(`/reports/${id}/owners/${userId}`, { method: "DELETE", body: "{}" });
/** D500: Settings → Report owners (admins): reports nobody can manage, or the admin cannot open; D505: `cursor` for the next page. */
export const ownerReview = (scope: OwnerReviewScope, q: string, cursor?: string | null) =>
  api<OwnerReview>(`/reports/admin/owner-review?${new URLSearchParams({ scope, ...(q.trim() ? { q: q.trim() } : {}), ...(cursor ? { cursor } : {}) })}`);

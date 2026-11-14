import { api, ApiError } from "../api";
import type {
  CrmBoard, CrmBook, CrmCompany, CrmCompanyDetail, CrmContact, CrmContactDetail, CrmDeal, CrmDealDetail, CrmEntity, CrmFieldDef, CrmFilter, CrmFollowup, CrmInteraction, CrmList,
  CrmPipeline, CrmSort, CrmView, CrmViewConfig, ImportPreview, ImportResult, InteractionKind
} from "../../shared/crm";
import type { ItemActivityEntry } from "../../shared/itemActivity";
import type { WorkLinkView } from "../../shared/workRefs";
import type { DatasetResult, StructuredQuery } from "../../shared/datasets";

/** The Contacts endpoints (server/crm/routes.ts, §D.5 HTTP). */

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? { body: "{}" } : { body: JSON.stringify(body) }) });
const enc = encodeURIComponent;

export type Page<T> = { items: T[]; nextCursor: string | null };
export type ListParams = { book?: string | null; q?: string; list?: string | null; filters?: CrmFilter[]; sort?: CrmSort | null; cursor?: string | null; limit?: number };
function listQuery(params: ListParams & Record<string, unknown>) {
  const query = new URLSearchParams();
  if (params.book) query.set("book", params.book);
  if (params.q?.trim()) query.set("q", params.q.trim());
  if (params.list) query.set("list", params.list);
  if (params.filters?.length) query.set("filter", JSON.stringify(params.filters));
  if (params.sort) query.set("sort", JSON.stringify(params.sort));
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));
  for (const name of ["pipeline", "stage", "owner", "status", "company"]) if (typeof params[name] === "string" && params[name]) query.set(name, params[name] as string);
  return query.toString();
}

export const errorMessage = (reason: unknown, fallback: string) => reason instanceof ApiError ? reason.message : fallback;
export const errorCode = (reason: unknown) => reason instanceof ApiError ? (reason.payload as { code?: string } | undefined)?.code ?? null : null;
export const errorPayload = <T>(reason: unknown) => reason instanceof ApiError ? reason.payload as T : undefined;

export const listBooks = () => api<{ books: CrmBook[] }>("/crm/books");
export const createBook = (input: { name: string; visibility?: string }) => api<{ book: CrmBook }>("/crm/books", json("POST", input));
export const getBook = (id: string) => api<{ book: CrmBook }>(`/crm/books/${enc(id)}`);
export const updateBook = (id: string, input: { name?: string; color?: string | null; settings?: Partial<CrmBook["settings"]> }) => api<{ book: CrmBook }>(`/crm/books/${enc(id)}`, json("PATCH", input));
export const binBook = (id: string) => api<{ binned: boolean }>(`/crm/books/${enc(id)}`, { method: "DELETE" });
export const saveFields = (bookId: string, entity: CrmEntity, fields: Array<Partial<CrmFieldDef>>) => api<{ book: CrmBook }>(`/crm/books/${enc(bookId)}/fields/${entity}`, json("PUT", { fields }));

export const listContacts = (params: ListParams) => api<Page<CrmContact>>(`/crm/contacts?${listQuery(params)}`);
export const getContact = (id: string) => api<{ contact: CrmContactDetail }>(`/crm/contacts/${enc(id)}`);
export const createContact = (input: Record<string, unknown>) => api<{ contact: CrmContact }>("/crm/contacts", json("POST", input));
export const updateContact = (id: string, patch: Record<string, unknown>) => api<{ contact: CrmContact }>(`/crm/contacts/${enc(id)}`, json("PATCH", patch));
export const binContact = (id: string) => api<{ binned: boolean }>(`/crm/contacts/${enc(id)}`, { method: "DELETE" });
export const mergeContact = (id: string, intoId: string) => api<{ contact: CrmContact }>(`/crm/contacts/${enc(id)}/merge`, json("POST", { intoId }));
export const contactDuplicates = (book: string) => api<{ pairs: Array<{ a: CrmContact; b: CrmContact; reason: string }> }>(`/crm/contacts/duplicates?book=${enc(book)}`);

export const listCompanies = (params: ListParams) => api<Page<CrmCompany>>(`/crm/companies?${listQuery(params)}`);
export const getCompany = (id: string) => api<{ company: CrmCompanyDetail }>(`/crm/companies/${enc(id)}`);
export const createCompany = (input: Record<string, unknown>) => api<{ company: CrmCompany }>("/crm/companies", json("POST", input));
export const updateCompany = (id: string, patch: Record<string, unknown>) => api<{ company: CrmCompany }>(`/crm/companies/${enc(id)}`, json("PATCH", patch));
export const binCompany = (id: string) => api<{ binned: boolean }>(`/crm/companies/${enc(id)}`, { method: "DELETE" });
export const mergeCompany = (id: string, intoId: string) => api<{ company: CrmCompany }>(`/crm/companies/${enc(id)}/merge`, json("POST", { intoId }));

export const listPipelines = (book: string) => api<{ pipelines: CrmPipeline[] }>(`/crm/pipelines?book=${enc(book)}`);
export const createPipeline = (input: { bookId: string; name: string; currency?: string | null }) => api<{ pipeline: CrmPipeline }>("/crm/pipelines", json("POST", input));
export const updatePipeline = (id: string, input: { name?: string; currency?: string | null; stages?: unknown[]; moveDealsTo?: string | null }) => api<{ pipeline: CrmPipeline }>(`/crm/pipelines/${enc(id)}`, json("PATCH", input));
export const deletePipeline = (id: string) => api<{ deleted: boolean }>(`/crm/pipelines/${enc(id)}`, { method: "DELETE" });
export const pipelineBoard = (id: string, params: { owner?: string | null; q?: string } = {}) => {
  const query = new URLSearchParams();
  if (params.owner) query.set("owner", params.owner);
  if (params.q?.trim()) query.set("q", params.q.trim());
  return api<{ board: CrmBoard }>(`/crm/pipelines/${enc(id)}/board?${query}`);
};
export const listDeals = (params: ListParams & { pipeline?: string | null; stage?: string | null; owner?: string | null; status?: string | null; company?: string | null }) => api<Page<CrmDeal>>(`/crm/deals?${listQuery(params as ListParams & Record<string, unknown>)}`);
export const getDeal = (id: string) => api<{ deal: CrmDealDetail }>(`/crm/deals/${enc(id)}`);
export const createDeal = (input: Record<string, unknown>) => api<{ deal: CrmDeal }>("/crm/deals", json("POST", input));
export const updateDeal = (id: string, patch: Record<string, unknown>) => api<{ deal: CrmDeal }>(`/crm/deals/${enc(id)}`, json("PATCH", patch));
export const binDeal = (id: string) => api<{ binned: boolean }>(`/crm/deals/${enc(id)}`, { method: "DELETE" });

export type CrmTimeline = { interactions: CrmInteraction[]; nextCursor: string | null; activity: ItemActivityEntry[]; links: WorkLinkView[]; followups: CrmFollowup[] };
export const recordTimeline = (kind: CrmEntity, id: string, cursor?: string | null) => api<CrmTimeline>(`/crm/records/${kind}/${enc(id)}/timeline${cursor ? `?cursor=${enc(cursor)}` : ""}`);
export const logInteraction = (input: { kind: InteractionKind; title?: string; body?: string; occurredAt?: string; durationS?: number | null; direction?: string; subjects: Array<{ kind: CrmEntity; id: string }> }) =>
  api<{ interaction: CrmInteraction }>("/crm/interactions", json("POST", input));
export const updateInteraction = (id: string, patch: Record<string, unknown>) => api<{ interaction: CrmInteraction }>(`/crm/interactions/${enc(id)}`, json("PATCH", patch));
export const deleteInteraction = (id: string) => api<{ undoTicket: string }>(`/crm/interactions/${enc(id)}`, { method: "DELETE" });
export const undo = (ticket: string) => api<unknown>(`/undo/${enc(ticket)}`, json("POST"));

export const listFollowups = (subject?: { kind: CrmEntity; id: string }) => api<{ followups: CrmFollowup[] }>(`/crm/followups${subject ? `?subject=${subject.kind}:${enc(subject.id)}` : ""}`);
export const createFollowup = (input: { subject: { kind: CrmEntity; id: string }; dueAt: string; note?: string }) => api<{ followup: CrmFollowup }>("/crm/followups", json("POST", input));
export const updateFollowup = (id: string, patch: { done?: boolean; dueAt?: string; note?: string }) => api<{ followup: CrmFollowup }>(`/crm/followups/${enc(id)}`, json("PATCH", patch));
export const createTask = (input: { subject: { kind: CrmEntity; id: string }; boardId: string; columnId: string; title: string; dueOn?: string | null }) => api<{ cardId: string }>("/crm/tasks", json("POST", input));

export const listLists = (book?: string | null, entity?: CrmEntity | null) => api<{ lists: CrmList[] }>(`/crm/lists?${new URLSearchParams({ ...(book ? { book } : {}), ...(entity ? { entity } : {}) })}`);
export const createList = (input: { bookId: string; name: string; entity: CrmEntity }) => api<{ list: CrmList }>("/crm/lists", json("POST", input));
export const getList = (id: string) => api<{ list: CrmList }>(`/crm/lists/${enc(id)}`);
export const renameList = (id: string, name: string) => api<{ list: CrmList }>(`/crm/lists/${enc(id)}`, json("PATCH", { name }));
export const deleteList = (id: string) => api<{ deleted: boolean }>(`/crm/lists/${enc(id)}`, { method: "DELETE" });
export const changeListMembers = (id: string, change: { add?: string[]; remove?: string[] }) => api<{ list: CrmList }>(`/crm/lists/${enc(id)}/members`, json("POST", change));

export const listViews = (book: string, entity: CrmEntity) => api<{ views: CrmView[] }>(`/crm/views?book=${enc(book)}&entity=${entity}`);
export const createView = (input: { bookId: string; entity: CrmEntity; name: string; config: CrmViewConfig; shared?: boolean }) => api<{ view: CrmView }>("/crm/views", json("POST", input));
export const updateView = (id: string, input: { name?: string; config?: CrmViewConfig }) => api<{ view: CrmView }>(`/crm/views/${enc(id)}`, json("PATCH", input));
export const deleteView = (id: string) => api<{ deleted: boolean }>(`/crm/views/${enc(id)}`, { method: "DELETE" });

export const previewImport = (input: { bookId: string; entity: "contact" | "company"; csv: string }) => api<{ preview: ImportPreview }>("/crm/import", json("POST", input));
export const remapImport = (jobId: string, mapping: Array<string | null>) => api<{ preview: ImportPreview }>(`/crm/import/${enc(jobId)}/preview`, json("POST", { mapping }));
export const commitImport = (jobId: string, input: { duplicates: "update" | "skip"; mapping?: Array<string | null> }) => api<{ result: ImportResult }>(`/crm/import/${enc(jobId)}/commit`, json("POST", input));
export const undoImport = (jobId: string) => api<{ deleted: number; restored: number }>(`/crm/import/${enc(jobId)}/undo`, json("POST"));
export const exportUrl = (book: string, entity: CrmEntity, params: { q?: string; list?: string | null; filters?: CrmFilter[] } = {}) => `/api/crm/export.csv?${listQuery({ book, ...params })}&entity=${entity}`;
export const vcardUrl = (id: string) => `/api/crm/contacts/${enc(id)}/vcard`;

export const queryDataset = (query: StructuredQuery) => api<DatasetResult>("/datasets/query", json("POST", query));

/** Board and column picker for "Create task": readable boards and their columns. */
export const listBoardsForTask = () => api<{ boards: Array<{ id: string; name: string; columns?: Array<{ id: string; name: string }> }> }>("/tasks/boards");
export const boardColumns = (boardId: string) => api<{ columns: Array<{ id: string; name: string }> }>(`/tasks/boards/${enc(boardId)}/columns`);

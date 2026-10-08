import { api } from "../api";
import { isPausedSource, type KnowledgeCandidate, type KnowledgeChunkPage, type KnowledgeDetail, type KnowledgeEmbeddingChoice, type KnowledgeHit, type KnowledgeSource, type KnowledgeSummary, type SourceStatus } from "../../shared/knowledge";

/** The knowledge base API (docs/plan/API_CONTRACTS.md § Knowledge bases; Wave 44 AC-E). */

export const listKnowledge = () => api<{ knowledgeBases: KnowledgeSummary[] }>("/knowledge");
export const getKnowledge = (id: string) => api<{ knowledgeBase: KnowledgeDetail }>(`/knowledge/${id}`);
export const createKnowledge = (input: { name: string; description?: string }) => api<{ knowledgeBase: KnowledgeDetail }>("/knowledge", { method: "POST", body: JSON.stringify(input) });
export const updateKnowledge = (id: string, input: { name?: string; description?: string }) => api<{ knowledgeBase: KnowledgeDetail }>(`/knowledge/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteKnowledge = (id: string) => api<{ ok: true }>(`/knowledge/${id}`, { method: "DELETE", body: "{}" });
export type SourceInput = { kind: "note"; noteId: string } | { kind: "document"; documentId: string } | { kind: "text"; title: string; text: string };
export const addSource = (id: string, input: SourceInput) => api<{ source: KnowledgeSource }>(`/knowledge/${id}/sources`, { method: "POST", body: JSON.stringify(input) });
export const removeSource = (id: string, sourceId: string) => api<{ ok: true }>(`/knowledge/${id}/sources/${sourceId}`, { method: "DELETE", body: "{}" });
export const reindexKnowledge = (id: string) => api<{ ok: true; sources: number }>(`/knowledge/${id}/reindex`, { method: "POST", body: "{}" });
export const sourceCandidates = (id: string, kind: "note" | "document", q: string) => api<{ candidates: KnowledgeCandidate[] }>(`/knowledge/${id}/candidates?kind=${kind}&q=${encodeURIComponent(q)}`);
/** 2026-10-08: Change embedding model (owner): the providers to choose from, and the change. */
export const embeddingOptions = (id: string) => api<{ current: { providerId: string | null; model: string; dims: number }; providers: KnowledgeEmbeddingChoice[] }>(`/knowledge/${id}/embedding-options`);
export const changeEmbeddingModel = (id: string, input: { providerId: string; model: string; dims?: number | null }) => api<{ ok: true; sources: number; knowledgeBase: KnowledgeDetail }>(`/knowledge/${id}/model`, { method: "POST", body: JSON.stringify(input) });
/** 2026-10-08: a page of a source's chunk previews (the owner and managers who can read it). */
export const sourceChunks = (id: string, sourceId: string, offset: number, limit = 20) => api<KnowledgeChunkPage>(`/knowledge/${id}/sources/${sourceId}/chunks?offset=${offset}&limit=${limit}`);
export const searchKnowledge = (id: string, query: string, k?: number) => api<{ hits: KnowledgeHit[]; mode: "hybrid" | "keyword"; notice?: string }>(`/knowledge/${id}/search`, { method: "POST", body: JSON.stringify({ query, ...(k ? { k } : {}) }) });

/** A source's state as its row says it (plan §13.4). */
export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = { pending: "Waiting", indexing: "Indexing", ready: "Ready", error: "Error", unavailable: "Unavailable" };

/** Whether the page should keep polling: something is still waiting or being indexed. */
export const stillIndexing = (sources: readonly Pick<KnowledgeSource, "status">[]) => sources.some((source) => source.status === "pending" || source.status === "indexing");

/**
 * How often the base's page checks again (QA LOW-3): every 1.5 s while something is being indexed or
 * waits its turn, every 60 s while everything waiting is paused on the daily budget (it resumes after
 * midnight UTC, or when an admin raises the budget), and not at all when nothing waits.
 */
export function pollInterval(sources: readonly Pick<KnowledgeSource, "status" | "error">[]): number | null {
  const waiting = sources.filter((source) => source.status === "pending" || source.status === "indexing");
  if (waiting.length === 0) return null;
  return waiting.every((source) => isPausedSource(source)) ? 60_000 : 1_500;
}

/** A source's badge: "Paused" for one waiting on the budget, else its state. */
export const sourceStatusLabel = (source: Pick<KnowledgeSource, "status" | "error">) => isPausedSource(source) ? "Paused" : SOURCE_STATUS_LABELS[source.status];

/** "Note", "File", or "Pasted text", and what to call a source whose title the reader may not see. */
export function sourceLabel(source: Pick<KnowledgeSource, "kind" | "title" | "titleHidden">) {
  const kind = source.kind === "note" ? "Note" : source.kind === "document" ? "File" : "Pasted text";
  const title = source.titleHidden ? (source.kind === "note" ? "A note you can't open" : "A file you can't open") : source.title ?? "Untitled";
  return { kind, title };
}

/**
 * The list line of a base: "3 sources · 42 chunks · Ready". Sources in error or unavailable are named
 * instead of Ready (QA LOW-4): "1 source has an error · 2 sources unavailable".
 */
export function knowledgeLine(kb: Pick<KnowledgeSummary, "sourceCount" | "chunkCount" | "status" | "counts">) {
  const errors = kb.counts.error;
  const unavailable = kb.counts.unavailable;
  const problems = [
    errors > 0 ? `${errors} ${errors === 1 ? "source has an error" : "sources have errors"}` : null,
    unavailable > 0 ? `${unavailable} ${unavailable === 1 ? "source" : "sources"} unavailable` : null
  ].filter(Boolean);
  const errorLine = problems.join(" · ");
  const waiting = kb.counts.pending + kb.counts.indexing;
  // Everything waiting is paused on the daily budget (QA LOW-3): say so rather than "Indexing".
  const paused = waiting > 0 && kb.counts.indexing === 0 && (kb.counts.paused ?? 0) === kb.counts.pending;
  const status = kb.status === "indexing" ? `${paused ? "Paused" : "Indexing"} ${waiting}${errorLine ? ` · ${errorLine}` : ""}` : errorLine ? errorLine : kb.status === "ready" ? "Ready" : "Empty";
  return `${kb.sourceCount} ${kb.sourceCount === 1 ? "source" : "sources"} · ${kb.chunkCount.toLocaleString()} ${kb.chunkCount === 1 ? "chunk" : "chunks"} · ${status}`;
}

/** Whether every source a base has waiting is paused on the daily budget (the list's badge says Paused). */
export const knowledgePaused = (kb: Pick<KnowledgeSummary, "counts">) => kb.counts.pending > 0 && kb.counts.indexing === 0 && (kb.counts.paused ?? 0) === kb.counts.pending;

/** The hit's source as Try it shows it: the title only when the reader can open it. */
export function hitSource(hit: Pick<KnowledgeHit, "source">) {
  if (hit.source.kind === "text") return `Pasted text · ${hit.source.title ?? "Untitled"}`;
  if (hit.source.title) return `${hit.source.kind === "note" ? "Note" : "File"} · ${hit.source.title}`;
  return hit.source.kind === "note" ? "A note you can't open" : "A file you can't open";
}

/** "Chunks 1–20 of 57" for a source's preview. */
export function previewRange(page: { offset: number; total: number }, shown: number) {
  if (page.total === 0) return "No chunks";
  return `Chunks 1–${Math.min(page.total, shown)} of ${page.total.toLocaleString()}`;
}

import { useEffect, useId, useState } from "react";
import { Combobox } from "../ui/Combobox";
import { EMBEDDING_MODEL_ID, KNOWLEDGE_POLICY_BOUNDS, type ProviderKnowledgePolicy } from "../../shared/agents";
import { providerModels } from "./chatApi";

/**
 * The provider editor's "Knowledge bases" group (2026-10-08, admins): whether knowledge bases may use
 * the provider, which embedding models (Any, or a list: chips with suggestions from the provider's
 * model list and free text, D91), and the largest size in dimensions (empty: 3,072). Bases already
 * over a newer limit keep working (grandfathered); their page says so.
 */

export type PolicyDraft = { enabled: boolean; anyModel: boolean; models: string[]; maxDims: string };

export const policyDraft = (policy: ProviderKnowledgePolicy | undefined): PolicyDraft => ({
  enabled: policy?.enabled ?? true, anyModel: !policy?.models, models: policy?.models ? [...policy.models] : [], maxDims: policy?.maxDims ? String(policy.maxDims) : ""
});

/** The draft as the API takes it, or the reason it cannot be saved. */
export function policyFromDraft(draft: PolicyDraft): { policy: ProviderKnowledgePolicy } | { error: string } {
  if (!draft.anyModel && draft.models.length === 0) return { error: "Add at least one embedding model, or choose Any model." };
  const text = draft.maxDims.trim();
  const maxDims = text === "" ? null : Number(text);
  if (maxDims !== null && (!Number.isInteger(maxDims) || maxDims < KNOWLEDGE_POLICY_BOUNDS.minDims || maxDims > KNOWLEDGE_POLICY_BOUNDS.maxDims)) {
    return { error: `The largest size must be a whole number from ${KNOWLEDGE_POLICY_BOUNDS.minDims} to ${KNOWLEDGE_POLICY_BOUNDS.maxDims.toLocaleString("en-US")}, or empty.` };
  }
  return { policy: { enabled: draft.enabled, models: draft.anyModel ? null : draft.models, maxDims } };
}

/** Suggestions from a provider's model list: its embedding models when they can be told apart by name, else every model. */
export function embeddingSuggestions(models: readonly string[]): string[] {
  const embedding = models.filter((model) => /embed/i.test(model));
  return (embedding.length ? embedding : [...models]).filter((model) => model.length <= KNOWLEDGE_POLICY_BOUNDS.modelName && EMBEDDING_MODEL_ID.test(model)).slice(0, 100);
}

/** The provider card's one line about its policy. */
export function policySummary(policy: ProviderKnowledgePolicy): string {
  if (!policy.enabled) return "Not allowed";
  const models = policy.models ? `${policy.models.length} ${policy.models.length === 1 ? "model" : "models"}` : "Any model";
  return `${models}, up to ${(policy.maxDims ?? KNOWLEDGE_POLICY_BOUNDS.maxDims).toLocaleString("en-US")} dimensions`;
}

export function ProviderKnowledgeFields({ providerId, draft, onChange, disabled }: { providerId: string | null; draft: PolicyDraft; onChange: (draft: PolicyDraft) => void; disabled?: boolean }) {
  const ids = { heading: useId(), models: useId(), dims: useId() };
  const [suggested, setSuggested] = useState<string[]>([]);
  // The provider's model list (the server keeps it ten minutes); none for a provider not saved yet, or when it cannot be reached.
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    providerModels(providerId).then((result) => { if (!cancelled) setSuggested(embeddingSuggestions(result.models)); }, () => undefined);
    return () => { cancelled = true; };
  }, [providerId]);
  const options = [...new Set([...suggested, ...draft.models])].map((model) => ({ value: model, label: model }));
  const set = (patch: Partial<PolicyDraft>) => onChange({ ...draft, ...patch });
  return <div className="ai-knowledge-policy" role="group" aria-labelledby={ids.heading}>
    <span className="ai-label" id={ids.heading}>Knowledge bases</span>
    <label className="ai-check"><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={(event) => set({ enabled: event.target.checked })} />Knowledge bases may use this provider</label>
    {draft.enabled && <>
      <span className="ai-sublabel" id={ids.models}>Allowed embedding models</span>
      <div className="ai-segments" role="group" aria-labelledby={ids.models}>
        <button type="button" className={`ai-segment${draft.anyModel ? " active" : ""}`} aria-pressed={draft.anyModel} disabled={disabled} onClick={() => set({ anyModel: true })}>Any model</button>
        <button type="button" className={`ai-segment${!draft.anyModel ? " active" : ""}`} aria-pressed={!draft.anyModel} disabled={disabled} onClick={() => set({ anyModel: false })}>Only these</button>
      </div>
      {!draft.anyModel && <Combobox<string> multiple label="Allowed embedding models" value={draft.models} onChange={(models) => set({ models })} options={options}
        onCreate={async (text) => { const id = text.trim().slice(0, KNOWLEDGE_POLICY_BOUNDS.modelName); return { value: id, label: id }; }} createLabel={(text) => `Use “${text}”`}
        placeholder="Add an embedding model…" placeholderWithValues="Add another model…" emptyText="Type a model id" maxSelected={KNOWLEDGE_POLICY_BOUNDS.models} disabled={disabled} backspaceRemoves={false} />}
      <label htmlFor={ids.dims}>Largest size (dimensions)</label>
      <input id={ids.dims} type="number" inputMode="numeric" min={KNOWLEDGE_POLICY_BOUNDS.minDims} max={KNOWLEDGE_POLICY_BOUNDS.maxDims} step={1} value={draft.maxDims} disabled={disabled}
        placeholder={`${KNOWLEDGE_POLICY_BOUNDS.maxDims.toLocaleString("en-US")} (no limit)`} onChange={(event) => set({ maxDims: event.target.value })} />
    </>}
    <p className="file-dialog-hint">A 3,072-dimension base takes six times the storage and memory of the 512 default. Knowledge bases already over a new limit keep working and are not embedded again; their owners are told, and Change embedding model offers only what is allowed.</p>
  </div>;
}

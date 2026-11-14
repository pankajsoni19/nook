import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import {
  binBook, createPipeline, errorCode, errorMessage, errorPayload, listPipelines, saveFields, updateBook, updatePipeline
} from "./crmApi";
import { COMMON_CURRENCIES } from "../../shared/money";
import { CRM_FIELD_LABELS, CRM_FIELD_TYPES, type CrmBook, type CrmEntity, type CrmFieldDef, type CrmFieldType, type CrmPipeline, type StageKind } from "../../shared/crm";
import { WorkspaceAccess } from "../access/WorkspaceAccess";
import "./crmPanels.css";

/**
 * Contacts → Settings for one book (§D.5): the book's own settings, custom fields per kind (the
 * Collections field engine), pipelines and stages, who has access (the generic Access sheet API for
 * contact books, D803), and moving the book to the Bin. Owners and managers change them; everyone
 * else reads them with a line saying why.
 */

const canManage = (book: CrmBook) => book.level === "owner" || book.level === "manage";

export function SettingsView({ book, onBookChanged, onBinned, flash }: { book: CrmBook; onBookChanged: (book: CrmBook) => void; onBinned: () => void; flash: (message: string) => void }) {
  const manage = canManage(book);
  const { ask, confirmElement } = useConfirm();
  return <div className="crm-settings">
    {!manage && <p className="crm-note" role="note">Only the book's owner or a manager can change these settings. You can read them.</p>}
    <BookPanel book={book} disabled={!manage} onSaved={onBookChanged} flash={flash} />
    <FieldsPanel book={book} disabled={!manage} onSaved={onBookChanged} flash={flash} />
    <PipelinesPanel book={book} disabled={!manage} flash={flash} />
    {manage && <SharingPanel book={book} flash={flash} />}
    {book.level === "owner" && <section className="crm-panel crm-danger" aria-labelledby="crm-danger-title">
      <h2 id="crm-danger-title">Move to Bin</h2>
      <p className="crm-panel-help">Moves {book.name} with its contacts, companies, and deals to the Bin for 30 days. You can restore it from the Bin.</p>
      <button type="button" className="action-button secondary crm-danger-button" onClick={async () => {
        if (!await ask({ title: `Move ${book.name} to the Bin?`, message: "Its contacts, companies, deals, and notes go with it. You can restore it from the Bin for 30 days.", confirmLabel: "Move to Bin", danger: true })) return;
        try { await binBook(book.id); flash(`${book.name} moved to the Bin`); onBinned(); }
        catch (reason) { flash(errorMessage(reason, "Could not move the book to the Bin")); }
      }}><Trash2 aria-hidden="true" />Move book to Bin</button>
    </section>}
    {confirmElement}
  </div>;
}

function BookPanel({ book, disabled, onSaved, flash }: { book: CrmBook; disabled: boolean; onSaved: (book: CrmBook) => void; flash: (message: string) => void }) {
  const id = useId();
  const [name, setName] = useState(book.name);
  const [linkDomains, setLinkDomains] = useState(book.settings.linkCompaniesByDomain);
  const [rotting, setRotting] = useState(String(book.settings.rottingDays));
  const [currency, setCurrency] = useState(book.settings.currency ?? "");
  const [lifecycles, setLifecycles] = useState(book.settings.lifecycles.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(book.name); setLinkDomains(book.settings.linkCompaniesByDomain); setRotting(String(book.settings.rottingDays));
    setCurrency(book.settings.currency ?? ""); setLifecycles(book.settings.lifecycles.join(", "));
  }, [book]);

  const save = async () => {
    const days = Number(rotting);
    if (!Number.isInteger(days) || days < 1 || days > 365) { setError("Rotting days are 1 to 365"); return; }
    setBusy(true); setError(null);
    try {
      const body = await updateBook(book.id, { name: name.trim(), settings: { linkCompaniesByDomain: linkDomains, rottingDays: days, currency: currency || null, lifecycles: lifecycles.split(",").map((item) => item.trim()).filter(Boolean) } });
      onSaved(body.book);
      flash("Book saved");
    } catch (reason) { setError(errorMessage(reason, "Could not save the book")); }
    finally { setBusy(false); }
  };

  return <section className="crm-panel" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Book</h2>
    <div className="crm-form-grid">
      <div className="ui-field"><label htmlFor={`${id}-name`}>Name</label><input id={`${id}-name`} value={name} maxLength={120} disabled={disabled} onChange={(event) => setName(event.target.value)} /></div>
      <div className="ui-field"><label htmlFor={`${id}-rot`}>Days without activity before a deal is rotting</label><input id={`${id}-rot`} type="number" inputMode="numeric" min={1} max={365} value={rotting} disabled={disabled} onChange={(event) => setRotting(event.target.value)} /></div>
      <div className="ui-field"><span id={`${id}-currency`}>Currency for new deals</span>
        <Select labelledBy={`${id}-currency`} value={currency} disabled={disabled} onChange={setCurrency} options={[{ value: "", label: "Workspace default" }, ...COMMON_CURRENCIES.map((code) => ({ value: code, label: code }))]} />
      </div>
      <div className="ui-field"><label htmlFor={`${id}-life`}>Lifecycle stages</label><input id={`${id}-life`} value={lifecycles} disabled={disabled} onChange={(event) => setLifecycles(event.target.value)} aria-describedby={`${id}-life-hint`} />
        <small id={`${id}-life-hint`} className="ui-field-hint">Separate them with commas.</small></div>
    </div>
    <button type="button" role="switch" aria-checked={linkDomains} className="ui-switch crm-switch-row" disabled={disabled} onClick={() => setLinkDomains(!linkDomains)}>
      <span className="ui-switch-track" aria-hidden="true"><span className="ui-switch-thumb" /></span>Link contacts to a company by their email's domain
    </button>
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    {!disabled && <div className="crm-panel-actions"><button type="button" className="action-button" onClick={() => { void save(); }} disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save book"}</button></div>}
  </section>;
}

type FieldDraft = { key: string; id?: string; name: string; type: CrmFieldType; options: string; previous?: CrmFieldDef };
const draftOf = (field: CrmFieldDef): FieldDraft => ({ key: field.id, id: field.id, name: field.name, type: field.type, options: (field.options ?? []).map((option) => option.label).join(", "), previous: field });
const ENTITY_LABELS: Record<CrmEntity, string> = { contact: "Contacts", company: "Companies", deal: "Deals" };

function FieldsPanel({ book, disabled, onSaved, flash }: { book: CrmBook; disabled: boolean; onSaved: (book: CrmBook) => void; flash: (message: string) => void }) {
  const id = useId();
  const [entity, setEntity] = useState<CrmEntity>("contact");
  const [drafts, setDrafts] = useState<FieldDraft[]>(() => book.fields.contact.map(draftOf));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDrafts(book.fields[entity].map(draftOf)); setError(null); }, [book, entity]);
  const update = (key: string, patch: Partial<FieldDraft>) => setDrafts((list) => list.map((draft) => draft.key === key ? { ...draft, ...patch } : draft));

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const fields = drafts.map((draft) => {
        const selectLike = draft.type === "select" || draft.type === "multi_select";
        const labels = [...new Set(draft.options.split(",").map((label) => label.trim()).filter(Boolean))];
        return {
          ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), type: draft.type,
          ...(selectLike ? { options: labels.map((label) => { const existing = draft.previous?.options?.find((option) => option.label.toLowerCase() === label.toLowerCase()); return existing ? { id: existing.id, label, color: existing.color } : { label }; }) } : {})
        };
      });
      const body = await saveFields(book.id, entity, fields as never);
      onSaved(body.book);
      flash("Fields saved");
    } catch (reason) {
      const details = errorPayload<{ fieldErrors?: Record<string, string> }>(reason);
      setError(errorMessage(reason, "Could not save the fields") + (details?.fieldErrors ? ` ${Object.values(details.fieldErrors).join(" ")}` : ""));
    } finally { setBusy(false); }
  };

  return <section className="crm-panel" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Custom fields</h2>
    <div className="ui-segmented" role="group" aria-label="Fields for">
      {(Object.keys(ENTITY_LABELS) as CrmEntity[]).map((item) => <button key={item} type="button" aria-pressed={entity === item} onClick={() => setEntity(item)}>{ENTITY_LABELS[item]}</button>)}
    </div>
    {drafts.length === 0 && <p className="crm-panel-help">No custom fields for {ENTITY_LABELS[entity].toLowerCase()} yet.</p>}
    <ul className="crm-rows" aria-label={`Custom fields for ${ENTITY_LABELS[entity].toLowerCase()}`}>
      {drafts.map((draft, index) => <li key={draft.key} className="crm-row">
        <div className="ui-field"><label htmlFor={`${id}-n-${draft.key}`}>Field {index + 1} name</label>
          <input id={`${id}-n-${draft.key}`} value={draft.name} maxLength={60} disabled={disabled} onChange={(event) => update(draft.key, { name: event.target.value })} /></div>
        <div className="ui-field"><span id={`${id}-t-${draft.key}`}>Type</span>
          <Select<CrmFieldType> labelledBy={`${id}-t-${draft.key}`} value={draft.type} disabled={disabled || Boolean(draft.id && !["text", "url", "select"].includes(draft.previous?.type ?? ""))}
            onChange={(type) => update(draft.key, { type })} options={CRM_FIELD_TYPES.map((type) => ({ value: type, label: CRM_FIELD_LABELS[type] }))} />
        </div>
        {(draft.type === "select" || draft.type === "multi_select") && <div className="ui-field crm-row-wide"><label htmlFor={`${id}-o-${draft.key}`}>Options</label>
          <input id={`${id}-o-${draft.key}`} value={draft.options} disabled={disabled} placeholder="Gold, Silver, Bronze" onChange={(event) => update(draft.key, { options: event.target.value })} />
          <small className="ui-field-hint">Separate options with commas.</small></div>}
        {!disabled && <button type="button" className="icon-button crm-row-remove" aria-label={`Remove ${draft.name || `field ${index + 1}`}`} title="Remove" onClick={() => setDrafts((list) => list.filter((item) => item.key !== draft.key))}><Trash2 /></button>}
      </li>)}
    </ul>
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    {!disabled && <div className="crm-panel-actions">
      <button type="button" className="action-button secondary" onClick={() => setDrafts((list) => [...list, { key: crypto.randomUUID(), name: "", type: "text", options: "" }])} disabled={drafts.length >= 30}><Plus aria-hidden="true" />Add field</button>
      <button type="button" className="action-button" onClick={() => { void save(); }} disabled={busy || drafts.some((draft) => !draft.name.trim())}>{busy ? "Saving…" : "Save fields"}</button>
    </div>}
  </section>;
}

type StageDraft = { key: string; id?: string; name: string; kind: StageKind; probability: string; rotDays: string };
const stageDrafts = (pipeline: CrmPipeline): StageDraft[] => pipeline.stages.map((stage) => ({ key: stage.id, id: stage.id, name: stage.name, kind: stage.kind, probability: String(stage.probability), rotDays: stage.rotDays ? String(stage.rotDays) : "" }));
const KIND_LABELS: Record<StageKind, string> = { open: "Open", won: "Won", lost: "Lost" };

function PipelinesPanel({ book, disabled, flash }: { book: CrmBook; disabled: boolean; flash: (message: string) => void }) {
  const id = useId();
  const [pipelines, setPipelines] = useState<CrmPipeline[]>([]);
  const [pipelineId, setPipelineId] = useState<string>("");
  const [name, setName] = useState("");
  const [stages, setStages] = useState<StageDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveFrom, setMoveFrom] = useState<{ name: string; deals: number } | null>(null);
  const [moveTo, setMoveTo] = useState<string>("");

  const load = async (select?: string) => {
    try {
      const body = await listPipelines(book.id);
      setPipelines(body.pipelines);
      const chosen = body.pipelines.find((item) => item.id === select) ?? body.pipelines[0];
      if (chosen) { setPipelineId(chosen.id); setName(chosen.name); setStages(stageDrafts(chosen)); }
    } catch (reason) { setError(errorMessage(reason, "Could not load pipelines")); }
  };
  useEffect(() => { void load(); }, [book.id]);
  const choose = (next: string) => {
    const pipeline = pipelines.find((item) => item.id === next);
    if (!pipeline) return;
    setPipelineId(next); setName(pipeline.name); setStages(stageDrafts(pipeline)); setMoveFrom(null); setError(null);
  };
  const update = (key: string, patch: Partial<StageDraft>) => setStages((list) => list.map((stage) => stage.key === key ? { ...stage, ...patch } : stage));
  const move = (index: number, delta: number) => setStages((list) => {
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    return next;
  });

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = await updatePipeline(pipelineId, {
        name: name.trim(), moveDealsTo: moveFrom && moveTo ? moveTo : null,
        stages: stages.map((stage) => ({ ...(stage.id ? { id: stage.id } : {}), name: stage.name.trim(), kind: stage.kind, probability: Number(stage.probability) || 0, rotDays: stage.rotDays ? Number(stage.rotDays) : null }))
      });
      setMoveFrom(null); setMoveTo("");
      setPipelines((list) => list.map((item) => item.id === body.pipeline.id ? body.pipeline : item));
      setStages(stageDrafts(body.pipeline));
      flash("Pipeline saved");
    } catch (reason) {
      if (errorCode(reason) === "STAGE_IN_USE") {
        const details = errorPayload<{ stageId: string; deals: number }>(reason);
        const stage = pipelines.find((item) => item.id === pipelineId)?.stages.find((item) => item.id === details?.stageId);
        setMoveFrom({ name: stage?.name ?? "A removed stage", deals: details?.deals ?? 0 });
        setMoveTo(stages.find((item) => item.id)?.id ?? "");
      }
      setError(errorMessage(reason, "Could not save the pipeline"));
    } finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const body = await createPipeline({ bookId: book.id, name: `Pipeline ${pipelines.length + 1}` });
      await load(body.pipeline.id);
      flash("Pipeline added");
    } catch (reason) { setError(errorMessage(reason, "Could not add a pipeline")); }
    finally { setBusy(false); }
  };

  return <section className="crm-panel" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Pipelines</h2>
    <div className="crm-inline">
      <Select label="Pipeline" value={pipelineId || null} onChange={choose} options={pipelines.map((item) => ({ value: item.id, label: item.name }))} />
      {!disabled && <button type="button" className="action-button secondary" onClick={() => { void create(); }} disabled={busy}><Plus aria-hidden="true" />New pipeline</button>}
    </div>
    {pipelineId && <>
      <div className="ui-field"><label htmlFor={`${id}-pname`}>Pipeline name</label><input id={`${id}-pname`} value={name} maxLength={80} disabled={disabled} onChange={(event) => setName(event.target.value)} /></div>
      <ol className="crm-rows" aria-label="Stages">
        {stages.map((stage, index) => <li key={stage.key} className="crm-row crm-stage-row">
          <div className="ui-field"><label htmlFor={`${id}-s-${stage.key}`}>Stage {index + 1}</label>
            <input id={`${id}-s-${stage.key}`} value={stage.name} maxLength={60} disabled={disabled} onChange={(event) => update(stage.key, { name: event.target.value })} /></div>
          <div className="ui-field"><span id={`${id}-k-${stage.key}`}>Kind</span>
            <Select<StageKind> labelledBy={`${id}-k-${stage.key}`} value={stage.kind} disabled={disabled} onChange={(kind) => update(stage.key, { kind, probability: kind === "won" ? "100" : kind === "lost" ? "0" : stage.probability })}
              options={(Object.keys(KIND_LABELS) as StageKind[]).map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))} /></div>
          <div className="ui-field crm-narrow"><label htmlFor={`${id}-p-${stage.key}`}>Probability %</label>
            <input id={`${id}-p-${stage.key}`} type="number" inputMode="numeric" min={0} max={100} value={stage.probability} disabled={disabled} onChange={(event) => update(stage.key, { probability: event.target.value })} /></div>
          <div className="ui-field crm-narrow"><label htmlFor={`${id}-r-${stage.key}`}>Rot days</label>
            <input id={`${id}-r-${stage.key}`} type="number" inputMode="numeric" min={1} max={365} placeholder={String(book.settings.rottingDays)} value={stage.rotDays} disabled={disabled} onChange={(event) => update(stage.key, { rotDays: event.target.value })} /></div>
          {!disabled && <div className="crm-row-tools">
            <button type="button" className="icon-button" aria-label={`Move ${stage.name || `stage ${index + 1}`} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></button>
            <button type="button" className="icon-button" aria-label={`Move ${stage.name || `stage ${index + 1}`} down`} disabled={index === stages.length - 1} onClick={() => move(index, 1)}><ArrowDown /></button>
            <button type="button" className="icon-button" aria-label={`Remove ${stage.name || `stage ${index + 1}`}`} disabled={stages.length <= 2} onClick={() => setStages((list) => list.filter((item) => item.key !== stage.key))}><Trash2 /></button>
          </div>}
        </li>)}
      </ol>
      {moveFrom && <div className="crm-move-deals" role="group" aria-label="Where its deals go">
        <p>“{moveFrom.name}” has {moveFrom.deals} {moveFrom.deals === 1 ? "deal" : "deals"}. Move them to:</p>
        <Select label="Move its deals to" value={moveTo || null} onChange={setMoveTo} options={stages.filter((stage) => stage.id).map((stage) => ({ value: stage.id!, label: stage.name }))} />
      </div>}
      {error && <p className="ui-field-error" role="alert">{error}</p>}
      {!disabled && <div className="crm-panel-actions">
        <button type="button" className="action-button secondary" onClick={() => setStages((list) => [...list, { key: crypto.randomUUID(), name: "", kind: "open", probability: "50", rotDays: "" }])} disabled={stages.length >= 20}><Plus aria-hidden="true" />Add stage</button>
        <button type="button" className="action-button" onClick={() => { void save(); }} disabled={busy || !name.trim() || stages.some((stage) => !stage.name.trim())}>{busy ? "Saving…" : moveFrom ? "Move deals and save" : "Save pipeline"}</button>
      </div>}
    </>}
  </section>;
}

/** Who has access to the book: the shared Access sheet over `/api/access/contact_book/:id` (D984, D1050). */
function SharingPanel({ book, flash }: { book: CrmBook; flash: (message: string) => void }) {
  const id = useId();
  return <section className="crm-panel" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Who has access</h2>
    <p className="crm-panel-help">Readers see every contact, company, and deal in {book.name}; editors change them; managers also change these settings.</p>
    <WorkspaceAccess kind="contact_book" id={book.id} title={book.name} canManage onSaved={() => flash("Access saved")} />
  </section>;
}

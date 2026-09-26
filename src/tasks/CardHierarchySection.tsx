import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronRight, Layers, ListChecks, Plus, SquarePen, X } from "lucide-react";
import { canHaveChildren, childName, childPlural, levelName } from "../../shared/boardStructure";
import { Combobox } from "../ui/Combobox";
import { Select } from "../ui/Select";
import { ancestorsOf, checklistColumn, childrenOf, hasLevels, levelOf, parentCandidates } from "./hierarchyModel";
import { dueStatus, localDateString, validateCardTitle } from "./taskActions";
import type { CardChange, CardDetail } from "./tasksApi";
import type { CardHierarchyContext } from "./useBoardHierarchy";

const NO_PARENT = "__none";

/**
 * Runs one inline add at a time (QA 0.9.0): while `flag` is set a second call is refused (null),
 * so a quick double Enter never creates a duplicate. Otherwise the add's own result.
 */
export async function addOnce(flag: { current: boolean }, run: () => Promise<boolean>): Promise<boolean | null> {
  if (flag.current) return null;
  flag.current = true;
  try {
    return await run();
  } finally {
    flag.current = false;
  }
}

/** "Epic: Checkout › Story: Refunds ›" above the card title; each step opens that card (a history entry). */
export function CardBreadcrumb({ card, context }: { card: CardDetail; context: CardHierarchyContext }) {
  const chain = ancestorsOf(context.cards, card.id);
  if (!chain.length) return null;
  return <nav className="task-breadcrumb" aria-label="Parents">
    {chain.map((item) => <span key={item.id}>
      <button type="button" onClick={() => context.openCard(item.id)} title={item.title}>
        <small>{levelName(context.structure, levelOf(item))}</small><span className="sr-only">: </span>{item.title}
      </button>
      <ChevronRight aria-hidden="true" />
    </span>)}
  </nav>;
}

type ParentFieldsProps = {
  card: CardDetail;
  context: CardHierarchyContext;
  idPrefix: string;
  saving: boolean;
  onSave: (change: Pick<CardChange, "parentId" | "level">, success: string) => Promise<boolean>;
};

/**
 * The Parent field (a Combobox over this board's cards one level up, "No epic" first) and the Level
 * field ("Change level", D128). Hidden on a flat board; the Parent field is hidden at the top level.
 */
export function CardParentFields({ card, context, idPrefix, saving, onSave }: ParentFieldsProps) {
  const { structure } = context;
  if (!hasLevels(structure)) return null;
  const level = levelOf(card);
  const liveChildren = childrenOf(context.cards, context.columns, card.id).length;
  const parentLevelName = level > 0 ? levelName(structure, level - 1) : "";
  const candidates = parentCandidates(context.cards, card);
  const columnName = (columnId: string) => context.columns.find((column) => column.id === columnId)?.name;
  const options = [
    { value: NO_PARENT, label: `No ${parentLevelName.toLowerCase()}` },
    ...candidates.map((candidate) => ({ value: candidate.id, label: candidate.title, ...(columnName(candidate.column_id) ? { description: columnName(candidate.column_id)! } : {}) }))
  ];
  const current = card.parent_card_id ?? NO_PARENT;
  const levelOptions = structure.levels.map((item, index) => ({ value: String(index), label: item.name, ...(index === level ? { description: "Now" } : {}) }));

  function changeLevel(value: string) {
    const next = Number(value);
    if (next === level) return;
    // The parent stays only if it is one level above the new level.
    const parent = card.parent_card_id ? context.cards.find((item) => item.id === card.parent_card_id) : undefined;
    const keep = parent && levelOf(parent) === next - 1;
    void onSave({ level: next, parentId: keep ? parent.id : null }, `Now a ${levelName(structure, next).toLowerCase()}`);
  }

  return <>
    {level > 0 && <div className="task-card-field">
      <label htmlFor={`${idPrefix}-parent`}><Layers aria-hidden="true" />{parentLevelName}</label>
      <Combobox id={`${idPrefix}-parent`} label={parentLevelName} placeholder={`Find a ${parentLevelName.toLowerCase()}…`} emptyText={`No ${structure.levels[level - 1]!.plural.toLowerCase()} match`}
        value={[current]} options={options} disabled={saving}
        selectedOptions={card.parent_card_id && !candidates.some((item) => item.id === card.parent_card_id) ? [{ value: card.parent_card_id, label: "Parent" }] : undefined}
        onChange={(next) => {
          const value = next[next.length - 1] ?? NO_PARENT;
          if (value === current) return;
          const title = candidates.find((item) => item.id === value)?.title;
          void onSave({ parentId: value === NO_PARENT ? null : value }, value === NO_PARENT ? `No ${parentLevelName.toLowerCase()} now` : `Moved under “${title}”`);
        }} />
    </div>}
    <div className="task-card-field">
      <label id={`${idPrefix}-level-label`}><Layers aria-hidden="true" />Level</label>
      <Select id={`${idPrefix}-level`} labelledBy={`${idPrefix}-level-label`} label="Level" value={String(level)} options={levelOptions} disabled={saving || liveChildren > 0} onChange={changeLevel} />
      {liveChildren > 0 && <small className="task-due-text">It has {liveChildren === 1 ? "a child" : `${liveChildren} children`}, so it stays a {levelName(structure, level).toLowerCase()}.</small>}
    </div>
  </>;
}

type SubtasksProps = { card: CardDetail; context: CardHierarchyContext; idPrefix: string };

/**
 * The Subtasks section (§7.2), named by the level below ("Stories" on an epic): a checklist whose
 * checkbox moves a child to the board's first done column and back (D127), links that open each
 * child, "Remove from parent", and an inline add that keeps focus for the next one.
 */
export function SubtasksSection({ card, context, idPrefix }: SubtasksProps) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const headingId = useId();
  const { structure } = context;
  const level = levelOf(card);
  if (!canHaveChildren(structure, level)) return null;
  const children = childrenOf(context.cards, context.columns, card.id);
  const doneIds = new Set(context.columns.filter((column) => column.is_done === 1).map((column) => column.id));
  const done = children.filter((child) => doneIds.has(child.column_id)).length;
  const checkable = checklistColumn(context.columns, true) !== null;
  const plural = childPlural(structure, level);
  const singular = childName(structure, level);
  const today = localDateString();
  const columnName = (columnId: string) => context.columns.find((column) => column.id === columnId)?.name ?? "";

  // QA 0.9.0: the input stays enabled (a disabled input drops focus) and a ref, not state, refuses a
  // second Enter while the first add is saving, so a quick double Enter never adds a duplicate.
  async function add() {
    const check = validateCardTitle(draft);
    if (!check.ok || inFlightRef.current) return;
    setAdding(true);
    const added = await addOnce(inFlightRef, () => context.addChild(card, check.name));
    setAdding(false);
    if (added) setDraft((current) => current.trim() === check.name ? "" : current);
    inputRef.current?.focus();
  }

  function onKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void add();
    }
    if (event.key === "Escape" && draft) {
      event.preventDefault();
      setDraft("");
    }
  }

  async function toggle(child: (typeof children)[number], checked: boolean) {
    setPending(child.id);
    try {
      await context.setChildDone(child, checked);
    } finally {
      setPending(null);
    }
  }

  return <section className="task-card-section task-subtasks" aria-labelledby={headingId}>
    <header>
      <h3 id={headingId}><ListChecks aria-hidden="true" />{plural} {children.length > 0 && <span className="task-subtasks-count">{done}/{children.length}</span>}</h3>
      <button type="button" className="secondary-button task-small-button" onClick={() => context.composeChild(card)}><SquarePen />Add with details</button>
    </header>
    {children.length > 0 && <span className="task-subtasks-bar" role="progressbar" aria-label={`${done} of ${children.length} ${plural.toLowerCase()} done`} aria-valuemin={0} aria-valuemax={children.length} aria-valuenow={done}>
      <span style={{ width: `${Math.round((done / children.length) * 100)}%` }} />
    </span>}
    <ul className="task-subtask-list" aria-label={plural}>
      {children.map((child) => {
        const isDone = doneIds.has(child.column_id);
        const due = dueStatus(child.due_on, today, isDone, { dueAt: child.due_at });
        return <li key={child.id} className={`task-subtask${isDone ? " done" : ""}`}>
          {checkable
            ? <label className="task-subtask-check"><input type="checkbox" checked={isDone} disabled={pending === child.id} onChange={(event) => { void toggle(child, event.target.checked); }}
              aria-label={`${isDone ? "Done" : "Not done"}: ${child.title}`} /></label>
            : <span className="task-subtask-column">{columnName(child.column_id)}</span>}
          <button type="button" className="task-subtask-title" onClick={() => context.openCard(child.id)} title={child.title}>{child.title}</button>
          {due && <span className={`task-due-chip ${due.tone}`}>{due.label}</span>}
          {checkable && <small className="task-subtask-where">{columnName(child.column_id)}</small>}
          <button type="button" className="icon-button" onClick={() => { void context.detachChild(child); }} aria-label={`Remove “${child.title}” from this ${levelName(structure, level).toLowerCase()}`} title="Remove from parent"><X /></button>
        </li>;
      })}
    </ul>
    <div className="task-subtask-add">
      <Plus aria-hidden="true" />
      <input ref={inputRef} id={`${idPrefix}-add-child`} value={draft} maxLength={200} placeholder={`Add ${singular.toLowerCase()}…`} aria-label={`Add ${singular.toLowerCase()}`}
        aria-busy={adding || undefined} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} enterKeyHint="done" />
      {draft.trim() && <button type="button" className="primary-button task-small-button" onClick={() => { void add(); }} disabled={adding}>{adding ? "Adding…" : "Add"}</button>}
    </div>
  </section>;
}

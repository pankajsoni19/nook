import { useEffect, useId, useState } from "react";
import { Link2, Tag, X } from "lucide-react";
import { Select } from "../ui/Select";
import { LinkPicker, WorkRefChip } from "../ui/links/WorkLinks";
import { PROJECT_COLOR_HEX, MAX_TAGS, type TimeProject } from "../../shared/time";
import type { WorkSummary } from "../../shared/workRefs";
import { timeApi } from "./api";
import { onTimeChanged } from "./timerStore";

/**
 * Time's form fields: the project picker (loggable projects), the work item field (the shared
 * LinkPicker: search, or paste MYT-12 or a link), tags (up to five, suggestions from the workspace's
 * tags), and the billable switch. Shared by the timer popover, the entry sheet, and the Timer bar.
 */

let projectsCache: Promise<TimeProject[]> | null = null;
let tagsCache: Promise<string[]> | null = null;
onTimeChanged(() => { tagsCache = null; });
export const invalidateProjects = () => { projectsCache = null; };

export function useLoggableProjects(): TimeProject[] {
  const [projects, setProjects] = useState<TimeProject[]>([]);
  useEffect(() => {
    let alive = true;
    projectsCache ??= timeApi.projects({ loggable: true }).then((body) => body.projects, () => { projectsCache = null; return []; });
    void projectsCache.then((list) => { if (alive) setProjects(list); });
    return () => { alive = false; };
  }, []);
  return projects;
}

function useTags(): string[] {
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    tagsCache ??= timeApi.tags().then((body) => body.tags, () => { tagsCache = null; return []; });
    void tagsCache.then((list) => { if (alive) setTags(list); });
    return () => { alive = false; };
  }, []);
  return tags;
}

export const projectDot = (color: string | undefined) => <span className="time-dot" style={{ background: PROJECT_COLOR_HEX[color as keyof typeof PROJECT_COLOR_HEX] ?? PROJECT_COLOR_HEX.amber }} aria-hidden="true" />;

export function ProjectSelect({ value, onChange, label = "Project", allowNone = true, variant = "field", current }: {
  value: string | null;
  onChange: (projectId: string | null, project: TimeProject | null) => void;
  label?: string;
  allowNone?: boolean;
  variant?: "field" | "chip";
  /** The entry's project when it is no longer loggable (archived, read-only): still shown. */
  current?: { id: string; name: string; color?: string } | null;
}) {
  const projects = useLoggableProjects();
  const options = [
    ...(allowNone ? [{ value: "", label: "No project" }] : []),
    ...projects.map((project) => ({ value: project.id, label: project.name, description: project.client?.name ?? undefined, icon: projectDot(project.color) })),
    ...(current && !projects.some((project) => project.id === current.id) ? [{ value: current.id, label: current.name, icon: projectDot(current.color), disabled: true }] : [])
  ];
  const select = <Select label={label} variant={variant} value={value ?? ""} searchable="auto" options={options}
    onChange={(id) => onChange(id || null, projects.find((project) => project.id === id) ?? null)} placeholder="No project" />;
  return variant === "chip" ? select : <div className="ui-field"><span aria-hidden="true">{label}</span>{select}</div>;
}

export type PickedTarget = { kind: string; id: string; summary: WorkSummary } | null;

export function WorkItemField({ value, onChange, onOpen, label = "Work item" }: { value: PickedTarget; onChange: (target: PickedTarget) => void; onOpen?: (href: string) => void; label?: string }) {
  const [picking, setPicking] = useState(false);
  const id = useId();
  return <div className="ui-field time-workitem">
    <span id={id}>{label}</span>
    <div className="time-workitem-row" role="group" aria-labelledby={id}>
      {value
        ? <WorkRefChip summary={value.summary} onOpen={onOpen} onRemove={() => onChange(null)} removeLabel={`Remove ${value.summary.title}`} />
        : <button type="button" className="secondary-button ui-small-button" onClick={() => setPicking(true)}><Link2 aria-hidden="true" />Link a card or item</button>}
    </div>
    {picking && <LinkPicker title="Track time on" relations={["tracks"]} onClose={() => setPicking(false)}
      onPick={async (target) => {
        if ("ref" in target) return;
        onChange({ kind: target.kind, id: target.id, summary: target });
      }} />}
  </div>;
}

export function TagsField({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const known = useTags();
  const [text, setText] = useState("");
  const inputId = useId();
  const listId = useId();
  const add = (raw: string) => {
    const tag = raw.trim().replace(/,$/, "").trim().slice(0, 40);
    if (!tag || value.some((item) => item.toLowerCase() === tag.toLowerCase()) || value.length >= MAX_TAGS) { setText(""); return; }
    onChange([...value, tag]);
    setText("");
  };
  return <div className="ui-field time-tags">
    <label htmlFor={inputId}>Tags</label>
    <div className="time-tags-box">
      {value.map((tag) => <span key={tag} className="time-tag"><Tag aria-hidden="true" />{tag}<button type="button" onClick={() => onChange(value.filter((item) => item !== tag))} aria-label={`Remove tag ${tag}`}><X /></button></span>)}
      {value.length < MAX_TAGS && <input id={inputId} list={listId} value={text} placeholder={value.length ? "" : "Add a tag"} maxLength={40}
        onChange={(event) => { if (event.target.value.endsWith(",")) add(event.target.value); else setText(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && text.trim()) { event.preventDefault(); add(text); }
          if (event.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => { if (text.trim()) add(text); }} />}
      <datalist id={listId}>{known.filter((tag) => !value.includes(tag)).slice(0, 50).map((tag) => <option key={tag} value={tag} />)}</datalist>
    </div>
    <small className="ui-field-hint">Up to {MAX_TAGS}; Enter or a comma adds one.</small>
  </div>;
}

export function BillableSwitch({ value, onChange, disabled = false }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" className="ui-switch time-billable" aria-checked={value} disabled={disabled} onClick={() => onChange(!value)}>
    <span className="ui-switch-track"><span className="ui-switch-thumb" /></span>
    <span>Billable</span>
  </button>;
}

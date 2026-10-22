import { useId, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, FileText, Link2, Plus, Search, X } from "lucide-react";
import { appName } from "../appName";
import { Select } from "../ui/Select";
import type { DocInput, DocServerChoice } from "../../shared/reportsGenerate";
import { linkHost, parseNookRef } from "../../shared/nookDocRef";
import { NookDocPicker, nookLinkOf } from "./NookDocPicker";
import "./generate.css";
import "./docList.css";

/**
 * D515–D517: a report's docs, or a change's attached docs, as a list (each row its title or link, where
 * it is read from, and its state, with ↑ ↓ and remove), and the control that adds one: a pasted link
 * with the source it is read through (a link on a tool server's host picks that server, a link into
 * this Nook picks Nook), or "Pick from <APP_NAME>". Used by New report, Doc settings, and the Changes
 * composer.
 */

export type DocListItem = {
  key: string;
  title: string | null;
  ref: string;
  nook: boolean;
  /** Where it is read from, e.g. "Nook" or "via Outline". */
  source: string;
  /** "Changed", "New", "Added by a change"… */
  tag?: string | null;
  meta?: string | null;
};

/** A doc to add, with its title when the picker knew it. */
export type PickedDoc = DocInput & { title?: string | null };

/**
 * B4: the source a pasted link selects: Nook for a link on one of this instance's origins (or a bare
 * id), else the tool server whose host the link is on (or a subdomain of it, either way); null keeps
 * the current choice.
 */
export function sourceForLink(ref: string, servers: readonly DocServerChoice[]): string | null {
  const nook = servers.find((item) => item.builtin);
  if (nook && parseNookRef(ref, nook.origins?.length ? nook.origins : typeof window === "undefined" ? [] : [window.location.origin])) return nook.id;
  const host = linkHost(ref);
  if (!host) return null;
  const match = servers.find((item) => item.host && (host === item.host || host.endsWith(`.${item.host}`) || item.host.endsWith(`.${host}`)));
  return match?.id ?? null;
}

/** A short line for a link: its host and path end, or the id. */
export const shortLink = (ref: string) => {
  try {
    const url = new URL(ref);
    const path = url.pathname.split("/").filter(Boolean);
    return `${url.hostname}${path.length ? `/…/${path.at(-1)}` : ""}`;
  } catch {
    return ref.length > 48 ? `${ref.slice(0, 45)}…` : ref;
  }
};

export function DocList({ items, onMove, onRemove, disabled = false, label = "Docs", removeLabel = "Remove" }: { items: DocListItem[]; onMove?: (index: number, by: -1 | 1) => void; onRemove?: (index: number) => void; disabled?: boolean; label?: string; removeLabel?: string }) {
  if (!items.length) return null;
  return <ol className="report-doc-list" aria-label={label}>
    {items.map((item, index) => {
      const name = item.title ?? shortLink(item.ref);
      return <li key={item.key} className="report-doc-row">
        <span className="report-doc-row-icon" aria-hidden="true">{item.nook ? <FileText /> : <Link2 />}</span>
        <span className="report-doc-row-text">
          <strong title={item.ref}>{name}</strong>
          <small>{item.tag && <><span className="report-doc-row-flag">{item.tag}</span> · </>}{item.source}{item.title ? ` · ${shortLink(item.ref)}` : ""}{item.meta ? ` · ${item.meta}` : ""}</small>
        </span>
        <span className="report-doc-row-actions">
          {onMove && items.length > 1 && <>
            <button type="button" className="icon-button" onClick={() => onMove(index, -1)} disabled={disabled || index === 0} aria-label={`Move “${name}” up`}><ArrowUp /></button>
            <button type="button" className="icon-button" onClick={() => onMove(index, 1)} disabled={disabled || index === items.length - 1} aria-label={`Move “${name}” down`}><ArrowDown /></button>
          </>}
          {onRemove && <button type="button" className="icon-button" onClick={() => onRemove(index)} disabled={disabled} aria-label={`${removeLabel} “${name}”`}><X /></button>}
        </span>
      </li>;
    })}
  </ol>;
}

/**
 * Adds a doc: a link and its source (picked from the link when it can be), or a pick from this Nook.
 * `defaultServerId` is the source to start with (the report's first doc's in Changes).
 */
export function DocAdder({ servers, defaultServerId, onAdd, disabled = false, busy = false, full = false, label = "Add a doc", addLabel = "Add" }: {
  servers: DocServerChoice[] | null; defaultServerId: string | null; onAdd: (doc: PickedDoc) => void | Promise<unknown>; disabled?: boolean; busy?: boolean; full?: boolean; label?: string; addLabel?: string;
}) {
  const [ref, setRef] = useState("");
  const [serverId, setServerId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const ids = { link: useId(), source: useId() };
  const source = serverId ?? defaultServerId ?? servers?.[0]?.id ?? "nook";
  const change = (value: string) => {
    setRef(value);
    if (servers) setServerId(sourceForLink(value, servers) ?? serverId);
  };
  const add = async () => {
    if (!ref.trim() || disabled || busy || full) return;
    await onAdd({ docRef: ref.trim(), serverId: source });
    setRef("");
    setServerId(null);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void add();
  };
  return <div className="report-doc-adder" role="group" aria-label={label}>
    <div className="report-doc-adder-head">
      <label htmlFor={ids.link}>{label}</label>
      <button type="button" className="secondary-button" onClick={() => setPicking((open) => !open)} aria-expanded={picking} disabled={disabled || full}><Search aria-hidden="true" />Pick from {appName()}</button>
    </div>
    <div className="report-doc-adder-row">
      <input id={ids.link} value={ref} maxLength={2048} autoComplete="off" inputMode="url" disabled={disabled || full} placeholder={full ? "That is the most docs" : `A link to a note or file in ${appName()}, or to a doc in your doc system`} onChange={(event) => change(event.target.value)} onKeyDown={keyDown} />
      <button type="button" className="secondary-button" onClick={() => { void add(); }} disabled={disabled || busy || full || !ref.trim()}><Plus aria-hidden="true" />{busy ? "Adding…" : addLabel}</button>
    </div>
    {ref.trim() && servers && servers.length > 1 && <div className="report-doc-adder-source">
      <span className="reports-label" id={ids.source}>Read it through</span>
      <Select labelledBy={ids.source} label="Doc source" value={source} onChange={setServerId}
        options={servers.map((item) => ({ value: item.id, label: item.name, description: item.builtin ? "Notes, text files, and PDFs" : item.pick ? `Uses ${item.pick.tool}` : "No fetch tool found" }))} />
    </div>}
    {picking && <NookDocPicker onClose={() => setPicking(false)} onPick={(pick) => { setPicking(false); void onAdd({ docRef: nookLinkOf(pick), serverId: "nook", title: pick.title }); }} />}
  </div>;
}

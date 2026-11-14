import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { Share2 } from "lucide-react";
import { getAccess, type ItemAccess } from "./accessApi";
import { accessSummary } from "./accessModel";
import type { WorkspaceContainerKind } from "../../shared/workspaceModules";
import "./workspaceAccess.css";

const AccessSheet = lazy(() => import("./AccessSheet").then((module) => ({ default: module.AccessSheet })));

export type WorkspaceAccessProps = {
  kind: WorkspaceContainerKind;
  id: string;
  /** The container's name: the sheet's heading. */
  title: string;
  /** Owner or manager: only they open the sheet (the server answers 403 to anyone else). */
  canManage: boolean;
  /** After a save, with the saved access (the host refreshes and says so). */
  onSaved?: (access: ItemAccess) => void;
  /** What the module shows when the person cannot change access (nothing by default). */
  readOnlyText?: ReactNode;
  /** The button's words; "Change who has access" by default. */
  label?: string;
};

/**
 * Who has access to a workspace container (D1050): a one-line summary ("Everyone signed in · Can
 * view", "Ana, Ben and 1 group") and a button that opens the shared Access sheet over the generic
 * `/api/access/:kind/:id`. Every workspace module uses this one control instead of its own sharing
 * panel; what answering, taking part, or booking means stays in the module (it is not access, §B.9).
 */
export function WorkspaceAccess({ kind, id, title, canManage, onSaved, readOnlyText, label = "Change who has access" }: WorkspaceAccessProps) {
  const [access, setAccess] = useState<ItemAccess | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { if (canManage) getAccess(kind, id).then(setAccess, () => setAccess(null)); }, [canManage, kind, id]);
  useEffect(() => { load(); }, [load]);
  if (!canManage) return readOnlyText ? <p className="workspace-access-summary">{readOnlyText}</p> : null;
  return <div className="workspace-access">
    <p className="workspace-access-summary" aria-live="polite">{access ? accessSummary(access) : "Loading who has access…"}</p>
    <button type="button" className="secondary-button workspace-access-button" onClick={() => setOpen(true)} aria-haspopup="dialog"><Share2 aria-hidden="true" />{label}</button>
    {open && <Suspense fallback={null}><AccessSheet kind={kind} id={id} title={title} guardHistory onClose={() => setOpen(false)}
      onSaved={(saved) => { setOpen(false); setAccess(saved); onSaved?.(saved); }} /></Suspense>}
  </div>;
}

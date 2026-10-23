import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bookmark, BookmarkPlus, Copy, Ellipsis, Lock, Pencil, Pin, PinOff, Save, Share2, SquareCheck, Square, Trash2, Undo2 } from "lucide-react";
import type { TaskQuery } from "../../../shared/taskQuery";
import { ApiError } from "../../api";
import { ConfirmDialog, ModalDialog } from "../../files/Dialog";
import { NameDialog } from "../../files/RenameDialog";
import { AccessSheet } from "../../access/AccessSheet";
import { Select } from "../../ui/Select";
import { useHistoryDialogGuard } from "../../ui/useHistoryDialogGuard";
import { useRole } from "../../team/roleAccess";
import type { BoardViewId } from "../boardUrl";
import type { TaskNotify } from "../taskActions";
import { taskErrorCode, taskErrorMessage } from "../tasksApi";
import { createView, deleteView, duplicateView, getView, getViewLanePrefs, listBoardViews, pinBoardView, saveViewPrefs, saveViewSharing, unpinBoardView, updateView, type TaskView, type ViewPrefs } from "../home/homeApi";
import type { SwimlaneMode } from "../../../shared/swimlanes";
import { boardViewQueryText, displayLayoutOf, sameFilter, savedBoardFilter } from "./boardViewModel";
import { announceViewsChanged, onViewsChanged, ownedViewActions, validateViewName, viewNameHint, viewRoleAccess, viewUndoBody, viewVisibilityLabel } from "./viewActions";

const ALL_CARDS = "";

type Options = {
  boardId: string;
  /** The saved view the route names (/tasks/:b/views/:v), or null for All cards. */
  savedViewId: string | null;
  /** The URL's filter: the board's, or an unsaved change to the view's (`unsaved`). */
  routeFilter: TaskQuery;
  unsaved: boolean;
  /** The board's layout (`?view=`), saved with the view. */
  layout: BoardViewId;
  notify: TaskNotify;
  /**
   * Shows a saved view on this board (or All cards for null). `opened`: a fresh pick, which opens in
   * its saved layout; `replace` keeps Back where it was (after a save or delete).
   */
  onSelect: (view: TaskView | null, options?: { replace?: boolean }) => void;
  /** The view's filter is not on this board any more (edited elsewhere): leave for its cross-board page. */
  onLeave: (viewId: string) => void;
  /** Lane VIEWS2 (D655): the swimlanes the URL picked (null: none), saved with the view; undefined keeps the view's own. */
  swim?: SwimlaneMode | null;
  /** The board's own collapsed columns and rows, which "Keep this view's own collapsed columns" starts from (D657). */
  boardCollapse?: { columns: string[]; rows: string[] };
};

type Dialog = { kind: "menu" | "saveAs" | "rename" | "share" | "delete" } | { kind: "conflict"; latest: TaskView };

/** A board view's own collapse (D657), while "Keep this view's own collapsed columns" is on. */
export type OwnCollapse = { on: boolean; columns: string[]; rows: string[] };

/**
 * Saved views on a board (lane VIEWS, D635–D638; pins and own collapse, VIEWS2, D657–D658): the header's **View: All cards ▾** picker of the
 * readable views pinned to this board, the filter bar's **Save view…** / **Save** / **Discard**, and
 * the view's options (rename, share, duplicate, delete), with the view page's rules: only the owner
 * changes a view (revision CAS, 409 VIEW_CHANGED offers a reload), recipients duplicate.
 */
export function useBoardSavedViews({ boardId, savedViewId, routeFilter, unsaved, layout, notify, onSelect, onLeave, swim, boardCollapse }: Options) {
  const [view, setView] = useState<TaskView | null>(null);
  const [views, setViews] = useState<TaskView[]>([]);
  // Lane VIEWS2 (D658): views pinned on this board for everyone who can open it, listed first.
  const [pinned, setPinned] = useState<TaskView[]>([]);
  const [canPin, setCanPin] = useState(false);
  // Lane VIEWS2 (D657): the view's own collapse, per person; null until loaded (or for All cards).
  const [own, setOwn] = useState<OwnCollapse | null>(null);
  const ownRef = useRef(own);
  ownRef.current = own;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const role = useRole();
  const { canCreate, canShare } = viewRoleAccess(role);
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const closeDialog = useCallback(() => {
    setDialog(null);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target) window.setTimeout(() => { if (target.isConnected) target.focus(); }, 0);
  }, []);
  useHistoryDialogGuard(dialog !== null, closeDialog);
  const open = (next: Dialog, trigger?: HTMLElement | null) => {
    if (trigger) returnFocusRef.current = trigger;
    setDialog(next);
  };

  const loadList = useCallback(async () => {
    try {
      const lists = await listBoardViews(boardId);
      setPinned(lists.pinned);
      setViews(lists.views);
      setCanPin(lists.canPin);
    } catch {
      // The picker keeps what it had; the board itself does not depend on it.
    }
  }, [boardId]);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => onViewsChanged(() => { void loadList(); }), [loadList]);

  // The view's own collapse (D657): loaded with the view, per person.
  useEffect(() => {
    setOwn(null);
    if (!savedViewId) return;
    let active = true;
    getViewLanePrefs(savedViewId).then((prefs: ViewPrefs) => {
      if (active) setOwn({ on: prefs.ownCollapse === true, columns: prefs.collapsedColumnIds ?? [], rows: prefs.collapsedRows ?? [] });
    }, () => undefined);
    return () => { active = false; };
  }, [savedViewId]);

  /** Saves a change to the view's own collapse at once on screen; a failed save puts it back. */
  const saveOwn = useCallback(async (next: OwnCollapse, change: Parameters<typeof saveViewPrefs>[1], failure: string) => {
    if (!savedViewId) return;
    const before = ownRef.current;
    setOwn(next);
    try {
      await saveViewPrefs(savedViewId, change);
    } catch (reason) {
      setOwn(before);
      notify.error(taskErrorMessage(reason, failure));
    }
  }, [notify, savedViewId]);

  /** "Keep this view's own collapsed columns" (D657): on, it starts from the board's columns and rows. */
  function setOwnCollapse(on: boolean) {
    const columns = on ? boardCollapse?.columns ?? [] : own?.columns ?? [];
    const rows = on ? boardCollapse?.rows ?? [] : own?.rows ?? [];
    void saveOwn({ on, columns, rows }, on ? { ownCollapse: true, collapsedColumnIds: columns, collapsedRows: rows } : { ownCollapse: false },
      on ? "Could not keep this view's own collapsed columns" : "Could not share the board's collapsed columns again");
    notify(on ? "This view keeps its own collapsed columns now" : "This view shows the board's collapsed columns again");
  }

  /** Pin for everyone on this board, or unpin (D658). */
  async function setPinnedView(pin: boolean) {
    if (!current || busy) return;
    setBusy(true);
    try {
      const lists = pin ? await pinBoardView(boardId, current.id) : await unpinBoardView(boardId, current.id);
      setPinned(lists.pinned);
      setViews(lists.views);
      setDialog(null);
      notify.success(pin ? `Pinned “${current.name}” for everyone on this board` : `Unpinned “${current.name}”`);
    } catch (reason) {
      closeDialog();
      notify.error(taskErrorCode(reason) === "LIMIT_REACHED" ? "This board already has 20 pinned views" : taskErrorMessage(reason, pin ? "Could not pin the view" : "Could not unpin the view"));
    } finally {
      setBusy(false);
    }
  }

  const loadView = useCallback(async () => {
    if (!savedViewId) return;
    try {
      const { view: loaded } = await getView(savedViewId);
      if (loaded.board_id !== boardId) {
        onLeaveRef.current(savedViewId);
        return;
      }
      setView(loaded);
    } catch (reason) {
      notify.warning(reason instanceof ApiError && reason.status === 404 ? "That view was deleted or is not shared with you" : taskErrorMessage(reason, "Could not open this view"));
      onSelectRef.current(null, { replace: true });
    }
  }, [boardId, notify, savedViewId]);
  useEffect(() => {
    setView((current) => current && current.id === savedViewId ? current : null);
    void loadView();
  }, [loadView, savedViewId]);

  const current = view && view.id === savedViewId ? view : null;
  const savedFilter = useMemo(() => current ? savedBoardFilter(current, boardId) : null, [boardId, current]);
  // The filter on screen: the saved view's, unless the URL carries a change to it.
  const filter = savedFilter && !unsaved ? savedFilter : routeFilter;
  const owner = Boolean(current && canCreate && current.is_owner === 1);
  const actions = ownedViewActions(canShare, current?.visibility ?? "private");
  const editable = owner && actions.edit;
  // Swimlanes picked in the URL that differ from the view's own are a change to save too (D655).
  const dirty = Boolean(current && savedFilter && (!sameFilter(filter, savedFilter) || (swim !== undefined && swim !== (current.display.swimlanes ?? null))));

  /** The 409 VIEW_CHANGED answer carries the current view: offer to reload it. */
  function conflictOr(reason: unknown, fallback: string) {
    const latest = reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { view?: TaskView }).view : undefined;
    if (taskErrorCode(reason) === "VIEW_CHANGED" && latest) {
      setDialog({ kind: "conflict", latest });
      return;
    }
    notify.error(taskErrorMessage(reason, fallback));
  }

  async function save() {
    if (!current || !editable || busy) return;
    setBusy(true);
    try {
      const { view: next } = await updateView(current.id, {
        query: boardViewQueryText(boardId, filter),
        display: { ...current.display, layout: displayLayoutOf(layout, current.display.layout), swimlanes: swim === undefined ? current.display.swimlanes ?? null : swim },
        revision: current.revision
      });
      setView(next);
      announceViewsChanged();
      onSelect(next, { replace: true });
      notify.success(`Saved “${next.name}”`);
    } catch (reason) {
      conflictOr(reason, "Could not save the view");
    } finally {
      setBusy(false);
    }
  }

  async function saveAs(name: string) {
    const swimlanes = swim === undefined ? current?.display.swimlanes ?? null : swim;
    const { view: next } = await createView({ name, query: boardViewQueryText(boardId, filter), display: { layout: displayLayoutOf(layout, undefined), group: "none", sort: "due", ...(swimlanes ? { swimlanes } : {}) } });
    setDialog(null);
    returnFocusRef.current = null;
    setView(next);
    announceViewsChanged();
    notify.success(`Saved “${next.name}” to your views`);
    onSelect(next, { replace: true });
  }

  async function rename(name: string) {
    if (!current) return;
    try {
      const { view: next } = await updateView(current.id, { name, revision: current.revision });
      setView(next);
      setDialog(null);
      announceViewsChanged();
      notify.success(`Renamed to “${next.name}”`);
    } catch (reason) {
      if (taskErrorCode(reason) === "VIEW_CHANGED") conflictOr(reason, "Could not rename the view");
      else throw reason;
    }
  }

  async function duplicate() {
    if (!current) return;
    setDialog(null);
    try {
      const { view: copy } = await duplicateView(current.id);
      announceViewsChanged();
      notify.success(`Duplicated as “${copy.name}”`);
      onSelect(copy);
    } catch (reason) {
      notify.error(taskErrorCode(reason) === "LIMIT_REACHED" ? "You already have 50 views" : taskErrorMessage(reason, "Could not duplicate the view"));
    }
  }

  async function remove() {
    if (!current) return;
    setBusy(true);
    try {
      await deleteView(current.id);
      setDialog(null);
      returnFocusRef.current = null;
      announceViewsChanged();
      onSelect(null, { replace: true });
      const body = viewUndoBody(current);
      notify.success(`Deleted “${current.name}”`, { action: { label: "Undo", onClick: () => {
        createView(body).then(({ view: restored }) => {
          announceViewsChanged();
          notify.success(`Restored “${restored.name}” as a private view`, { action: { label: "Open", onClick: () => onSelectRef.current(restored) } });
        }, (reason) => notify.error(taskErrorMessage(reason, "Could not restore the view")));
      } } });
    } catch (reason) {
      closeDialog();
      notify.error(taskErrorMessage(reason, "Could not delete the view"));
    } finally {
      setBusy(false);
    }
  }

  async function makePrivate() {
    if (!current || busy) return;
    setBusy(true);
    try {
      await saveViewSharing(current.id, "private", []);
      setDialog(null);
      notify.success(`“${current.name}” is private now`);
      void loadView();
      announceViewsChanged();
    } catch (reason) {
      closeDialog();
      notify.error(taskErrorMessage(reason, "Could not make the view private"));
    } finally {
      setBusy(false);
    }
  }

  // The picker lists the views pinned on this board first (D658), then the viewer's own; a view the
  // route names but the lists have not caught up with (just saved) is listed too.
  const isPinned = Boolean(current && pinned.some((item) => item.id === current.id));
  const listed = current && !views.some((item) => item.id === current.id) && !isPinned ? [current, ...views] : views;
  const everyView = [...pinned, ...listed];
  const picker: ReactNode = <span className="task-saved-view-picker">
    <Select<string> variant="chip" label="Saved view" value={savedViewId ?? ALL_CARDS} searchable="auto"
      options={[
        { value: ALL_CARDS, label: "View: All cards" },
        ...pinned.map((item) => ({ value: item.id, label: `View: ${item.name}`, icon: <Pin />, group: "Pinned for everyone" })),
        ...listed.map((item) => ({ value: item.id, label: `View: ${item.name}`, icon: <Bookmark />, ...(pinned.length ? { group: "Your views" } : {}) }))
      ]}
      onChange={(value) => {
        if (value === (savedViewId ?? ALL_CARDS)) return;
        onSelect(value === ALL_CARDS ? null : everyView.find((item) => item.id === value) ?? null);
      }} />
    {current && (owner || canCreate || canPin || own !== null) && <button type="button" className="icon-button task-saved-view-more" onClick={(event) => open({ kind: "menu" }, event.currentTarget)}
      aria-haspopup="dialog" aria-label={`Options for the view ${current.name}`} title="View options"><Ellipsis /></button>}
  </span>;

  const hasFilter = filter.terms.length > 0;
  const filterActions: ReactNode = <>
    {current && dirty && <span className="task-view-dirty task-board-view-dirty" role="status">Unsaved view changes</span>}
    {current && editable && dirty && <button type="button" className="icon-button task-saved-view-discard" onClick={() => onSelect(current)} aria-label="Discard view changes" title="Discard view changes"><Undo2 /></button>}
    {current && editable && dirty && <button type="button" className="primary-button task-saved-view-save" onClick={() => { void save(); }} disabled={busy}><Save aria-hidden="true" /><span>{busy ? "Saving…" : "Save"}</span></button>}
    {canCreate && ((!current && hasFilter) || (current && dirty && !editable)) && <button type="button" className="secondary-button task-saved-view-save" onClick={(event) => open({ kind: "saveAs" }, event.currentTarget)} aria-haspopup="dialog">
      <BookmarkPlus aria-hidden="true" /><span>Save view…</span></button>}
  </>;

  // Pinning (D658): the board's owner or a manager pins a view they own; they, or the view's owner, unpin.
  const canPinThis = Boolean(current && canPin && owner && !isPinned);
  const canUnpinThis = Boolean(current && isPinned && (canPin || current.is_owner === 1));
  const dialogs: ReactNode = <>
    {dialog?.kind === "menu" && current && <ModalDialog title={current.name} eyebrow={isPinned ? `Pinned for everyone${current.is_owner === 1 ? "" : ` · ${current.owner_name}’s`}` : current.is_owner === 1 ? `View · ${viewVisibilityLabel(current.visibility)}` : `${current.owner_name}’s view · read only`} onClose={closeDialog}>
      <div className="move-list task-menu">
        {owner && actions.withdraw && <button className="move-option" autoFocus onClick={() => { void makePrivate(); }} disabled={busy}><Lock aria-hidden="true" /><span>Make private<small>Your Team role is view only: stop sharing to change this view</small></span></button>}
        {owner && actions.edit && <button className="move-option" autoFocus onClick={() => setDialog({ kind: "rename" })}><Pencil aria-hidden="true" /><span>Rename</span></button>}
        {canCreate && <button className="move-option" autoFocus={!owner} onClick={() => setDialog({ kind: "saveAs" })}><BookmarkPlus aria-hidden="true" /><span>Save as a new view…<small>With the filters on screen</small></span></button>}
        {canCreate && <button className="move-option" onClick={() => { void duplicate(); }}><Copy aria-hidden="true" /><span>Duplicate<small>A private copy of the saved view</small></span></button>}
        {own !== null && <button className="move-option" aria-pressed={own.on} autoFocus={!owner && !canCreate} onClick={() => { setDialog(null); setOwnCollapse(!own.on); }}>
          {own.on ? <SquareCheck aria-hidden="true" /> : <Square aria-hidden="true" />}
          <span>Keep this view’s own collapsed columns<small>{own.on ? "Collapsing here leaves the board as it is" : "Off: it shares the board’s collapsed columns"}</small></span>
        </button>}
        {canPinThis && <button className="move-option" onClick={() => { void setPinnedView(true); }} disabled={busy}><Pin aria-hidden="true" /><span>Pin for everyone on this board<small>Everyone who can open the board sees it first in View</small></span></button>}
        {canUnpinThis && <button className="move-option" onClick={() => { void setPinnedView(false); }} disabled={busy}><PinOff aria-hidden="true" /><span>Unpin<small>It stays a view; only the people it is shared with see it</small></span></button>}
        {owner && canShare && <button className="move-option" onClick={() => setDialog({ kind: "share" })}><Share2 aria-hidden="true" /><span>Share…<small>{viewVisibilityLabel(current.visibility)}</small></span></button>}
        {owner && actions.edit && <button className="move-option danger" onClick={() => setDialog({ kind: "delete" })}><Trash2 aria-hidden="true" /><span>Delete view</span></button>}
      </div>
    </ModalDialog>}
    {dialog?.kind === "saveAs" && <NameDialog title={current ? "Save as a new view" : "Save view"} eyebrow="Views" label="View name" initialValue={current ? `${current.name} (copy)`.slice(0, 80) : ""} submitLabel="Save view"
      hint={viewNameHint(canShare)} validate={(value) => validateViewName(value)} onSubmit={saveAs} onCancel={closeDialog} />}
    {dialog?.kind === "rename" && current && <NameDialog title="Rename view" eyebrow="Views" label="View name" initialValue={current.name} submitLabel="Rename" hint="Up to 80 characters."
      validate={(value) => validateViewName(value, current.name)} onSubmit={rename} onCancel={closeDialog} />}
    {dialog?.kind === "share" && current && canShare && <AccessSheet kind="task_view" id={current.id} title={current.name} onClose={closeDialog} onSaved={() => {
      closeDialog();
      notify.success("Access updated");
      void loadView();
    }} />}
    {dialog?.kind === "delete" && current && <ConfirmDialog title="Delete this view?" danger busy={busy} confirmLabel="Delete view"
      message={`Delete “${current.name}”? Its cards stay on the board.${current.visibility !== "private" ? " People you shared it with lose it too." : ""}`}
      onConfirm={() => { void remove(); }} onCancel={closeDialog} />}
    {dialog?.kind === "conflict" && <ConfirmDialog title="This view changed" confirmLabel="Reload the view"
      message={`“${dialog.latest.name}” was changed somewhere else since you opened it. Reload it to see the latest version; your unsaved changes here are dropped.`}
      onConfirm={() => { setView(dialog.latest); setDialog(null); if (dialog.latest.board_id === boardId) onSelect(dialog.latest, { replace: true }); else onLeave(dialog.latest.id); }} onCancel={closeDialog} />}
  </>;

  return {
    /** The saved view on screen, once loaded. */
    view: current,
    /** The route names a view that has not loaded yet: the board waits for its filter. */
    pending: Boolean(savedViewId && !current),
    /** The view's filter on this board (without its board term), or null for All cards. */
    savedFilter,
    /** The filter the board runs. */
    filter,
    /** Whether the picker has anything to offer: views on this board, or the right to save one. */
    showPicker: canCreate || everyView.length > 0,
    /** The view's own collapse while "Keep this view's own collapsed columns" is on (D657), else null (the board's). */
    ownCollapse: own?.on ? own : null,
    /** Saves the view's own collapsed columns or rows (only while it keeps its own). */
    saveOwnColumns: (columns: string[]) => { if (own?.on) void saveOwn({ ...own, columns }, { collapsedColumnIds: columns }, "Could not change the collapsed columns"); },
    saveOwnRows: (rows: string[]) => { if (own?.on) void saveOwn({ ...own, rows }, { collapsedRows: rows }, "Could not change the collapsed rows"); },
    dirty,
    picker,
    filterActions,
    dialogs
  };
}

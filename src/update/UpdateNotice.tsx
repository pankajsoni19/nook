import { useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { appName } from "../appName";
import { buildWatch, type BuildWatch, type UpdateState } from "./buildWatch";
import "./update.css";

/** Whether a new build is waiting, and whether the notice shows (Later hides it). */
export function useUpdateState(watch: BuildWatch = buildWatch): UpdateState {
  return useSyncExternalStore(watch.subscribe, watch.getState, watch.getState);
}

/**
 * The floating notice (docs/ARCHITECTURE.md, Update notice): bottom centre above the toasts, above
 * the phone's bottom bar and safe area (update.css). It stays until Reload or Later, takes no focus
 * when it appears (a polite status), and its buttons are in the tab order.
 */
export function UpdateNotice({ state, onReload, onLater }: { state: UpdateState; onReload: () => void; onLater: () => void }) {
  if (!state.shown) return null;
  return <div className="update-notice" role="status" aria-live="polite" aria-label="Update available">
    <RefreshCw className="update-notice-icon" aria-hidden="true" />
    <p>A new version of {appName()} is available</p>
    <div className="update-notice-actions">
      <button type="button" className="action-button secondary" onClick={onLater}>Later</button>
      <button type="button" className="action-button" onClick={onReload}>Reload</button>
    </div>
  </div>;
}

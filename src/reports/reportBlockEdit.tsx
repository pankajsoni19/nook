import { createContext, useCallback, useContext, useRef, type ReactNode } from "react";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import type { ReportBlock, ReportDetail } from "../../shared/reports";
import type { PatchOp } from "../../shared/reportsEdit";
import { editSpec, listVersions, restoreVersion } from "./reportEditApi";
import { codeOf, messageOf } from "./reportsApi";

/**
 * Lane EDIT (D525–D529): what the report page lets its viewer change in place. The owner (with a
 * writing role) removes a block or a section from its header and edits a query's SQL from Inspect;
 * a person at the comment level suggests a query edit instead. Null where nothing changes (readers,
 * a past version, the proposal review, tests).
 */
export type ReportEditing = {
  /** The owner: Remove on block headers and section titles, Edit SQL in Inspect → Query. */
  canEdit: boolean;
  /** The comment level (not an owner): Suggest an edit in Inspect → Query. */
  canSuggest: boolean;
  /** The report changed (a removal, a saved query, an Undo): the page reloads it. */
  onChanged: () => void;
  /** Opens the Changes panel (where a suggestion waits for the owner). */
  openChanges?: (blockId: string | null) => void;
};

export const ReportEditContext = createContext<ReportEditing | null>(null);
export const useReportEditing = () => useContext(ReportEditContext);

export const blockLabel = (block: ReportBlock) => block.title ?? (block.type === "kpi" ? block.label ?? block.column : block.type === "markdown" ? "this text" : block.queryKey);

/** What a header's trash removes: one block, or a section with its blocks. */
export type RemovalTarget =
  | { kind: "block"; block: ReportBlock }
  | { kind: "section"; section: { id: string; title: string }; blockIds: string[] };

/** The ops that remove the target (a section's blocks first, then the section). */
export function removalOps(target: RemovalTarget): PatchOp[] {
  if (target.kind === "block") return [{ op: "remove_block", id: target.block.id }];
  return [...target.blockIds.map((id): PatchOp => ({ op: "remove_block", id })), { op: "remove_section", id: target.section.id }];
}

/** Whether removing the target leaves the report at least one block (the spec needs one). */
export const leavesABlock = (report: Pick<ReportDetail, "spec">, target: RemovalTarget) =>
  report.spec.blocks.length > (target.kind === "block" ? 1 : target.blockIds.length);

/**
 * Undo of a header removal (D526): restores the version that was current before it, only while the
 * removal's version is still the current one (otherwise Versions has every version to restore).
 */
export async function undoToBefore(reportId: string, made: number): Promise<"restored" | "moved_on"> {
  const { versions } = await listVersions(reportId);
  const current = versions.find((item) => item.current);
  if (!current || current.version !== made) return "moved_on";
  const before = versions.filter((item) => item.version < made).sort((a, b) => b.version - a.version)[0];
  if (!before) return "moved_on";
  await restoreVersion(reportId, before.version);
  return "restored";
}

/**
 * Remove from the header (D525, D526): the same confirm as Changes → Arrange, then `remove_block`
 * (and `remove_section`) as a new version, with an Undo toast that restores the version before.
 */
export function useHeaderRemoval(report: Pick<ReportDetail, "id" | "revision" | "spec">, onChanged: () => void): { remove: (target: RemovalTarget) => Promise<void>; confirmElement: ReactNode } {
  const confirm = useConfirm();
  const busy = useRef(false);
  const remove = useCallback(async (target: RemovalTarget) => {
    if (busy.current) return;
    const name = target.kind === "block" ? blockLabel(target.block) : target.section.title;
    if (!leavesABlock(report, target)) {
      notify.warning("A report keeps at least one block; regenerate it or add blocks first");
      return;
    }
    const count = target.kind === "section" ? target.blockIds.length : 0;
    const ok = await confirm.ask({
      title: target.kind === "block" ? `Remove ${name}?` : `Remove the section ${name}?`,
      message: `${count ? `Its ${count === 1 ? "block goes" : `${count} blocks go`} with it. ` : ""}It becomes a new version; Undo, or restore the one before from Versions, to bring it back.`,
      confirmLabel: "Remove",
      danger: true
    });
    if (!ok) return;
    busy.current = true;
    try {
      const saved = await editSpec(report.id, removalOps(target), report.revision);
      onChanged();
      notify.success(`Removed ${name} (version ${saved.version})`, {
        id: `report-removed:${report.id}`,
        action: {
          label: "Undo",
          onClick: () => {
            void undoToBefore(report.id, saved.version).then((outcome) => {
              if (outcome === "restored") notify.success(`${name} is back`);
              else notify.warning("The report changed since; restore a version from Versions");
              onChanged();
            }, (reason: unknown) => notify.error(codeOf(reason).code === "RUN_IN_PROGRESS" ? "The report is running; undo from Versions when it finishes" : messageOf(reason, "Could not undo the removal")));
          }
        }
      });
    } catch (reason) {
      const { code } = codeOf(reason);
      notify.error(code === "REVISION_CONFLICT" ? "The report changed; reload it and try again." : code === "RUN_IN_PROGRESS" ? "The report is running; try when it finishes." : messageOf(reason, "Could not remove it"));
    } finally {
      busy.current = false;
    }
  }, [confirm, onChanged, report]);
  return { remove, confirmElement: confirm.confirmElement };
}

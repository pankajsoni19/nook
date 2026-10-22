import { useEffect, useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Combobox } from "../ui/Combobox";
import { Select, type Option } from "../ui/Select";
import {
  CREATE_ONLY, fixedLevelReason, MODULE_LABELS, parseResourceToken, permissionHelp, permissionLabel, rowModuleChoices, rowPermissionChoices, selectorFor, SELECTOR_KINDS, grantSummary,
  type GrantModule, type GrantRow, type KeyPermission, type PolicySummary, type ResourceKind
} from "./keyGrants";
import { useKeysApi, type ResourceOption } from "./keysApi";

/**
 * The grant builder (access plan §E "New key", step 3): one row per permission. Module → permission
 * → "all" or chosen items. Custom Select and Combobox only (D91); every control is 44 px at 390 px.
 *
 * New key, Rotate, and Edit use it alike (D585): Edit adds, changes, and removes rows; the dialog asks
 * for the password only when the rows add access. A module with one level shows it as text (D587).
 */

let rowCounter = 0;
export const newRowKey = () => `row-${++rowCounter}`;

export function GrantBuilder({ rows, onChange, role, policy, disabled = false }: {
  rows: GrantRow[];
  onChange: (rows: GrantRow[]) => void;
  role: string | undefined;
  policy: PolicySummary | null;
  disabled?: boolean;
}) {
  const [resources, setResources] = useState<Partial<Record<GrantModule, ResourceOption[] | "error">>>({});
  // Settings: your own items; Team → Integrations: only what is shared with the integration.
  const { loadResources } = useKeysApi();
  const needed = [...new Set(rows.filter((row) => row.applies === "chosen").filter((row) => selectorFor(row.module, row.permission)).map((row) => row.module))];

  useEffect(() => {
    for (const module of needed) {
      if (resources[module] !== undefined) continue;
      setResources((current) => ({ ...current, [module]: [] }));
      loadResources(module).then((options) => setResources((current) => ({ ...current, [module]: options })), () => setResources((current) => ({ ...current, [module]: "error" })));
    }
    // needed is derived from rows; resources is read only to skip modules already loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed.join(",")]);

  const update = (key: string, patch: Partial<GrantRow>) => onChange(rows.map((row) => row.key === key ? { ...row, ...patch } : row));
  const remove = (key: string) => onChange(rows.filter((row) => row.key !== key));
  const add = () => {
    const choice = rowModuleChoices(role, policy, rows, null).find((module) => !module.disabled && module.firstPermission);
    if (!choice) return;
    onChange([...rows, { key: newRowKey(), module: choice.value, permission: choice.firstPermission!, applies: "all", resourceIds: [] }]);
  };

  return <div className="grant-builder">
    <ul className="grant-rows" aria-label="Permissions">
      {rows.map((row, index) => <GrantRowEditor key={row.key} row={row} index={index} role={role} policy={policy} disabled={disabled} rows={rows}
        resources={resources[row.module]}
        moduleOptions={rowModuleChoices(role, policy, rows, row.key).map((module) => ({ value: module.value, label: module.label, disabled: module.disabled && module.value !== row.module, description: module.description }))}
        onChange={(patch) => update(row.key, patch)} onRemove={() => remove(row.key)} />)}
    </ul>
    {!rows.length && <p className="grant-empty">No permissions yet.</p>}
    <button type="button" className="action-button secondary grant-add" onClick={add} disabled={disabled || !rowModuleChoices(role, policy, rows, null).some((module) => !module.disabled)}><Plus aria-hidden="true" />Add permission</button>
    <p className="grant-summary" aria-live="polite">{grantSummary(rows)}</p>
  </div>;
}

function GrantRowEditor({ row, index, role, policy, disabled, rows, resources, moduleOptions, onChange, onRemove }: {
  row: GrantRow;
  rows: readonly GrantRow[];
  index: number;
  role: string | undefined;
  policy: PolicySummary | null;
  disabled: boolean;
  resources: ResourceOption[] | "error" | undefined;
  moduleOptions: Option<GrantModule>[];
  onChange: (patch: Partial<GrantRow>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const opener = useKeysApi().opener ?? "you";
  const selector = selectorFor(row.module, row.permission);
  const permissions: Option<KeyPermission>[] = rowPermissionChoices(row.module, role, policy, rows, row.key).map((choice) => ({ value: choice.value, label: choice.label, description: choice.description, disabled: choice.disabled && choice.value !== row.permission }));
  // D587: a module with one level has nothing to choose, so its level is text with the reason.
  const fixedReason = fixedLevelReason(row.module);
  // Wave 44 (AC-E): Chat → Read is everything (agents, chats, knowledge bases) or chosen knowledge bases to search.
  const readsChat = row.module === "agents" && row.permission === "read";
  const appliesOptions: Option<"all" | "chosen">[] = selector ? [
    readsChat
      ? { value: "all", label: "Everything", description: `Agents, chats, and every knowledge base ${opener} can open` }
      : { value: "all", label: `All ${selector.many}`, description: `Every ${selector.one} ${opener} can open, now and later` },
    readsChat
      ? { value: "chosen", label: "Chosen knowledge bases", description: "Only searching the knowledge bases you pick; no agents or chats" }
      : { value: "chosen", label: `Chosen ${selector.many}`, description: `Only the ${selector.many} you pick` }
  ] : [];
  const writable = row.permission !== "read";
  // A module may offer several kinds; a row lists only those its permission names (Wave 44: Chat → Read lists knowledge bases).
  const resourceOptions: Option[] = resources === "error" || !resources ? [] : resources.filter((option) => !selector || selector.kinds.includes(parseResourceToken(option.value)?.kind as ResourceKind)).map((option) => ({
    value: option.value, label: option.label,
    description: writable && option.readOnly ? "Views can only be read through a key" : writable && !option.writable ? "You can only view this one" : option.description,
    disabled: writable && !option.writable
  }));
  // Chosen items leave the list (their chips hold them, with ×), so a pick never reads as a no-op (Friction 3).
  const unchosen = resourceOptions.filter((option) => !row.resourceIds.includes(option.value));
  const labels = { module: `${id}-module`, permission: `${id}-permission`, applies: `${id}-applies` };

  return <li className="grant-row">
    <div className="grant-row-head">
      <span className="grant-row-number">Permission {index + 1}</span>
      <button type="button" className="icon-button grant-remove" onClick={onRemove} disabled={disabled} aria-label={`Remove ${MODULE_LABELS[row.module]}: ${permissionLabel(row.module, row.permission)}`}><Trash2 /></button>
    </div>
    <div className="grant-row-fields">
      <div className="grant-field"><span id={labels.module}>Module</span>
        <Select<GrantModule> labelledBy={labels.module} label="Module" value={row.module} options={moduleOptions} disabled={disabled}
          onChange={(module) => {
            const first = rowPermissionChoices(module, role, policy, rows, row.key).find((choice) => !choice.disabled)?.value ?? "read";
            onChange({ module, permission: first, applies: "all", resourceIds: [] });
          }} />
      </div>
      <div className="grant-field"><span id={labels.permission}>Permission</span>
        {fixedReason
          ? <div className="grant-fixed" title={fixedReason} data-fixed-level=""><span>{permissionLabel(row.module, row.permission)}</span><span className="grant-fixed-reason">{fixedReason}</span></div>
          : <Select<KeyPermission> labelledBy={labels.permission} label="Permission" value={row.permission} options={permissions} disabled={disabled}
            onChange={(permission) => onChange(CREATE_ONLY.has(`${row.module}:${permission}`) ? { permission, applies: "all", resourceIds: [] } : { permission })} />}
      </div>
      {selector && <div className="grant-field"><span id={labels.applies}>Applies to</span>
        <Select<"all" | "chosen"> labelledBy={labels.applies} label="Applies to" value={row.applies} options={appliesOptions} disabled={disabled}
          onChange={(applies) => onChange({ applies, resourceIds: applies === "all" ? [] : row.resourceIds })} />
      </div>}
    </div>
    {selector && row.applies === "chosen" && <div className="grant-resources">
      {resources === "error" ? <p className="form-error" role="alert">Could not load your {selector.many}.</p>
        : <Combobox multiple backspaceRemoves={false} label={`Chosen ${selector.many}`} placeholder={`Choose ${selector.many}…`} placeholderWithValues={`Add another ${selector.one}…`} value={row.resourceIds} options={unchosen}
          selectedOptions={row.resourceIds.map((value) => resourceOptions.find((option) => option.value === value) ?? { value, label: "An item you cannot open now" })}
          emptyText={resources && resources.length === 0 ? `You have no ${selector.many} to choose` : resourceOptions.length && !unchosen.length ? `Every ${selector.one} is chosen` : "No matches"} disabled={disabled}
          onChange={(resourceIds) => onChange({ resourceIds })} maxSelected={100} />}
    </div>}
    <p className="grant-help">{permissionHelp(row.module, row.permission)}</p>
  </li>;
}

import { useContext } from "react";
import { useDisabledModules } from "../modules";
import { parseRoute, type Route } from "../router";
import { RoleContext } from "../team/roleAccess";
import type { Role } from "../team/teamRoles";
import { notify } from "../ui/notify";
import { readyWorkspaceModules, type QuickActionDef } from "../workspaceModules";

/** The quick actions a viewer gets: ready modules that are on, without those hidden for their role. */
export function visibleQuickActions(disabled: readonly string[], role: Role | undefined): Array<QuickActionDef & { module: string }> {
  return readyWorkspaceModules()
    .filter((module) => !disabled.includes(module.id))
    .flatMap((module) => (module.quickActions ?? []).map((action) => ({ ...action, module: module.id })))
    .filter((action) => !role || !action.hiddenFor?.includes(role));
}

/**
 * Today's Quick actions row (§B.11, D836): "Start timer", "New poll", "Log a call", one button each,
 * registered by the workspace modules that are on. Nothing renders while no module offers one, so
 * Today looks as it always did until a module ships.
 */
export function QuickActions({ onOpenRoute }: { onOpenRoute: (route: Route) => void }) {
  const disabled = useDisabledModules();
  const role = useContext(RoleContext);
  const actions = visibleQuickActions(disabled, role);
  if (actions.length === 0) return null;
  const context = { openPath: (path: string) => onOpenRoute(parseRoute(path)), flash: (message: string) => notify.info(message) };
  return <>
    <p className="today-launcher-label today-quick-label" aria-hidden="true">Quick actions</p>
    <ul className="today-quick-actions" aria-label="Quick actions">
      {actions.map(({ id, module, label, icon: Icon, href, run }) => <li key={`${module}:${id}`}>
        {href && !run
          ? <a className="today-quick-action" href={href} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            context.openPath(href);
          }}><Icon aria-hidden="true" />{label}</a>
          : <button type="button" className="today-quick-action" onClick={() => { void run?.(context); }}><Icon aria-hidden="true" />{label}</button>}
      </li>)}
    </ul>
  </>;
}

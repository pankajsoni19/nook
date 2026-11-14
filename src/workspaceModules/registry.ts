import { shortIdOfSegment } from "../../shared/friendlyUrls";
import { itemIdForShortId, type ItemKind } from "../routeNames";
import type { PendingLink } from "../router";
import { registerBoardHeaderItem, registerCardFaceBadge, registerCardHeaderAction, registerCardSection, registerTimelineDecoration } from "../ui/cardSlots";
import { registerEmbedKind, registerSlashItem } from "../editor/moduleEmbedRegistry";
import { registerItemSection } from "../ui/itemSlots";
import { registerMemberAction } from "../ui/memberSlots";
import { WORKSPACE_MODULE_IDS, type WorkspaceClientModule, type WorkspaceModuleId, type WorkspaceRoute } from "./types";

/**
 * The client module registry (D832). A leaf: it imports only other leaf registries, so the router,
 * src/modules.ts, Today, and tests can read it without import cycles. `src/workspaceModules/index.ts`
 * fills it with the seven module files; tests register a throwaway module the same way.
 */
const modules = new Map<WorkspaceModuleId, WorkspaceClientModule>();
const listeners = new Set<(module: WorkspaceClientModule) => void>();

/**
 * Registers (or replaces) one module. A ready module's card slots, embeds, and slash items go into
 * their registries at once; listeners (Today's sections) hear about it too. A module that is not
 * ready registers nothing but its name, so it stays hidden everywhere (D800).
 */
export function registerWorkspaceClientModule(module: WorkspaceClientModule) {
  modules.set(module.id, module);
  if (!module.ready) return;
  for (const section of module.cardSections ?? []) registerCardSection({ ...section, module: module.id });
  for (const badge of module.cardFaceBadges ?? []) registerCardFaceBadge({ ...badge, module: module.id });
  for (const action of module.cardHeaderActions ?? []) registerCardHeaderAction({ ...action, module: module.id });
  for (const decoration of module.timelineDecorations ?? []) registerTimelineDecoration({ ...decoration, module: module.id });
  for (const item of module.boardHeaderItems ?? []) registerBoardHeaderItem({ ...item, module: module.id });
  for (const embed of module.embedRenderers ?? []) registerEmbedKind({ ...embed, module: module.id });
  for (const item of module.slashItems ?? []) registerSlashItem({ ...item, module: module.id });
  for (const section of module.itemSections ?? []) registerItemSection({ ...section, module: module.id });
  for (const action of module.memberActions ?? []) registerMemberAction({ ...action, module: module.id });
  for (const listener of [...listeners]) listener(module);
}

/** Calls `listener` for every ready module registered so far and every one registered later. */
export function onWorkspaceModule(listener: (module: WorkspaceClientModule) => void) {
  for (const module of modules.values()) if (module.ready) listener(module);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Every registered module in Settings order (WORKSPACE_MODULE_IDS), ready or not. */
export const workspaceModules = (): WorkspaceClientModule[] => WORKSPACE_MODULE_IDS.flatMap((id) => modules.get(id) ?? []);
export const readyWorkspaceModules = () => workspaceModules().filter((module) => module.ready);
export const workspaceModule = (id: WorkspaceModuleId): WorkspaceClientModule | null => modules.get(id) ?? null;

/** The ready module whose URL starts with this segment ("contacts" → crm). */
export function workspaceModuleForSegment(segment: string | undefined): WorkspaceClientModule | null {
  if (!segment) return null;
  return readyWorkspaceModules().find((module) => module.segment === segment) ?? null;
}

/**
 * `/<segment>/…` as a route, through the module's `parseRoute` (D833). Null when no ready module owns
 * the segment: the router then opens Home, as for any unknown path, so a hidden module's URL never
 * renders.
 */
export function parseWorkspaceRoute(segments: string[], search: string): WorkspaceRoute | null {
  const [segment, ...rest] = segments;
  const module = workspaceModuleForSegment(segment);
  if (!module) return null;
  const part = module.parseRoute ? module.parseRoute(rest, search) : { path: rest, search: "" };
  return { app: module.id, path: part.path, search: part.search ?? "", ...(part.pending ? { pending: part.pending } : {}) };
}

/** A module route's URL: the module's `formatRoute`, else `/<segment>/<path…><search>`. */
export function formatWorkspaceRoute(route: WorkspaceRoute): string {
  const module = modules.get(route.app);
  if (!module) return "/";
  if (module.formatRoute) return module.formatRoute(route);
  const path = route.path.map((part) => encodeURIComponent(part)).join("/");
  return `/${module.segment}${path ? `/${path}` : ""}${route.search}`;
}

/** The module's home route (its launcher tile, Back from a detail page). */
export const workspaceHomeRoute = (id: WorkspaceModuleId): WorkspaceRoute => ({ app: id, path: [], search: "" });

/**
 * One friendly segment (`grow-mrr-20-k7f3q2ab01`, D773) for a module's `parseRoute`: the item's id
 * when the tab has named it (routeNames.nameItems), else a pending link the app resolves through
 * GET /api/links/:kind/:ref. Null when the segment carries no short id.
 */
export function friendlyWorkspaceItem(kind: ItemKind, segment: string | undefined, url: string): { id: string } | { pending: PendingLink } | null {
  const shortId = shortIdOfSegment(segment);
  if (!shortId) return null;
  const id = itemIdForShortId(kind, shortId);
  return id ? { id } : { pending: { kind, ref: shortId, url } };
}

/** Tests: forget a module registered for one test (its slots stay; tests that add slots clear them). */
export function unregisterWorkspaceClientModuleForTests(id: WorkspaceModuleId) {
  modules.delete(id);
}

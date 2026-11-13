import type { WorkspaceAppProps } from "../workspaceModules/types";
import { TownhallHome } from "./TownhallHome";
import { SessionPage } from "./SessionPage";
import "./townhall.css";

/**
 * Townhall's app (lazy chunk). Routes (module.tsx parses them): `/townhall` (sessions),
 * `/townhall/insights`, `/townhall/<slug>-<shortid>` (a session; `?tab=polls|recap`, `?filter=review`,
 * `?q=<question>`), and `/townhall/<slug>-<shortid>/present` (the presenter view).
 */
export default function TownhallApp(props: WorkspaceAppProps) {
  const [first, second] = props.route.path;
  if (!first) return <TownhallHome {...props} tab="sessions" />;
  if (first === "insights") return <TownhallHome {...props} tab="insights" />;
  return <SessionPage key={first} {...props} segment={first} present={second === "present"} />;
}

import { afterAll, expect, test } from "bun:test";
import { lazy } from "react";
import type { Route } from "../src/router";
import { installDom, render } from "./support/dom";

/**
 * WorkspaceModuleHost (D833) rendered with happy-dom: a path the module opens through `onOpenPath`
 * that is its own moves the module (it re-renders on the new route, one new history entry); any
 * other path goes to App's handler.
 */
installDom("http://nook.test/forms/first");

const { registerWorkspaceClientModule, workspaceModule } = await import("../src/workspaceModules");
const { WorkspaceModuleHost, inModuleRoute } = await import("../src/workspaceModules/WorkspaceModuleHost");
const { formatRoute } = await import("../src/router");
type AppProps = import("../src/workspaceModules").WorkspaceAppProps;

const saved = workspaceModule("forms")!;
afterAll(() => registerWorkspaceClientModule(saved));

function TestApp({ route, onOpenPath }: AppProps) {
  return <main>
    <p className="where">{route.path.join("/") || "home"}</p>
    <button type="button" onClick={() => onOpenPath("/forms/second")}>Second</button>
    <button type="button" onClick={() => onOpenPath("/tasks")}>Tasks</button>
  </main>;
}

test("onOpenPath to a path inside the same module navigates the module; other paths go to App", async () => {
  registerWorkspaceClientModule({ id: "forms", segment: "forms", label: "Forms", icon: saved.icon, description: saved.description, ready: true, app: lazy(async () => ({ default: TestApp })) });
  expect(inModuleRoute("forms", "/forms/second")).toEqual({ app: "forms", path: ["second"], search: "" });
  expect(inModuleRoute("forms", "/tasks")).toBeNull();
  expect(inModuleRoute("forms", "https://elsewhere.example/forms/x")).toBeNull();

  const navigated: Route[] = [];
  const opened: string[] = [];
  const navigate = (route: Route) => { navigated.push(route); window.history.pushState(null, "", formatRoute(route)); };
  const noop = () => undefined;
  const view = await render(<WorkspaceModuleHost id="forms" userId="u1" displayName="Ada" role="member" navigate={navigate} onOpenPath={(path) => { opened.push(path); }} flash={noop} onHome={noop} onSettings={noop} onSignOut={noop} />);
  await view.waitFor(() => view.container.querySelector(".where")?.textContent === "first");

  await view.click(view.button("Second")!);
  await view.waitFor(() => view.container.querySelector(".where")?.textContent === "second");
  expect(navigated).toEqual([{ app: "forms", path: ["second"], search: "" }]);
  expect(window.location.pathname).toBe("/forms/second");
  expect(opened).toEqual([]);

  await view.click(view.button("Tasks")!);
  expect(opened).toEqual(["/tasks"]);
  expect(navigated).toHaveLength(1);
});

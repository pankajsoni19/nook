/**
 * Real pointer drags in Tasks (lane VIEWS2, D662, D668): drives headless Chrome over the DevTools
 * protocol with `Input.dispatchMouseEvent` press, moves, and release, so Chrome's own input pipeline
 * starts each HTML5 drag (no synthetic DragEvent), against a running QA instance.
 *
 *   NOOK_QA_EMAIL=… NOOK_QA_PASSWORD=… bun --no-env-file scripts/dragSmoke.ts http://qa.localhost:22195
 *
 * It signs in as the QA account, makes two boards ("Drag smoke A/B …"), a few cards, tags, and a
 * cross-board view, then checks six drags through the API: a card from your lane to No assignee
 * (lanes by assignee), onto a collapsed Done strip (lanes by state), across swimlane rows and
 * columns on a board, from one tag lane to another, onto a tag lane its board lacks (confirming
 * "Create tag and move"), and across rows and lanes of a cross-board
 * view's swimlanes. It moves its boards to the Bin and deletes
 * its view when done, and exits 1 when a drag did not do what it should. Chrome (CHROME_BIN, default
 * google-chrome) gets an OS-assigned debugging port and its own temporary profile.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Session = { cookie: string; csrf: string; userId: string };
type Point = { x: number; y: number };

const origin = process.argv[2];
if (!origin) {
  console.error("Usage: bun --no-env-file scripts/dragSmoke.ts <origin>  (NOOK_QA_EMAIL and NOOK_QA_PASSWORD set)");
  process.exit(2);
}
const url = new URL(origin);
const base = `http://127.0.0.1:${url.port || 80}`;
const headers = (session?: Session, write = false): Record<string, string> => ({
  "Content-Type": "application/json", Origin: url.origin, Host: url.host,
  ...(session ? { Cookie: session.cookie, ...(write ? { "X-CSRF-Token": session.csrf } : {}) } : {})
});

async function signIn(): Promise<Session> {
  const email = process.env.NOOK_QA_EMAIL, password = process.env.NOOK_QA_PASSWORD;
  if (!email || !password) throw new Error("Set NOOK_QA_EMAIL and NOOK_QA_PASSWORD");
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: headers(), body: JSON.stringify({ email, password }) });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!response.ok || !cookie) throw new Error(`Sign-in failed: HTTP ${response.status}`);
  const body = await response.json() as { csrfToken: string; user: { id: string } };
  return { cookie, csrf: body.csrfToken, userId: body.user.id };
}

async function api<T = any>(session: Session, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${path}`, { method, headers: headers(session, method !== "GET"), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function openChrome(session: Session) {
  const profile = mkdtempSync(join(tmpdir(), "nook-drag-"));
  const chrome = Bun.spawn([process.env.CHROME_BIN ?? "google-chrome", "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await Bun.sleep(100);
    if (existsSync(join(profile, "DevToolsActivePort"))) port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || 0;
  }
  if (!port) throw new Error("Chrome did not report its debugging port");
  let wsUrl = "";
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await Bun.sleep(200);
    try { wsUrl = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? ""; } catch { /* not up yet */ }
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  let id = 0;
  const waiting = new Map<number, (value: any) => void>();
  ws.addEventListener("message", (event) => { const message = JSON.parse(String(event.data)); if (message.id) { waiting.get(message.id)?.(message); waiting.delete(message.id); } });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve) => { const n = ++id; waiting.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Network.enable");
  const [name, ...value] = session.cookie.split("=");
  await send("Network.setCookie", { name, value: value.join("="), domain: url.hostname, path: "/", httpOnly: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1585, height: 1000, deviceScaleFactor: 1, mobile: false });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) throw new Error(`Page script failed: ${JSON.stringify(result.result.exceptionDetails).slice(0, 300)}`);
    return result.result?.result?.value as T;
  };
  return {
    send, evaluate,
    go: async (path: string) => { await send("Page.navigate", { url: url.origin + path }); await Bun.sleep(2800); },
    close: () => { ws.close(); chrome.kill(); rmSync(profile, { recursive: true, force: true }); }
  };
}

type Page = Awaited<ReturnType<typeof openChrome>>;

/** The centre of the first element matching `selector` (scrolled into view), or of its upper part. */
async function point(page: Page, selector: string, scroll = false): Promise<Point> {
  const found = await page.evaluate<Point | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; if (${scroll}) el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 30)) }; })()`);
  if (!found) throw new Error(`Not on the page: ${selector}`);
  return found;
}

/** A real drag: press, twelve moves, release (Input.dispatchMouseEvent only). */
async function drag(page: Page, fromSelector: string, toSelector: string) {
  // The source in view, then both measured where they are (scrolling again would move the source).
  await point(page, fromSelector, true);
  const from = await point(page, fromSelector);
  const to = await point(page, toSelector);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 12; step++) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((to.x - from.x) * step) / 12, y: from.y + ((to.y - from.y) * step) / 12, button: "left", buttons: 1 });
    await Bun.sleep(30);
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await Bun.sleep(1800);
}

const session = await signIn();
const stamp = new Date().toISOString().slice(11, 19);
const made: { boards: string[]; view?: string } = { boards: [] };
const results: Array<[string, boolean, string]> = [];
let page: Page | null = null;
try {
  const board = async (name: string) => {
    const created = await api(session, "POST", "/tasks/boards", { name: `${name} ${stamp}`, template: "kanban" });
    made.boards.push(created.board.id);
    return { id: created.board.id as string, columns: created.columns as Array<{ id: string; name: string; state: string }> };
  };
  const a = await board("Drag smoke A");
  const b = await board("Drag smoke B");
  const tag = async (boardId: string, name: string) => (await api(session, "POST", `/tasks/boards/${boardId}/tags`, { name })).tag.id as string;
  const urgent = await tag(a.id, "Urgent");
  const bug = await tag(a.id, "Bug");
  const card = async (boardId: string, columnId: string, title: string, extra: Record<string, unknown> = {}) =>
    (await api(session, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title, ...extra })).card.id as string;
  const mine = await card(a.id, a.columns[0]!.id, "Smoke mine", { assigneeIds: [session.userId] });
  const loose = await card(b.id, b.columns[0]!.id, "Smoke loose");
  const rowCard = await card(a.id, a.columns[0]!.id, "Smoke row", { assigneeIds: [session.userId] });
  const tagged = await card(a.id, a.columns[0]!.id, "Smoke tagged", { tagIds: [bug] });
  await card(a.id, a.columns[0]!.id, "Smoke urgent", { tagIds: [urgent] });
  const q = `board:${[a.id, b.id].sort().join(",")}`;
  const view = (await api(session, "POST", "/tasks/views", { name: `Drag smoke ${stamp}`, query: q, display: { layout: "board", group: "none", sort: "due" } })).view;
  made.view = view.id;
  const viewPath = (lanes: string) => `/tasks/views/${view.id}?layout=board&group=none&sort=due&lanes=${lanes}&q=${encodeURIComponent(q)}`;
  const cardOf = async (id: string) => (await api(session, "GET", `/tasks/cards/${id}`)).card;
  page = await openChrome(session);

  // 1. Lanes by assignee: your lane to No assignee clears the people.
  await page.go(viewPath("assignee"));
  await drag(page, `[data-lane-key="a:${session.userId}"] [data-card-id="${mine}"]`, `[data-lane-key="none:a"]`);
  const after1 = await cardOf(mine);
  results.push(["person lane to No assignee", after1.assignees.length === 0, `assignees: ${after1.assignees.length}`]);

  // 2. Lanes by state: onto the collapsed Done strip moves the card to its board's done column.
  await api(session, "PUT", `/tasks/views/${view.id}/prefs`, { collapsedLanes: ["s:done"] });
  await page.go(viewPath("state"));
  await drag(page, `[data-lane-key="s:todo"] [data-card-id="${loose}"]`, `[data-lane-key="s:done"] .task-column-strip`);
  const after2 = await cardOf(loose);
  const doneColumn = b.columns.find((column) => column.state === "done")!.id;
  results.push(["onto a collapsed Done strip", after2.column_id === doneColumn, `column: ${after2.column_id === doneColumn ? "done" : after2.column_id}`]);
  await api(session, "PUT", `/tasks/views/${view.id}/prefs`, { collapsedLanes: [] });

  // 3. Swimlanes on a board: your row, first column, to No assignee in the second column.
  await page.go(`/tasks/${a.id}?swim=assignee`);
  const second = a.columns[1]!.id;
  await drag(page, `[data-row-key="a:${session.userId}"] [data-card-id="${rowCard}"]`, `[data-row-key="none:a"] .task-swim-cell[data-column-id="${second}"]`);
  const after3 = await cardOf(rowCard);
  results.push(["across swimlane rows and columns", after3.assignees.length === 0 && after3.column_id === second, `assignees: ${after3.assignees.length}, column moved: ${after3.column_id === second}`]);

  // 4. Lanes by tag: Bug to Urgent swaps the tag.
  await page.go(viewPath("tag"));
  await drag(page, `[data-lane-key="t:bug"] [data-card-id="${tagged}"]`, `[data-lane-key="t:urgent"]`);
  const after4 = await cardOf(tagged);
  results.push(["tag lane to tag lane", after4.tag_ids.length === 1 && after4.tag_ids[0] === urgent, `tags: ${after4.tag_ids.length}`]);

  // 5. A tag lane the card's board lacks: the drop asks, and "Create tag and move" makes it there.
  const bare = await card(b.id, b.columns[0]!.id, "Smoke bare");
  await page.go(viewPath("tag"));
  await drag(page, `[data-lane-key="none:t"] [data-card-id="${bare}"]`, `[data-lane-key="t:urgent"]`);
  await page.evaluate(`(() => { [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Create tag and move")?.click(); return true; })()`);
  await Bun.sleep(1800);
  const bTags = (await api(session, "GET", `/tasks/boards/${b.id}`)).tags as Array<{ id: string; name: string }>;
  const after5 = await cardOf(bare);
  results.push(["create the tag on drop", after5.tag_ids.length === 1 && bTags.find((item) => item.id === after5.tag_ids[0])?.name === "Urgent", `tags: ${after5.tag_ids.length}`]);

  // 6. Swimlanes across boards (lanes by state, rows by person): No assignee in To do to your row in In progress.
  await card(b.id, b.columns[0]!.id, "Smoke anchor", { assigneeIds: [session.userId] });
  const swimCard = await card(b.id, b.columns[0]!.id, "Smoke swim");
  await page.go(`${viewPath("state")}&swim=assignee`);
  await drag(page, `[data-row-key="none:a"] [data-lane-key="s:todo"] [data-card-id="${swimCard}"]`, `[data-row-key="a:${session.userId}"] .task-swim-cell[data-lane-key="s:doing"]`);
  const after6 = await cardOf(swimCard);
  const doing = b.columns.find((column) => column.state === "doing")!.id;
  results.push(["across rows and lanes in a cross-board view", after6.assignees.length === 1 && after6.column_id === doing, `assignees: ${after6.assignees.length}, column moved: ${after6.column_id === doing}`]);
} finally {
  page?.close();
  if (made.view) await api(session, "DELETE", `/tasks/views/${made.view}`).catch(() => undefined);
  for (const boardId of made.boards) await api(session, "DELETE", `/tasks/boards/${boardId}`).catch(() => undefined);
}

for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name} (${detail})`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `${failed} of ${results.length} drags failed` : `All ${results.length} drags passed`);
process.exit(failed || results.length < 6 ? 1 : 0);

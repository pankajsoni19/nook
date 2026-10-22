import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODULE_IDS, type ModuleId } from "../server/moduleIds";

// The docs site (GitHub Pages, .github/workflows/pages.yml): index.html leads with the apps and keeps
// only the latest release; every "What's new in vX" lives on releases.html. Links between the two
// pages resolve, old index.html#whats-new-x-y-z links land on releases.html, and every module has a
// section. The Docker verify stage has no site/, so these run in the repository only.

const root = join(import.meta.dir, "..");
const sitePresent = ["site/index.html", "site/releases.html", "site/app.js"].every((path) => existsSync(join(root, path)));
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Page = { html: string; ids: Set<string>; nav: string[]; hrefs: string[] };
function page(path: string): Page {
  const html = read(path);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!));
  const navBlock = html.slice(html.indexOf("<nav>", html.indexOf('class="sidebar"')), html.indexOf("</nav>", html.indexOf('class="sidebar"')));
  const nav = [...navBlock.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]!);
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
  return { html, ids, nav, hrefs };
}
const pages = () => ({ "index.html": page("site/index.html"), "releases.html": page("site/releases.html") }) as Record<string, Page>;

/** Where a link from `from` lands, or why it does not. */
function resolves(all: Record<string, Page>, from: string, href: string) {
  if (/^(https?:|mailto:)/.test(href) || href.startsWith("./") || href.startsWith("images/")) return true;
  const [file, hash] = href.startsWith("#") ? [from, href.slice(1)] : href.split("#") as [string, string | undefined];
  const target = all[file!];
  if (!target) return false;
  return !hash || target.ids.has(hash);
}

const releaseIds = (releases: Page) => [...releases.html.matchAll(/<section id="(whats-new-[\d-]+)"/g)].map((match) => match[1]!);
const version = () => JSON.parse(read("package.json")).version as string;

test.skipIf(!sitePresent)("every link on both pages resolves, and every nav entry points at a section that exists", () => {
  const all = pages();
  for (const [name, p] of Object.entries(all)) {
    const broken = p.hrefs.filter((href) => !resolves(all, name, href));
    expect({ name, broken }).toEqual({ name, broken: [] });
    expect(p.nav.length).toBeGreaterThan(5);
    expect(p.nav.filter((href) => !resolves(all, name, href))).toEqual([]);
  }
});

test.skipIf(!sitePresent)("index.html keeps one What's new (the latest) and links to every release on releases.html", () => {
  const { "index.html": index, "releases.html": releases } = pages();
  const ids = releaseIds(releases);
  // Release notes are out of the landing page: only the latest box, no version anchors.
  expect([...index.ids].filter((id) => id.startsWith("whats-new"))).toEqual(["whats-new"]);
  expect(index.nav.filter((href) => href.includes("whats-new"))).toEqual(["#whats-new"]);
  expect(index.nav).toContain("releases.html");
  expect(index.html).toContain('href="releases.html">All release notes');
  // Features come before operations and the latest release in the nav.
  expect(index.nav.indexOf("#features")).toBeLessThan(index.nav.indexOf("#quickstart"));
  expect(index.nav.indexOf("#reports")).toBeLessThan(index.nav.indexOf("#whats-new"));
  // releases.html: newest first, one nav link per version, and its first entry is the latest on index.html.
  expect(ids.length).toBeGreaterThan(30);
  expect(releases.nav.filter((href) => href.startsWith("#whats-new-"))).toEqual(ids.map((id) => `#${id}`));
  const latest = /<section id="whats-new"[\s\S]*?What's new in v([\d.]+)</.exec(index.html)![1]!;
  expect(ids[0]).toBe(`whats-new-${latest.replaceAll(".", "-")}`);
  expect(latest).toBe(version());
  for (const p of [index, releases]) expect(p.html).toContain(`<span class="version">v${version()}</span>`);
  expect(index.html).toContain(`<a href="#whats-new">What's new in v${version()}</a>`);
  expect(index.html).toContain(`<b>New in v${version()}</b>`);
});

test.skipIf(!sitePresent)("old index.html#whats-new-x-y-z links redirect to releases.html, and #whats-new stays the latest", () => {
  const source = read("site/app.js");
  const fn = /function hashRedirectTarget\([\s\S]*?\n}/.exec(source)![0];
  const target = new Function(`${fn}; return hashRedirectTarget;`)() as (page: string, id: string, existsHere: boolean) => string | null;
  const { "index.html": index, "releases.html": releases } = pages();
  for (const id of releaseIds(releases)) {
    expect(target("docs", id, index.ids.has(id))).toBe(`releases.html#${id}`);
    expect(target("releases", id, releases.ids.has(id))).toBeNull();
  }
  expect(target("docs", "whats-new-0-40-0", false)).toBe("releases.html#whats-new-0-40-0");
  expect(target("docs", "whats-new", index.ids.has("whats-new"))).toBeNull();
  expect(target("docs", "reports", true)).toBeNull();
  expect(target("docs", "no-such-section", false)).toBeNull();
  // A docs anchor opened on releases.html goes back to index.html.
  expect(target("releases", "mcp", releases.ids.has("mcp"))).toBe("index.html#mcp");
  expect(target("releases", "whats-new", releases.ids.has("whats-new"))).toBe("index.html#whats-new");
  expect(index.html).toContain('<body data-page="docs">');
  expect(releases.html).toContain('<body data-page="releases">');
});

test.skipIf(!sitePresent)("every module a person can turn on has a section and a nav entry on index.html", () => {
  const { "index.html": index } = pages();
  const section: Partial<Record<ModuleId, string>> = { notes: "editor", agents: "chat" };
  const missing = MODULE_IDS.map((id) => section[id] ?? id).filter((id) => !index.html.includes(`<section id="${id}"`) || !index.nav.includes(`#${id}`));
  expect(missing).toEqual([]);
  // Knowledge and the provider setup behind Chat, Knowledge, and Reports.
  for (const id of ["knowledge", "ai-providers", "vault-key"]) expect(index.nav).toContain(`#${id}`);
});

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { distRoot } from "./staticFiles";

/**
 * The build this server serves (update notice, docs/ARCHITECTURE.md): the id the production build
 * wrote into dist/index.html (`<meta name="nook-build">`, vite.config.ts buildIdentity). Sent as
 * `X-Nook-Build` on every API response and by `GET /api/build`, so an open tab sees a new release on
 * its next request. Outside production (no dist served), or without the meta, it is "development",
 * which never offers a reload. index.html is read again when its mtime changes, looked at most once
 * per RECHECK_MS, so a dist replaced under a running server is reported too (staticFiles.ts serves it).
 */

export const DEV_BUILD = "development";
export const BUILD_HEADER = "X-Nook-Build";
export const RECHECK_MS = 5_000;

const META = /<meta name="nook-build" content="([A-Za-z0-9._-]{1,64})"\s*\/?>/;

/** The build id in an index.html, or "development". */
export function buildIdFromHtml(html: string) {
  return META.exec(html)?.[1] ?? DEV_BUILD;
}

type Cache = { id: string; mtimeMs: number; checkedAt: number; root: string };
let cache: Cache | null = null;

/** The build id of `root`/index.html (cached by mtime, rechecked at most every RECHECK_MS). */
export function readBuildId(root: string, now = Date.now()) {
  if (cache && cache.root === root && now - cache.checkedAt < RECHECK_MS) return cache.id;
  const path = join(root, "index.html");
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const id = cache && cache.root === root && cache.mtimeMs === mtimeMs ? cache.id : buildIdFromHtml(readFileSync(path, "utf8"));
    cache = { id, mtimeMs, checkedAt: now, root };
  } catch {
    cache = { id: DEV_BUILD, mtimeMs: -1, checkedAt: now, root };
  }
  return cache.id;
}

/** The build this server serves now. */
export function currentBuildId() {
  return config.isProduction ? readBuildId(distRoot()) : DEV_BUILD;
}

/** Test hook. */
export function resetBuildIdCacheForTests() {
  cache = null;
}

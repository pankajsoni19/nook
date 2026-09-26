import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Comments in server/, src/, and shared/ that point at a test file name one that exists (review L7). */
test("every tests/*.test.ts(x) named in a source comment exists", () => {
  const root = join(import.meta.dir, "..");
  const missing: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx|css)$/.test(entry)) continue;
      for (const match of readFileSync(path, "utf8").matchAll(/tests\/[A-Za-z0-9_./-]+?\.test\.tsx?\b/g)) {
        if (!existsSync(join(root, match[0]))) missing.push(`${path.slice(root.length + 1)} → ${match[0]}`);
      }
    }
  };
  for (const dir of ["server", "src", "shared"]) walk(join(root, dir));
  expect(missing).toEqual([]);
});

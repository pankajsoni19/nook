import type { Database } from "bun:sqlite";

/**
 * The 12-step table rebuild (https://www.sqlite.org/lang_altertable.html#otheralter), generalized from
 * 039's `rebuildApiKeyGrants` for the workspace modules' CHECK-list widening (migration 085, D800, T510).
 *
 * The new table's SQL is the stored CREATE statement with edits applied (widened `IN (…)` lists, added
 * columns), so every column, default, foreign key, and other CHECK stays exactly as it was. Every row
 * and column is copied; the table's own indexes and triggers are re-created from their stored SQL; the
 * rename runs in legacy mode so triggers and views on other tables that name the table are not
 * rewritten (039). The row count is compared before and after and the migration fails (rolling back)
 * on any difference.
 */

/** The quoted words of one `<column> IN (…)` list in a CREATE TABLE statement (exact column name). */
export function inListWords(sql: string, column: string): string[] {
  const match = new RegExp(`(?<![A-Za-z0-9_])${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(sql);
  return match ? [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((item) => item[1]!) : [];
}

/** The SQL with the `<column> IN (…)` list widened by `added` (existing words kept, in order). */
export function widenInList(sql: string, column: string, added: readonly string[]): string {
  const pattern = new RegExp(`((?<![A-Za-z0-9_])${column}\\s+IN\\s*\\()([^)]*)(\\))`);
  const match = pattern.exec(sql);
  if (!match) throw new Error(`No ${column} IN (...) list to widen`);
  const current = inListWords(sql, column);
  const words = [...current, ...added.filter((word) => !current.includes(word))];
  return sql.replace(pattern, (_all, open: string, _list: string, close: string) => `${open}${words.map((word) => `'${word}'`).join(",")}${close}`);
}

/** The stored CREATE statement of a table, or null. */
export const tableSql = (db: Database, table: string) =>
  (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | null)?.sql ?? null;

/**
 * Rebuilds `table` from `nextSql` (its CREATE statement, naming the same table). `columns` are copied
 * by name from the old table (every column it has, by default). Throws when the counts differ.
 */
export function rebuildTable(db: Database, table: string, nextSql: string, options: { extraColumns?: readonly string[] } = {}) {
  const temp = `${table}_rebuild`;
  const header = new RegExp(`^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"${table}"|${table})\\s*\\(`, "i");
  if (!header.test(nextSql)) throw new Error(`The new SQL must create ${table}`);
  const columns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
    .filter((name) => !(options.extraColumns ?? []).includes(name));
  const dependents = db.query("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table) as Array<{ type: string; name: string; sql: string }>;
  const before = (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  const list = columns.map((name) => `"${name}"`).join(", ");
  db.exec(nextSql.replace(header, `CREATE TABLE ${temp} (`));
  db.exec(`INSERT INTO ${temp} (${list}) SELECT ${list} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec("PRAGMA legacy_alter_table = ON");
  try {
    db.exec(`ALTER TABLE ${temp} RENAME TO ${table}`);
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
  }
  for (const dependent of dependents) db.exec(dependent.sql);
  const after = (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  if (after !== before) throw new Error(`Rebuilding ${table} changed its row count from ${before} to ${after}`);
  return { rows: after };
}

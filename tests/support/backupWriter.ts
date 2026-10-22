/**
 * A concurrent writer for the backup consistency test (lane BACKUP): `bun --no-env-file
 * tests/support/backupWriter.ts <database> <ms>` commits, as fast as it can for <ms>, transactions that
 * each insert the same counter into `pair_a` and `pair_b` (and a page of filler into `pair_a`), the way
 * the server writes beside a running backup. Any consistent snapshot has equal counts and equal maxima
 * in both tables. Prints the number of transactions it committed.
 */
import { Database } from "bun:sqlite";

const [path, msRaw] = process.argv.slice(2);
if (!path || !msRaw) {
  console.error("Usage: bun tests/support/backupWriter.ts <database> <ms>");
  process.exit(2);
}
const db = new Database(path, { readwrite: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
const insertA = db.query("INSERT INTO pair_a (n, filler) VALUES (?, ?)");
const insertB = db.query("INSERT INTO pair_b (n) VALUES (?)");
const filler = "x".repeat(2000);
let n = (db.query("SELECT COALESCE(MAX(n), 0) AS n FROM pair_a").get() as { n: number }).n;
const until = Date.now() + Number(msRaw);
const pair = db.transaction((value: number) => {
  insertA.run(value, filler);
  insertB.run(value);
});
let committed = 0;
while (Date.now() < until) {
  n += 1;
  pair(n);
  committed += 1;
  // Yield now and then so the process stays responsive, as the server would.
  if (committed % 50 === 0) await Bun.sleep(0);
}
db.close();
console.log(committed);

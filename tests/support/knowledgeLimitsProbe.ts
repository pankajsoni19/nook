/**
 * Run as a separate `bun --no-env-file` process by tests/knowledgeDeferred.test.ts, twice on one data
 * directory, so the knowledge limits kept in SQLite (2026-10-08) are proven to survive a restart:
 *
 * - `first`: makes an account and a knowledge base, runs Re-index all (allowed), and charges a key's
 *   search minute to its limit (60), the 61st refused. The process then exits (the "restart").
 * - `second`: a new process on the same data: Re-index all is refused (429 `REINDEX_RATE_LIMITED`
 *   with its Retry-After), and the key's day still holds the 60 searches the first process made.
 *
 * Nothing is served and nothing leaves the process. Prints one JSON line with what it observed.
 */
const [phase, dataDir] = process.argv.slice(2) as ["first" | "second", string];
const origin = "http://localhost:24919";
Object.assign(process.env, {
  DATA_DIR: dataDir,
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "24919",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  ALLOW_REGISTRATION: "false",
  TOTP_POLICY: "optional",
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_EMAILS: "",
  MIN_FREE_DISK_BYTES: "0",
  PUSH_ENABLED: "false"
});

const { db } = await import("../../server/db");
const { reindexAll } = await import("../../server/knowledge/index");
const { chargeKeySearch, KNOWLEDGE_SEARCH_LIMITS } = await import("../../server/knowledge/limits");
const { AgentError } = await import("../../server/agents/status");
type KbRow = import("../../server/knowledge/service").KbRow;

const ownerId = "00000000-0000-4000-8000-0000000000a1";
const kbId = "00000000-0000-4000-8000-0000000000b1";
const keyId = "00000000-0000-4000-8000-0000000000c1";
const timestamp = new Date().toISOString();
if (phase === "first") {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, 'kbdef-probe@nook.test', 'Probe', 'x', ?)").run(ownerId, timestamp);
  db.query("INSERT INTO knowledge_bases (id, owner_id, name, provider_id, embedding_model, dims, created_at, updated_at) VALUES (?, ?, 'Probe', NULL, 'text-embedding-3-small', 512, ?, ?)").run(kbId, ownerId, timestamp, timestamp);
}
const kb = db.query("SELECT * FROM knowledge_bases WHERE id = ?").get(kbId) as KbRow;
let reindex = "ok";
let retryAfterSeconds: number | null = null;
try {
  reindexAll({ userId: ownerId }, kb);
} catch (error) {
  if (!(error instanceof AgentError)) throw error;
  reindex = error.code;
  retryAfterSeconds = typeof error.details.retryAfterSeconds === "number" ? error.details.retryAfterSeconds : null;
}
let searches = 0;
if (phase === "first") {
  for (let index = 0; index < KNOWLEDGE_SEARCH_LIMITS.minute.limit; index += 1) if (chargeKeySearch(keyId) === 0) searches += 1;
}
// The day window persists exactly (the minute slides, so a run across a minute boundary may admit one).
const dayCount = (db.query("SELECT count FROM agent_rate_limits WHERE bucket = ?").get(`kb_search_day:${keyId}`) as { count: number } | null)?.count ?? 0;
const searchRetryAfter = phase === "first" ? chargeKeySearch(keyId) : 0;
console.log(JSON.stringify({ phase, reindex, retryAfterSeconds, searches, refusedSearch: searchRetryAfter > 0, dayCount }));
db.close();
process.exit(0);

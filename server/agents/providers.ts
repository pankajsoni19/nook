import { audit, db, now } from "../db";
import { AGENT_BOUNDS, DEFAULT_BASE_URL, DEFAULT_COMPAT, DEFAULT_MODEL, type ProviderCompat, type ProviderSummary } from "../../shared/agents";
import { checkEgressUrl, EgressError } from "./egress";
import { completeStreaming, listModels, ProviderError, type ProviderConnection } from "./loop";
import { openSecret, sealSecret, secretHint } from "./secrets";
import { readAgentSettings } from "./settings";
import { AgentError } from "./status";

/**
 * Providers (plan §4.1): at most five OpenAI-compatible endpoints, one of them the default. The API
 * key is write-only (D354): `PUT`/`PATCH` take `apiKey`, reads return `hasSecret` and `hint`, and
 * the plaintext is opened only inside `connectionFor` for the duration of one request.
 */

export type ProviderRow = {
  id: string; name: string; base_url: string; api_key_ct: string | null; api_key_hint: string | null; default_model: string;
  embedding_model: string | null; embedding_dims: number | null; compat_json: string; prices_json: string | null; is_default: number;
  revision: number; created_at: string; updated_at: string;
};

export function parseCompat(json: string | null): ProviderCompat {
  let value: Partial<ProviderCompat> = {};
  try { value = json ? JSON.parse(json) as Partial<ProviderCompat> : {}; } catch { value = {}; }
  return {
    tokenParam: value.tokenParam === "max_tokens" ? "max_tokens" : DEFAULT_COMPAT.tokenParam,
    streamUsage: value.streamUsage !== false,
    supportsTools: value.supportsTools !== false,
    contextTokens: typeof value.contextTokens === "number" && value.contextTokens >= 1024 && value.contextTokens <= 10_000_000 ? Math.floor(value.contextTokens) : DEFAULT_COMPAT.contextTokens
  };
}

export const providerSummary = (row: ProviderRow): ProviderSummary => ({
  id: row.id, name: row.name, baseUrl: row.base_url, defaultModel: row.default_model, embeddingModel: row.embedding_model, embeddingDims: row.embedding_dims,
  compat: parseCompat(row.compat_json), isDefault: row.is_default === 1, hasSecret: row.api_key_ct !== null, hint: row.api_key_ct ? row.api_key_hint : null,
  revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
});

export function listProviders(): ProviderSummary[] {
  return (db.query("SELECT * FROM agent_providers ORDER BY is_default DESC, created_at").all() as ProviderRow[]).map(providerSummary);
}

export function providerRow(id: string): ProviderRow {
  const row = db.query("SELECT * FROM agent_providers WHERE id = ?").get(id) as ProviderRow | null;
  if (!row) throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

export type ProviderInput = {
  name: string; baseUrl?: string; apiKey?: string | null; defaultModel?: string; embeddingModel?: string | null; embeddingDims?: number | null;
  compat?: Partial<ProviderCompat>; isDefault?: boolean;
};

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    checkEgressUrl(trimmed);
  } catch (error) {
    throw new AgentError(400, "INVALID", error instanceof EgressError ? error.message : "The base URL is not valid", { field: "baseUrl" });
  }
  return trimmed;
}

const compatJson = (current: ProviderCompat, patch: Partial<ProviderCompat> | undefined) => JSON.stringify(parseCompat(JSON.stringify({ ...current, ...(patch ?? {}) })));

export function createProvider(actorId: string, input: ProviderInput): ProviderSummary {
  return db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM agent_providers").get() as { count: number }).count;
    if (count >= AGENT_BOUNDS.providers) throw new AgentError(409, "LIMIT_REACHED", `At most ${AGENT_BOUNDS.providers} providers can be configured`);
    const id = crypto.randomUUID();
    const timestamp = now();
    const makeDefault = input.isDefault === true || count === 0;
    if (makeDefault) db.query("UPDATE agent_providers SET is_default = 0 WHERE is_default = 1").run();
    const apiKey = input.apiKey?.trim() || null;
    db.query(`INSERT INTO agent_providers (id, name, base_url, api_key_ct, api_key_hint, default_model, embedding_model, embedding_dims, compat_json, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.name.trim(), normalizeBaseUrl(input.baseUrl ?? DEFAULT_BASE_URL), apiKey ? sealSecret("provider", id, apiKey) : null, apiKey ? secretHint(apiKey) : null,
      (input.defaultModel ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL, input.embeddingModel?.trim() || null, input.embeddingDims ?? null,
      compatJson(DEFAULT_COMPAT, input.compat), makeDefault ? 1 : 0, timestamp, timestamp
    );
    audit(actorId, null, "agents.provider.create", { providerId: id, hasSecret: apiKey !== null });
    return providerSummary(providerRow(id));
  })();
}

export function updateProvider(actorId: string, id: string, input: Partial<ProviderInput> & { expectedRevision: number; removeSecret?: boolean }): ProviderSummary {
  return db.transaction(() => {
    const row = providerRow(id);
    if (row.revision !== input.expectedRevision) throw new AgentError(409, "REVISION_MISMATCH", "This provider changed elsewhere; reload and try again", { revision: row.revision });
    const apiKey = input.apiKey?.trim() || null;
    const apiKeyCt = input.removeSecret ? null : apiKey ? sealSecret("provider", id, apiKey) : row.api_key_ct;
    const hint = input.removeSecret ? null : apiKey ? secretHint(apiKey) : row.api_key_hint;
    if (input.isDefault === true) db.query("UPDATE agent_providers SET is_default = 0 WHERE is_default = 1 AND id <> ?").run(id);
    if (input.isDefault === false && row.is_default === 1) throw new AgentError(409, "DEFAULT_REQUIRED", "Make another provider the default first");
    db.query(`UPDATE agent_providers SET name = ?, base_url = ?, api_key_ct = ?, api_key_hint = ?, default_model = ?, embedding_model = ?, embedding_dims = ?, compat_json = ?,
      is_default = ?, revision = revision + 1, updated_at = ? WHERE id = ?`).run(
      (input.name ?? row.name).trim(), input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : row.base_url, apiKeyCt, hint,
      (input.defaultModel ?? row.default_model).trim() || DEFAULT_MODEL, input.embeddingModel !== undefined ? input.embeddingModel?.trim() || null : row.embedding_model,
      input.embeddingDims !== undefined ? input.embeddingDims : row.embedding_dims, compatJson(parseCompat(row.compat_json), input.compat),
      input.isDefault === true ? 1 : row.is_default, now(), id
    );
    audit(actorId, null, "agents.provider.update", { providerId: id, secretChanged: apiKey !== null || input.removeSecret === true });
    return providerSummary(providerRow(id));
  })();
}

export function deleteProvider(actorId: string, id: string) {
  db.transaction(() => {
    const row = providerRow(id);
    db.query("DELETE FROM agent_providers WHERE id = ?").run(id);
    if (row.is_default === 1) {
      const next = db.query("SELECT id FROM agent_providers ORDER BY created_at LIMIT 1").get() as { id: string } | null;
      if (next) db.query("UPDATE agent_providers SET is_default = 1 WHERE id = ?").run(next.id);
    }
    audit(actorId, null, "agents.provider.delete", { providerId: id });
  })();
  modelCache.delete(id);
}

/** The default provider row, or null when none is configured. */
export function defaultProvider(): ProviderRow | null {
  const settings = readAgentSettings();
  if (settings.defaultProviderId) {
    const chosen = db.query("SELECT * FROM agent_providers WHERE id = ?").get(settings.defaultProviderId) as ProviderRow | null;
    if (chosen) return chosen;
  }
  return (db.query("SELECT * FROM agent_providers WHERE is_default = 1").get() as ProviderRow | null)
    ?? (db.query("SELECT * FROM agent_providers ORDER BY created_at LIMIT 1").get() as ProviderRow | null);
}

/**
 * The connection a run uses: the agent's provider when set and still present, else the default.
 * The API key is opened here and lives on the returned object for one request only.
 */
export function connectionFor(providerId: string | null, model: string | null): ProviderConnection {
  const row = (providerId ? db.query("SELECT * FROM agent_providers WHERE id = ?").get(providerId) as ProviderRow | null : null) ?? defaultProvider();
  if (!row) throw new AgentError(409, "NO_PROVIDER", "No model provider is configured; an admin sets one in Settings → AI");
  return {
    id: row.id,
    baseUrl: row.base_url,
    apiKey: row.api_key_ct ? openSecret("provider", row.id, row.api_key_ct) : null,
    model: model?.trim() || row.default_model,
    compat: parseCompat(row.compat_json)
  };
}

const modelCache = new Map<string, { at: number; models: string[] }>();
const MODEL_CACHE_MS = 10 * 60_000;

/** `GET /models` of a provider, cached for ten minutes (plan §4.1). */
export async function providerModels(id: string, options: { fresh?: boolean } = {}): Promise<{ models: string[]; cachedAt: string }> {
  const cached = modelCache.get(id);
  if (cached && !options.fresh && Date.now() - cached.at < MODEL_CACHE_MS) return { models: cached.models, cachedAt: new Date(cached.at).toISOString() };
  const connection = connectionFor(id, null);
  const models = await listModels(connection);
  modelCache.set(id, { at: Date.now(), models });
  return { models, cachedAt: new Date().toISOString() };
}

export type ProviderTest = {
  ok: boolean;
  models: { ok: boolean; count: number | null; latencyMs: number | null; error: string | null };
  completion: { ok: boolean; model: string | null; latencyMs: number | null; error: string | null };
};

const describe = (error: unknown) => error instanceof ProviderError || error instanceof EgressError || error instanceof AgentError ? `${error.code}: ${error.message}` : "Failed";

/** Test (plan §4.1): the model list and a one-token completion, reported as latency and counts only. */
export async function testProvider(id: string): Promise<ProviderTest> {
  const connection = connectionFor(id, null);
  const result: ProviderTest = { ok: false, models: { ok: false, count: null, latencyMs: null, error: null }, completion: { ok: false, model: null, latencyMs: null, error: null } };
  const started = Date.now();
  try {
    const models = await listModels(connection);
    modelCache.set(id, { at: Date.now(), models });
    result.models = { ok: true, count: models.length, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    result.models.error = describe(error);
  }
  const again = Date.now();
  try {
    const reply = await completeStreaming(connection, { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxOutputTokens: 1 }, new AbortController().signal, () => undefined);
    result.completion = { ok: true, model: reply.model ?? connection.model, latencyMs: Date.now() - again, error: null };
  } catch (error) {
    result.completion.error = describe(error);
  }
  result.ok = result.completion.ok;
  return result;
}

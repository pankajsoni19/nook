/**
 * D679 (lane FILT3): a DateTime date range written in a zone (`toDate(col, '<zone>') BETWEEN
 * {id_from:Date} AND {id_to:Date}`, D672) that is no longer the report's zone, after the owner changed
 * the schedule's zone. Its presets resolve in the new zone while its days are still counted in the old
 * one, so Nook proposes the rewrite in Changes (never silently) and the filter shows a notice until the
 * owner applies it.
 *
 * Pure: the server (the proposal) and the client (the notice) share it.
 */

type Spec = { parameters: ReadonlyArray<{ id: string; label: string; type: string }>; queries: ReadonlyArray<{ key: string; sql: string }> };

/** A date range whose days some queries count in another zone than the report's. */
export type StaleZoneFilter = { paramId: string; label: string; zones: string[]; queryKeys: string[] };

const ZONED = /toDate\(\s*(`(?:[^`\\]|\\.)+`|[A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)(\s+BETWEEN\s+\{\s*([a-z][a-z0-9_]*)_from\s*:\s*Date\s*\}\s+AND\s+\{\s*\4_to\s*:\s*Date\s*\})/g;
const unquote = (zone: string) => zone.replace(/\\(.)/g, "$1");
const quote = (zone: string) => `'${zone.replace(/[\\']/g, "\\$&")}'`;

/** The report's date ranges whose zoned condition names another zone than `reportZone`, each with the queries and old zones. */
export function staleZoneFilters(spec: Spec, reportZone: string): StaleZoneFilter[] {
  const ranges = new Map(spec.parameters.filter((param) => param.type === "date_range").map((param) => [param.id, param.label]));
  const found = new Map<string, StaleZoneFilter>();
  for (const query of spec.queries) {
    for (const match of query.sql.matchAll(ZONED)) {
      const paramId = match[4]!;
      const zone = unquote(match[2]!);
      if (!ranges.has(paramId) || zone === reportZone) continue;
      const item = found.get(paramId) ?? { paramId, label: ranges.get(paramId)!, zones: [], queryKeys: [] };
      if (!item.zones.includes(zone)) item.zones.push(zone);
      if (!item.queryKeys.includes(query.key)) item.queryKeys.push(query.key);
      found.set(paramId, item);
    }
  }
  return [...found.values()];
}

/** The SQL with each zoned day condition on one of `paramIds` counted in `zone` instead (nothing else changes). */
export function rezonedSql(sql: string, paramIds: ReadonlySet<string>, zone: string): string {
  return sql.replace(ZONED, (whole, column: string, _old: string, tail: string, paramId: string) => paramIds.has(paramId) ? `toDate(${column}, ${quote(zone)})${tail}` : whole);
}

import { canonicalValues, optionParentsOf, valueLabel, type ParamValues, type ReportParameter } from "../../shared/reportParams";
import { getParamOptions } from "./reportViewApi";

/**
 * Linked filters on the client (D560, D561): a select whose options query reads earlier parameters
 * lists its choices for those parameters' values. When a parent changes, the child's picks that are not
 * among its new choices drop, with a note ("Route reset: not in DE").
 */

/** A linked select's parents' values (the ones its list is read for); undefined when it has no parents. */
export function parentValuesOf(param: ReportParameter, parameters: readonly ReportParameter[], values: ParamValues): ParamValues | undefined {
  const parents = optionParentsOf(param, parameters);
  if (!parents.length) return undefined;
  return Object.fromEntries(parameters.filter((item) => parents.includes(item.id)).map((item) => [item.id, values[item.id] ?? item.default]));
}

/** The key a linked select's list is cached under on the client ("" when it has no parents). */
export function parentsKey(param: ReportParameter, parameters: readonly ReportParameter[], values: ParamValues): string {
  const parents = optionParentsOf(param, parameters);
  return parents.length ? canonicalValues(parameters.filter((item) => parents.includes(item.id)), values) : "";
}

const picksOf = (param: ReportParameter, value: unknown): string[] => param.type === "multi_select" ? (value as string[] ?? []) : param.type === "select" && value !== param.default ? [value as string] : [];
const changed = (param: ReportParameter, a: ParamValues, b: ParamValues) => canonicalValues([param], { [param.id]: a[param.id] ?? param.default }) !== canonicalValues([param], { [param.id]: b[param.id] ?? param.default });

/**
 * D561: the values with each linked child's picks that its new list does not hold taken out (a select
 * goes back to its default), in array order so a grandchild follows its parent's cleaned value. Only
 * children whose parents changed from `before` are checked (every child when `before` is null). A list
 * that could not be read, or is cut at 200 (the server checks those values itself), keeps the picks.
 */
export async function dropUnlinked(reportId: string, parameters: readonly ReportParameter[], before: ParamValues | null, next: ParamValues): Promise<{ values: ParamValues; notes: string[] }> {
  const values: ParamValues = { ...next };
  const notes: string[] = [];
  const byId = new Map(parameters.map((param) => [param.id, param]));
  for (const param of parameters) {
    const parents = optionParentsOf(param, parameters).map((id) => byId.get(id)!);
    if (!parents.length) continue;
    const moved = before ? parents.filter((parent) => changed(parent, before, values)) : parents;
    if (!moved.length) continue;
    const picks = picksOf(param, values[param.id] ?? param.default);
    if (!picks.length) continue;
    let list: { options: string[]; truncated: boolean; error: string | null };
    try {
      list = (await getParamOptions(reportId, param.id, undefined, parentValuesOf(param, parameters, values))).options;
    } catch {
      continue;
    }
    if (list.error || list.truncated) continue;
    const kept = picks.filter((pick) => list.options.includes(pick));
    if (kept.length === picks.length) continue;
    const where = moved.map((parent) => valueLabel(parent, values[parent.id] ?? parent.default)).join(" and ");
    if (param.type === "select") values[param.id] = param.default;
    else values[param.id] = kept;
    notes.push(kept.length ? `${param.label}: ${picks.filter((pick) => !kept.includes(pick)).join(", ").slice(0, 80)} dropped, not in ${where}` : `${param.label} reset: not in ${where}`);
  }
  return { values, notes };
}

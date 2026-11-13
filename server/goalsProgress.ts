import type { z } from "zod";

/**
 * Key result progress sources (docs/plan/WORKSPACE_MODULES.md §D.3, §C7–C11, §F.2): kept in the
 * foundation so every lane registers its own source before Goals merges (TIME registers `time` in
 * server/time/progressSource.ts, CRM `crm_won_value`, …) and Goals lists whatever is registered.
 *
 * A source computes a key result's current value for its config over a period, **as the KR's owner**
 * (the stored progress is owner-computed, §G.1 Q4): it must read only what that owner can read. It
 * returns a number (and optionally the target it implies, e.g. total cards) or null when it cannot
 * compute (the config points at something gone or unreadable).
 */

export type ProgressContext = {
  /** The key result's owner; the source reads as this person. */
  ownerId: string;
  /** The KR's period, local dates (inclusive), or null for no period (KPIs). */
  period: { start: string; end: string } | null;
  tz: string;
  nowMs: number;
};

export type ProgressValue = { value: number; target?: number; detail?: string };

export type ProgressSource<C = unknown> = {
  /** The word stored with the KR (`tasks`, `time`, `crm_won_value`, …). */
  kind: string;
  label: string;
  /** The module that provides it (its settings say where it comes from). */
  module: string;
  /** Validates the KR's source config (the editor's form posts it). */
  configSchema: z.ZodType<C>;
  /** One line for the KR page: "Done cards on Roadmap", "Hours on Acme website". */
  describe: (config: C, context: { viewerId: string }) => string;
  compute: (config: C, context: ProgressContext) => ProgressValue | null | Promise<ProgressValue | null>;
};

const sources = new Map<string, ProgressSource>();

export function registerProgressSource<C>(kind: string, source: Omit<ProgressSource<C>, "kind">) {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(kind)) throw new Error(`Invalid progress source ${kind}`);
  if (sources.has(kind)) throw new Error(`Progress source ${kind} is already registered`);
  sources.set(kind, { ...source, kind } as ProgressSource);
  return () => { sources.delete(kind); };
}

export const progressSource = (kind: string) => sources.get(kind) ?? null;
export const registeredProgressSources = () => [...sources.values()].map(({ kind, label, module }) => ({ kind, label, module }));

export class ProgressError extends Error {}

/** Computes a KR's value from its source (config validated first). Null when the source is unknown or cannot compute. */
export async function computeProgress(kind: string, config: unknown, context: ProgressContext): Promise<ProgressValue | null> {
  const source = sources.get(kind);
  if (!source) return null;
  const parsed = source.configSchema.safeParse(config);
  if (!parsed.success) throw new ProgressError(`Invalid ${kind} source settings`);
  const result = await source.compute(parsed.data, context);
  return result && Number.isFinite(result.value) ? result : null;
}

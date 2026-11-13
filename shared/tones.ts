/**
 * Status tones (docs/plan/WORKSPACE_MODULES.md §E, §B.4.2): the small, fixed set of colours a status
 * chip, a health chip, or a work summary may ask for. Modules name a tone, never a colour, so the
 * palette stays one place (the client maps each tone to its CSS variables).
 */
export const TONES = ["neutral", "info", "success", "warning", "danger", "accent"] as const;
export type Tone = typeof TONES[number];
export const isTone = (value: unknown): value is Tone => typeof value === "string" && (TONES as readonly string[]).includes(value);

/** Goal and key result health (§D.3), and the tone each one shows in. */
export const HEALTHS = ["on_track", "at_risk", "off_track", "done", "none"] as const;
export type Health = typeof HEALTHS[number];
export const HEALTH_TONE: Record<Health, Tone> = { on_track: "success", at_risk: "warning", off_track: "danger", done: "info", none: "neutral" };
export const HEALTH_LABEL: Record<Health, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track", done: "Done", none: "No status" };

/** A status as a summary carries it: a short label and its tone. */
export type Status = { label: string; tone: Tone };

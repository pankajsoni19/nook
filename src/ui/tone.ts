import { CircleCheck, CircleDashed, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";

/**
 * The status tones (§E.1.7): one map for health, deal won/lost, booking status, form status, and
 * participation. The names match shared/tones.ts (W1-CORE); the colors are workspace.css's
 * `--tone-*` variables, set by `data-tone` on a component. Color is never the only signal (§E.1.9):
 * each tone has an icon, and every tone chip carries its words.
 */
export const TONES = ["good", "warn", "bad", "info", "neutral"] as const;
export type Tone = (typeof TONES)[number];

export const isTone = (value: unknown): value is Tone => typeof value === "string" && (TONES as readonly string[]).includes(value);

export const TONE_ICONS: Record<Tone, LucideIcon> = { good: CircleCheck, warn: TriangleAlert, bad: OctagonAlert, info: Info, neutral: CircleDashed };

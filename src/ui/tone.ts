import { CircleCheck, CircleDashed, Info, OctagonAlert, Sparkle, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Tone } from "../../shared/tones";

/**
 * The status tones (§E.1.7, shared/tones.ts): one map for health, deal won/lost, booking status, form
 * status, and participation. Components set `data-tone`; workspace.css maps each tone to its
 * `--tone-*` colors. Color is never the only signal (§E.1.9): each tone has an icon, and every chip
 * carries its words.
 */
export { TONES, isTone, HEALTHS, HEALTH_LABEL, HEALTH_TONE, type Health, type Status, type Tone } from "../../shared/tones";

export const TONE_ICONS: Record<Tone, LucideIcon> = { success: CircleCheck, warning: TriangleAlert, danger: OctagonAlert, info: Info, neutral: CircleDashed, accent: Sparkle };

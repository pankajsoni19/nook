import { lazy, Suspense } from "react";
import type { EmbedCardProps, EmbedKindDef } from "../editor/moduleEmbedRegistry";

/**
 * Forms embeds in notes and card descriptions (§B.4.4, §C C18, D835): a poll votes inline, a time
 * poll shows the best time and a "Vote" button, a form shows "Respond". The live card is its own
 * chunk; the Markdown always says "Poll", "Form", or "Time poll" (T513).
 */
const LiveEmbed = lazy(() => import("./FormEmbed"));

function Embed(props: EmbedCardProps) {
  return <Suspense fallback={<div className="ui-embed" role="status" aria-label="Loading">Loading…</div>}><LiveEmbed {...props} /></Suspense>;
}

const isFormPath = (path: string) => /^\/forms\/[^/?#]+/.test(path) && !/^\/forms\/(shared|answer|insights)(\/|$|\?)/.test(path);

export const formsEmbeds: EmbedKindDef[] = [
  { kind: "poll", match: isFormPath, component: Embed },
  { kind: "time_poll", match: isFormPath, component: Embed },
  { kind: "form", match: isFormPath, component: Embed }
];

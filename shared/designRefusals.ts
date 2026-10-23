/**
 * D674 (lane FILT3): the design rules' refusals of a manual edit, read back per block, so the owner's
 * "Save as report default" (D566) can say which block stops it and offer the obvious fix where a rule
 * has one. The server's refusal lines are `block <id>: rule <n>: <text>` (specValidate.ts checkDesign);
 * anything else (a query that fails, a column that is gone) is kept as a plain line.
 *
 * Pure: the client (the Views sheet) and tests share it.
 */

/** The fix a refused block can take in one step: a format or unit on its measure, or a title. */
export type DesignFix = "format" | "title";
export type DesignRefusal = { blockId: string; rule: number; text: string; fix: DesignFix | null };

const LINE = /^block ([^:\s]+): rule (\d+): ([\s\S]+)$/;

/** The refusals a 400's `details` list holds, per block (`other` keeps the lines that name no block). */
export function designRefusals(details: readonly unknown[]): { blocks: DesignRefusal[]; other: string[] } {
  const blocks: DesignRefusal[] = [];
  const other: string[] = [];
  for (const line of details) {
    if (typeof line !== "string") continue;
    const match = LINE.exec(line.trim());
    if (!match) { other.push(line); continue; }
    const rule = Number(match[2]);
    const text = match[3]!.trim();
    // Rule 8 has the two obvious fixes: a measure without a format or unit, and a block without a title.
    const fix: DesignFix | null = rule === 8 && /needs a format\b.*\bor a unit/.test(text) ? "format" : rule === 8 && /give the block a title/.test(text) ? "title" : null;
    blocks.push({ blockId: match[1]!, rule, text, fix });
  }
  return { blocks, other };
}

/** D674: the formats the one-step fix offers (a unit word is the other choice). */
export const DESIGN_FIX_FORMATS = [
  { value: "number", label: "Number" },
  { value: "percent", label: "Percent" },
  { value: "duration", label: "Duration" }
] as const;

/** A refusal's text as a sentence ("the measure x needs …" → "The measure x needs …."). */
export const refusalSentence = (text: string) => {
  const trimmed = text.trim();
  const upper = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(upper) ? upper : `${upper}.`;
};

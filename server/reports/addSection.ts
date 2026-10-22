import { looseBlockSection, type ReportBlock, type ReportSpec } from "../../shared/reports";
import { diffSpecs } from "./patch";

/**
 * "Add a new section" (D516): an instruction of kind `add` asks the edit agent for a new spec section
 * with new blocks, placed after a chosen block or at the end, changing nothing else. Sections render
 * in their declared order; a block outside any section shows before them when it comes before every
 * block in a section, else right after the section of the block before it (D578). So the new section
 * goes right after the section that holds the chosen block, or that the chosen block outside any
 * section shows after (first among the sections when there is none), or after the last section at the
 * end; its blocks follow the chosen block (or the last block) in order. Blocks outside any section that
 * came after the chosen block then come after the new section's blocks, so they show after it: the
 * section lands truly between them, and no existing block is moved.
 */

export type AddPlacement = {
  /** The block the new blocks follow (`add_block {after}`); null when the report has no blocks. */
  afterBlock: string | null;
  /** The section the new section follows (`add_section {after}`); null: first among the sections. */
  afterSection: string | null;
  /** Whether the chosen block is gone (the section then goes at the end). */
  anchorMissing: boolean;
  atEnd: boolean;
  /** Whether the chosen block is in a section (else it is outside any, D578). */
  inSection?: boolean;
};

const titleOf = (block: ReportBlock | undefined) => block && "title" in block && typeof block.title === "string" && block.title ? block.title : null;

export function addPlacement(spec: ReportSpec, afterBlockId: string | null): AddPlacement {
  const declared = new Set((spec.sections ?? []).map((section) => section.id));
  const anchor = afterBlockId ? spec.blocks.find((block) => block.id === afterBlockId) : undefined;
  if (anchor) {
    const section = anchor.section && declared.has(anchor.section) ? anchor.section : looseBlockSection(spec, anchor.id);
    return { afterBlock: anchor.id, afterSection: section, anchorMissing: false, atEnd: false, inSection: Boolean(anchor.section && declared.has(anchor.section)) };
  }
  const sections = spec.sections ?? [];
  return { afterBlock: spec.blocks.at(-1)?.id ?? null, afterSection: sections.at(-1)?.id ?? null, anchorMissing: Boolean(afterBlockId), atEnd: true };
}

/** What the edit prompt says about the new section and where it goes. */
export function addSectionText(spec: ReportSpec, afterBlockId: string | null): string {
  const place = addPlacement(spec, afterBlockId);
  const anchor = place.afterBlock ? spec.blocks.find((block) => block.id === place.afterBlock) : undefined;
  const where = place.atEnd
    ? `at the end of the report${place.anchorMissing ? ` (the block it was to follow, ${afterBlockId}, is no longer in the report)` : ""}: add_section {after: ${place.afterSection ? `"${place.afterSection}"` : "null"}}${place.afterBlock ? ` and add_block {after: "${place.afterBlock}"} for the first new block` : ""}`
    : `right after block \`${place.afterBlock}\`${titleOf(anchor) ? ` (“${titleOf(anchor)}”)` : ""}: add_section {after: ${place.afterSection ? `"${place.afterSection}"` : "null"}}${place.inSection ? " (the section that holds it)" : place.afterSection ? " (it is outside any section and shows after that section)" : " (it is outside any section, so the new section comes first among the sections)"} and add_block {after: "${place.afterBlock}"} for the first new block`;
  return [
    "The instruction asks for a NEW SECTION. Add one section with add_section {section: {id, title, summary?}, after} and its blocks with add_block, each block's section set to the new section's id and each new block after the one before it. Add the queries they need with add_query.",
    `Place it ${where}.`,
    "Only add: do not update, move, or remove any existing block, query, section, or parameter. A patch that changes anything already in the report is refused."
  ].join("\n");
}

/** Why a patched spec is not "a new section in its place, nothing else changed" (empty when it is). */
export function addSectionErrors(before: ReportSpec, after: ReportSpec, afterBlockId: string | null): string[] {
  const errors: string[] = [];
  const place = addPlacement(before, afterBlockId);
  const diff = diffSpecs(before, after);
  for (const change of diff.blocks) if (change.change !== "added") errors.push(`Block ${change.blockId} was ${change.change}; a new section only adds blocks`);
  for (const change of diff.queries) if (change.change !== "added") errors.push(`Query ${change.key} was ${change.change}; a new section only adds queries`);
  const oldSections = before.sections ?? [];
  const newSections = after.sections ?? [];
  const oldIds = new Set(oldSections.map((section) => section.id));
  for (const section of oldSections) {
    const now = newSections.find((item) => item.id === section.id);
    if (!now) errors.push(`Section ${section.id} was removed; a new section changes no other section`);
    else if (now.title !== section.title || (now.summary ?? null) !== (section.summary ?? null)) errors.push(`Section ${section.id} was changed; a new section changes no other section`);
  }
  const kept = newSections.filter((section) => oldIds.has(section.id)).map((section) => section.id);
  if (kept.join("\n") !== oldSections.filter((section) => kept.includes(section.id)).map((section) => section.id).join("\n")) errors.push("The existing sections were reordered; keep their order");
  if (JSON.stringify(before.parameters ?? []) !== JSON.stringify(after.parameters ?? [])) errors.push("The report's parameters changed; a new section leaves them as they are");
  const added = newSections.filter((section) => !oldIds.has(section.id));
  if (!added.length) errors.push("Add the new section with add_section");
  const addedIds = new Set(added.map((section) => section.id));
  const blocks = diff.blocks.filter((change) => change.change === "added" && change.after).map((change) => change.after!);
  if (!blocks.length) errors.push("Add at least one block to the new section with add_block");
  for (const block of blocks) if (!block.section || !addedIds.has(block.section)) errors.push(`Block ${block.id} must be in the new section (set its section to ${added[0]?.id ?? "the new section's id"})`);
  if (added.length) {
    const start = place.afterSection === null ? 0 : newSections.findIndex((section) => section.id === place.afterSection) + 1;
    const at = newSections.map((section, index) => addedIds.has(section.id) ? index : -1).filter((index) => index >= 0);
    if (at[0] !== start || at.some((index, offset) => index !== start + offset)) {
      errors.push(`The new section is in the wrong place: add it with add_section {after: ${place.afterSection ? `"${place.afterSection}"` : "null"}}`);
    }
  }
  // D578: the new blocks follow the chosen block, one after another, so the blocks that came after it
  // (outside any section) show after the new section.
  if (blocks.length && place.afterBlock) {
    const order = after.blocks.map((block) => block.id);
    const anchorAt = order.indexOf(place.afterBlock);
    const addedBlockIds = new Set(blocks.map((block) => block.id));
    const positions = order.map((id, index) => addedBlockIds.has(id) ? index : -1).filter((index) => index >= 0);
    if (anchorAt < 0 || positions.some((index, offset) => index !== anchorAt + 1 + offset)) {
      errors.push(`The new blocks are in the wrong place: add the first with add_block {after: "${place.afterBlock}"} and each next one after the one before it`);
    }
  }
  return errors;
}

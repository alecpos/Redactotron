import type { RedactionBlock } from "../pdf/types.ts";

function overlaps(candidate: RedactionBlock, block: RedactionBlock) {
  if (block.pageIndex !== candidate.pageIndex) return false;
  return block.rects.some((rect) =>
    candidate.rects.some((candidateRect) => {
      const overlapWidth = Math.max(
        0,
        Math.min(rect.x1, candidateRect.x1) -
          Math.max(rect.x0, candidateRect.x0),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(rect.y1, candidateRect.y1) -
          Math.max(rect.y0, candidateRect.y0),
      );
      const candidateArea =
        (candidateRect.x1 - candidateRect.x0) *
        (candidateRect.y1 - candidateRect.y0);
      return (
        (overlapWidth * overlapHeight) / Math.max(1, candidateArea) > 0.6
      );
    }),
  );
}

export function mergeSuggestionBlocks(
  existing: RedactionBlock[],
  suggestions: RedactionBlock[],
  maxBlocks: number,
) {
  const added: RedactionBlock[] = [];
  for (const candidate of suggestions) {
    if (existing.length + added.length >= maxBlocks) break;
    if (
      existing.some((block) => overlaps(candidate, block)) ||
      added.some((block) => overlaps(candidate, block))
    ) {
      continue;
    }
    added.push(candidate);
  }
  return { blocks: [...existing, ...added], added };
}

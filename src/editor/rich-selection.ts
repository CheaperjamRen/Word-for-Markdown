import type { RichSelectionBookmark } from "./active-editor";

export type { RichSelectionBookmark };

function isSurrogateBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

/** Clamps a presentation bookmark without ever placing a caret inside an astral code point. */
export function normalizeRichSelectionBookmark(
  bookmark: RichSelectionBookmark,
  visibleText: string,
): RichSelectionBookmark | null {
  const clamp = (value: number): number => Math.max(0, Math.min(visibleText.length, Math.trunc(value)));
  let anchorTextOffset = clamp(bookmark.anchorTextOffset);
  let focusTextOffset = clamp(bookmark.focusTextOffset);
  if (isSurrogateBoundary(visibleText, anchorTextOffset)) anchorTextOffset -= 1;
  if (isSurrogateBoundary(visibleText, focusTextOffset)) focusTextOffset -= 1;
  if (!Number.isSafeInteger(anchorTextOffset) || !Number.isSafeInteger(focusTextOffset)) return null;
  return { ...bookmark, anchorTextOffset, focusTextOffset };
}

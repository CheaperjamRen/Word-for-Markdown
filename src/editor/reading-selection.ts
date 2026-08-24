import type { RichToolbarState } from "./active-editor";
import { normalizeRichSelectionBookmark } from "./rich-selection";

export interface ReadingSelectionSnapshot {
  sessionId: string;
  candidateRevision: number;
  blockViewKey: string;
  anchorTextOffset: number;
  focusTextOffset: number;
  state: RichToolbarState;
}

function ownerElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function visibleOffset(block: Element, node: Node, offset: number): number | null {
  const range = document.createRange();
  try {
    range.setStart(block, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function blockType(block: Element): RichToolbarState["block"] {
  const tag = block.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return tag as RichToolbarState["block"];
  if (tag === "blockquote") return "quote";
  if (tag === "pre") return "code";
  return "paragraph";
}

export function captureReadingSelection(
  root: HTMLElement,
  selection: Selection,
  sessionId: string,
  candidateRevision: number,
): ReadingSelectionSnapshot | null {
  if (selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const anchorBlock = ownerElement(selection.anchorNode!)?.closest<HTMLElement>("[data-block-view-key]");
  const focusBlock = ownerElement(selection.focusNode!)?.closest<HTMLElement>("[data-block-view-key]");
  if (!anchorBlock || anchorBlock !== focusBlock || !root.contains(anchorBlock)) return null;
  const blockViewKey = anchorBlock.dataset.blockViewKey;
  if (!blockViewKey) return null;
  const anchorTextOffset = visibleOffset(anchorBlock, selection.anchorNode!, selection.anchorOffset);
  const focusTextOffset = visibleOffset(anchorBlock, selection.focusNode!, selection.focusOffset);
  if (anchorTextOffset === null || focusTextOffset === null || anchorTextOffset === focusTextOffset) return null;
  const selectedStart = Math.min(anchorTextOffset, focusTextOffset);
  const selectedEnd = Math.max(anchorTextOffset, focusTextOffset);
  const walker = document.createTreeWalker(anchorBlock, NodeFilter.SHOW_TEXT);
  const selectedText: Array<{ node: Text; start: number; end: number }> = [];
  let visible = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const start = visible;
    const end = start + text.data.length;
    visible = end;
    if (end > selectedStart && start < selectedEnd) selectedText.push({ node: text, start, end });
  }
  if (!selectedText.length) return null;
  const bookmark = normalizeRichSelectionBookmark({
    blockViewKey,
    anchorTextOffset,
    focusTextOffset,
  }, anchorBlock.textContent ?? "");
  if (!bookmark) return null;
  const formatState = (selector: string): "off" | "on" | "mixed" => {
    const enabled = selectedText.filter(({ node }) => ownerElement(node)?.closest(selector)).length;
    return enabled === 0 ? "off" : enabled === selectedText.length ? "on" : "mixed";
  };
  const linkUrls = new Set(
    selectedText
      .map(({ node }) => ownerElement(node)?.closest<HTMLAnchorElement>("a")?.getAttribute("href") ?? null)
      .filter((value): value is string => value !== null),
  );
  const listElement = anchorBlock.closest("ul,ol");
  const list: RichToolbarState["list"] = listElement?.tagName === "OL"
    ? "number"
    : listElement?.querySelector('input[type="checkbox"]')
      ? "task"
      : listElement
        ? "bullet"
        : "none";
  return {
    sessionId,
    candidateRevision,
    blockViewKey: bookmark.blockViewKey,
    anchorTextOffset: bookmark.anchorTextOffset,
    focusTextOffset: bookmark.focusTextOffset,
    state: {
      canUndo: false,
      canRedo: false,
      canLink: true,
      block: blockType(anchorBlock),
      formats: {
        bold: formatState("strong,b"),
        italic: formatState("em,i"),
        strikethrough: formatState("del,s"),
        code: formatState("code"),
      },
      list,
      linkUrl: linkUrls.size === 1 ? [...linkUrls][0] : null,
    },
  };
}

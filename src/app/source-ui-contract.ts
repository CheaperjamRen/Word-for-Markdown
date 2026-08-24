import { mountedSourceEditorForContent } from "../source/source-editor-instance";

export interface ComputedSourceContract {
  fontSize: string;
  lineHeight: string;
  searchFontSize: string;
  searchLineHeight: string;
  scrollerCount: number;
  sourceBackgroundColor: string;
  gutterBackgroundColor: string;
  gutterTextColor: string;
  activeGutterBackgroundColor: string;
  activeGutterTextColor: string;
  gutterBorderRightWidth: string;
  focusOutlineWidth: string;
  tokenColors: readonly string[];
  tokenColorBySemantic: Readonly<Record<
    "heading" | "emphasis" | "strong" | "monospace" | "link" | "strikethrough" | "comment",
    string
  >>;
}

export type ComputedSourceState = "selection" | "search-match" | "matching-bracket";

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`real mounted Source editor is missing ${selector}`);
  return element;
}

function colorValue(element: HTMLElement, value: string): string {
  const resolved = value.replace(/var\((--[^),\s]+)(?:,[^)]+)?\)/g, (original, name: string) => {
    let current: HTMLElement | null = element;
    while (current) {
      const token = getComputedStyle(current).getPropertyValue(name).trim();
      if (token) return token;
      current = current.parentElement;
    }
    return original;
  });
  const hex = /^#([0-9a-f]{6})$/i.exec(resolved)?.[1];
  if (!hex) return resolved;
  return `rgb(${Number.parseInt(hex.slice(0, 2), 16)}, ${Number.parseInt(hex.slice(2, 4), 16)}, ${Number.parseInt(hex.slice(4, 6), 16)})`;
}

function colorForText(content: HTMLElement, marker: string): string {
  const token = [...content.querySelectorAll<HTMLElement>("span")]
    .find((element) => element.textContent?.includes(marker));
  if (!token) throw new Error(`real mounted Source editor is missing ${marker} token`);
  return colorValue(token, getComputedStyle(token).color);
}

function computedOutlineWidth(element: HTMLElement): string {
  const style = getComputedStyle(element);
  return style.outlineWidth || style.outline.match(/(?:^|\s)(\d+(?:\.\d+)?px)(?:\s|$)/)?.[1] || "0px";
}

export function collectComputedSourceContract(root: ParentNode): ComputedSourceContract {
  const content = requiredElement<HTMLElement>(root, ".cm-content");
  if (mountedSourceEditorForContent(content) === null) {
    throw new Error("real mounted Source editor is required");
  }
  const editor = requiredElement<HTMLElement>(root, ".cm-editor");
  const gutter = requiredElement<HTMLElement>(editor, ".cm-gutters");
  const activeGutter = requiredElement<HTMLElement>(gutter, ".cm-activeLineGutter");
  const searchControl = requiredElement<HTMLElement>(editor, ".cm-panel.cm-search label, .cm-panel.cm-search input");
  const contentStyle = getComputedStyle(content);
  const editorStyle = getComputedStyle(editor);
  const gutterStyle = getComputedStyle(gutter);
  const activeGutterStyle = getComputedStyle(activeGutter);
  const searchStyle = getComputedStyle(searchControl);
  const searchFontSize = searchStyle.fontSize;
  const searchLineHeight = searchStyle.lineHeight;
  let focusOutlineWidth = computedOutlineWidth(editor);
  const tokenColorBySemantic = {
    heading: (() => {
      const token = requiredElement<HTMLElement>(content, ".cm-line:first-child span");
      return colorValue(token, getComputedStyle(token).color);
    })(),
    emphasis: colorForText(content, "emphasis"),
    strong: colorForText(content, "strong"),
    monospace: colorForText(content, "code"),
    link: colorForText(content, "link"),
    strikethrough: colorForText(content, "old"),
    comment: colorForText(content, "comment"),
  } as const;
  return {
    fontSize: contentStyle.fontSize,
    lineHeight: contentStyle.lineHeight,
    searchFontSize,
    searchLineHeight,
    scrollerCount: editor.querySelectorAll(".cm-scroller").length,
    sourceBackgroundColor: colorValue(editor, editorStyle.backgroundColor),
    gutterBackgroundColor: colorValue(gutter, gutterStyle.backgroundColor),
    gutterTextColor: colorValue(gutter, gutterStyle.color),
    activeGutterBackgroundColor: colorValue(activeGutter, activeGutterStyle.backgroundColor),
    activeGutterTextColor: colorValue(activeGutter, activeGutterStyle.color),
    gutterBorderRightWidth: gutterStyle.borderRightWidth,
    focusOutlineWidth,
    tokenColors: [...new Set(Object.values(tokenColorBySemantic))],
    tokenColorBySemantic,
  };
}

export function collectComputedSourceStateColor(
  root: ParentNode,
  state: ComputedSourceState,
): string {
  const content = requiredElement<HTMLElement>(root, ".cm-content");
  if (mountedSourceEditorForContent(content) === null) {
    throw new Error("real mounted Source editor is required");
  }
  const selector = {
    selection: ".cm-selectionBackground",
    "search-match": ".cm-searchMatch",
    "matching-bracket": ".cm-matchingBracket",
  }[state];
  const element = requiredElement<HTMLElement>(root, selector);
  return colorValue(element, getComputedStyle(element).backgroundColor);
}

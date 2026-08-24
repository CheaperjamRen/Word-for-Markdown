// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { BlockViewSpan, SelectionSnapshot } from "../contracts/markdown";
import {
  sourceOffsetForViewportAnchor,
  sourceRangeForSelection,
  textSelectionForSourceRange,
  textSelectionAfterSourceEdit,
  viewportAnchorForSourceOffset,
} from "./source-selection";
import { applyDocumentEdit, parseSourceDocument } from "../markdown/source-document";
import { buildBlockViewSpans, buildSourceView } from "../markdown/source-view";

const spans: readonly BlockViewSpan[] = [
  { blockId: "a", blockViewKey: "key-a", kind: "paragraph", start: 2, end: 6 },
  { blockId: "table", blockViewKey: "key-table", kind: "table", start: 8, end: 17 },
  { blockId: "c", blockViewKey: "key-c", kind: "paragraph", start: 19, end: 21 },
];
const text = "  A😀B\n\n| A | B |\n\n尾段";

describe("Source selection mapping", () => {
  it("preserves forward and reverse ranges within blocks and uses absolute offsets in blank gaps", () => {
    expect(textSelectionForSourceRange({ anchor: 3, head: 6 }, spans, text)).toEqual({
      kind: "text",
      anchorBlockKey: "key-a",
      anchorOffset: 1,
      focusBlockKey: "key-a",
      focusOffset: 4,
    });
    const reverse = textSelectionForSourceRange({ anchor: 20, head: 5 }, spans, text);
    expect(sourceRangeForSelection(reverse, spans, text)).toEqual({ anchor: 20, head: 5 });
    expect(textSelectionForSourceRange({ anchor: 7, head: 7 }, spans, text)).toMatchObject({
      anchorBlockKey: null,
      anchorOffset: 7,
      focusBlockKey: null,
      focusOffset: 7,
    });
  });

  it("degrades a table selection to the stable table start and rejects split-surrogate offsets", () => {
    const table: SelectionSnapshot = {
      kind: "table",
      tableBlockViewKey: "key-table",
      anchor: { row: 0, column: 0 },
      focus: { row: 1, column: 1 },
      origin: { row: 0, column: 0 },
    };
    expect(sourceRangeForSelection(table, spans, text)).toEqual({ anchor: 8, head: 8 });
    expect(() => textSelectionForSourceRange({ anchor: 4, head: 4 }, spans, text)).toThrow("surrogate");
  });

  it("falls back to the nearest surviving predecessor or successor when a stable key is deleted", () => {
    const previous: readonly BlockViewSpan[] = [
      spans[0],
      { blockId: "gone", blockViewKey: "key-gone", kind: "paragraph", start: 8, end: 11 },
      spans[2],
    ];
    const selection: SelectionSnapshot = {
      kind: "text",
      anchorBlockKey: "key-gone",
      anchorOffset: 2,
      focusBlockKey: "key-gone",
      focusOffset: 2,
    };
    expect(sourceRangeForSelection(selection, [spans[0], spans[2]], text, previous))
      .toEqual({ anchor: spans[0].end, head: spans[0].end });

    const missingFirst: SelectionSnapshot = {
      kind: "text",
      anchorBlockKey: "key-gone-first",
      anchorOffset: 1,
      focusBlockKey: "key-gone-first",
      focusOffset: 1,
    };
    const previousWithSuccessor: readonly BlockViewSpan[] = [
      { blockId: "gone-first", blockViewKey: "key-gone-first", kind: "paragraph", start: 0, end: 1 },
      spans[1],
      spans[2],
    ];
    expect(sourceRangeForSelection(missingFirst, [spans[1], spans[2]], text, previousWithSuccessor))
      .toEqual({ anchor: spans[1].start, head: spans[1].start });
  });

  it("round-trips structured viewport anchors without returning line one for gaps", () => {
    expect(viewportAnchorForSourceOffset(10, spans, text)).toEqual({
      blockViewKey: "key-table",
      offset: 2,
    });
    expect(sourceOffsetForViewportAnchor({ blockViewKey: "key-table", offset: 2 }, spans, text)).toBe(10);
    expect(viewportAnchorForSourceOffset(7, spans, text)).toEqual({ blockViewKey: null, offset: 7 });
    expect(sourceOffsetForViewportAnchor({ blockViewKey: "missing", offset: 99 }, spans, text)).toBe(21);
  });

  it("uses stable keys only for real exclusive same-kind remaps and absolute offsets for split or merged blocks", () => {
    const original = parseSourceDocument(new TextEncoder().encode("A\n\nB\n"));
    const [oldA, oldB] = original.blocks;
    const keys = new Map([[oldA.id, "stable-a"], [oldB.id, "stable-b"]]);
    const split = applyDocumentEdit(original, {
      kind: "replace-block",
      blockId: oldA.id,
      markdown: "A1\n\nA2",
    });
    const splitView = buildSourceView(split.candidate);
    const splitSelection = textSelectionAfterSourceEdit(
      { anchor: splitView.text.indexOf("A2") + 1, head: splitView.text.indexOf("A2") + 1 },
      original,
      keys,
      split,
      splitView,
    );
    expect(splitSelection).toMatchObject({
      anchorBlockKey: null,
      anchorOffset: splitView.text.indexOf("A2") + 1,
      focusBlockKey: null,
    });
    const stableBOffset = splitView.text.lastIndexOf("B");
    expect(textSelectionAfterSourceEdit(
      { anchor: stableBOffset, head: stableBOffset },
      original,
      keys,
      split,
      splitView,
    )).toMatchObject({ anchorBlockKey: "stable-b", anchorOffset: 0 });

    const originalView = buildSourceView(original);
    const merged = applyDocumentEdit(original, {
      kind: "source-changes",
      view: originalView,
      changes: [{ from: 1, to: 3, insert: " " }],
    }, { sessionId: "one", candidateRevision: 0, candidate: original, view: originalView });
    const mergedView = buildSourceView(merged.candidate);
    expect(textSelectionAfterSourceEdit(
      { anchor: 1, head: 1 },
      original,
      keys,
      merged,
      mergedView,
    )).toMatchObject({ anchorBlockKey: null, anchorOffset: 1 });
  });

  it("rejects unsafe accepted ranges without mutating caller-owned range or remap", () => {
    const original = parseSourceDocument(new TextEncoder().encode("A😀\n"));
    const keys = new Map([[original.blocks[0].id, "stable"]]);
    const result = applyDocumentEdit(original, {
      kind: "replace-block",
      blockId: original.blocks[0].id,
      markdown: "B😀",
    });
    const view = buildSourceView(result.candidate);
    const range = { anchor: 2, head: 2 };
    const remapBefore = [...result.blockRemap];

    expect(() => textSelectionAfterSourceEdit(range, original, keys, result, view)).toThrow("surrogate");
    expect(range).toEqual({ anchor: 2, head: 2 });
    expect([...result.blockRemap]).toEqual(remapBefore);
    expect(() => textSelectionAfterSourceEdit(
      { anchor: -1, head: Number.MAX_SAFE_INTEGER + 1 },
      original,
      keys,
      result,
      view,
    )).toThrow();
  });
});

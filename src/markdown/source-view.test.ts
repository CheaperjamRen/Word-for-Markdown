// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { parseSourceDocument } from "./source-document";
import {
  applySourceTextEditsToView,
  buildBlockViewSpans,
  buildSourceView,
  cloneSourceView,
  sourceViewsEqual,
  viewOffsetForByteOffset,
} from "./source-view";

const encoder = new TextEncoder();

describe("normalized Source view", () => {
  it("maps BOM, mixed newlines, CJK, emoji, frontmatter, and protected blocks from bytes once", () => {
    const bytes = Uint8Array.from([
      0xef, 0xbb, 0xbf,
      ...encoder.encode("---\r\ntitle: 中文😀\r\n---\r\n\r\n# 标题😀\n\n正文\r\n\r\n:::private\r\nopaque\r\n:::\r\n"),
    ]);
    const document = parseSourceDocument(bytes);
    const view = buildSourceView(document);
    const keys = new Map(document.blocks.map((block, index) => [block.id, `stable-${index}`]));
    const spans = buildBlockViewSpans(document, view, keys);

    expect(view.text).toBe("---\ntitle: 中文😀\n---\n\n# 标题😀\n\n正文\n\n:::private\nopaque\n:::\n");
    expect(view.byteOffsetAtViewOffset[0]).toBe(3);
    expect(view.byteOffsetAtViewOffset.at(-1)).toBe(bytes.length);
    expect(spans).toHaveLength(document.blocks.length);
    for (const [index, block] of document.blocks.entries()) {
      const span = spans[index];
      expect(span).toMatchObject({
        blockId: block.id,
        blockViewKey: `stable-${index}`,
        kind: block.kind,
        start: viewOffsetForByteOffset(view, block.byteStart, "before"),
        end: viewOffsetForByteOffset(view, block.byteEnd, "after"),
      });
      expect(view.text.slice(span.start, span.end)).toBe(block.raw.replace(/\r\n|\r/g, "\n"));
    }
  });

  it("applies literal UTF-16 edits without encoding and rejects unsafe, overlapping, or split-surrogate ranges", () => {
    const text = "A😀\nB";
    expect(applySourceTextEditsToView(text, [
      { from: 0, to: 1, insert: "AA" },
      { from: 4, to: 5, insert: "\ud800" },
    ])).toBe("AA😀\n\ud800");
    expect(() => applySourceTextEditsToView(text, [{ from: 2, to: 2, insert: "x" }]))
      .toThrow("surrogate");
    expect(() => applySourceTextEditsToView(text, [
      { from: 0, to: 1, insert: "x" },
      { from: 0, to: 4, insert: "y" },
    ])).toThrow("ordered and non-overlapping");
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => applySourceTextEditsToView(text, [{ from: bad, to: bad, insert: "x" }]))
        .toThrow();
    }
  });

  it("projects 100 replacements across 100KB with one forward segment pass and one join", () => {
    const text = "a".repeat(102_400);
    const changes = Array.from({ length: 100 }, (_, index) => ({
      from: index * 1_024,
      to: index * 1_024 + 1,
      insert: "b",
    }));
    const slice = vi.spyOn(String.prototype, "slice");

    const projected = applySourceTextEditsToView(text, changes);
    const sliceCalls = slice.mock.calls.length;
    const slicedWidth = slice.mock.calls.reduce((total, [start, end]) => {
      const normalizedStart = Number(start);
      const normalizedEnd = end === undefined ? text.length : Number(end);
      return total + Math.max(0, normalizedEnd - normalizedStart);
    }, 0);
    slice.mockRestore();

    expect(projected).toHaveLength(102_400);
    for (const change of changes) expect(projected[change.from]).toBe("b");
    expect(projected.at(-1)).toBe("a");
    expect(sliceCalls).toBe(changes.length + 1);
    // Each unchanged source range is consumed once. Counting calls alone would
    // miss an implementation that repeatedly slices the whole document.
    expect(slicedWidth).toBeLessThanOrEqual(text.length);
  });

  it("clones maps defensively and compares every canonical map entry", () => {
    const document = parseSourceDocument(encoder.encode("A😀\r\nB\n"));
    const view = buildSourceView(document);
    const clone = cloneSourceView(view);
    expect(sourceViewsEqual(view, clone)).toBe(true);
    expect(clone).not.toBe(view);
    expect(clone.byteOffsetAtViewOffset).not.toBe(view.byteOffsetAtViewOffset);
    clone.byteOffsetAtViewOffset[0] += 1;
    expect(sourceViewsEqual(view, clone)).toBe(false);
    expect(view.byteOffsetAtViewOffset[0]).toBe(document.bomLength);
  });

  it("builds the exact 102400-byte dense map without per-code-point TextEncoder work", () => {
    const bytes = new Uint8Array(102_400).fill(0x61);
    const document = parseSourceDocument(bytes);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");

    const view = buildSourceView(document);

    expect(view.text).toHaveLength(102_400);
    expect(view.byteOffsetAtViewOffset).toHaveLength(102_401);
    expect(view.byteOffsetAtViewOffset[0]).toBe(0);
    expect(view.byteOffsetAtViewOffset.at(-1)).toBe(bytes.length);
    expect(encode).not.toHaveBeenCalled();
    encode.mockRestore();
  });

  it("never returns the split-surrogate index from exact or interior astral byte offsets", () => {
    const document = parseSourceDocument(encoder.encode("A😀B"));
    const view = buildSourceView(document);
    expect([...view.byteOffsetAtViewOffset]).toEqual([0, 1, 1, 5, 6]);

    expect(viewOffsetForByteOffset(view, 1, "before")).toBe(1);
    expect(viewOffsetForByteOffset(view, 1, "after")).toBe(1);
    expect(viewOffsetForByteOffset(view, 2, "before")).toBe(1);
    expect(viewOffsetForByteOffset(view, 2, "after")).toBe(3);
    expect(viewOffsetForByteOffset(view, 4, "before")).toBe(1);
    expect(viewOffsetForByteOffset(view, 4, "after")).toBe(3);
  });
});

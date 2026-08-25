// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";

import {
  applyDocumentEdit,
  decodeSourceBytes,
  parseSourceDocument,
  replaceEditableBlock,
} from "./source-document";
import * as sourceDocumentModule from "./source-document";
import { buildSourceView, cloneSourceView } from "./source-view";
import { CurrentSourceViewCache } from "./current-source-view-cache";

const PROTECTED_LOGICAL_TEXT = readFileSync(
  resolve(process.cwd(), "fixtures/protected-syntax.md"),
  "utf8",
).replace(/\r\n/g, "\n");

function sourceContext(document: ReturnType<typeof parseSourceDocument>, view = buildSourceView(document)) {
  return { sessionId: "test", candidateRevision: 0, candidate: document, view };
}

it("maps text offsets to UTF-8 byte spans including a BOM", () => {
  const bytes = Uint8Array.from([
    0xef,
    0xbb,
    0xbf,
    ...new TextEncoder().encode("# 标题\r\n\r\n正文😀\r\n"),
  ]);
  const document = parseSourceDocument(bytes);
  const paragraph = document.blocks.find((block) => block.kind === "paragraph")!;

  expect(document.bomLength).toBe(3);
  expect(bytes.slice(paragraph.byteStart, paragraph.byteEnd)).toEqual(
    new TextEncoder().encode("正文😀"),
  );
});

it("maps every parsed block boundary exactly across UTF-8 and GFM fixtures", () => {
  const encoder = new TextEncoder();
  const bytes = Uint8Array.from([
    0xef,
    0xbb,
    0xbf,
    ...encoder.encode(
      "---\r\ntitle: 中文😀\r\n---\r\n\r\n# 标题😀\n\n首段😀\r\n\r\n| 名称 | 值😀 |\n| --- | --- |\n| 中文 | 😀 |\n\n```ts\r\nconst emoji = '😀';\r\n```\r\n\r\n<div>原始 HTML 😀</div>\n",
    ),
  ]);
  const document = parseSourceDocument(bytes);

  for (const block of document.blocks) {
    expect(block.byteStart).toBe(
      document.bomLength + encoder.encode(document.text.slice(0, block.start)).length,
    );
    expect(block.byteEnd).toBe(
      document.bomLength + encoder.encode(document.text.slice(0, block.end)).length,
    );
    expect(bytes.slice(block.byteStart, block.byteEnd)).toEqual(
      encoder.encode(block.raw),
    );
  }
});

it("maps a first block after leading blank whitespace exactly", () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode("\r\n \n\t\n😀 紧邻边界的首段\r\n");
  const document = parseSourceDocument(bytes);
  const firstBlock = document.blocks[0]!;

  expect(firstBlock.start).toBeGreaterThan(0);
  expect(firstBlock.byteStart).toBe(
    document.bomLength + encoder.encode(document.text.slice(0, firstBlock.start)).length,
  );
  expect(firstBlock.byteEnd).toBe(
    document.bomLength + encoder.encode(document.text.slice(0, firstBlock.end)).length,
  );
  expect(bytes.slice(firstBlock.byteStart, firstBlock.byteEnd)).toEqual(
    encoder.encode(firstBlock.raw),
  );
});

it("encodes no more than twice the source text volume when mapping block offsets", () => {
  const text = Array.from(
    { length: 96 },
    (_, index) => `段落 ${index} 😀 ${"x".repeat(1024)}\n\n`,
  ).join("");
  const bytes = new TextEncoder().encode(text);
  const encode = vi.spyOn(TextEncoder.prototype, "encode");

  parseSourceDocument(bytes);

  const encodedInputLength = encode.mock.calls.reduce(
    (total, [input]) => total + (input?.length ?? 0),
    0,
  );
  expect(encodedInputLength).toBeLessThanOrEqual(text.length * 2);
  encode.mockRestore();
});

it.each([Uint8Array.of(0xff), Uint8Array.of(0xef, 0xbb)])(
  "fatal-decodes invalid UTF-8 and a truncated BOM",
  (bytes) => {
    expect(() => parseSourceDocument(bytes)).toThrow();
  },
);

it("changes one paragraph while every surrounding byte stays identical", () => {
  const original = new TextEncoder().encode(
    PROTECTED_LOGICAL_TEXT.replace(/\n/g, "\r\n"),
  );
  const document = parseSourceDocument(original);
  const paragraph = document.blocks.find(
    (block) => block.kind === "paragraph" && !block.protected,
  )!;
  const replacement = "这是**唯一**允许修改的段落。";
  const candidate = replaceEditableBlock(document, {
    blockId: paragraph.id,
    markdown: replacement,
  });

  expect(decodeSourceBytes(candidate)).toContain(replacement);
  expect(decodeSourceBytes(candidate)).toContain(
    ":::codex-private\r\nopaque: **must stay byte-identical**\r\n:::",
  );
  expect(candidate.slice(0, paragraph.byteStart)).toEqual(
    original.slice(0, paragraph.byteStart),
  );
  expect(
    candidate.slice(
      paragraph.byteStart + new TextEncoder().encode(replacement).length,
    ),
  ).toEqual(original.slice(paragraph.byteEnd));
});

it("marks and refuses frontmatter, directives and raw HTML explicitly", () => {
  const document = parseSourceDocument(
    new TextEncoder().encode(PROTECTED_LOGICAL_TEXT.replace(/\n/g, "\r\n")),
  );
  const protectedBlocks = [
    document.blocks.find((block) => block.kind === "yaml"),
    document.blocks.find((block) => block.raw.startsWith(":::")),
    document.blocks.find((block) => block.raw.includes("<custom-widget")),
  ];

  expect(protectedBlocks.every(Boolean)).toBe(true);
  for (const block of protectedBlocks) {
    expect(block!.protected).toBe(true);
    expect(() =>
      replaceEditableBlock(document, {
        blockId: block!.id,
        markdown: "changed",
      }),
    ).toThrow("protected block");
  }

  const nestedDocument = parseSourceDocument(
    new TextEncoder().encode("prefix <span>raw</span> and <u>underline</u> suffix\n"),
  );
  const nestedHtml = nestedDocument.blocks[0];
  expect(nestedHtml.protected).toBe(true);
  expect(nestedHtml.raw).toContain("<u>underline</u>");
  expect(() =>
    replaceEditableBlock(nestedDocument, {
      blockId: nestedHtml.id,
      markdown: "changed",
    }),
  ).toThrow("protected block");
});

it("rejects syntax that swallows a protected block into an editable block", () => {
  const bytes = new TextEncoder().encode(
    'editable paragraph\r\n\r\n<custom-widget data-value="untouched"></custom-widget>\r\n',
  );
  const document = parseSourceDocument(bytes);
  const paragraph = document.blocks.find((block) => !block.protected)!;

  expect(() =>
    replaceEditableBlock(document, {
      blockId: paragraph.id,
      markdown: "\u0060\u0060\u0060txt",
    }),
  ).toThrow("protected block structure");
});

it("returns the original bytes when no patch is requested", () => {
  const bytes = new TextEncoder().encode(
    PROTECTED_LOGICAL_TEXT.replace(/\n/g, "\r\n"),
  );

  expect(parseSourceDocument(bytes).bytes).toEqual(bytes);
  expect(parseSourceDocument(bytes).bytes).toBe(bytes);
});

it("detects mixed line endings without rewriting them", () => {
  const bytes = new TextEncoder().encode("# A\r\n\r\nfirst\n\nsecond\r\n");

  expect(parseSourceDocument(bytes).newline).toBe("mixed");
  expect(parseSourceDocument(bytes).bytes).toEqual(bytes);
});

it("rejects a missing block, NUL and both unpaired-surrogate directions", () => {
  const document = parseSourceDocument(new TextEncoder().encode("paragraph\n"));

  expect(() =>
    replaceEditableBlock(document, { blockId: "missing", markdown: "x" }),
  ).toThrow("block not found");
  expect(() =>
    replaceEditableBlock(document, {
      blockId: document.blocks[0].id,
      markdown: "a\0b",
    }),
  ).toThrow("NUL");

  for (const markdown of ["high-\ud800", "low-\udc00"]) {
    expect(() =>
      replaceEditableBlock(document, {
        blockId: document.blocks[0].id,
        markdown,
      }),
    ).toThrow("unpaired surrogate");
  }
});

it("applies consecutive edits to the current candidate instead of the baseline", () => {
  const original = parseSourceDocument(
    new TextEncoder().encode("alpha\r\n\r\nbeta\r\n"),
  );
  const first = applyDocumentEdit(original, {
    kind: "replace-block",
    blockId: original.blocks[0].id,
    markdown: "ALPHA",
  });
  const second = applyDocumentEdit(first.candidate, {
    kind: "replace-block",
    blockId: first.candidate.blocks[1].id,
    markdown: "BETA",
  });

  expect(decodeSourceBytes(second.candidate.bytes)).toBe("ALPHA\r\n\r\nBETA\r\n");
});

it("replaces a BOM CRLF block beside emoji without touching protected or surrounding bytes", () => {
  const encoder = new TextEncoder();
  const bytes = Uint8Array.from([
    0xef, 0xbb, 0xbf,
    ...encoder.encode("---\r\ntitle: 😀\r\n---\r\n\r\nleft 😀 right\r\n\r\n<div>opaque 😀</div>\r\n"),
  ]);
  const document = parseSourceDocument(bytes);
  const editable = document.blocks.find((block) => !block.protected)!;
  const protectedRaw = document.blocks.filter((block) => block.protected).map((block) => block.raw);
  const replacement = "left 😀 changed";
  const result = applyDocumentEdit(document, {
    kind: "replace-block",
    blockId: editable.id,
    markdown: replacement,
  });

  expect(result.candidate.bytes.slice(0, editable.byteStart)).toEqual(
    bytes.slice(0, editable.byteStart),
  );
  expect(result.candidate.bytes.slice(editable.byteStart + encoder.encode(replacement).length)).toEqual(
    bytes.slice(editable.byteEnd),
  );
  expect(result.candidate.blocks.filter((block) => block.protected).map((block) => block.raw)).toEqual(
    protectedRaw,
  );
});

it("inserts before the first block, after a chosen block, and at EOF without rewriting whitespace", () => {
  const encoder = new TextEncoder();
  const initialBytes = encoder.encode("\r\nfirst\r\n \r\nsecond\r\n\t");
  const initial = parseSourceDocument(initialBytes);
  const beforeFirst = applyDocumentEdit(initial, {
    kind: "insert-after",
    blockId: null,
    markdown: "zero\r\n\r\n",
  });
  expect(beforeFirst.candidate.bytes.slice(0, initial.blocks[0].byteStart)).toEqual(
    initialBytes.slice(0, initial.blocks[0].byteStart),
  );

  const first = beforeFirst.candidate.blocks.find((block) => block.raw === "first")!;
  const afterChosen = applyDocumentEdit(beforeFirst.candidate, {
    kind: "insert-after",
    blockId: first.id,
    markdown: "\r\n\r\nmiddle",
  });
  const last = afterChosen.candidate.blocks.at(-1)!;
  const beforeEof = afterChosen.candidate.bytes.slice();
  const atEof = applyDocumentEdit(afterChosen.candidate, {
    kind: "insert-after",
    blockId: last.id,
    markdown: "\r\n\r\nend",
  });

  expect(decodeSourceBytes(atEof.candidate.bytes)).toBe(
    "\r\nzero\r\n\r\nfirst\r\n\r\nmiddle\r\n \r\nsecond\r\n\t\r\n\r\nend",
  );
  expect(atEof.candidate.bytes.slice(0, beforeEof.length)).toEqual(beforeEof);
});

it("returns explicit split, merge, shift, and insertion remaps", () => {
  const encoder = new TextEncoder();
  const original = parseSourceDocument(encoder.encode("A\n\nB\n\nC\n"));
  const [originalA, originalB, originalC] = original.blocks;
  const split = applyDocumentEdit(original, {
    kind: "replace-block",
    blockId: originalA.id,
    markdown: "A1\n\nA2",
  });

  expect(split.blockRemap.get(originalA.id)).toEqual(
    split.candidate.blocks.slice(0, 2).map((block) => block.id),
  );
  expect(split.blockRemap.get(originalB.id)).toEqual([split.candidate.blocks[2].id]);
  expect(split.blockRemap.get(originalC.id)).toEqual([split.candidate.blocks[3].id]);

  const view = buildSourceView(original);
  const context = sourceContext(original, view);
  const merge = applyDocumentEdit(original, {
    kind: "source-changes",
    view,
    changes: [{ from: 1, to: 3, insert: " " }],
  }, context);
  expect(merge.candidate.blocks[0].raw).toBe("A B");
  expect(merge.blockRemap.get(originalA.id)).toEqual([merge.candidate.blocks[0].id]);
  expect(merge.blockRemap.get(originalB.id)).toEqual([merge.candidate.blocks[0].id]);
  expect(merge.blockRemap.get(originalC.id)).toEqual([merge.candidate.blocks[1].id]);

  const inserted = applyDocumentEdit(original, {
    kind: "insert-after",
    blockId: originalA.id,
    markdown: "\n\nNEW",
  });
  expect(inserted.blockRemap.get(originalA.id)).toEqual([inserted.candidate.blocks[0].id]);
  expect(inserted.blockRemap.get(originalB.id)).toEqual([inserted.candidate.blocks[2].id]);
  expect(inserted.blockRemap.get(originalC.id)).toEqual([inserted.candidate.blocks[3].id]);
  expect([...inserted.blockRemap.values()].flat()).not.toContain(
    inserted.candidate.blocks[1].id,
  );
});

it("maps a fully deleted block to nothing while the shifted block keeps its identity", () => {
  const original = parseSourceDocument(new TextEncoder().encode("A\n\nB\n\nC\n"));
  const [a, b, c] = original.blocks;
  const view = buildSourceView(original);
  const context = sourceContext(original, view);
  const result = applyDocumentEdit(original, {
    kind: "source-changes",
    view,
    changes: [{ from: b.start, to: c.start, insert: "" }],
  }, context);

  expect(result.candidate.text).toBe("A\n\nC\n");
  expect(result.blockRemap.get(a.id)).toEqual([result.candidate.blocks[0].id]);
  expect(result.blockRemap.get(b.id)).toEqual([]);
  expect(result.blockRemap.get(c.id)).toEqual([result.candidate.blocks[1].id]);
});

it("builds a dense Uint32Array view and applies ordered source changes byte-exactly", () => {
  const encoder = new TextEncoder();
  const bytes = Uint8Array.from([
    0xef, 0xbb, 0xbf,
    ...encoder.encode("A😀\r\n\r\nB\n\n<div>raw 😀</div>\r\n"),
  ]);
  const document = parseSourceDocument(bytes);
  const view = buildSourceView(document);
  const context = sourceContext(document, view);
  expect(view.text).toBe("A😀\n\nB\n\n<div>raw 😀</div>\n");
  expect(view.byteOffsetAtViewOffset).toBeInstanceOf(Uint32Array);
  expect([...view.byteOffsetAtViewOffset.slice(0, 5)]).toEqual([3, 4, 4, 8, 10]);

  const result = applyDocumentEdit(document, {
    kind: "source-changes",
    view,
    changes: [
      { from: 0, to: 1, insert: "AA" },
      { from: 5, to: 6, insert: "BB\nCC" },
    ],
  }, context);
  expect(decodeSourceBytes(result.candidate.bytes)).toBe(
    "AA😀\r\n\r\nBB\r\nCC\n\n<div>raw 😀</div>\r\n",
  );
  expect(result.candidate.bytes.slice(0, 3)).toEqual(bytes.slice(0, 3));
  expect(result.candidate.blocks.find((block) => block.protected)!.raw).toBe(
    "<div>raw 😀</div>",
  );
});

it("appends Source text without rewriting distant frontmatter and Protected Raw", () => {
  const encoder = new TextEncoder();
  const originalBytes = encoder.encode(`${PROTECTED_LOGICAL_TEXT}\nplain tail`);
  const document = parseSourceDocument(originalBytes);
  const view = buildSourceView(document);
  const context = sourceContext(document, view);

  const result = applyDocumentEdit(document, {
    kind: "source-changes",
    view,
    changes: [{ from: view.text.length, to: view.text.length, insert: " marker" }],
  }, context);

  expect(result.candidate.bytes.slice(0, originalBytes.length)).toEqual(originalBytes);
  expect(decodeSourceBytes(result.candidate.bytes)).toBe(`${PROTECTED_LOGICAL_TEXT}\nplain tail marker`);
});

it("allocates one final byte buffer for a 100-change transaction across 100KB", () => {
  const bytes = new Uint8Array(102_400).fill(0x61);
  const document = parseSourceDocument(bytes);
  const view = buildSourceView(document);
  const context = sourceContext(document, view);
  const changes = Array.from({ length: 100 }, (_, index) => ({
    from: index * 1_024,
    to: index * 1_024 + 1,
    insert: "b",
  }));
  const parse = vi.fn(parseSourceDocument);
  const NativeUint8Array = globalThis.Uint8Array;
  let allocations = 0;
  const copiedLengths: number[] = [];
  const originalSet = NativeUint8Array.prototype.set;
  const set = vi.spyOn(NativeUint8Array.prototype, "set").mockImplementation(function (
    this: Uint8Array,
    source: ArrayLike<number>,
    offset?: number,
  ) {
    copiedLengths.push(source.length);
    return Reflect.apply(originalSet, this, [source, offset]);
  });
  const CountingUint8Array = new Proxy(NativeUint8Array, {
    construct(target, args, newTarget) {
      allocations += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  globalThis.Uint8Array = CountingUint8Array;
  let result: ReturnType<typeof applyDocumentEdit>;
  try {
    result = applyDocumentEdit.call({ parseSourceDocument: parse }, document, {
      kind: "source-changes",
      view,
      changes,
    }, context);
  } finally {
    globalThis.Uint8Array = NativeUint8Array;
    set.mockRestore();
  }

  expect(allocations).toBe(1);
  // The forward splice may issue one unchanged and one inserted copy per edit,
  // plus a tail. Its total copied input must still be exactly one final output.
  expect(copiedLengths).toHaveLength(changes.length * 2 + 1);
  expect(copiedLengths.reduce((total, length) => total + length, 0)).toBe(bytes.length);
  expect(parse).toHaveBeenCalledOnce();
  expect(result.candidate.bytes).toHaveLength(bytes.length);
  for (const change of changes) expect(result.candidate.bytes[change.from]).toBe(0x62);
  expect(result.candidate.bytes.at(-1)).toBe(0x61);
});

it("rejects stale views, bad block targets, overlapping source changes, and invalid inserts", () => {
  const document = parseSourceDocument(
    new TextEncoder().encode("editable\n\n<div>protected</div>\n"),
  );
  const editable = document.blocks.find((block) => !block.protected)!;
  const protectedBlock = document.blocks.find((block) => block.protected)!;
  const view = buildSourceView(document);
  const context = sourceContext(document, view);

  expect(() => applyDocumentEdit(document, {
    kind: "replace-block", blockId: "missing", markdown: "x",
  })).toThrow("block not found");
  expect(() => applyDocumentEdit(document, {
    kind: "replace-block", blockId: protectedBlock.id, markdown: "x",
  })).toThrow("protected block");
  expect(() => applyDocumentEdit(document, {
    kind: "replace-protected", blockId: editable.id, markdown: "x",
  })).toThrow("not protected");
  expect(() => applyDocumentEdit(document, {
    kind: "source-changes",
    view,
    changes: [{ from: 0, to: 2, insert: "x" }, { from: 1, to: 3, insert: "y" }],
  }, context)).toThrow("ordered and non-overlapping");
  expect(() => applyDocumentEdit(document, {
    kind: "source-changes",
    view: { text: `${view.text}stale`, byteOffsetAtViewOffset: view.byteOffsetAtViewOffset },
    changes: [],
  }, context)).toThrow("canonical Source view identity");

  for (const insert of ["bad\0text", "bad\ud800", "bad\udc00"]) {
    expect(() => applyDocumentEdit(document, {
      kind: "source-changes", view, changes: [{ from: 0, to: 0, insert }],
    }, context)).toThrow();
  }

  const shifted = applyDocumentEdit(document, {
    kind: "insert-after", blockId: null, markdown: "new\n\n",
  });
  expect(() => applyDocumentEdit(shifted.candidate, {
    kind: "replace-block",
    blockId: editable.id,
    markdown: "stale id must not hit a shifted block",
  })).toThrow("block not found");
});

it("explicitly replaces one protected block while all other spans remain byte-identical", () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(
    "---\r\ntitle: old\r\n---\r\n\r\nbody 😀\r\n\r\n<div>keep exact</div>\r\n",
  );
  const document = parseSourceDocument(bytes);
  const yaml = document.blocks.find((block) => block.kind === "yaml")!;
  const replacement = "---\r\ntitle: new\r\n---";
  const result = applyDocumentEdit(document, {
    kind: "replace-protected",
    blockId: yaml.id,
    markdown: replacement,
  });

  expect(result.candidate.bytes.slice(yaml.byteStart + encoder.encode(replacement).length)).toEqual(
    bytes.slice(yaml.byteEnd),
  );
  expect(result.candidate.blocks.find((block) => block.raw.includes("keep exact"))!.raw).toBe(
    "<div>keep exact</div>",
  );
});

it("requires the controller-owned candidate-bound canonical view for source changes", () => {
  const document = parseSourceDocument(new TextEncoder().encode("A\r\nB\r\n"));
  const cache = new CurrentSourceViewCache();
  const entry = cache.getOrBuild("one", 0, document);
  const edit = {
    kind: "source-changes" as const,
    view: cloneSourceView(entry.view),
    changes: [{ from: 0, to: 1, insert: "AA" }],
  };

  expect(() => applyDocumentEdit(document, edit, entry)).toThrow("canonical Source view identity");
  const result = applyDocumentEdit(document, { ...edit, view: entry.view }, entry);
  expect(result.candidate.text).toBe("AA\r\nB\r\n");
  expect(document.text).toBe("A\r\nB\r\n");
});

it("applies multiple Rich block edits against one candidate with one parse and one remap", () => {
  const applyDocumentEdits = (sourceDocumentModule as typeof sourceDocumentModule & {
    applyDocumentEdits?: (candidate: ReturnType<typeof parseSourceDocument>, edits: readonly {
      kind: "replace-block";
      blockId: string;
      markdown: string;
    }[]) => ReturnType<typeof applyDocumentEdit>;
  }).applyDocumentEdits;
  expect(typeof applyDocumentEdits).toBe("function");

  const original = parseSourceDocument(new TextEncoder().encode(
    "A\r\n\r\nB\r\n\r\n<div>keep exact</div>\r\n",
  ));
  const editable = original.blocks.filter((block) => !block.protected);
  const parse = vi.fn(parseSourceDocument);
  const result = applyDocumentEdits!.call({ parseSourceDocument: parse }, original, [
    { kind: "replace-block", blockId: editable[0]!.id, markdown: "A **changed**" },
    { kind: "replace-block", blockId: editable[1]!.id, markdown: "B ~one~" },
  ]);

  expect(parse).toHaveBeenCalledOnce();
  expect(decodeSourceBytes(result.candidate.bytes)).toBe(
    "A **changed**\r\n\r\nB ~one~\r\n\r\n<div>keep exact</div>\r\n",
  );
  expect(result.candidate.blocks.find((block) => block.protected)?.raw).toBe(
    "<div>keep exact</div>",
  );
});

it("replaces one contiguous Rich document range with one parse", () => {
  const applyDocumentEdits = (sourceDocumentModule as typeof sourceDocumentModule & {
    applyDocumentEdits?: (candidate: ReturnType<typeof parseSourceDocument>, edits: readonly {
      kind: "replace-range";
      firstBlockId: string;
      lastBlockId: string;
      markdown: string;
    }[]) => ReturnType<typeof applyDocumentEdit>;
  }).applyDocumentEdits;
  const original = parseSourceDocument(new TextEncoder().encode(
    "# First\r\n\r\nSecond\r\n\r\nThird\r\n\r\n<div>keep exact</div>\r\n",
  ));
  const editable = original.blocks.filter((block) => !block.protected);
  const parse = vi.fn(parseSourceDocument);

  const result = applyDocumentEdits!.call({ parseSourceDocument: parse }, original, [{
    kind: "replace-range",
    firstBlockId: editable[0]!.id,
    lastBlockId: editable[2]!.id,
    markdown: "# First\r\n\r\nSecond joined\r\n\r\nNew paragraph",
  }]);

  expect(parse).toHaveBeenCalledOnce();
  expect(decodeSourceBytes(result.candidate.bytes)).toBe(
    "# First\r\n\r\nSecond joined\r\n\r\nNew paragraph\r\n\r\n<div>keep exact</div>\r\n",
  );
  expect(result.candidate.blocks.find((block) => block.protected)?.raw).toBe("<div>keep exact</div>");
});

it("moves one block while preserving the BOM, every original gap, and protected raw", () => {
  const encoder = new TextEncoder();
  const original = parseSourceDocument(Uint8Array.from([
    0xef, 0xbb, 0xbf,
    ...encoder.encode("A\r\n\r\n| H |\n| --- |\n| x |\r\n \r\n<div>keep exact</div>\n\nC"),
  ]));
  const table = original.blocks.find((block) => block.kind === "table")!;
  const first = original.blocks[0]!;
  const applyMove = sourceDocumentModule.applyDocumentEdits as unknown as (
    candidate: typeof original,
    edits: readonly { kind: "move-block"; blockId: string; beforeBlockId: string | null }[],
  ) => ReturnType<typeof applyDocumentEdit>;
  const parse = vi.fn(parseSourceDocument);

  const result = applyMove.call({ parseSourceDocument: parse }, original, [{
    kind: "move-block",
    blockId: table.id,
    beforeBlockId: first.id,
  }]);

  expect(parse).toHaveBeenCalledOnce();
  expect(result.candidate.bomLength).toBe(3);
  expect(result.candidate.text).toBe(
    "| H |\n| --- |\n| x |\r\n\r\nA\r\n \r\n<div>keep exact</div>\n\nC",
  );
  expect(result.candidate.blocks.find((block) => block.protected)?.raw).toBe("<div>keep exact</div>");
  expect(result.blockRemap.get(table.id)).toEqual([result.candidate.blocks[0]!.id]);
  expect(result.blockRemap.get(first.id)).toEqual([result.candidate.blocks[1]!.id]);
});

it("moves a protected block to the end without changing its bytes", () => {
  const original = parseSourceDocument(new TextEncoder().encode(
    "A\n\n<div>raw 😀</div>\n\nB\n\nC\n",
  ));
  const protectedBlock = original.blocks.find((block) => block.protected)!;
  const applyMove = sourceDocumentModule.applyDocumentEdits as unknown as (
    candidate: typeof original,
    edits: readonly { kind: "move-block"; blockId: string; beforeBlockId: string | null }[],
  ) => ReturnType<typeof applyDocumentEdit>;

  const result = applyMove(original, [{
    kind: "move-block",
    blockId: protectedBlock.id,
    beforeBlockId: null,
  }]);

  expect(result.candidate.text).toBe("A\n\nB\n\nC\n\n<div>raw 😀</div>\n");
  expect(result.candidate.blocks.at(-1)?.raw).toBe("<div>raw 😀</div>");
});

it("moves a CRLF GFM table before a paragraph without changing table structure", () => {
  const original = parseSourceDocument(new TextEncoder().encode(
    "A\r\n\r\n| H |\r\n| --- |\r\n| x |\r\n\r\nB\r\n",
  ));
  const first = original.blocks[0]!;
  const table = original.blocks.find((block) => block.kind === "table")!;

  const result = sourceDocumentModule.applyDocumentEdits(original, [{
    kind: "move-block",
    blockId: table.id,
    beforeBlockId: first.id,
  }]);

  expect(result.candidate.text).toBe(
    "| H |\r\n| --- |\r\n| x |\r\n\r\nA\r\n\r\nB\r\n",
  );
  expect(result.candidate.blocks.map((block) => block.kind)).toEqual(["table", "paragraph", "paragraph"]);
});

it("treats a block move to its current boundary as an identity no-op", () => {
  const original = parseSourceDocument(new TextEncoder().encode("A\n\nB\n\nC\n"));
  const [a, b] = original.blocks;
  const applyMove = sourceDocumentModule.applyDocumentEdits as unknown as (
    candidate: typeof original,
    edits: readonly { kind: "move-block"; blockId: string; beforeBlockId: string | null }[],
  ) => ReturnType<typeof applyDocumentEdit>;
  const parse = vi.fn(parseSourceDocument);

  const result = applyMove.call({ parseSourceDocument: parse }, original, [{
    kind: "move-block",
    blockId: a.id,
    beforeBlockId: b.id,
  }]);

  expect(result.candidate).toBe(original);
  expect(parse).not.toHaveBeenCalled();
  expect(result.blockRemap.get(a.id)).toEqual([a.id]);
  expect(() => applyMove(original, [{
    kind: "move-block",
    blockId: a.id,
    beforeBlockId: "missing",
  }])).toThrow("block not found");
});

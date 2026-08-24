import type {
  BlockViewSpan,
  SourceDocument,
  SourceTextEdit,
  SourceViewModel,
} from "../contracts/markdown";

function requireSafeOffset(offset: number, maximum: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum) {
    throw new Error("Source view offset must be a safe in-range integer");
  }
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function assertUtf16Boundary(text: string, offset: number): void {
  requireSafeOffset(offset, text.length);
  if (offset === 0 || offset === text.length) return;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  if (
    previous >= 0xd800 && previous <= 0xdbff &&
    current >= 0xdc00 && current <= 0xdfff
  ) {
    throw new Error("Source view offset splits a surrogate pair");
  }
}

export function buildSourceView(document: SourceDocument): SourceViewModel {
  if (!(document.bytes instanceof Uint8Array)) {
    throw new TypeError("source bytes must be a Uint8Array");
  }
  const offsets = [Number(document.bomLength)];
  const chunks: string[] = [];
  let sourceOffset = 0;
  let byteOffset = document.bomLength;

  while (sourceOffset < document.text.length) {
    const first = document.text[sourceOffset];
    if (first === "\r" && document.text[sourceOffset + 1] === "\n") {
      chunks.push("\n");
      sourceOffset += 2;
      byteOffset += 2;
      offsets.push(byteOffset);
      continue;
    }
    if (first === "\r") {
      chunks.push("\n");
      sourceOffset += 1;
      byteOffset += 1;
      offsets.push(byteOffset);
      continue;
    }

    const codePoint = document.text.codePointAt(sourceOffset);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    chunks.push(value);
    for (let unit = 1; unit < value.length; unit += 1) offsets.push(byteOffset);
    sourceOffset += value.length;
    byteOffset += utf8ByteLength(codePoint);
    offsets.push(byteOffset);
  }

  return {
    text: chunks.join(""),
    byteOffsetAtViewOffset: Uint32Array.from(offsets),
  };
}

export function sourceViewsEqual(a: SourceViewModel, b: SourceViewModel): boolean {
  return a.text === b.text &&
    a.byteOffsetAtViewOffset instanceof Uint32Array &&
    b.byteOffsetAtViewOffset instanceof Uint32Array &&
    a.byteOffsetAtViewOffset.length === b.byteOffsetAtViewOffset.length &&
    a.byteOffsetAtViewOffset.every((value, index) => value === b.byteOffsetAtViewOffset[index]);
}

export function applySourceTextEditsToView(
  text: string,
  changes: readonly SourceTextEdit[],
): string {
  let previousEnd = 0;
  for (const [index, change] of changes.entries()) {
    requireSafeOffset(change.from, text.length);
    requireSafeOffset(change.to, text.length);
    assertUtf16Boundary(text, change.from);
    assertUtf16Boundary(text, change.to);
    if (change.to < change.from || (index > 0 && change.from < previousEnd)) {
      throw new Error("source changes must be ordered and non-overlapping");
    }
    previousEnd = change.to;
  }
  const segments: string[] = [];
  let sourceOffset = 0;
  for (const change of changes) {
    segments.push(text.slice(sourceOffset, change.from), change.insert);
    sourceOffset = change.to;
  }
  segments.push(text.slice(sourceOffset));
  return segments.join("");
}

export function cloneSourceView(view: SourceViewModel): SourceViewModel {
  return {
    text: view.text,
    byteOffsetAtViewOffset: view.byteOffsetAtViewOffset.slice(),
  };
}

export function viewOffsetForByteOffset(
  view: SourceViewModel,
  byteOffset: number,
  bias: "before" | "after",
): number {
  if (!Number.isSafeInteger(byteOffset)) throw new Error("byte offset must be a safe integer");
  const offsets = view.byteOffsetAtViewOffset;
  if (!offsets.length || byteOffset < offsets[0] || byteOffset > offsets[offsets.length - 1]) {
    throw new Error("byte offset is outside the Source view");
  }
  let lower = 0;
  let upper = offsets.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (offsets[middle] < byteOffset) lower = middle + 1;
    else upper = middle - 1;
  }
  if (lower < offsets.length && offsets[lower] === byteOffset) {
    return lower;
  }
  if (bias === "after") return Math.min(offsets.length - 1, lower);
  let previous = Math.max(0, lower - 1);
  while (previous > 0 && offsets[previous] === offsets[previous - 1]) previous -= 1;
  return previous;
}

export function buildBlockViewSpans(
  document: SourceDocument,
  view: SourceViewModel,
  blockViewKeys: ReadonlyMap<string, string>,
): readonly BlockViewSpan[] {
  return document.blocks.map((block) => {
    const blockViewKey = blockViewKeys.get(block.id);
    if (!blockViewKey) throw new Error(`missing block view key for ${block.id}`);
    return {
      blockId: block.id,
      blockViewKey,
      kind: block.kind,
      start: viewOffsetForByteOffset(view, block.byteStart, "before"),
      end: viewOffsetForByteOffset(view, block.byteEnd, "after"),
    };
  });
}

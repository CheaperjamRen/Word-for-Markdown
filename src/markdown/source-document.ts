import type {
  BlockDocumentEdit,
  BlockPatch,
  DocumentEdit,
  DocumentEditResult,
  SourceBlock,
  SourceDocument,
  SourceTextEdit,
  SourceViewModel,
} from "../contracts/markdown";
import type { CurrentSourceViewEntry } from "./current-source-view-cache";
import { registerDeletionSourceRuns } from "./inline-profile";
import { isDeletionNode, parseMarkdown } from "./markdown-profile";

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
let nextParseId = 0;

function requireSourceBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("source bytes must be a Uint8Array");
  }
}

function decodeUtf8(bytes: Uint8Array): {
  bomLength: 0 | 3;
  text: string;
} {
  requireSourceBytes(bytes);

  const hasBom =
    bytes.length >= UTF8_BOM.length &&
    UTF8_BOM.every((value, index) => bytes[index] === value);
  const bomLength = hasBom ? 3 : 0;

  return {
    bomLength,
    text: decoder.decode(bytes.subarray(bomLength)),
  };
}

function containsHtml(node: unknown): boolean {
  if (typeof node !== "object" || node === null) {
    return false;
  }

  const candidate = node as { type?: unknown; children?: unknown };
  if (candidate.type === "html") {
    return true;
  }

  return (
    Array.isArray(candidate.children) && candidate.children.some(containsHtml)
  );
}

function detectNewline(text: string): SourceDocument["newline"] {
  const hasCrlf = text.includes("\r\n");
  const textWithoutCrlf = text.replace(/\r\n/g, "");
  const hasLf = textWithoutCrlf.includes("\n");
  const hasBareCr = textWithoutCrlf.includes("\r");

  if (hasBareCr || (hasCrlf && hasLf)) {
    return "mixed";
  }

  return hasCrlf ? "crlf" : "lf";
}

function assertReplacementText(markdown: string): void {
  if (markdown.includes("\0")) {
    throw new Error("replacement contains NUL");
  }

  for (let index = 0; index < markdown.length; index += 1) {
    const codeUnit = markdown.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = markdown.charCodeAt(index + 1);
      if (
        index + 1 >= markdown.length ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        throw new Error("replacement contains an unpaired surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("replacement contains an unpaired surrogate");
    }
  }
}

interface ByteEdit {
  from: number;
  to: number;
  insert: Uint8Array;
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function dominantNewline(text: string): "\n" | "\r\n" {
  let crlf = 0;
  let other = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      crlf += 1;
      index += 1;
    } else if (text[index] === "\r" || text[index] === "\n") {
      other += 1;
    }
  }
  return crlf > 0 && crlf >= other ? "\r\n" : "\n";
}

function normalizeInsertedNewlines(text: string, newline: "\n" | "\r\n"): string {
  return text.replace(/\r\n|\r|\n/g, "\n").replace(/\n/g, newline);
}

function validateByteEdits(edits: readonly ByteEdit[], byteLength: number): void {
  let previousEnd = 0;
  for (const [index, edit] of edits.entries()) {
    if (
      !Number.isInteger(edit.from) ||
      !Number.isInteger(edit.to) ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > byteLength ||
      (index > 0 && edit.from < previousEnd)
    ) {
      throw new Error("source changes must be ordered and non-overlapping");
    }
    previousEnd = edit.to;
  }
}

function applyByteEdits(bytes: Uint8Array, edits: readonly ByteEdit[]): Uint8Array {
  const finalLength = edits.reduce(
    (length, edit) => length + edit.insert.length - (edit.to - edit.from),
    bytes.length,
  );
  const candidate = new Uint8Array(finalLength);
  let sourceOffset = 0;
  let targetOffset = 0;
  for (const edit of edits) {
    const unchanged = bytes.subarray(sourceOffset, edit.from);
    candidate.set(unchanged, targetOffset);
    targetOffset += unchanged.length;
    candidate.set(edit.insert, targetOffset);
    targetOffset += edit.insert.length;
    sourceOffset = edit.to;
  }
  candidate.set(bytes.subarray(sourceOffset), targetOffset);
  return candidate;
}

function editTouchesSpan(edit: ByteEdit, start: number, end: number): boolean {
  if (edit.from === edit.to) {
    return edit.from > start && edit.from < end;
  }
  return edit.from < end && edit.to > start;
}

function mapBoundary(
  originalOffset: number,
  edits: readonly ByteEdit[],
  boundary: "start" | "end",
): number {
  let deltaBefore = 0;
  for (const edit of edits) {
    const delta = edit.insert.length - (edit.to - edit.from);
    if (originalOffset < edit.from) break;
    if (originalOffset > edit.to) {
      deltaBefore += delta;
      continue;
    }
    if (edit.from === edit.to && originalOffset === edit.from) {
      if (boundary === "start") deltaBefore += edit.insert.length;
      continue;
    }
    if (originalOffset === edit.from) {
      return edit.from + deltaBefore;
    }
    if (originalOffset === edit.to) {
      deltaBefore += delta;
      if (boundary === "end") return originalOffset + deltaBefore;
      continue;
    }
    return edit.from + deltaBefore + (boundary === "end" ? edit.insert.length : 0);
  }
  return originalOffset + deltaBefore;
}

function assertUntouchedProtectedSpans(
  original: SourceDocument,
  candidate: SourceDocument,
  edits: readonly ByteEdit[],
): void {
  for (const block of original.blocks.filter((candidateBlock) => candidateBlock.protected)) {
    if (edits.some((edit) => editTouchesSpan(edit, block.byteStart, block.byteEnd))) {
      continue;
    }
    const byteStart = mapBoundary(block.byteStart, edits, "start");
    const byteEnd = mapBoundary(block.byteEnd, edits, "end");
    const structureRemains = candidate.blocks.some(
      (candidateBlock) =>
        candidateBlock.byteStart === byteStart &&
        candidateBlock.byteEnd === byteEnd &&
        candidateBlock.kind === block.kind &&
        candidateBlock.raw === block.raw &&
        candidateBlock.protected,
    );
    const bytesRemain = byteArraysEqual(
      original.bytes.subarray(block.byteStart, block.byteEnd),
      candidate.bytes.subarray(byteStart, byteEnd),
    );
    if (!structureRemains || !bytesRemain) {
      throw new Error("candidate changed protected block structure");
    }
  }
}

function buildBlockRemap(
  original: SourceDocument,
  candidate: SourceDocument,
  edits: readonly ByteEdit[],
): ReadonlyMap<string, readonly string[]> {
  const remap = new Map<string, readonly string[]>();
  for (const block of original.blocks) {
    const byteStart = mapBoundary(block.byteStart, edits, "start");
    const byteEnd = mapBoundary(block.byteEnd, edits, "end");
    const mapped = candidate.blocks
      .filter(
        (candidateBlock) =>
          candidateBlock.byteStart < byteEnd && candidateBlock.byteEnd > byteStart,
      )
      .map((candidateBlock) => candidateBlock.id);
    remap.set(block.id, mapped);
  }
  return remap;
}

function assertUtf16Boundary(text: string, offset: number): void {
  if (offset <= 0 || offset >= text.length) return;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  if (
    previous >= 0xd800 && previous <= 0xdbff &&
    current >= 0xdc00 && current <= 0xdfff
  ) {
    throw new Error("source change splits a surrogate pair");
  }
}

function sourceChangesToByteEdits(
  document: SourceDocument,
  view: SourceViewModel,
  changes: readonly SourceTextEdit[],
  canonicalSourceView: CurrentSourceViewEntry | undefined,
): ByteEdit[] {
  if (
    !canonicalSourceView ||
    canonicalSourceView.candidate !== document ||
    canonicalSourceView.view !== view
  ) {
    throw new Error("source changes require canonical Source view identity");
  }

  let previousEnd = 0;
  const newline = dominantNewline(document.text);
  return changes.map((change, index) => {
    assertReplacementText(change.insert);
    if (
      !Number.isInteger(change.from) ||
      !Number.isInteger(change.to) ||
      change.from < 0 ||
      change.to < change.from ||
      change.to > view.text.length ||
      (index > 0 && change.from < previousEnd)
    ) {
      throw new Error("source changes must be ordered and non-overlapping");
    }
    assertUtf16Boundary(view.text, change.from);
    assertUtf16Boundary(view.text, change.to);
    previousEnd = change.to;
    return {
      from: view.byteOffsetAtViewOffset[change.from],
      to: view.byteOffsetAtViewOffset[change.to],
      insert: encoder.encode(normalizeInsertedNewlines(change.insert, newline)),
    };
  });
}

export function decodeSourceBytes(bytes: Uint8Array): string {
  return decodeUtf8(bytes).text;
}

export function parseSourceDocument(bytes: Uint8Array): SourceDocument {
  const { bomLength, text } = decodeUtf8(bytes);
  const parseId = nextParseId;
  nextParseId += 1;
  const tree = parseMarkdown(text);

  const parsedBlocks = tree.children.map((node, index) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;

    if (start === undefined || end === undefined) {
      throw new Error("Markdown block is missing source offsets");
    }

    return { end, index, node, start };
  });

  const offsets = [
    ...new Set([0, ...parsedBlocks.flatMap(({ start, end }) => [start, end])]),
  ].sort((left, right) => left - right);
  const offsetMap = new Map<number, number>();
  let previousOffset = 0;
  let cumulativeEncodedBytes = 0;
  offsetMap.set(0, bomLength);
  for (const offset of offsets) {
    cumulativeEncodedBytes += encoder.encode(text.slice(previousOffset, offset)).length;
    offsetMap.set(offset, bomLength + cumulativeEncodedBytes);
    previousOffset = offset;
  }
  const byteOffsetFor = (offset: number): number => {
    const byteOffset = offsetMap.get(offset);
    if (byteOffset === undefined) {
      throw new Error("Markdown block offset map entry is missing");
    }
    return byteOffset;
  };

  const blocks: SourceBlock[] = parsedBlocks.map(({ end, index, node, start }) => {
    const raw = text.slice(start, end);

    return {
      id: `block-${parseId}-${index}`,
      kind: node.type,
      start,
      end,
      byteStart: byteOffsetFor(start),
      byteEnd: byteOffsetFor(end),
      raw,
      protected:
        node.type === "yaml" ||
        node.type === "html" ||
        raw.startsWith(":::") ||
        containsHtml(node),
    };
  });

  const document: SourceDocument = {
    bytes,
    text,
    bomLength,
    newline: detectNewline(text),
    blocks,
  };
  const deletionRuns = new Map<string, readonly string[]>();
  parsedBlocks.forEach(({ node }, index) => {
    const runs: string[] = [];
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      const candidate = value as {
        children?: unknown[];
        position?: { start?: { offset?: number }; end?: { offset?: number } };
      };
      if (isDeletionNode(candidate)) {
        const start = candidate.position?.start?.offset;
        const end = candidate.position?.end?.offset;
        if (start !== undefined && end !== undefined) runs.push(text.slice(start, end));
      }
      candidate.children?.forEach(visit);
    };
    visit(node);
    if (runs.length > 0) deletionRuns.set(blocks[index]!.id, runs);
  });
  registerDeletionSourceRuns(document, deletionRuns);
  return document;
}

export function applyDocumentEdit(
  this: { parseSourceDocument?: typeof parseSourceDocument } | void,
  currentCandidate: SourceDocument,
  edit: DocumentEdit,
  canonicalSourceView?: CurrentSourceViewEntry,
): DocumentEditResult {
  if (edit.kind === "source-changes") {
    const edits = sourceChangesToByteEdits(
      currentCandidate,
      edit.view,
      edit.changes,
      canonicalSourceView,
    );
    validateByteEdits(edits, currentCandidate.bytes.length);
    const parseCandidate = this && typeof this.parseSourceDocument === "function"
      ? this.parseSourceDocument
      : parseSourceDocument;
    const candidate = parseCandidate(applyByteEdits(currentCandidate.bytes, edits));
    assertUntouchedProtectedSpans(currentCandidate, candidate, edits);
    return {
      candidate,
      blockRemap: buildBlockRemap(currentCandidate, candidate, edits),
    };
  }

  return applyDocumentEdits.call(this, currentCandidate, [edit]);
}

export function applyDocumentEdits(
  this: { parseSourceDocument?: typeof parseSourceDocument } | void,
  currentCandidate: SourceDocument,
  documentEdits: readonly BlockDocumentEdit[],
): DocumentEditResult {
  if (documentEdits.length === 0) throw new Error("document edits cannot be empty");
  const moveEdits = documentEdits.filter(
    (edit): edit is Extract<BlockDocumentEdit, { kind: "move-block" }> => edit.kind === "move-block",
  );
  if (moveEdits.length > 0) {
    if (documentEdits.length !== 1) throw new Error("move-block must be the only document edit");
    const edit = moveEdits[0]!;
    const sourceIndex = currentCandidate.blocks.findIndex((block) => block.id === edit.blockId);
    if (sourceIndex < 0) throw new Error("block not found");
    const beforeIndex = edit.beforeBlockId === null
      ? currentCandidate.blocks.length
      : currentCandidate.blocks.findIndex((block) => block.id === edit.beforeBlockId);
    if (beforeIndex < 0) throw new Error("block not found");

    const remaining = currentCandidate.blocks.filter((_, index) => index !== sourceIndex);
    const insertionIndex = edit.beforeBlockId === null
      ? remaining.length
      : remaining.findIndex((block) => block.id === edit.beforeBlockId);
    if (edit.beforeBlockId !== null && insertionIndex < 0) {
      if (edit.beforeBlockId === edit.blockId) {
        const identity = new Map(currentCandidate.blocks.map((block) => [block.id, [block.id] as readonly string[]]));
        return { candidate: currentCandidate, blockRemap: identity };
      }
      throw new Error("block not found");
    }
    const ordered = [...remaining];
    ordered.splice(insertionIndex, 0, currentCandidate.blocks[sourceIndex]!);
    if (ordered.every((block, index) => block.id === currentCandidate.blocks[index]?.id)) {
      const identity = new Map(currentCandidate.blocks.map((block) => [block.id, [block.id] as readonly string[]]));
      return { candidate: currentCandidate, blockRemap: identity };
    }

    const first = currentCandidate.blocks[0];
    const last = currentCandidate.blocks.at(-1);
    const prefix = first ? currentCandidate.text.slice(0, first.start) : currentCandidate.text;
    const gaps = currentCandidate.blocks.slice(0, -1).map((block, index) =>
      currentCandidate.text.slice(block.end, currentCandidate.blocks[index + 1]!.start),
    );
    const suffix = last ? currentCandidate.text.slice(last.end) : "";
    const nextText = prefix + ordered.map((block, index) => block.raw + (gaps[index] ?? "")).join("") + suffix;
    const encoded = encoder.encode(nextText);
    const CandidateBytes = currentCandidate.bytes.constructor as Uint8ArrayConstructor;
    const bytes = new CandidateBytes(currentCandidate.bomLength + encoded.length);
    if (currentCandidate.bomLength === 3) bytes.set(UTF8_BOM, 0);
    bytes.set(encoded, currentCandidate.bomLength);
    const parseCandidate = this && typeof this.parseSourceDocument === "function"
      ? this.parseSourceDocument
      : parseSourceDocument;
    const candidate = parseCandidate(bytes);
    if (
      candidate.blocks.length !== ordered.length ||
      ordered.some((block, index) => {
        const moved = candidate.blocks[index];
        return !moved || moved.kind !== block.kind || moved.raw !== block.raw || moved.protected !== block.protected;
      })
    ) throw new Error("moved block changed Markdown structure");
    const blockRemap = new Map<string, readonly string[]>();
    for (const block of currentCandidate.blocks) {
      const movedIndex = ordered.findIndex((candidateBlock) => candidateBlock.id === block.id);
      blockRemap.set(block.id, [candidate.blocks[movedIndex]!.id]);
    }
    return { candidate, blockRemap };
  }
  const targetedBlocks = new Set<string>();
  const edits = documentEdits.map((edit): ByteEdit => {
    if (edit.kind === "move-block") throw new Error("unreachable move-block edit");
    assertReplacementText(edit.markdown);
    if (edit.kind === "replace-range") {
      const firstIndex = currentCandidate.blocks.findIndex(
        (candidate) => candidate.id === edit.firstBlockId,
      );
      const lastIndex = currentCandidate.blocks.findIndex(
        (candidate) => candidate.id === edit.lastBlockId,
      );
      if (firstIndex < 0 || lastIndex < firstIndex) throw new Error("block range not found");
      const range = currentCandidate.blocks.slice(firstIndex, lastIndex + 1);
      if (range.some((block) => block.protected)) {
        throw new Error("cannot replace a protected block range");
      }
      for (const block of range) {
        if (targetedBlocks.has(block.id)) throw new Error("duplicate block edit");
        targetedBlocks.add(block.id);
      }
      return {
        from: range[0]!.byteStart,
        to: range.at(-1)!.byteEnd,
        insert: encoder.encode(edit.markdown),
      };
    }
    if (edit.kind === "insert-after") {
      const target = edit.blockId === null
        ? null
        : currentCandidate.blocks.find((candidate) => candidate.id === edit.blockId);
      if (edit.blockId !== null && !target) throw new Error("block not found");
      const targetKey = `insert:${edit.blockId ?? "start"}`;
      if (targetedBlocks.has(targetKey)) throw new Error("duplicate block edit");
      targetedBlocks.add(targetKey);
      const byteOffset = target == null
        ? (currentCandidate.blocks[0]?.byteStart ?? currentCandidate.bytes.length)
        : target === currentCandidate.blocks.at(-1)
          ? currentCandidate.bytes.length
          : target.byteEnd;
      return { from: byteOffset, to: byteOffset, insert: encoder.encode(edit.markdown) };
    }

    const block = currentCandidate.blocks.find((candidate) => candidate.id === edit.blockId);
    if (!block) throw new Error("block not found");
    if (targetedBlocks.has(block.id)) throw new Error("duplicate block edit");
    targetedBlocks.add(block.id);
    if (edit.kind === "replace-block" && block.protected) {
      throw new Error("cannot replace a protected block");
    }
    if (edit.kind === "replace-protected" && !block.protected) {
      throw new Error("protected editor target is not protected");
    }
    return {
      from: block.byteStart,
      to: block.byteEnd,
      insert: encoder.encode(edit.markdown),
    };
  }).sort((left, right) => left.from - right.from || left.to - right.to);

  validateByteEdits(edits, currentCandidate.bytes.length);
  const parseCandidate = this && typeof this.parseSourceDocument === "function"
    ? this.parseSourceDocument
    : parseSourceDocument;
  const candidate = parseCandidate(applyByteEdits(currentCandidate.bytes, edits));
  assertUntouchedProtectedSpans(currentCandidate, candidate, edits);
  return {
    candidate,
    blockRemap: buildBlockRemap(currentCandidate, candidate, edits),
  };
}

export function replaceEditableBlock(
  document: SourceDocument,
  patch: BlockPatch,
): Uint8Array {
  return applyDocumentEdit(document, {
    kind: "replace-block",
    blockId: patch.blockId,
    markdown: patch.markdown,
  }).candidate.bytes;
}

import type {
  BlockViewSpan,
  DocumentEditResult,
  SelectionSnapshot,
  SourceDocument,
  SourceSelectionRange,
  SourceViewModel,
} from "../contracts/markdown";
import type { DocumentViewportAnchor } from "../documents/session";
import { viewOffsetForByteOffset } from "../markdown/source-view";

function validateOffset(text: string, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    throw new Error("Source selection offset must be a safe in-range integer");
  }
  if (offset > 0 && offset < text.length) {
    const previous = text.charCodeAt(offset - 1);
    const current = text.charCodeAt(offset);
    if (
      previous >= 0xd800 && previous <= 0xdbff &&
      current >= 0xdc00 && current <= 0xdfff
    ) throw new Error("Source selection offset splits a surrogate pair");
  }
  return offset;
}

function containingSpan(offset: number, spans: readonly BlockViewSpan[]): BlockViewSpan | null {
  return spans.find((span) => offset >= span.start && offset <= span.end) ?? null;
}

function textEndpoint(
  offset: number,
  spans: readonly BlockViewSpan[],
  text: string,
): { blockKey: string | null; offset: number } {
  validateOffset(text, offset);
  const span = containingSpan(offset, spans);
  return span
    ? { blockKey: span.blockViewKey, offset: offset - span.start }
    : { blockKey: null, offset };
}

export function textSelectionForSourceRange(
  range: SourceSelectionRange,
  spans: readonly BlockViewSpan[],
  text: string,
): Extract<SelectionSnapshot, { kind: "text" }> {
  const anchor = textEndpoint(range.anchor, spans, text);
  const focus = textEndpoint(range.head, spans, text);
  return {
    kind: "text",
    anchorBlockKey: anchor.blockKey,
    anchorOffset: anchor.offset,
    focusBlockKey: focus.blockKey,
    focusOffset: focus.offset,
  };
}

function fallbackForMissingKey(
  blockKey: string,
  currentSpans: readonly BlockViewSpan[],
  previousSpans: readonly BlockViewSpan[],
  text: string,
): number {
  const previousIndex = previousSpans.findIndex((span) => span.blockViewKey === blockKey);
  if (previousIndex >= 0) {
    for (let index = previousIndex - 1; index >= 0; index -= 1) {
      const survivor = currentSpans.find(
        (span) => span.blockViewKey === previousSpans[index].blockViewKey,
      );
      if (survivor) return validateOffset(text, survivor.end);
    }
    for (let index = previousIndex + 1; index < previousSpans.length; index += 1) {
      const survivor = currentSpans.find(
        (span) => span.blockViewKey === previousSpans[index].blockViewKey,
      );
      if (survivor) return validateOffset(text, survivor.start);
    }
  }
  return validateOffset(text, currentSpans.at(-1)?.end ?? 0);
}

function sourceOffsetForTextEndpoint(
  blockKey: string | null,
  offset: number,
  spans: readonly BlockViewSpan[],
  text: string,
  previousSpans: readonly BlockViewSpan[],
): number {
  if (blockKey === null) return validateOffset(text, Math.min(text.length, Math.max(0, offset)));
  const span = spans.find((candidate) => candidate.blockViewKey === blockKey);
  if (!span) return fallbackForMissingKey(blockKey, spans, previousSpans, text);
  const relative = Number.isSafeInteger(offset) ? Math.min(span.end - span.start, Math.max(0, offset)) : 0;
  return validateOffset(text, span.start + relative);
}

export function sourceRangeForSelection(
  selection: SelectionSnapshot | null,
  spans: readonly BlockViewSpan[],
  text: string,
  previousSpans: readonly BlockViewSpan[] = spans,
): SourceSelectionRange | null {
  if (selection === null) return null;
  if (selection.kind === "table") {
    const table = spans.find((span) => span.blockViewKey === selection.tableBlockViewKey);
    const offset = table?.start ?? fallbackForMissingKey(
      selection.tableBlockViewKey,
      spans,
      previousSpans,
      text,
    );
    return { anchor: offset, head: offset };
  }
  return {
    anchor: sourceOffsetForTextEndpoint(
      selection.anchorBlockKey,
      selection.anchorOffset,
      spans,
      text,
      previousSpans,
    ),
    head: sourceOffsetForTextEndpoint(
      selection.focusBlockKey,
      selection.focusOffset,
      spans,
      text,
      previousSpans,
    ),
  };
}

export function viewportAnchorForSourceOffset(
  offset: number,
  spans: readonly BlockViewSpan[],
  text: string,
): DocumentViewportAnchor {
  validateOffset(text, offset);
  const span = containingSpan(offset, spans);
  return span
    ? { blockViewKey: span.blockViewKey, offset: offset - span.start }
    : { blockViewKey: null, offset };
}

export function sourceOffsetForViewportAnchor(
  anchor: DocumentViewportAnchor | null,
  spans: readonly BlockViewSpan[],
  text: string,
  previousSpans: readonly BlockViewSpan[] = spans,
): number | null {
  if (anchor === null) return null;
  return sourceOffsetForTextEndpoint(
    anchor.blockViewKey,
    anchor.offset,
    spans,
    text,
    previousSpans,
  );
}

function endpointAfterSourceEdit(
  offset: number,
  currentDocument: SourceDocument,
  currentBlockViewKeys: ReadonlyMap<string, string>,
  result: DocumentEditResult,
  resultView: SourceViewModel,
): { blockKey: string | null; offset: number } {
  validateOffset(resultView.text, offset);
  const resultBlock = result.candidate.blocks.find((block) => {
    const start = viewOffsetForByteOffset(resultView, block.byteStart, "before");
    const end = viewOffsetForByteOffset(resultView, block.byteEnd, "after");
    return offset >= start && offset <= end;
  });
  if (!resultBlock) return { blockKey: null, offset };

  const owners = currentDocument.blocks.filter((block) =>
    result.blockRemap.get(block.id)?.includes(resultBlock.id),
  );
  if (owners.length !== 1) return { blockKey: null, offset };

  const owner = owners[0];
  const mapped = result.blockRemap.get(owner.id);
  const blockKey = currentBlockViewKeys.get(owner.id);
  if (
    mapped?.length !== 1 ||
    mapped[0] !== resultBlock.id ||
    owner.kind !== resultBlock.kind ||
    !blockKey
  ) {
    return { blockKey: null, offset };
  }

  const start = viewOffsetForByteOffset(resultView, resultBlock.byteStart, "before");
  return { blockKey, offset: offset - start };
}

export function textSelectionAfterSourceEdit(
  range: SourceSelectionRange,
  currentDocument: SourceDocument,
  currentBlockViewKeys: ReadonlyMap<string, string>,
  result: DocumentEditResult,
  resultView: SourceViewModel,
): Extract<SelectionSnapshot, { kind: "text" }> {
  const anchor = endpointAfterSourceEdit(
    range.anchor,
    currentDocument,
    currentBlockViewKeys,
    result,
    resultView,
  );
  const focus = endpointAfterSourceEdit(
    range.head,
    currentDocument,
    currentBlockViewKeys,
    result,
    resultView,
  );
  return {
    kind: "text",
    anchorBlockKey: anchor.blockKey,
    anchorOffset: anchor.offset,
    focusBlockKey: focus.blockKey,
    focusOffset: focus.offset,
  };
}

import type { SourceDocument } from "../contracts/markdown";

const deletionRunsByDocument = new WeakMap<
  SourceDocument,
  ReadonlyMap<string, readonly string[]>
>();

export function registerDeletionSourceRuns(
  document: SourceDocument,
  runsByBlockId: ReadonlyMap<string, readonly string[]>,
): void {
  deletionRunsByDocument.set(document, runsByBlockId);
}

export function deletionSourceRunsForBlock(
  document: SourceDocument,
  blockId: string,
): readonly string[] {
  return deletionRunsByDocument.get(document)?.get(blockId) ?? [];
}

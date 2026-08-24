import { ChangeSet } from "@codemirror/state";

import type { SourceTextEdit } from "../contracts/markdown";

export function composePendingChanges(pending: ChangeSet, next: ChangeSet): ChangeSet {
  if (!(pending instanceof ChangeSet) || !(next instanceof ChangeSet)) {
    throw new TypeError("Source changes must be CodeMirror ChangeSet values");
  }
  if (pending.newLength !== next.length) {
    throw new Error("Source ChangeSet composition length mismatch");
  }
  return pending.compose(next);
}

export function sourceTextEditsFromChangeSet(changes: ChangeSet): readonly SourceTextEdit[] {
  if (!(changes instanceof ChangeSet)) {
    throw new TypeError("Source changes must be a CodeMirror ChangeSet value");
  }
  const edits: SourceTextEdit[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return edits;
}

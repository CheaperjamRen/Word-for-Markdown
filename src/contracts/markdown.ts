export interface SourceBlock {
  id: string;
  kind: string;
  start: number;
  end: number;
  byteStart: number;
  byteEnd: number;
  raw: string;
  protected: boolean;
}

export interface SourceDocument {
  bytes: Uint8Array;
  text: string;
  bomLength: 0 | 3;
  newline: "lf" | "crlf" | "mixed";
  blocks: SourceBlock[];
}

export interface BlockPatch {
  blockId: string;
  markdown: string;
}

export interface SourceTextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface SourceViewModel {
  text: string;
  byteOffsetAtViewOffset: Uint32Array;
}

export interface BlockViewSpan {
  blockId: string;
  blockViewKey: string;
  kind: string;
  start: number;
  end: number;
}

export interface SourceSelectionRange {
  anchor: number;
  head: number;
}

export type SourceHistoryKind = "typing" | "delete" | "composition" | "atomic";

export interface SourceHistoryGroup {
  id: string;
  kind: SourceHistoryKind;
}

export interface SourceChangeBatch {
  sessionId: string;
  baseCandidateRevision: number;
  changes: readonly SourceTextEdit[];
  selectionAfter: SourceSelectionRange;
  historyGroup: SourceHistoryGroup;
}

export type SourceChangeAck =
  | { kind: "accepted"; candidateRevision: number }
  | { kind: "rejected"; validationError: string }
  | { kind: "stale" };

export type DocumentEdit =
  | { kind: "replace-block"; blockId: string; markdown: string }
  | { kind: "replace-protected"; blockId: string; markdown: string }
  | { kind: "insert-after"; blockId: string | null; markdown: string }
  | { kind: "move-block"; blockId: string; beforeBlockId: string | null }
  | {
      kind: "replace-range";
      firstBlockId: string;
      lastBlockId: string;
      markdown: string;
    }
  | {
      kind: "source-changes";
      view: SourceViewModel;
      changes: readonly SourceTextEdit[];
    };

export type BlockDocumentEdit = Exclude<DocumentEdit, { kind: "source-changes" }>;

export type RichBlockMutation =
  | {
      kind: "replace-block" | "replace-protected" | "insert-after";
      blockViewKey: string | null;
      markdown: string;
    }
  | {
      kind: "replace-range";
      firstBlockViewKey: string;
      lastBlockViewKey: string;
      markdown: string;
    }
  | {
      kind: "move-block";
      blockViewKey: string;
      beforeBlockViewKey: string | null;
    };

export interface RichSelectionBookmark {
  blockViewKey: string;
  anchorTextOffset: number;
  focusTextOffset: number;
}

export interface RichEditRequest {
  sessionId: string;
  baseCandidateRevision: number;
  mutations: readonly RichBlockMutation[];
  selectionAfter: RichSelectionBookmark | null;
}

export type RichEditAck =
  | { kind: "accepted"; candidateRevision: number }
  | {
      kind: "rejected";
      reason: "invalid-markdown" | "protected-boundary" | "unsupported-selection";
    }
  | { kind: "stale" };

export interface DocumentEditResult {
  candidate: SourceDocument;
  blockRemap: ReadonlyMap<string, readonly string[]>;
}

export interface SourceBufferState {
  sessionId: string;
  baseCandidateRevision: number;
  baseView: SourceViewModel;
  bufferText: string;
  composedChanges: readonly SourceTextEdit[];
  validationError: string | null;
}

export interface TableCoordinate {
  row: number;
  column: number;
}

export type SelectionSnapshot =
  | {
      kind: "text";
      anchorBlockKey: string | null;
      anchorOffset: number;
      focusBlockKey: string | null;
      focusOffset: number;
    }
  | {
      kind: "table";
      tableBlockViewKey: string;
      anchor: TableCoordinate;
      focus: TableCoordinate;
      origin: TableCoordinate;
    };

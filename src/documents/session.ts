import type { FileVersion } from "../contracts/desktop";
import type {
  DocumentEditResult,
  SelectionSnapshot,
  SourceBufferState,
  SourceDocument,
} from "../contracts/markdown";

export type DocumentMode = "reading" | "rich" | "source";
export type DocumentModeChangeResult = "changed" | "unchanged" | "blocked-buffer" | "stale";
export type DocumentStatus =
  | "clean"
  | "dirty"
  | "saving"
  | "failed"
  | "readonly"
  | "conflict";

export type ExternalChangeState =
  | { kind: "checking"; watchId: string }
  | {
      kind: "conflict";
      watchId: string;
      external: SourceDocument;
      detectedVersion: FileVersion;
    }
  | { kind: "deleted"; watchId: string }
  | { kind: "renamed"; watchId: string; suggestedPath: string | null };

export interface DocumentHistoryEntry {
  candidate: SourceDocument;
  blockViewKeys: ReadonlyMap<string, string>;
  selection: SelectionSnapshot | null;
}

export const DOCUMENT_HISTORY_LIMIT = 50;

export interface DocumentHistory {
  past: DocumentHistoryEntry[];
  future: DocumentHistoryEntry[];
}

export interface DocumentViewportAnchor {
  blockViewKey: string | null;
  offset: number;
}

export interface ProtectedRawBufferState {
  sessionId: string;
  baseCandidateRevision: number;
  blockViewKey: string;
  bufferText: string;
  validationError: string | null;
  dirty: boolean;
}

export interface DocumentSession {
  kind: "document";
  id: string;
  file:
    | { kind: "untitled"; displayName: string }
    | { kind: "local"; canonicalPath: string; version: FileVersion };
  baseline: SourceDocument;
  candidate: SourceDocument;
  status: DocumentStatus;
  mode: DocumentMode;
  revision: number;
  zoomPercent: number;
  draftId: string | null;
  externalChange: ExternalChangeState | null;
  blockViewKeys: ReadonlyMap<string, string>;
  sourceBuffer: SourceBufferState | null;
  protectedRawBuffer: ProtectedRawBufferState | null;
  viewState: {
    scrollAnchor: DocumentViewportAnchor | null;
    selection: SelectionSnapshot | null;
  };
  history: DocumentHistory;
}

export type DocumentCommand = "save" | "undo" | "redo";

export function documentEditsAreEnabled(session: DocumentSession): boolean {
  return session.status !== "readonly" &&
    session.status !== "conflict" &&
    session.protectedRawBuffer === null;
}

export function documentCommandIsEnabled(
  session: DocumentSession,
  command: DocumentCommand,
): boolean {
  if (session.sourceBuffer !== null || session.protectedRawBuffer !== null) return false;
  if (command === "save") return session.status === "dirty" || session.status === "failed";
  if (session.status === "readonly" || session.status === "conflict") return false;
  return command === "undo"
    ? session.history.past.length > 0
    : session.history.future.length > 0;
}

export interface ResourcePreviewSession {
  kind: "preview";
  id: string;
  canonicalPath: string;
  displayName: string;
  mediaType: "image" | "pdf";
  zoomPercent: number;
}

export type WorkspaceTab = DocumentSession | ResourcePreviewSession;

export type DocumentFileIntent = DocumentSession["file"];

export const WRITTEN_TARGET_RECEIPT_LIMIT = 50;

export interface WrittenTargetReceipt {
  operationId: string;
  kind: "save" | "save-as";
  sessionId: string;
  canonicalPath: string;
  version: FileVersion;
  reason: "session-closed" | "intent-replaced";
  savedRevision: number;
  byteLength: number;
  seen: boolean;
}

export interface WorkspaceState {
  tabs: readonly WorkspaceTab[];
  activeTabId: string | null;
  pendingOperations: ReadonlyMap<string, PendingOperation>;
  writeReceipts: readonly WrittenTargetReceipt[];
  pendingWatchCleanupIds: readonly string[];
}

export type PendingOperation =
  | { id: string; kind: "open"; requestedPath: string }
  | {
      id: string;
      kind: "save";
      sessionId: string;
      savedRevision: number;
      savedCandidate: SourceDocument;
      source: { canonicalPath: string; expectedVersion: FileVersion };
    }
  | {
      id: string;
      kind: "save-as";
      sessionId: string;
      savedRevision: number;
      savedCandidate: SourceDocument;
      source: DocumentFileIntent;
      target: { requestedPath: string; expectedVersion: FileVersion | null };
    }
  | {
      id: string;
      kind: "draft";
      sessionId: string;
      candidateRevision: number;
    }
  | {
      id: string;
      kind: "watch";
      sessionId: string;
      canonicalPath: string;
    };

export type SessionAction =
  | { type: "begin-operation"; operation: PendingOperation }
  | { type: "open-succeeded"; operationId: string; session: DocumentSession }
  | { type: "draft-restored"; session: DocumentSession }
  | { type: "draft-cleared"; sessionId: string; draftId: string }
  | { type: "open-preview"; preview: ResourcePreviewSession }
  | {
      type: "external-reloaded";
      sessionId: string;
      expectedRevision: number;
      watchId: string;
      document: SourceDocument;
      version: FileVersion;
    }
  | {
      type: "external-conflict";
      sessionId: string;
      expectedRevision: number;
      watchId: string;
      document: SourceDocument;
      version: FileVersion;
    }
  | { type: "external-keep-local"; sessionId: string }
  | { type: "external-use-disk"; sessionId: string }
  | {
      type: "external-marked";
      sessionId: string;
      expectedRevision: number;
      watchId: string;
      kind: "deleted" | "renamed";
      suggestedPath: string | null;
    }
  | { type: "operation-failed"; operationId: string }
  | { type: "activate-tab"; tabId: string }
  | { type: "close-tab"; tabId: string }
  | {
      type: "edit-applied";
      sessionId: string;
      expectedRevision: number;
      result: DocumentEditResult;
      selectionAfter: SelectionSnapshot | null;
    }
  | { type: "history-undo"; sessionId: string; expectedRevision: number }
  | { type: "history-redo"; sessionId: string; expectedRevision: number }
  | {
      type: "set-mode";
      sessionId: string;
      expectedRevision: number;
      mode: DocumentMode;
    }
  | {
      type: "document-zoom-updated";
      sessionId: string;
      expectedRevision: number;
      zoomPercent: number;
    }
  | {
      type: "source-selection-updated";
      sessionId: string;
      expectedRevision: number;
      selection: Extract<SelectionSnapshot, { kind: "text" }> | null;
    }
  | {
      type: "source-viewport-updated";
      sessionId: string;
      expectedRevision: number;
      anchor: DocumentViewportAnchor | null;
    }
  | { type: "save-succeeded"; operationId: string; version: FileVersion }
  | {
      type: "save-as-succeeded";
      operationId: string;
      canonicalPath: string;
      version: FileVersion;
      closeIfClean?: boolean;
    }
  | { type: "draft-succeeded"; operationId: string; draftId: string }
  | { type: "watch-succeeded"; operationId: string; watchId: string }
  | { type: "write-receipts-seen"; operationIds: readonly string[] }
  | { type: "watch-cleanup-succeeded"; watchId: string }
  | {
      type: "source-buffer-rejected";
      sessionId: string;
      expectedRevision: number;
      buffer: SourceBufferState;
      selectionAfter: Extract<SelectionSnapshot, { kind: "text" }>;
    }
  | {
      type: "source-buffer-accepted";
      sessionId: string;
      expectedRevision: number;
      expectedBufferText: string;
      result: DocumentEditResult | null;
      selectionAfter: Extract<SelectionSnapshot, { kind: "text" }>;
    }
  | {
      type: "protected-raw-buffer-opened";
      sessionId: string;
      expectedRevision: number;
      blockViewKey: string;
    }
  | {
      type: "protected-raw-buffer-updated";
      sessionId: string;
      expectedRevision: number;
      blockViewKey: string;
      bufferText: string;
    }
  | {
      type: "protected-raw-buffer-cancelled";
      sessionId: string;
      expectedRevision: number;
      blockViewKey: string;
    }
  | {
      type: "protected-raw-buffer-rejected";
      sessionId: string;
      expectedRevision: number;
      blockViewKey: string;
      expectedBufferText: string;
      validationError: string;
    }
  | {
      type: "protected-raw-buffer-accepted";
      sessionId: string;
      expectedRevision: number;
      blockViewKey: string;
      expectedBufferText: string;
      result: DocumentEditResult;
    };

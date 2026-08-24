export const DESKTOP_COMMANDS = {
  takeOpenRequests: "take_open_requests",
  openDocument: "open_document",
  saveDocument: "save_document",
  saveDocumentAs: "save_document_as",
  writeDraft: "write_draft",
  listDrafts: "list_drafts",
  readDraft: "read_draft",
  deleteDraft: "delete_draft",
  watchDocument: "watch_document",
  unwatchDocument: "unwatch_document",
  recordFirstReadablePaint: "record_first_readable_paint",
  resolveTarget: "resolve_target",
  getUiLanguageHint: "get_ui_language_hint",
} as const;

export const DESKTOP_EVENTS = {
  openDocumentRequests: "open-document-requests",
  fileChanged: "document-file-changed",
} as const;

import type { SelectionSnapshot } from "./markdown";
import type { ResolvedTarget } from "../desktop/target-resolver";

export interface FileVersion {
  len: number;
  modifiedMs: number;
  sha256: string;
}

export interface HostOpenDocument {
  canonicalPath: string;
  bytes: number[];
  version: FileVersion;
}

export interface SaveDocumentRequest {
  canonicalPath: string;
  bytes: number[];
  expectedVersion: FileVersion;
}

export type TakeOpenRequestsRequest = Record<string, never>;

export interface TakeOpenRequestsInvoke {
  request: TakeOpenRequestsRequest;
}

export interface OpenDocumentRequest {
  path: string;
}

export interface OpenDocumentInvoke {
  request: OpenDocumentRequest;
}

export interface SaveDocumentInvoke {
  request: SaveDocumentRequest;
}

export interface SaveDocumentAsRequest {
  targetPath: string;
  bytes: number[];
  expectedTargetVersion: FileVersion | null;
}

export interface SaveDocumentAsInvoke {
  request: SaveDocumentAsRequest;
}

export interface SaveDocumentAsResult {
  canonicalPath: string;
  version: FileVersion;
}

export interface RejectedSourceBuffer {
  baseCandidateRevision: number;
  baseCandidateSha256: string;
  utf16CodeUnitsBase64: string;
  selection: SelectionSnapshot | null;
}

export interface DraftRecord {
  id: string;
  sessionId: string;
  canonicalPath: string | null;
  baselineVersion: FileVersion | null;
  bytes: number[];
  candidateRevision: number;
  rejectedSourceBuffer: RejectedSourceBuffer | null;
  updatedMs: number;
}

export type DraftPayload = Omit<DraftRecord, "updatedMs">;

export interface WriteDraftRequest { draft: DraftPayload }
export interface DraftIdRequest { id: string }
export interface WatchDocumentRequest { canonicalPath: string }
export interface WatchDocumentResult { watchId: string; canonicalPath: string }
export interface UnwatchDocumentRequest { watchId: string }

export interface WriteDraftInvoke { request: WriteDraftRequest }
export interface ListDraftsInvoke { request: TakeOpenRequestsRequest }
export interface ReadDraftInvoke { request: DraftIdRequest }
export interface DeleteDraftInvoke { request: DraftIdRequest }
export interface WatchDocumentInvoke { request: WatchDocumentRequest }
export interface UnwatchDocumentInvoke { request: UnwatchDocumentRequest }
export interface ResolveTargetInvoke { request: { basePath: string; href: string } }

export interface FileChangedEvent {
  watchId: string;
  canonicalPath: string;
  kind: "content" | "deleted" | "renamed";
  newCanonicalPath: string | null;
}

export type DesktopFailureCode =
  | "invalid-request" | "invalid-path" | "not-found" | "already-exists"
  | "changed" | "concurrent-writer" | "permission-denied" | "read-only"
  | "io" | "draft-invalid" | "watch-failed";

export interface DesktopFailure {
  code: DesktopFailureCode;
  affectedPaths: string[];
  recoveryPaths: string[];
  draftId: string | null;
}

export class DesktopWireError extends Error {
  constructor() {
    super("Invalid desktop wire payload");
    this.name = "DesktopWireError";
  }
}

export class DesktopFailureError extends Error {
  constructor(readonly failure: DesktopFailure) {
    super(failure.code);
    this.name = "DesktopFailureError";
  }
}

export function getDesktopFailure(error: unknown): DesktopFailure | null {
  return error instanceof DesktopFailureError ? error.failure : null;
}

export interface UiContractSnapshot {
  uiFontSize: string;
  statusFontSize: string;
  documentFontSize: string;
  documentLineHeight: string;
  toolbarIconWidth: string;
  iconButtonHeight: string;
}

export interface RecordFirstReadablePaintRequest {
  path: string;
  applicationNetworkRequests: number;
  uiContract: UiContractSnapshot;
}

export interface RecordFirstReadablePaintInvoke {
  request: RecordFirstReadablePaintRequest;
}

export type TakeOpenRequestsResult = string[];
export type OpenDocumentEventPayload = null;

export interface HostApi {
  onOpenRequests(listener: (paths: string[]) => void): Promise<() => void>;
  onFileDrop(listener: (paths: string[]) => void): Promise<() => void>;
  onWindowCloseRequested(listener: () => void): Promise<() => void>;
  onFileChanged(listener: (event: FileChangedEvent) => void): Promise<() => void>;
  pickMarkdownFiles(): Promise<string[] | null>;
  pickMarkdownSavePath(suggestedName?: string): Promise<string | null>;
  openDocument(path: string): Promise<HostOpenDocument>;
  saveDocument(request: SaveDocumentRequest): Promise<FileVersion>;
  saveDocumentAs(request: SaveDocumentAsRequest): Promise<SaveDocumentAsResult>;
  writeDraft(draft: DraftPayload): Promise<DraftRecord>;
  listDrafts(): Promise<DraftRecord[]>;
  readDraft(id: string): Promise<DraftRecord>;
  deleteDraft(id: string): Promise<void>;
  watchDocument(canonicalPath: string): Promise<WatchDocumentResult>;
  unwatchDocument(watchId: string): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  closeWindow(): Promise<void>;
  getAppVersion(): Promise<string>;
  getUiLanguageHint?(): Promise<"zh-CN" | "en-US" | null>;
  recordFirstReadablePaint(path: string, uiContract: UiContractSnapshot): Promise<number>;
  resolveTarget?(basePath: string, href: string): Promise<ResolvedTarget>;
  openSystemTarget?(canonicalPath: string): Promise<void>;
  openExternalUrl?(url: string): Promise<void>;
}

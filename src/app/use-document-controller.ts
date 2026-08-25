import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  DesktopWireError,
  type FileChangedEvent,
  type DraftPayload,
  type DraftRecord,
  getDesktopFailure,
  type FileVersion,
  type HostApi,
} from "../contracts/desktop";
import type {
  BlockDocumentEdit,
  RichEditAck,
  RichEditRequest,
  SelectionSnapshot,
  SourceChangeAck,
  SourceChangeBatch,
  SourceDocument,
  SourceViewModel,
} from "../contracts/markdown";
import type {
  DocumentMode,
  DocumentModeChangeResult,
  DocumentSession,
  DocumentViewportAnchor,
  SessionAction,
  WorkspaceState,
  WorkspaceTab,
  WrittenTargetReceipt,
} from "../documents/session";
import { documentCommandIsEnabled, documentEditsAreEnabled } from "../documents/session";
import { documentHasUnsavedWork, sessionReducer } from "../documents/session-reducer";
import { loadSourceDocumentCore } from "../markdown/load-source-document";
import { CurrentSourceViewCache } from "../markdown/current-source-view-cache";
import {
  applySourceTextEditsToView,
  buildSourceView,
  cloneSourceView,
  sourceViewsEqual,
} from "../markdown/source-view";
import {
  textSelectionAfterSourceEdit,
  textSelectionForSourceRange,
} from "../source/source-selection";
import { sourceBytesToWire, wireBytesToSourceInput, wireDocumentToSourceInput } from "../desktop/host";
import { decodeUtf16CodeUnitsBase64, encodeUtf16CodeUnitsBase64, sha256Hex } from "../documents/draft-codec";
import { fileNameForDisplay } from "./path-display";
import { formatMessage, type UiLocale } from "../i18n/messages";

export interface DocumentController {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeTabId: string | null;
  readonly closePrompt: { tabId: string; exitAfterAll: boolean } | null;
  readonly closing: boolean;
  readonly persistentMessage: { kind: "info" | "error"; text: string } | null;
  readonly recoveryDrafts?: readonly DraftRecord[];
  newDocument(): Promise<void>;
  openPaths(paths?: string[]): Promise<void>;
  save(tabId?: string): Promise<void>;
  saveAs(tabId?: string): Promise<void>;
  requestClose(tabId: string): void;
  requestCloseAll(): void;
  resolveClose(choice: "save" | "discard" | "cancel"): Promise<void>;
  activate(tabId: string): void;
  setMode(tabId: string, expectedRevision: number, mode: DocumentMode): DocumentModeChangeResult;
  getSourceView(tabId: string, expectedRevision: number): SourceViewModel | null;
  commitRichEdit(request: RichEditRequest): RichEditAck;
  beginProtectedRawEdit(tabId: string, expectedRevision: number, blockViewKey: string): boolean;
  updateProtectedRawBuffer(
    tabId: string,
    expectedRevision: number,
    blockViewKey: string,
    bufferText: string,
  ): boolean;
  cancelProtectedRawEdit(tabId: string, expectedRevision: number, blockViewKey: string): boolean;
  commitProtectedRawEdit(tabId: string, expectedRevision: number, blockViewKey: string): RichEditAck;
  applySourceChangeBatch(batch: SourceChangeBatch): SourceChangeAck;
  updateSourceSelection(
    tabId: string,
    expectedRevision: number,
    selection: Extract<SelectionSnapshot, { kind: "text" }> | null,
  ): void;
  updateSourceViewport(
    tabId: string,
    expectedRevision: number,
    anchor: DocumentViewportAnchor | null,
  ): void;
  undo(tabId: string, expectedRevision: number): boolean;
  redo(tabId: string, expectedRevision: number): boolean;
  openResourcePreview?(canonicalPath: string, mediaType: "image" | "pdf"): void;
  setDocumentZoom?(tabId: string, expectedRevision: number, zoomPercent: number): void;
  resolveExternalChange?(tabId: string, choice: "keep-local" | "use-disk"): void;
  restoreDraft?(id: string): Promise<void>;
  discardDraft?(id: string): Promise<void>;
  setUiLocale?(locale: UiLocale): void;
}

type SourceCore = Awaited<ReturnType<typeof loadSourceDocumentCore>>;
type PersistentMessage = NonNullable<DocumentController["persistentMessage"]>;
type ScopedMessage = PersistentMessage & { sequence: number };

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function failureMessage(error: unknown): string {
  const failure = getDesktopFailure(error);
  if (failure) {
    switch (failure.code) {
      case "not-found": return "文件不存在，请重新选择";
      case "already-exists": return "文件已存在，请重新选择";
      case "changed": return "文件已发生变化，请重试";
      case "permission-denied": return "无权访问该文件";
      case "read-only": return "文件为只读，无法保存";
      case "concurrent-writer": return "文件正在被其他程序修改，请稍后重试";
      case "invalid-path": return "请选择 .md 或 .markdown 文件";
      case "invalid-request": return "无法读取此 Markdown 文件";
      case "io": return "文件操作失败，请重试";
      case "draft-invalid": return "恢复数据不可用";
      case "watch-failed": return "无法监测文件变化";
    }
  }
  return error instanceof DesktopWireError
    ? "无法读取文件响应，请重试"
    : "文件操作失败，请重试";
}

function makeSession(
  id: string,
  source: SourceDocument,
  file: DocumentSession["file"],
  status: DocumentSession["status"],
  mode: DocumentSession["mode"] = "reading",
): DocumentSession {
  return {
    kind: "document",
    id,
    file,
    baseline: source,
    candidate: source,
    status,
    mode,
    revision: 0,
    zoomPercent: 100,
    draftId: null,
    externalChange: null,
    blockViewKeys: new Map(source.blocks.map((block) => [block.id, `${id}:${block.id}`])),
    sourceBuffer: null,
    protectedRawBuffer: null,
    viewState: { scrollAnchor: null, selection: null },
    history: { past: [], future: [] },
  };
}

function newDraftId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return `${hex()}-${hex().slice(0, 4)}-4${hex().slice(1, 4)}-8${hex().slice(1, 4)}-${hex()}${hex().slice(0, 4)}`;
}

function cloneSelectionSnapshot(selection: SelectionSnapshot | null): SelectionSnapshot | null {
  if (selection === null) return null;
  if (selection.kind === "text") return { ...selection };
  return {
    ...selection,
    anchor: { ...selection.anchor },
    focus: { ...selection.focus },
    origin: { ...selection.origin },
  };
}

export class DocumentControllerStore implements DocumentController {
  private uiLocale: UiLocale = "zh-CN";
  private state: WorkspaceState = {
    tabs: [],
    activeTabId: null,
    pendingOperations: new Map(),
    writeReceipts: [],
    pendingWatchCleanupIds: [],
  };
  private messages = new Map<string, ScopedMessage>();
  private messageSequence = 0;
  private prompt: DocumentController["closePrompt"] = null;
  private promptRevision = 0;
  private listeners = new Set<() => void>();
  private revision = 0;
  private nextId = 0;
  private nextUntitled = 0;
  private active = true;
  private sourceCore: SourceCore | null = null;
  private sourceCorePromise: Promise<SourceCore> | null = null;
  private stops: Array<() => void> = [];
  private generation = 0;
  private hookMounted = false;
  private hookStarted = false;
  private hookDisposeTicket = 0;
  private saveAsIntents = new Set<string>();
  private pendingCloseTabs = new Set<string>();
  private admittedOperations = new Set<number>();
  private nextAdmission = 0;
  private closeQueue: string[] = [];
  private exitAfterCloseQueue = false;
  private closingState = false;
  private nextExitEpoch = 0;
  private activeExitEpoch: number | null = null;
  private closeWindowEpoch: number | null = null;
  private titleRequest = 0;
  private desiredWindowTitle: string | null = null;
  private syncedWindowTitle: string | null = null;
  private pendingWindowTitle: string | null = null;
  private closeGuardBlocked = false;
  private watchCleanupInFlight = new Set<string>();
  private readonly sourceViewCache: CurrentSourceViewCache;
  private recoveryDraftRecords: DraftRecord[] = [];
  private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly draftEpochs = new Map<string, number>();
  private readonly draftIds = new Map<string, string>();

  constructor(
    private readonly host: HostApi,
    private readonly loadCore: typeof loadSourceDocumentCore = loadSourceDocumentCore,
    options: { sourceViewCache?: CurrentSourceViewCache } = {},
  ) {
    this.sourceViewCache = options.sourceViewCache ?? new CurrentSourceViewCache();
  }

  get tabs() { return this.state.tabs; }
  get activeTabId() { return this.state.activeTabId; }
  get closePrompt() { return this.prompt; }
  get recoveryDrafts(): readonly DraftRecord[] { return this.recoveryDraftRecords; }
  get closing() { return this.closingState || this.closeGuardBlocked; }
  get persistentMessage(): DocumentController["persistentMessage"] {
    let latest: ScopedMessage | null = null;
    for (const message of this.messages.values()) {
      if (
        !latest ||
        (message.kind === "error" && latest.kind !== "error") ||
        (message.kind === latest.kind && message.sequence > latest.sequence)
      ) {
        latest = message;
      }
    }
    return latest ? { kind: latest.kind, text: latest.text } : null;
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  readonly getSnapshot = () => this.revision;

  private emit(): void {
    if (!this.active) return;
    this.revision += 1;
    this.listeners.forEach((listener) => listener());
  }

  private setMessage(scope: string, message: PersistentMessage): void {
    this.messages.set(scope, { ...message, sequence: ++this.messageSequence });
    this.emit();
  }

  private clearMessage(scope: string): void {
    if (!this.messages.delete(scope)) return;
    this.emit();
  }

  private async loadRecoveryDrafts(generation: number): Promise<void> {
    try {
      const records = await this.host.listDrafts();
      if (!this.active || this.generation !== generation) return;
      if (!Array.isArray(records)) return;
      this.recoveryDraftRecords = [...records].sort((left, right) => right.updatedMs - left.updatedMs);
      this.emit();
    } catch (error) {
      if (!this.active || this.generation !== generation) return;
      this.setMessage("recovery-list", { kind: "error", text: failureMessage(error) });
    }
  }

  private isDraftMutation(action: SessionAction): action is Extract<
    SessionAction,
    {
      type:
        | "edit-applied"
        | "history-undo"
        | "history-redo"
        | "source-buffer-rejected"
        | "source-buffer-accepted"
        | "protected-raw-buffer-opened"
        | "protected-raw-buffer-updated"
        | "protected-raw-buffer-rejected"
        | "protected-raw-buffer-accepted"
        | "protected-raw-buffer-cancelled"
        | "external-conflict";
    }
  > {
    return action.type === "edit-applied" ||
      action.type === "history-undo" ||
      action.type === "history-redo" ||
      action.type === "source-buffer-rejected" ||
      action.type === "source-buffer-accepted" ||
      action.type === "protected-raw-buffer-opened" ||
      action.type === "protected-raw-buffer-updated" ||
      action.type === "protected-raw-buffer-rejected" ||
      action.type === "protected-raw-buffer-accepted" ||
      action.type === "protected-raw-buffer-cancelled" ||
      action.type === "external-conflict";
  }

  private scheduleDraft(tabId: string): void {
    const existing = this.draftTimers.get(tabId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.draftTimers.delete(tabId);
      void this.writeDraft(tabId);
    }, 500);
    this.draftTimers.set(tabId, timer);
  }

  private async writeDraft(tabId: string): Promise<void> {
    const tab = this.state.tabs.find((candidate): candidate is DocumentSession =>
      candidate.kind === "document" && candidate.id === tabId,
    );
    if (!tab || !documentHasUnsavedWork(tab)) return;
    const epoch = this.draftEpochs.get(tabId) ?? 0;
    const draftId = tab.draftId ?? this.draftIds.get(tabId) ?? newDraftId();
    this.draftIds.set(tabId, draftId);
    const candidateRevision = tab.revision;
    const candidateBytes = tab.candidate.bytes.slice();
    const rejected = tab.sourceBuffer;
    let rejectedSha: string | null = null;
    try {
      rejectedSha = rejected ? await sha256Hex(candidateBytes) : null;
    } catch (error) {
      if (this.active) this.setMessage(`draft:${tabId}`, { kind: "error", text: failureMessage(error) });
      return;
    }
    if (!this.active) return;
    const current = this.state.tabs.find((candidate): candidate is DocumentSession =>
      candidate.kind === "document" && candidate.id === tabId,
    );
    if (!current || current.revision !== candidateRevision || (this.draftEpochs.get(tabId) ?? 0) !== epoch) {
      if (current && documentHasUnsavedWork(current)) this.scheduleDraft(tabId);
      return;
    }
    const payload: DraftPayload = {
      id: draftId,
      sessionId: current.id,
      canonicalPath: current.file.kind === "local" ? current.file.canonicalPath : null,
      baselineVersion: current.file.kind === "local" ? { ...current.file.version } : null,
      bytes: [...candidateBytes],
      candidateRevision,
      rejectedSourceBuffer: rejected && rejectedSha
        ? {
            baseCandidateRevision: rejected.baseCandidateRevision,
            baseCandidateSha256: rejectedSha,
            utf16CodeUnitsBase64: encodeUtf16CodeUnitsBase64(rejected.bufferText),
            selection: cloneSelectionSnapshot(current.viewState.selection),
          }
        : null,
    };
    const operationId = `draft-${++this.nextId}`;
    this.dispatch({
      type: "begin-operation",
      operation: { id: operationId, kind: "draft", sessionId: tabId, candidateRevision },
    });
    try {
      const record = await this.host.writeDraft(payload);
      if (!this.active) return;
      if ((this.draftEpochs.get(tabId) ?? 0) !== epoch) {
        await this.deleteDraftQuietly(record.id);
        return;
      }
      this.dispatch({ type: "draft-succeeded", operationId, draftId: record.id });
      const after = this.state.tabs.find((candidate): candidate is DocumentSession =>
        candidate.kind === "document" && candidate.id === tabId,
      );
      if (after && (after.revision !== candidateRevision || documentHasUnsavedWork(after) && after.sourceBuffer !== rejected)) {
        this.scheduleDraft(tabId);
      }
    } catch (error) {
      if (!this.active) return;
      this.dispatch({ type: "operation-failed", operationId });
      this.setMessage(`draft:${tabId}`, { kind: "error", text: failureMessage(error) });
    }
  }

  private async deleteDraftQuietly(id: string): Promise<void> {
    try {
      await this.host.deleteDraft(id);
    } catch {
      // A failed cleanup is surfaced only when the draft is still visible.
    }
  }

  private invalidateDraft(tabId: string, draftId?: string | null): void {
    const timer = this.draftTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    this.draftTimers.delete(tabId);
    this.draftEpochs.set(tabId, (this.draftEpochs.get(tabId) ?? 0) + 1);
    const id = draftId ?? this.draftIds.get(tabId) ?? null;
    this.draftIds.delete(tabId);
    if (id) void this.deleteDraftQuietly(id);
  }

  private admitOperation(generation: number): number | null {
    if (!this.active || this.generation !== generation) return null;
    const admission = ++this.nextAdmission;
    this.admittedOperations.add(admission);
    return admission;
  }

  private settleOperation(admission: number): void {
    if (!this.admittedOperations.delete(admission)) return;
    if (this.active && this.closingState) {
      this.advanceCloseQueue();
    }
  }

  private hasPendingWrite(tabId: string): boolean {
    return [...this.state.pendingOperations.values()].some(
      (operation) =>
        (operation.kind === "save" || operation.kind === "save-as") &&
        operation.sessionId === tabId,
    );
  }

  private flushPendingClose(tabId: string): void {
    if (!this.active || this.hasPendingWrite(tabId) || this.saveAsIntents.has(tabId)) return;
    if (!this.pendingCloseTabs.delete(tabId)) {
      if (this.closingState) this.advanceCloseQueue();
      return;
    }
    if (this.closingState && this.exitAfterCloseQueue) {
      this.advanceCloseQueue();
      return;
    }
    this.requestClose(tabId);
  }

  private closeRequested(tabId: string): boolean {
    return this.pendingCloseTabs.has(tabId) ||
      (this.closingState && this.exitAfterCloseQueue && this.closeQueue.includes(tabId));
  }

  private settleWriteFailure(
    tabId: string,
    savedRevision: number,
    savedCandidate: SourceDocument,
  ): void {
    this.replaceDocument(tabId, (current) => {
      const failedExactCandidate = current.sourceBuffer === null &&
        current.revision === savedRevision &&
        current.candidate === savedCandidate;
      if (failedExactCandidate) return { ...current, status: "failed" };
      return {
        ...current,
        status: documentHasUnsavedWork(current) ? "dirty" : "clean",
      };
    });
  }

  private dispatch(action: SessionAction): void {
    if (action.type === "close-tab") {
      const closing = this.state.tabs.find((tab): tab is DocumentSession => tab.kind === "document" && tab.id === action.tabId);
      if (closing) this.invalidateDraft(closing.id, closing.draftId);
    }
    let next = sessionReducer(this.state, action);
    if (next === this.state) {
      this.drainPendingWatchCleanup();
      return;
    }
    const unseenReceipts = next.writeReceipts.filter((receipt) => !receipt.seen);
    if (unseenReceipts.length) {
      for (const receipt of unseenReceipts) this.projectWriteReceipt(receipt);
      next = sessionReducer(next, {
        type: "write-receipts-seen",
        operationIds: unseenReceipts.map((receipt) => receipt.operationId),
      });
    }
    this.pruneWriteReceiptMessages(next.writeReceipts);
    this.pruneRemovedTabMessages(this.state.tabs, next.tabs);
    this.state = next;
    this.sourceViewCache.retainSessions(new Set(
      next.tabs.filter((tab) => tab.kind === "document").map((tab) => tab.id),
    ));
    this.emit();
    this.syncWindowTitle();
    this.drainPendingWatchCleanup();
    if (action.type === "external-reloaded") {
      const refreshed = next.tabs.find((tab): tab is DocumentSession => tab.kind === "document" && tab.id === action.sessionId);
      if (refreshed && !documentHasUnsavedWork(refreshed)) this.invalidateDraft(refreshed.id, refreshed.draftId);
    }
    if (this.isDraftMutation(action)) {
      const affected = next.tabs.find((tab): tab is DocumentSession => tab.kind === "document" && tab.id === action.sessionId);
      if (affected && documentHasUnsavedWork(affected)) this.scheduleDraft(action.sessionId);
      else if (affected) this.invalidateDraft(action.sessionId, affected.draftId);
    }
  }

  private projectWriteReceipt(receipt: WrittenTargetReceipt): void {
    const changed = receipt.reason === "session-closed" ? "原标签页已关闭" : "原保存目标已变化";
    this.messages.set(`write-receipt:${receipt.operationId}`, {
      kind: "info",
      text: `${fileNameForDisplay(receipt.canonicalPath)} 已写入；${changed}，可从该文件恢复。`,
      sequence: ++this.messageSequence,
    });
  }

  private pruneWriteReceiptMessages(receipts: readonly WrittenTargetReceipt[]): void {
    const retained = new Set(receipts.map((receipt) => `write-receipt:${receipt.operationId}`));
    for (const scope of this.messages.keys()) {
      if (scope.startsWith("write-receipt:") && !retained.has(scope)) {
        this.messages.delete(scope);
      }
    }
  }

  private pruneRemovedTabMessages(
    previousTabs: readonly WorkspaceTab[],
    nextTabs: readonly WorkspaceTab[],
  ): void {
    const remaining = new Set(nextTabs.map((tab) => tab.id));
    for (const tab of previousTabs) {
      if (remaining.has(tab.id)) continue;
      for (const prefix of ["source-buffer", "save", "save-as"] as const) {
        this.messages.delete(`${prefix}:${tab.id}`);
      }
    }
  }

  private drainPendingWatchCleanup(): void {
    for (const watchId of this.state.pendingWatchCleanupIds) {
      if (this.watchCleanupInFlight.has(watchId)) continue;
      this.watchCleanupInFlight.add(watchId);
      let cleanup: Promise<void>;
      try {
        cleanup = this.host.unwatchDocument(watchId);
      } catch (error) {
        cleanup = Promise.reject(error);
      }
      void cleanup.then(
        () => {
          this.watchCleanupInFlight.delete(watchId);
          if (!this.active) return;
          this.dispatch({ type: "watch-cleanup-succeeded", watchId });
          this.clearMessage(`watch-cleanup:${watchId}`);
        },
        (error) => {
          this.watchCleanupInFlight.delete(watchId);
          if (!this.active) return;
          this.setMessage(`watch-cleanup:${watchId}`, {
            kind: "error",
            text: failureMessage(error),
          });
        },
      );
    }
  }

  private replaceDocument(tabId: string, update: (tab: DocumentSession) => DocumentSession): void {
    let changed = false;
    const tabs = this.state.tabs.map((tab) => {
      if (tab.id !== tabId || tab.kind !== "document") return tab;
      changed = true;
      return update(tab);
    });
    if (!changed) return;
    this.state = { ...this.state, tabs };
    this.emit();
  }

  private getCore(): Promise<SourceCore> {
    if (this.sourceCore) return Promise.resolve(this.sourceCore);
    if (!this.sourceCorePromise) {
      const pending = this.loadCore().then((core) => {
        this.sourceCore = core;
        return core;
      });
      this.sourceCorePromise = pending;
      void pending.catch(() => {
        if (this.sourceCorePromise === pending) this.sourceCorePromise = null;
      });
    }
    return this.sourceCorePromise;
  }

  private async handleFileChanged(event: FileChangedEvent, generation: number): Promise<void> {
    if (!this.active || this.generation !== generation) return;
    const current = this.state.tabs.find((tab): tab is DocumentSession =>
      tab.kind === "document" && tab.externalChange?.kind === "checking" && tab.externalChange.watchId === event.watchId,
    );
    if (!current) return;
    if (event.kind === "deleted" || event.kind === "renamed") {
      this.dispatch({
        type: "external-marked",
        sessionId: current.id,
        expectedRevision: current.revision,
        watchId: event.watchId,
        kind: event.kind,
        suggestedPath: event.newCanonicalPath,
      });
      return;
    }
    try {
      const [openedWire, core] = await Promise.all([
        this.host.openDocument(event.canonicalPath),
        this.getCore(),
      ]);
      if (!this.active || this.generation !== generation) return;
      const tab = this.state.tabs.find((candidate): candidate is DocumentSession =>
        candidate.kind === "document" && candidate.id === current.id && candidate.revision === current.revision,
      );
      if (!tab || tab.externalChange?.kind !== "checking" || tab.externalChange.watchId !== event.watchId) return;
      const external = core.parseSourceDocument(wireDocumentToSourceInput(openedWire).bytes);
      const sameCandidate = external.bytes.length === tab.candidate.bytes.length && external.bytes.every((value, index) => value === tab.candidate.bytes[index]);
      if (sameCandidate) return;
      if (documentHasUnsavedWork(tab)) {
        this.dispatch({ type: "external-conflict", sessionId: tab.id, expectedRevision: tab.revision, watchId: event.watchId, document: external, version: openedWire.version });
      } else {
        this.dispatch({ type: "external-reloaded", sessionId: tab.id, expectedRevision: tab.revision, watchId: event.watchId, document: external, version: openedWire.version });
      }
    } catch (error) {
      this.setMessage(`external:${current.id}`, { kind: "error", text: failureMessage(error) });
    }
  }

  private beginWatch(session: DocumentSession, generation: number): void {
    if (!this.active || this.generation !== generation || session.file.kind !== "local") return;
    const canonicalPath = session.file.canonicalPath;
    const operationId = `watch-${++this.nextId}`;
    this.dispatch({ type: "begin-operation", operation: { id: operationId, kind: "watch", sessionId: session.id, canonicalPath } });
    void Promise.resolve().then(() => this.host.watchDocument(canonicalPath)).then(
      (result) => {
        if (!this.active || this.generation !== generation) return;
        if (!result || typeof result.watchId !== "string" || result.watchId.length === 0) {
          this.dispatch({ type: "operation-failed", operationId });
          return;
        }
        this.dispatch({ type: "watch-succeeded", operationId, watchId: result.watchId });
      },
      (error) => {
        if (!this.active || this.generation !== generation) return;
        this.dispatch({ type: "operation-failed", operationId });
        this.setMessage(`watch:${session.id}`, { kind: "error", text: failureMessage(error) });
      },
    );
  }

  private syncWindowTitle(): void {
    const tab = this.state.tabs.find((candidate) => candidate.id === this.state.activeTabId);
    const rawTitle = tab?.kind === "document"
      ? (tab.file.kind === "local" ? fileNameForDisplay(tab.file.canonicalPath) : tab.file.displayName)
      : tab?.displayName ?? formatMessage(this.uiLocale, "app.name");
    const untitled = /^未命名 (\d+)$/.exec(rawTitle);
    const recovered = /^恢复 · (.+)$/.exec(rawTitle);
    const title = this.uiLocale === "en-US" && untitled
      ? formatMessage(this.uiLocale, "document.untitled", { number: untitled[1]! })
      : this.uiLocale === "en-US" && rawTitle === "恢复的文档"
        ? formatMessage(this.uiLocale, "document.recovered")
        : this.uiLocale === "en-US" && recovered
          ? formatMessage(this.uiLocale, "document.recoveredNamed", { name: recovered[1]! })
          : rawTitle;
    if (title === this.desiredWindowTitle) return;
    this.desiredWindowTitle = title;
    if (this.pendingWindowTitle !== null) return;
    this.startWindowTitleSync();
  }

  setUiLocale(locale: UiLocale): void {
    if (this.uiLocale === locale) return;
    this.uiLocale = locale;
    this.syncWindowTitle();
  }

  private startWindowTitleSync(): void {
    const title = this.desiredWindowTitle;
    if (title === null) return;
    if (title === this.syncedWindowTitle) {
      this.clearMessage("window-title");
      return;
    }
    const request = ++this.titleRequest;
    const generation = this.generation;
    this.pendingWindowTitle = title;
    void this.host.setWindowTitle(title).then(
      () => {
        if (!this.active || this.generation !== generation || this.titleRequest !== request) return;
        this.pendingWindowTitle = null;
        this.syncedWindowTitle = title;
        if (this.desiredWindowTitle !== title) {
          this.startWindowTitleSync();
          return;
        }
        this.clearMessage("window-title");
      },
      (error) => {
        if (!this.active || this.generation !== generation || this.titleRequest !== request) return;
        this.pendingWindowTitle = null;
        if (this.desiredWindowTitle !== title) {
          this.startWindowTitleSync();
          return;
        }
        this.setMessage("window-title", { kind: "error", text: failureMessage(error) });
      },
    );
  }

  async start(): Promise<void> {
    if (!this.active) return;
    this.stop();
    const generation = ++this.generation;
    this.closeGuardBlocked = true;
    this.emit();
    const install = async (subscribe: () => Promise<() => void>) => {
      const stop = await subscribe();
      if (this.active && this.generation === generation) this.stops.push(stop);
      else stop();
    };
    try {
      await install(() => this.host.onWindowCloseRequested(() => {
        if (this.active && this.generation === generation) this.requestCloseAll();
      }));
    } catch (error) {
      if (!this.active || this.generation !== generation) return;
      this.setMessage("host-close-subscription", { kind: "error", text: failureMessage(error) });
      return;
    }
    if (!this.active || this.generation !== generation) return;
    this.closeGuardBlocked = false;
    this.emit();
    this.clearMessage("host-close-subscription");

    const installOptional = async (scope: string, subscribe: () => Promise<() => void>) => {
      try {
        await install(subscribe);
        if (this.active && this.generation === generation) this.clearMessage(scope);
      } catch (error) {
        if (!this.active || this.generation !== generation) return;
        this.setMessage(scope, { kind: "error", text: failureMessage(error) });
      }
    };
    await Promise.all([
      installOptional("host-open-subscription", () => this.host.onOpenRequests((paths) => {
        if (this.active && this.generation === generation) void this.openPathsForGeneration(paths, generation, true);
      })),
      installOptional("host-file-drop-subscription", () => this.host.onFileDrop((paths) => {
        if (!this.active || this.generation !== generation) return;
        const supported = paths.filter(isMarkdownPath);
        if (supported.length !== paths.length) {
          this.setMessage("file-drop", { kind: "info", text: "仅支持 .md 和 .markdown 文件" });
        }
        void this.openPathsForGeneration(supported, generation, true);
      })),
      installOptional("host-file-change-subscription", () => this.host.onFileChanged((event) => {
        void this.handleFileChanged(event, generation);
      })),
    ]);
    void this.loadRecoveryDrafts(generation);
  }

  mount(): void {
    if (!this.active) return;
    this.hookMounted = true;
    this.hookDisposeTicket += 1;
    if (this.hookStarted) return;
    this.hookStarted = true;
    void this.start();
  }

  scheduleUnmount(): void {
    this.hookMounted = false;
    const ticket = ++this.hookDisposeTicket;
    queueMicrotask(() => {
      if (this.hookMounted || this.hookDisposeTicket !== ticket) return;
      this.dispose();
    });
  }

  stop(): void {
    this.generation += 1;
    this.titleRequest += 1;
    this.desiredWindowTitle = null;
    this.syncedWindowTitle = null;
    this.pendingWindowTitle = null;
    const stops = this.stops.splice(0);
    stops.forEach((stop) => stop());
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.closingState = false;
    this.activeExitEpoch = null;
    this.closeWindowEpoch = null;
    this.closeGuardBlocked = false;
    this.closeQueue = [];
    this.pendingCloseTabs.clear();
    this.admittedOperations.clear();
    this.watchCleanupInFlight.clear();
    this.desiredWindowTitle = null;
    this.syncedWindowTitle = null;
    this.pendingWindowTitle = null;
    this.sourceViewCache.clear();
    for (const timer of this.draftTimers.values()) clearTimeout(timer);
    this.draftTimers.clear();
    this.draftEpochs.clear();
    this.draftIds.clear();
    this.stop();
    this.listeners.clear();
  }

  async newDocument(): Promise<void> {
    const generation = this.generation;
    if (this.closing) return;
    const admission = this.admitOperation(generation);
    if (admission === null) return;
    try {
      const core = await this.getCore();
      if (!this.active || this.generation !== generation || this.closeGuardBlocked) return;
      const source = core.parseSourceDocument(new Uint8Array());
      const id = `document-${++this.nextId}`;
      const session = makeSession(
        id,
        source,
        { kind: "untitled", displayName: `未命名 ${++this.nextUntitled}` },
        "dirty",
        "rich",
      );
      this.state = { ...this.state, tabs: [...this.state.tabs, session], activeTabId: id };
      this.emit();
      this.clearMessage("new-document");
      this.syncWindowTitle();
    } catch (error) {
      if (!this.active || this.generation !== generation) return;
      this.setMessage("new-document", { kind: "error", text: failureMessage(error) });
    } finally {
      this.settleOperation(admission);
    }
  }

  async openPaths(paths?: string[]): Promise<void> {
    return this.openPathsForGeneration(paths, this.generation, false);
  }

  private async openPathsForGeneration(
    paths: string[] | undefined,
    generation: number,
    allowWhileClosing: boolean,
  ): Promise<void> {
    if (
      !this.active ||
      this.generation !== generation ||
      this.closeGuardBlocked ||
      (this.closingState && !allowWhileClosing)
    ) return;
    const admission = this.admitOperation(generation);
    if (admission === null) return;
    try {
      let selected: string[] | null | undefined;
      try {
        selected = paths ?? await this.host.pickMarkdownFiles();
      } catch (error) {
        if (!this.active || this.generation !== generation) return;
        this.setMessage("open-dialog", { kind: "error", text: failureMessage(error) });
        return;
      }
      if (!selected || !this.active || this.generation !== generation || this.closeGuardBlocked) return;
      this.clearMessage("open-dialog");
      const supported = selected.filter(isMarkdownPath);
      if (supported.length !== selected.length) {
        this.setMessage("open-filter", { kind: "info", text: "仅支持 .md 和 .markdown 文件" });
      }
      await Promise.allSettled(supported.map(async (path) => {
        if (!this.active || this.generation !== generation || this.closeGuardBlocked) return;
        const operationId = `open-${++this.nextId}`;
        this.dispatch({ type: "begin-operation", operation: { id: operationId, kind: "open", requestedPath: path } });
        try {
          const [openedWire, core] = await Promise.all([this.host.openDocument(path), this.getCore()]);
          if (!this.active || this.generation !== generation || this.closeGuardBlocked) return;
          const opened = wireDocumentToSourceInput(openedWire);
          const source = core.parseSourceDocument(opened.bytes);
          const session = makeSession(`document-${++this.nextId}`, source, {
            kind: "local", canonicalPath: opened.canonicalPath, version: opened.version,
          }, "clean");
          this.dispatch({ type: "open-succeeded", operationId, session });
          if (this.state.tabs.some((tab) => tab.id === session.id)) this.beginWatch(session, generation);
          this.clearMessage(`open:${path.toLowerCase()}`);
        } catch (error) {
          if (!this.active || this.generation !== generation) return;
          this.dispatch({ type: "operation-failed", operationId });
          this.setMessage(`open:${path.toLowerCase()}`, { kind: "error", text: failureMessage(error) });
        }
      }));
    } finally {
      this.settleOperation(admission);
    }
  }

  async save(tabId = this.state.activeTabId ?? undefined): Promise<void> {
    if (!tabId || this.saveAsIntents.has(tabId) || this.hasPendingWrite(tabId)) return;
    const generation = this.generation;
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.kind !== "document") return;
    if (tab.sourceBuffer !== null) {
      this.setMessage(`source-buffer:${tabId}`, { kind: "info", text: "修复字符后保存" });
      return;
    }
    if (tab.protectedRawBuffer !== null) {
      this.setMessage(`protected-raw:${tabId}`, { kind: "info", text: "先完成或取消局部源码编辑" });
      return;
    }
    if (!documentCommandIsEnabled(tab, "save")) return;
    if (tab.file.kind === "untitled") {
      await this.saveAs(tabId);
      return;
    }
    const operationId = `save-${++this.nextId}`;
    const revision = tab.revision;
    const candidate = tab.candidate;
    this.dispatch({
      type: "begin-operation",
      operation: {
        id: operationId,
        kind: "save",
        sessionId: tabId,
        savedRevision: revision,
        savedCandidate: candidate,
        source: {
          canonicalPath: tab.file.canonicalPath,
          expectedVersion: tab.file.version,
        },
      },
    });
    const admitted = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (admitted?.kind === "document" && admitted.sourceBuffer !== null) {
      this.dispatch({ type: "operation-failed", operationId });
      this.setMessage(`source-buffer:${tabId}`, { kind: "info", text: "修复字符后保存" });
      return;
    }
    this.replaceDocument(tabId, (current) => current.revision === revision && current.candidate === candidate
      ? { ...current, status: "saving" }
      : current);
    try {
      const version = await this.host.saveDocument({
        canonicalPath: tab.file.canonicalPath,
        bytes: sourceBytesToWire(candidate.bytes),
        expectedVersion: tab.file.version,
      });
      if (!this.active || this.generation !== generation) return;
      this.dispatch({ type: "save-succeeded", operationId, version });
      const savedTab = this.state.tabs.find((candidate): candidate is DocumentSession =>
        candidate.kind === "document" && candidate.id === tabId,
      );
      if (savedTab && !documentHasUnsavedWork(savedTab) && savedTab.draftId) {
        const draftId = savedTab.draftId;
        this.dispatch({ type: "draft-cleared", sessionId: tabId, draftId });
        this.invalidateDraft(tabId, draftId);
      }
      this.clearMessage(`save:${tabId}`);
    } catch (error) {
      if (!this.active || this.generation !== generation) return;
      this.dispatch({ type: "operation-failed", operationId });
      this.settleWriteFailure(tabId, revision, candidate);
      this.setMessage(`save:${tabId}`, { kind: "error", text: failureMessage(error) });
    } finally {
      this.flushPendingClose(tabId);
    }
  }

  async saveAs(tabId = this.state.activeTabId ?? undefined): Promise<void> {
    if (!tabId || this.saveAsIntents.has(tabId) || this.hasPendingWrite(tabId)) return;
    const generation = this.generation;
    const beforeDialog = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (!beforeDialog || beforeDialog.kind !== "document" || beforeDialog.status === "saving") return;
    if (beforeDialog.sourceBuffer !== null) {
      this.setMessage(`source-buffer:${tabId}`, { kind: "info", text: "修复字符后保存" });
      return;
    }
    if (beforeDialog.protectedRawBuffer !== null) {
      this.setMessage(`protected-raw:${tabId}`, { kind: "info", text: "先完成或取消局部源码编辑" });
      return;
    }
    const admission = this.admitOperation(generation);
    if (admission === null) return;
    this.saveAsIntents.add(tabId);
    const revision = beforeDialog.revision;
    const candidate = beforeDialog.candidate;
    const originalStatus = beforeDialog.status;
    this.replaceDocument(tabId, (current) => current.revision === revision && current.candidate === candidate
      ? { ...current, status: "saving" }
      : current);
    const suggestedName = beforeDialog.file.kind === "untitled"
      ? `${beforeDialog.file.displayName}.md`
      : fileNameForDisplay(beforeDialog.file.canonicalPath);
    let operationId: string | null = null;
    let writeStarted = false;
    let writeFailed = false;
    const restore = (status: DocumentSession["status"]) => {
      this.replaceDocument(tabId, (current) => current.revision === revision && current.candidate === candidate
        ? { ...current, status: current.sourceBuffer === null ? status : "dirty" }
        : current);
    };
    try {
      const targetPath = await this.host.pickMarkdownSavePath(suggestedName);
      if (!this.active || this.generation !== generation) return;
      const afterDialog = this.state.tabs.find((candidate) => candidate.id === tabId);
      if (afterDialog?.kind === "document" && afterDialog.sourceBuffer !== null) {
        restore(originalStatus);
        this.setMessage(`source-buffer:${tabId}`, { kind: "info", text: "修复字符后保存" });
        return;
      }
      if (!targetPath) {
        restore(originalStatus);
        return;
      }
      if (!isMarkdownPath(targetPath)) {
        restore(originalStatus);
        this.setMessage(`save-as:${tabId}`, { kind: "error", text: "请选择 .md 或 .markdown 文件" });
        return;
      }

      const currentBeforeProbe = this.state.tabs.find((current) => current.id === tabId);
      if (
        !currentBeforeProbe ||
        currentBeforeProbe.kind !== "document" ||
        currentBeforeProbe.revision !== revision ||
        currentBeforeProbe.candidate !== candidate
      ) return;

      let expectedTargetVersion: FileVersion | null = null;
      try {
        expectedTargetVersion = (await this.host.openDocument(targetPath)).version;
      } catch (error) {
        if (getDesktopFailure(error)?.code !== "not-found") throw error;
      }
      if (!this.active || this.generation !== generation) return;
      const tab = this.state.tabs.find((current) => current.id === tabId);
      if (!tab || tab.kind !== "document" || tab.revision !== revision || tab.candidate !== candidate) return;
      if (tab.sourceBuffer !== null) {
        restore(originalStatus);
        this.setMessage(`source-buffer:${tabId}`, { kind: "info", text: "修复字符后保存" });
        return;
      }
      operationId = `save-as-${++this.nextId}`;
      const draftIdBeforeWrite = tab.draftId;
      const source = tab.file.kind === "local"
        ? {
            kind: "local" as const,
            canonicalPath: tab.file.canonicalPath,
            version: tab.file.version,
          }
        : { kind: "untitled" as const, displayName: tab.file.displayName };
      this.dispatch({
        type: "begin-operation",
        operation: {
          id: operationId,
          kind: "save-as",
          sessionId: tabId,
          savedRevision: revision,
          savedCandidate: candidate,
          source,
          target: { requestedPath: targetPath, expectedVersion: expectedTargetVersion },
        },
      });
      const admitted = this.state.tabs.find((candidate) => candidate.id === tabId);
      if (admitted?.kind === "document" && admitted.sourceBuffer !== null) {
        this.dispatch({ type: "operation-failed", operationId });
        restore(originalStatus);
        this.setMessage(`source-buffer:${tabId}`, { kind: "info", text: "修复字符后保存" });
        return;
      }
      writeStarted = true;
      const result = await this.host.saveDocumentAs({
        targetPath,
        bytes: sourceBytesToWire(candidate.bytes),
        expectedTargetVersion,
      });
      if (!this.active || this.generation !== generation) return;
      // Project the immutable write terminal before honoring a queued close.
      // A newer candidate or rejected source buffer must remain attached so
      // the close barrier can prompt instead of detaching it into a receipt.
      this.dispatch({
        type: "save-as-succeeded",
        operationId,
        canonicalPath: result.canonicalPath,
        version: result.version,
        closeIfClean: this.closeRequested(tabId),
      });
      const savedTab = this.state.tabs.find((candidate) => candidate.id === tabId);
      if (!savedTab && draftIdBeforeWrite) this.invalidateDraft(tabId, draftIdBeforeWrite);
      if (savedTab?.kind === "document" && !documentHasUnsavedWork(savedTab) && savedTab.draftId) {
        const draftId = savedTab.draftId;
        this.dispatch({ type: "draft-cleared", sessionId: tabId, draftId });
        this.invalidateDraft(tabId, draftId);
      }
      if (savedTab?.kind === "document" && savedTab.file.kind === "local") this.beginWatch(savedTab, generation);
      this.clearMessage(`save-as:${tabId}`);
    } catch (error) {
      if (!this.active || this.generation !== generation) return;
      if (operationId) this.dispatch({ type: "operation-failed", operationId });
      if (writeStarted) {
        writeFailed = true;
        this.settleWriteFailure(tabId, revision, candidate);
      }
      else restore(originalStatus);
      this.setMessage(`save-as:${tabId}`, { kind: "error", text: failureMessage(error) });
    } finally {
      this.saveAsIntents.delete(tabId);
      if (writeFailed) {
        this.pendingCloseTabs.delete(tabId);
        if (this.closingState && !this.prompt) {
          this.restoreAfterExitStops();
          this.emit();
        }
      } else {
        this.flushPendingClose(tabId);
      }
      this.settleOperation(admission);
    }
  }

  requestClose(tabId: string): void {
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    if (tab.kind === "document" && (this.hasPendingWrite(tabId) || this.saveAsIntents.has(tabId))) {
      this.pendingCloseTabs.add(tabId);
      return;
    }
    if (tab.kind === "document" && documentHasUnsavedWork(tab)) {
      this.promptRevision += 1;
      this.prompt = { tabId, exitAfterAll: false };
      this.emit();
      return;
    }
    this.dispatch({ type: "close-tab", tabId });
  }

  requestCloseAll(): void {
    const becameClosing = !this.closingState;
    if (becameClosing) {
      this.closingState = true;
      this.activeExitEpoch = ++this.nextExitEpoch;
    }
    this.exitAfterCloseQueue = true;
    const currentIds = this.state.tabs.map((tab) => tab.id);
    if (this.prompt) {
      this.closeQueue = [
        this.prompt.tabId,
        ...new Set([...this.closeQueue, ...currentIds].filter((tabId) => tabId !== this.prompt?.tabId)),
      ];
      this.prompt = { ...this.prompt, exitAfterAll: true };
      this.emit();
      return;
    }
    if (this.closeQueue.length) {
      this.closeQueue = [...new Set([...this.closeQueue, ...currentIds])];
      if (becameClosing) this.emit();
      return;
    }
    this.closeQueue = currentIds;
    if (becameClosing) this.emit();
    this.advanceCloseQueue();
  }

  private advanceCloseQueue(): void {
    if (!this.closingState || !this.exitAfterCloseQueue || this.prompt) return;
    while (true) {
      if (!this.closeQueue.length) {
        const currentIds = this.state.tabs.map((tab) => tab.id);
        if (currentIds.length) {
          this.closeQueue = currentIds;
        } else if (this.admittedOperations.size) {
          return;
        } else {
          this.prompt = null;
          this.promptRevision += 1;
          this.closeNativeWindow();
          return;
        }
      }
      const tabId = this.closeQueue[0];
      const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        this.closeQueue.shift();
        continue;
      }
      if (tab.kind === "document" && (this.hasPendingWrite(tabId) || this.saveAsIntents.has(tabId))) {
        return;
      }
      if (tab.kind === "document" && documentHasUnsavedWork(tab)) {
        this.promptRevision += 1;
        this.prompt = { tabId, exitAfterAll: this.exitAfterCloseQueue };
        this.emit();
        return;
      }
      this.dispatch({ type: "close-tab", tabId });
      this.closeQueue.shift();
    }
  }

  private closeNativeWindow(): void {
    const exitEpoch = this.activeExitEpoch;
    if (exitEpoch === null || this.closeWindowEpoch !== null) return;
    this.closeWindowEpoch = exitEpoch;
    let closing: Promise<void>;
    try {
      closing = this.host.closeWindow();
    } catch (error) {
      closing = Promise.reject(error);
    }
    void closing.then(
      () => {
        if (
          !this.active ||
          this.activeExitEpoch !== exitEpoch ||
          this.closeWindowEpoch !== exitEpoch
        ) return;
        this.messages.delete("close-window");
        this.emit();
      },
      (error) => {
        if (
          !this.active ||
          this.activeExitEpoch !== exitEpoch ||
          this.closeWindowEpoch !== exitEpoch
        ) return;
        this.restoreAfterExitStops();
        this.setMessage("close-window", { kind: "error", text: failureMessage(error) });
      },
    );
  }

  private restoreAfterExitStops(): void {
    this.closingState = false;
    this.activeExitEpoch = null;
    this.closeWindowEpoch = null;
    this.closeQueue = [];
    this.exitAfterCloseQueue = false;
  }

  async resolveClose(choice: "save" | "discard" | "cancel"): Promise<void> {
    const prompt = this.prompt;
    if (!prompt) return;
    const generation = this.generation;
    const promptRevision = this.promptRevision;
    if (choice === "cancel") {
      this.prompt = null;
      this.promptRevision += 1;
      this.restoreAfterExitStops();
      this.emit();
      return;
    }
    if (choice === "discard") {
      this.dispatch({ type: "close-tab", tabId: prompt.tabId });
      if (this.closeQueue[0] === prompt.tabId) this.closeQueue.shift();
      this.prompt = null;
      this.promptRevision += 1;
      this.advanceCloseQueue();
      return;
    }
    await this.save(prompt.tabId);
    const currentPrompt = this.prompt;
    if (
      !this.active ||
      this.generation !== generation ||
      this.promptRevision !== promptRevision ||
      currentPrompt?.tabId !== prompt.tabId
    ) return;
    const tab = this.state.tabs.find((candidate) => candidate.id === prompt.tabId);
    if (!tab || (tab.kind === "document" && !documentHasUnsavedWork(tab))) {
      this.dispatch({ type: "close-tab", tabId: prompt.tabId });
      if (this.closeQueue[0] === prompt.tabId) this.closeQueue.shift();
      this.prompt = null;
      this.promptRevision += 1;
      this.advanceCloseQueue();
    } else {
      this.prompt = currentPrompt;
      this.emit();
    }
  }

  activate(tabId: string): void {
    this.dispatch({ type: "activate-tab", tabId });
  }

  setMode(
    tabId: string,
    expectedRevision: number,
    mode: DocumentMode,
  ): DocumentModeChangeResult {
    if (!this.active) return "stale";
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (tab?.kind !== "document" || tab.revision !== expectedRevision) return "stale";
    if (tab.mode === mode) return "unchanged";
    if (
      (tab.sourceBuffer !== null && mode !== "source") ||
      tab.protectedRawBuffer !== null
    ) return "blocked-buffer";
    this.dispatch({ type: "set-mode", sessionId: tabId, expectedRevision, mode });
    return "changed";
  }

  getSourceView(tabId: string, expectedRevision: number): SourceViewModel | null {
    if (!this.active) return null;
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (tab?.kind !== "document" || tab.revision !== expectedRevision) return null;
    return cloneSourceView(
      this.sourceViewCache.getOrBuild(tab.id, tab.revision, tab.candidate).view,
    );
  }

  beginProtectedRawEdit(
    tabId: string,
    expectedRevision: number,
    blockViewKey: string,
  ): boolean {
    const before = this.state;
    this.dispatch({
      type: "protected-raw-buffer-opened",
      sessionId: tabId,
      expectedRevision,
      blockViewKey,
    });
    return this.state !== before;
  }

  updateProtectedRawBuffer(
    tabId: string,
    expectedRevision: number,
    blockViewKey: string,
    bufferText: string,
  ): boolean {
    const before = this.state;
    this.dispatch({
      type: "protected-raw-buffer-updated",
      sessionId: tabId,
      expectedRevision,
      blockViewKey,
      bufferText,
    });
    return this.state !== before;
  }

  cancelProtectedRawEdit(
    tabId: string,
    expectedRevision: number,
    blockViewKey: string,
  ): boolean {
    const before = this.state;
    this.dispatch({
      type: "protected-raw-buffer-cancelled",
      sessionId: tabId,
      expectedRevision,
      blockViewKey,
    });
    if (this.state !== before) this.clearMessage(`protected-raw:${tabId}`);
    return this.state !== before;
  }

  commitProtectedRawEdit(
    tabId: string,
    expectedRevision: number,
    blockViewKey: string,
  ): RichEditAck {
    if (!this.active || !this.sourceCore) return { kind: "stale" };
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    const buffer = tab?.kind === "document" ? tab.protectedRawBuffer : null;
    if (
      tab?.kind !== "document" ||
      tab.mode !== "rich" ||
      tab.revision !== expectedRevision ||
      !buffer ||
      buffer.baseCandidateRevision !== expectedRevision ||
      buffer.blockViewKey !== blockViewKey
    ) return { kind: "stale" };
    const matches = tab.candidate.blocks.filter(
      (block) => tab.blockViewKeys.get(block.id) === blockViewKey,
    );
    if (matches.length !== 1 || !matches[0].protected) return { kind: "stale" };
    try {
      const result = this.sourceCore.applyDocumentEdits(tab.candidate, [{
        kind: "replace-protected",
        blockId: matches[0].id,
        markdown: buffer.bufferText,
      }]);
      this.dispatch({
        type: "protected-raw-buffer-accepted",
        sessionId: tab.id,
        expectedRevision,
        blockViewKey,
        expectedBufferText: buffer.bufferText,
        result,
      });
      const accepted = this.state.tabs.find((candidate) => candidate.id === tab.id);
      if (
        accepted?.kind !== "document" ||
        accepted.revision !== expectedRevision + 1 ||
        accepted.protectedRawBuffer !== null
      ) return { kind: "stale" };
      this.clearMessage(`protected-raw:${tab.id}`);
      return { kind: "accepted", candidateRevision: accepted.revision };
    } catch {
      const validationError = "内容无法解析，请修复后重试";
      this.dispatch({
        type: "protected-raw-buffer-rejected",
        sessionId: tab.id,
        expectedRevision,
        blockViewKey,
        expectedBufferText: buffer.bufferText,
        validationError,
      });
      this.setMessage(`protected-raw:${tab.id}`, { kind: "error", text: validationError });
      return { kind: "rejected", reason: "invalid-markdown" };
    }
  }

  commitRichEdit(request: RichEditRequest): RichEditAck {
    if (!this.active || !this.sourceCore || request.mutations.length === 0) {
      return { kind: "stale" };
    }
    const tab = this.state.tabs.find((candidate) => candidate.id === request.sessionId);
    if (
      tab?.kind !== "document" ||
      tab.mode !== "rich" ||
      tab.revision !== request.baseCandidateRevision ||
      tab.sourceBuffer !== null ||
      !documentEditsAreEnabled(tab)
    ) return { kind: "stale" };
    if (tab.status === "saving" && request.mutations.some((mutation) => mutation.kind === "move-block")) {
      return { kind: "stale" };
    }
    if (request.selectionAfter !== null) {
      return { kind: "rejected", reason: "unsupported-selection" };
    }

    const resolveBlockId = (blockViewKey: string): string | null => {
      const matches = tab.candidate.blocks.filter(
        (block) => tab.blockViewKeys.get(block.id) === blockViewKey,
      );
      return matches.length === 1 ? matches[0].id : null;
    };
    const edits: BlockDocumentEdit[] = [];
    for (const mutation of request.mutations) {
      if (mutation.kind === "replace-range") {
        const firstBlockId = resolveBlockId(mutation.firstBlockViewKey);
        const lastBlockId = resolveBlockId(mutation.lastBlockViewKey);
        if (firstBlockId === null || lastBlockId === null) return { kind: "stale" };
        edits.push({
          kind: "replace-range",
          firstBlockId,
          lastBlockId,
          markdown: mutation.markdown,
        });
        continue;
      }
      if (mutation.kind === "insert-after") {
        const blockId = mutation.blockViewKey === null
          ? null
          : resolveBlockId(mutation.blockViewKey);
        if (mutation.blockViewKey !== null && blockId === null) return { kind: "stale" };
        edits.push({ kind: "insert-after", blockId, markdown: mutation.markdown });
        continue;
      }
      if (mutation.kind === "move-block") {
        const blockId = resolveBlockId(mutation.blockViewKey);
        const beforeBlockId = mutation.beforeBlockViewKey === null
          ? null
          : resolveBlockId(mutation.beforeBlockViewKey);
        if (blockId === null || (mutation.beforeBlockViewKey !== null && beforeBlockId === null)) {
          return { kind: "stale" };
        }
        edits.push({ kind: "move-block", blockId, beforeBlockId });
        continue;
      }
      if (mutation.blockViewKey === null) return { kind: "stale" };
      const blockId = resolveBlockId(mutation.blockViewKey);
      if (blockId === null) return { kind: "stale" };
      edits.push({ kind: mutation.kind, blockId, markdown: mutation.markdown });
    }

    try {
      const result = this.sourceCore.applyDocumentEdits(tab.candidate, edits);
      if (result.candidate === tab.candidate) {
        return { kind: "accepted", candidateRevision: tab.revision };
      }
      this.dispatch({
        type: "edit-applied",
        sessionId: tab.id,
        expectedRevision: tab.revision,
        result,
        selectionAfter: null,
      });
      const accepted = this.state.tabs.find((candidate) => candidate.id === tab.id);
      if (
        accepted?.kind !== "document" ||
        accepted.revision !== tab.revision + 1 ||
        accepted.candidate !== result.candidate
      ) return { kind: "stale" };
      return { kind: "accepted", candidateRevision: accepted.revision };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        kind: "rejected",
        reason: /protected/i.test(message) ? "protected-boundary" : "invalid-markdown",
      };
    }
  }

  applySourceChangeBatch(batch: SourceChangeBatch): SourceChangeAck {
    if (!this.active || !this.sourceCore) return { kind: "stale" };
    const tab = this.state.tabs.find((candidate) => candidate.id === batch.sessionId);
    if (
      tab?.kind !== "document" ||
      tab.mode !== "source" ||
      tab.revision !== batch.baseCandidateRevision ||
      !documentEditsAreEnabled(tab)
    ) return { kind: "stale" };

    const entry = this.sourceViewCache.getOrBuild(tab.id, tab.revision, tab.candidate);

    const changes = batch.changes.map((change) => ({ ...change }));
    const selectionAfter = { ...batch.selectionAfter };
    let projected: string;
    let absoluteSelection: Extract<SelectionSnapshot, { kind: "text" }>;
    try {
      projected = applySourceTextEditsToView(entry.view.text, changes);
      absoluteSelection = textSelectionForSourceRange(selectionAfter, [], projected);
    } catch {
      return { kind: "stale" };
    }

    const currentBuffer = tab.sourceBuffer;
    if (
      currentBuffer &&
      (
        currentBuffer.sessionId !== tab.id ||
        currentBuffer.baseCandidateRevision !== tab.revision ||
        !sourceViewsEqual(currentBuffer.baseView, entry.view)
      )
    ) return { kind: "stale" };

    if (currentBuffer && projected === entry.view.text) {
      this.dispatch({
        type: "source-buffer-accepted",
        sessionId: tab.id,
        expectedRevision: tab.revision,
        expectedBufferText: currentBuffer.bufferText,
        result: null,
        selectionAfter: absoluteSelection,
      });
      const repaired = this.state.tabs.find((candidate) => candidate.id === tab.id);
      if (
        repaired?.kind !== "document" ||
        repaired.revision !== tab.revision ||
        repaired.candidate !== tab.candidate ||
        repaired.sourceBuffer !== null
      ) return { kind: "stale" };
      this.clearMessage(`source-buffer:${tab.id}`);
      return {
        kind: "accepted",
        candidateRevision: tab.revision,
      };
    }

    if (!currentBuffer && projected === entry.view.text) {
      this.dispatch({
        type: "source-selection-updated",
        sessionId: tab.id,
        expectedRevision: tab.revision,
        selection: absoluteSelection,
      });
      const accepted = this.state.tabs.find((candidate) => candidate.id === tab.id);
      if (
        accepted?.kind !== "document" ||
        accepted.revision !== tab.revision ||
        accepted.candidate !== tab.candidate ||
        accepted.sourceBuffer !== null
      ) return { kind: "stale" };
      return {
        kind: "accepted",
        candidateRevision: tab.revision,
      };
    }

    try {
      const result = this.sourceCore.applyDocumentEdit(tab.candidate, {
        kind: "source-changes",
        view: entry.view,
        changes,
      }, entry);
      const nextRevision = tab.revision + 1;
      const nextEntry = this.sourceViewCache.getOrBuild(
        tab.id,
        nextRevision,
        result.candidate,
      );
      const taggedSelection = textSelectionAfterSourceEdit(
        selectionAfter,
        tab.candidate,
        tab.blockViewKeys,
        result,
        nextEntry.view,
      );
      this.dispatch(currentBuffer ? {
        type: "source-buffer-accepted",
        sessionId: tab.id,
        expectedRevision: tab.revision,
        expectedBufferText: currentBuffer.bufferText,
        result,
        selectionAfter: taggedSelection,
      } : {
        type: "edit-applied",
        sessionId: tab.id,
        expectedRevision: tab.revision,
        result,
        selectionAfter: taggedSelection,
      });
      const accepted = this.state.tabs.find((candidate) => candidate.id === tab.id);
      if (
        accepted?.kind !== "document" ||
        accepted.revision !== nextRevision ||
        accepted.candidate !== result.candidate ||
        accepted.sourceBuffer !== null
      ) return { kind: "stale" };
      this.clearMessage(`source-buffer:${tab.id}`);
      return {
        kind: "accepted",
        candidateRevision: nextRevision,
      };
    } catch {
      const buffer = {
        sessionId: tab.id,
        baseCandidateRevision: tab.revision,
        baseView: cloneSourceView(entry.view),
        bufferText: projected,
        composedChanges: changes.map((change) => ({ ...change })),
        validationError: "invalid-source-text",
      };
      this.dispatch({
        type: "source-buffer-rejected",
        sessionId: tab.id,
        expectedRevision: tab.revision,
        buffer,
        selectionAfter: absoluteSelection,
      });
      return { kind: "rejected", validationError: "有字符无法保存" };
    }
  }

  updateSourceSelection(
    tabId: string,
    expectedRevision: number,
    selection: Extract<SelectionSnapshot, { kind: "text" }> | null,
  ): void {
    if (!this.active) return;
    this.dispatch({
      type: "source-selection-updated",
      sessionId: tabId,
      expectedRevision,
      selection,
    });
  }

  updateSourceViewport(
    tabId: string,
    expectedRevision: number,
    anchor: DocumentViewportAnchor | null,
  ): void {
    if (!this.active) return;
    this.dispatch({
      type: "source-viewport-updated",
      sessionId: tabId,
      expectedRevision,
      anchor,
    });
  }

  undo(tabId: string, expectedRevision: number): boolean {
    if (!this.active) return false;
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (tab?.kind !== "document" || tab.revision !== expectedRevision || !documentCommandIsEnabled(tab, "undo")) {
      return false;
    }
    const before = this.state;
    this.dispatch({ type: "history-undo", sessionId: tabId, expectedRevision });
    return this.state !== before;
  }

  redo(tabId: string, expectedRevision: number): boolean {
    if (!this.active) return false;
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
    if (tab?.kind !== "document" || tab.revision !== expectedRevision || !documentCommandIsEnabled(tab, "redo")) {
      return false;
    }
    const before = this.state;
    this.dispatch({ type: "history-redo", sessionId: tabId, expectedRevision });
    return this.state !== before;
  }

  async restoreDraft(id: string): Promise<void> {
    const listed = this.recoveryDraftRecords.find((record) => record.id === id);
    if (!listed) return;
    try {
      const record = await this.host.readDraft(id);
      const core = await this.getCore();
      const candidate = core.parseSourceDocument(wireBytesToSourceInput(record.bytes));
      let baseline = core.parseSourceDocument(new Uint8Array());
      let file: DocumentSession["file"] = {
        kind: "untitled",
        displayName: record.canonicalPath
          ? `恢复 · ${fileNameForDisplay(record.canonicalPath)}`
          : "恢复的文档",
      };
      if (record.canonicalPath) {
        try {
          const opened = await this.host.openDocument(record.canonicalPath);
          baseline = core.parseSourceDocument(wireBytesToSourceInput(opened.bytes));
          file = {
            kind: "local",
            canonicalPath: opened.canonicalPath,
            version: opened.version,
          };
        } catch {
          // Keep the draft as an untitled recovery document when its source disappeared.
        }
      }
      const idForSession = `recovered-${++this.nextId}`;
      const recovered = makeSession(
        idForSession,
        baseline,
        file,
        "dirty",
      );
      recovered.candidate = candidate;
      recovered.revision = record.candidateRevision;
      recovered.draftId = record.id;
      recovered.mode = record.rejectedSourceBuffer ? "source" : "reading";
      recovered.status = file.kind === "untitled" ||
        record.rejectedSourceBuffer !== null ||
        candidate.bytes.length !== baseline.bytes.length ||
        candidate.bytes.some((value, index) => value !== baseline.bytes[index])
        ? "dirty"
        : "clean";
      recovered.blockViewKeys = new Map(candidate.blocks.map((block) => [block.id, `${idForSession}:${block.id}`]));
      if (record.rejectedSourceBuffer) {
        const bufferText = decodeUtf16CodeUnitsBase64(record.rejectedSourceBuffer.utf16CodeUnitsBase64);
        recovered.sourceBuffer = {
          sessionId: idForSession,
          baseCandidateRevision: record.rejectedSourceBuffer.baseCandidateRevision,
          baseView: buildSourceView(candidate),
          bufferText,
          composedChanges: [],
          validationError: null,
        };
        recovered.viewState.selection = cloneSelectionSnapshot(record.rejectedSourceBuffer.selection);
      }
      this.dispatch({ type: "draft-restored", session: recovered });
      this.recoveryDraftRecords = this.recoveryDraftRecords.filter((item) => item.id !== id);
      this.emit();
      this.draftIds.set(idForSession, id);
      if (file.kind === "local") this.beginWatch(recovered, this.generation);
    } catch (error) {
      this.setMessage(`recovery:${id}`, { kind: "error", text: failureMessage(error) });
    }
  }

  async discardDraft(id: string): Promise<void> {
    if (!this.recoveryDraftRecords.some((record) => record.id === id)) return;
    try {
      await this.host.deleteDraft(id);
      this.recoveryDraftRecords = this.recoveryDraftRecords.filter((record) => record.id !== id);
      this.emit();
    } catch (error) {
      this.setMessage(`recovery:${id}`, { kind: "error", text: failureMessage(error) });
    }
  }

  openResourcePreview(canonicalPath: string, mediaType: "image" | "pdf"): void {
    const displayName = fileNameForDisplay(canonicalPath);
    this.dispatch({
      type: "open-preview",
      preview: {
        kind: "preview",
        id: `preview-${++this.nextId}`,
        canonicalPath,
        displayName,
        mediaType,
        zoomPercent: 100,
      },
    });
  }

  setDocumentZoom(tabId: string, expectedRevision: number, zoomPercent: number): void {
    this.dispatch({ type: "document-zoom-updated", sessionId: tabId, expectedRevision, zoomPercent });
  }

  resolveExternalChange(tabId: string, choice: "keep-local" | "use-disk"): void {
    if (choice === "use-disk") {
      const tab = this.state.tabs.find((candidate): candidate is DocumentSession => candidate.kind === "document" && candidate.id === tabId);
      if (tab) this.invalidateDraft(tabId, tab.draftId);
    }
    this.dispatch({ type: choice === "keep-local" ? "external-keep-local" : "external-use-disk", sessionId: tabId });
  }
}

export function createDocumentController(
  host: HostApi,
  loadCore?: typeof loadSourceDocumentCore,
  options?: { sourceViewCache?: CurrentSourceViewCache },
): DocumentControllerStore {
  return new DocumentControllerStore(host, loadCore, options);
}

export function useDocumentController(host: HostApi, loadCore?: typeof loadSourceDocumentCore): DocumentControllerStore {
  const controllerRef = useRef<DocumentControllerStore | null>(null);
  if (!controllerRef.current) controllerRef.current = createDocumentController(host, loadCore);
  const controller = controllerRef.current;
  useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    controller.mount();
    return () => controller.scheduleUnmount();
  }, [controller]);
  return controller;
}

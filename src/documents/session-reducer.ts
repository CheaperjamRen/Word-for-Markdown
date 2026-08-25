import type {
  DocumentEditResult,
  SelectionSnapshot,
  SourceBufferState,
  SourceDocument,
} from "../contracts/markdown";
import type { FileVersion } from "../contracts/desktop";
import type {
  DocumentFileIntent,
  DocumentHistoryEntry,
  DocumentSession,
  PendingOperation,
  SessionAction,
  WrittenTargetReceipt,
  WorkspaceState,
} from "./session";
import {
  DOCUMENT_HISTORY_LIMIT,
  documentCommandIsEnabled,
  documentEditsAreEnabled,
  WRITTEN_TARGET_RECEIPT_LIMIT,
} from "./session";
import { clampDocumentZoom } from "../document/zoom";

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function documentHasUnsavedWork(session: DocumentSession): boolean {
  return session.file.kind === "untitled" ||
    !bytesEqual(session.candidate.bytes, session.baseline.bytes) ||
    session.sourceBuffer !== null ||
    session.protectedRawBuffer?.dirty === true;
}

function editStatus(
  session: Pick<DocumentSession, "baseline" | "file">,
  candidate: SourceDocument,
  sourceBuffer: SourceBufferState | null,
  protectedRawDirty = false,
): "clean" | "dirty" {
  return session.file.kind === "untitled" ||
    !bytesEqual(candidate.bytes, session.baseline.bytes) ||
    sourceBuffer !== null ||
    protectedRawDirty
    ? "dirty"
    : "clean";
}

function cloneVersion(version: FileVersion): FileVersion {
  return { ...version };
}

function versionsEqual(
  left: FileVersion,
  right: FileVersion,
): boolean {
  return left.len === right.len && left.modifiedMs === right.modifiedMs && left.sha256 === right.sha256;
}

function cloneSourceDocument(source: SourceDocument): SourceDocument {
  return {
    ...source,
    bytes: source.bytes.slice(),
    blocks: source.blocks.map((block) => ({ ...block })),
  };
}

function snapshotOperation(operation: PendingOperation): PendingOperation {
  if (operation.kind === "save") {
    return {
      ...operation,
      savedCandidate: cloneSourceDocument(operation.savedCandidate),
      source: {
        ...operation.source,
        expectedVersion: cloneVersion(operation.source.expectedVersion),
      },
    };
  }
  if (operation.kind === "save-as") {
    return {
      ...operation,
      savedCandidate: cloneSourceDocument(operation.savedCandidate),
      source: operation.source.kind === "local"
        ? { ...operation.source, version: cloneVersion(operation.source.version) }
        : { ...operation.source },
      target: {
        ...operation.target,
        expectedVersion: operation.target.expectedVersion === null
          ? null
          : cloneVersion(operation.target.expectedVersion),
      },
    };
  }
  return { ...operation };
}

function withPending(
  state: WorkspaceState,
  update: (pending: Map<string, PendingOperation>) => void,
): WorkspaceState {
  const pendingOperations = new Map(state.pendingOperations);
  update(pendingOperations);
  return { ...state, pendingOperations };
}

function appendWriteReceipt(
  state: WorkspaceState,
  operation: Extract<PendingOperation, { kind: "save" | "save-as" }>,
  canonicalPath: string,
  version: FileVersion,
  reason: WrittenTargetReceipt["reason"],
): WorkspaceState {
  const receipt: WrittenTargetReceipt = {
    operationId: operation.id,
    kind: operation.kind,
    sessionId: operation.sessionId,
    canonicalPath,
    version: cloneVersion(version),
    reason,
    savedRevision: operation.savedRevision,
    byteLength: operation.savedCandidate.bytes.length,
    seen: false,
  };
  return {
    ...state,
    writeReceipts: boundWriteReceipts([...state.writeReceipts, receipt]),
  };
}

function boundWriteReceipts(
  receipts: readonly WrittenTargetReceipt[],
): readonly WrittenTargetReceipt[] {
  let excess = Math.max(0, receipts.length - WRITTEN_TARGET_RECEIPT_LIMIT);
  if (excess === 0) return receipts;
  const retained: WrittenTargetReceipt[] = [];
  for (const receipt of receipts) {
    if (excess > 0 && receipt.seen) {
      excess -= 1;
      continue;
    }
    retained.push(receipt);
  }
  return retained;
}

function queueWatchCleanup(state: WorkspaceState, watchId: string): WorkspaceState {
  if (state.pendingWatchCleanupIds.includes(watchId)) return state;
  return {
    ...state,
    pendingWatchCleanupIds: [...state.pendingWatchCleanupIds, watchId],
  };
}

function resolveOperation(
  state: WorkspaceState,
  operationId: string,
  kind: PendingOperation["kind"],
): PendingOperation | null {
  const operation = state.pendingOperations.get(operationId);
  if (!operation || operation.kind !== kind) return null;
  return operation;
}

function findDocument(
  state: WorkspaceState,
  sessionId: string,
  revision?: number,
): DocumentSession | null {
  const tab = state.tabs.find((candidate) => candidate.id === sessionId);
  if (
    !tab ||
    tab.kind !== "document" ||
    (revision !== undefined && tab.revision !== revision)
  ) {
    return null;
  }
  return tab;
}

function protectedBlockFor(session: DocumentSession, blockViewKey: string) {
  const matches = session.candidate.blocks.filter(
    (block) => session.blockViewKeys.get(block.id) === blockViewKey,
  );
  return matches.length === 1 && matches[0].protected ? matches[0] : null;
}

function replaceDocument(
  state: WorkspaceState,
  session: DocumentSession,
): WorkspaceState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === session.id ? session : tab)),
  };
}

function hasPendingWrite(state: WorkspaceState, sessionId: string): boolean {
  return [...state.pendingOperations.values()].some(
    (operation) =>
      (operation.kind === "save" || operation.kind === "save-as") &&
      operation.sessionId === sessionId,
  );
}

function keepPendingWriteStatus(
  state: WorkspaceState,
  session: DocumentSession,
): DocumentSession {
  return hasPendingWrite(state, session.id) ? { ...session, status: "saving" } : session;
}

function keepSourceHistoryWriteStatus(
  state: WorkspaceState,
  previous: DocumentSession,
  restored: DocumentSession,
): DocumentSession {
  return previous.mode === "source" &&
    previous.status === "saving" &&
    hasPendingWrite(state, previous.id)
    ? { ...restored, status: "saving" }
    : restored;
}

function hasCompleteValidBlockRemap(
  session: DocumentSession,
  result: DocumentEditResult,
): boolean {
  const oldIds = new Set(session.candidate.blocks.map((block) => block.id));
  const newIds = new Set(result.candidate.blocks.map((block) => block.id));
  if (result.blockRemap.size !== oldIds.size) return false;
  for (const oldId of oldIds) {
    if (!result.blockRemap.has(oldId)) return false;
  }
  for (const [oldId, targets] of result.blockRemap) {
    if (!oldIds.has(oldId) || new Set(targets).size !== targets.length) return false;
    if (targets.some((targetId) => !newIds.has(targetId))) return false;
  }
  return true;
}

function carryBlockViewKeys(
  session: DocumentSession,
  result: DocumentEditResult,
  remapIsValid: boolean,
): ReadonlyMap<string, string> {
  const next = new Map<string, string>();
  if (!remapIsValid) {
    for (const block of result.candidate.blocks) {
      next.set(block.id, `${session.id}:block:${session.revision + 1}:${block.id}`);
    }
    return next;
  }
  const mappedOwnerCount = new Map<string, number>();
  for (const block of session.candidate.blocks) {
    for (const mappedId of new Set(result.blockRemap.get(block.id) ?? [])) {
      mappedOwnerCount.set(mappedId, (mappedOwnerCount.get(mappedId) ?? 0) + 1);
    }
  }
  for (const block of session.candidate.blocks) {
    const stableKey = session.blockViewKeys.get(block.id);
    if (!stableKey) continue;
    const mapped = result.blockRemap.get(block.id) ?? [];
    if (mapped.length !== 1) continue;
    const target = result.candidate.blocks.find((candidate) => candidate.id === mapped[0]);
    if (
      target &&
      target.kind === block.kind &&
      mappedOwnerCount.get(target.id) === 1 &&
      !next.has(target.id)
    ) {
      next.set(target.id, stableKey);
    }
  }

  for (const block of result.candidate.blocks) {
    if (!next.has(block.id)) {
      next.set(block.id, `${session.id}:block:${session.revision + 1}:${block.id}`);
    }
  }
  return next;
}

function cloneSelection(selection: SelectionSnapshot | null): SelectionSnapshot | null {
  if (selection === null) return null;
  if (selection.kind === "text") return { ...selection };
  return {
    ...selection,
    anchor: { ...selection.anchor },
    focus: { ...selection.focus },
    origin: { ...selection.origin },
  };
}

function clampTextOffset(text: string, offset: number): number {
  let result = Math.min(text.length, Math.max(0, Number.isFinite(offset) ? offset : 0));
  result = Math.trunc(result);
  if (
    result > 0 &&
    result < text.length &&
    /[\uD800-\uDBFF]/.test(text[result - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[result] ?? "")
  ) result -= 1;
  return result;
}

function cloneSourceBuffer(buffer: SourceBufferState): SourceBufferState {
  return {
    ...buffer,
    baseView: {
      text: buffer.baseView.text,
      byteOffsetAtViewOffset: buffer.baseView.byteOffsetAtViewOffset.slice(),
    },
    composedChanges: buffer.composedChanges.map((change) => ({ ...change })),
  };
}

function snapshot(session: DocumentSession): DocumentHistoryEntry {
  return {
    candidate: session.candidate,
    blockViewKeys: new Map(session.blockViewKeys),
    selection: cloneSelection(session.viewState.selection),
  };
}

function boundedPast(entries: DocumentHistoryEntry[]): DocumentHistoryEntry[] {
  return entries.slice(-DOCUMENT_HISTORY_LIMIT);
}

function reconcileSelectionAfter(
  session: DocumentSession,
  result: DocumentEditResult,
  blockViewKeys: ReadonlyMap<string, string>,
  selectionAfter: SelectionSnapshot | null,
  remapIsValid: boolean,
): SelectionSnapshot | null {
  if (selectionAfter?.kind === "text") {
    const remapTextPoint = (blockViewKey: string | null, offset: number) => {
      if (blockViewKey === null) return { blockViewKey: null, offset };
      const oldMatches = session.candidate.blocks.filter(
        (block) => session.blockViewKeys.get(block.id) === blockViewKey,
      );
      if (oldMatches.length !== 1 || !remapIsValid) return null;
      const mapped = result.blockRemap.get(oldMatches[0].id) ?? [];
      if (mapped.length !== 1) return null;
      const target = result.candidate.blocks.find((block) => block.id === mapped[0]);
      const nextKey = target ? blockViewKeys.get(target.id) ?? null : null;
      if (!target || nextKey === null) return null;
      return { blockViewKey: nextKey, offset: clampTextOffset(target.raw, offset) };
    };
    const anchor = remapTextPoint(selectionAfter.anchorBlockKey, selectionAfter.anchorOffset);
    const focus = remapTextPoint(selectionAfter.focusBlockKey, selectionAfter.focusOffset);
    if (!anchor || !focus) return null;
    return {
      kind: "text",
      anchorBlockKey: anchor.blockViewKey,
      anchorOffset: anchor.offset,
      focusBlockKey: focus.blockViewKey,
      focusOffset: focus.offset,
    };
  }
  if (selectionAfter === null || selectionAfter.kind !== "table") return cloneSelection(selectionAfter);
  if (!remapIsValid) return null;
  const oldMatches = session.candidate.blocks.filter(
    (block) => session.blockViewKeys.get(block.id) === selectionAfter.tableBlockViewKey,
  );
  const oldBlock = oldMatches.length === 1 ? oldMatches[0] : null;
  const mapped = oldBlock ? (result.blockRemap.get(oldBlock.id) ?? []) : [];
  const targetId = mapped.length === 1 ? mapped[0] : null;
  const target = targetId
    ? result.candidate.blocks.find((block) => block.id === targetId)
    : undefined;
  const owners = targetId
    ? session.candidate.blocks.filter((block) =>
        (result.blockRemap.get(block.id) ?? []).includes(targetId),
      )
    : [];
  const exclusive = Boolean(oldBlock && target && mapped.length === 1 && owners.length === 1);
  if (
    exclusive &&
    oldBlock?.kind === "table" &&
    target?.kind === "table" &&
    blockViewKeys.get(target.id) === selectionAfter.tableBlockViewKey
  ) {
    return cloneSelection(selectionAfter);
  }
  if (exclusive && oldBlock?.kind === "table" && target && target.kind !== "table") {
    const key = blockViewKeys.get(target.id) ?? null;
    return {
      kind: "text",
      anchorBlockKey: key,
      anchorOffset: 0,
      focusBlockKey: key,
      focusOffset: 0,
    };
  }
  return null;
}

function reconcileViewportAfter(
  session: DocumentSession,
  result: DocumentEditResult,
  blockViewKeys: ReadonlyMap<string, string>,
  remapIsValid: boolean,
): DocumentSession["viewState"]["scrollAnchor"] {
  const anchor = session.viewState.scrollAnchor;
  if (anchor === null || anchor.blockViewKey === null) {
    return anchor === null ? null : { ...anchor };
  }
  if (!remapIsValid) return null;
  const oldIndex = session.candidate.blocks.findIndex(
    (block) => session.blockViewKeys.get(block.id) === anchor.blockViewKey,
  );
  if (oldIndex < 0) return null;
  const oldBlock = session.candidate.blocks[oldIndex];
  const mapped = result.blockRemap.get(oldBlock.id) ?? [];
  if (mapped.length === 1 && blockViewKeys.get(mapped[0]) === anchor.blockViewKey) {
    return { ...anchor };
  }

  for (let index = oldIndex - 1; index >= 0; index -= 1) {
    const targets = result.blockRemap.get(session.candidate.blocks[index].id) ?? [];
    for (let targetIndex = targets.length - 1; targetIndex >= 0; targetIndex -= 1) {
      const key = blockViewKeys.get(targets[targetIndex]);
      if (key) return { blockViewKey: key, offset: Number.MAX_SAFE_INTEGER };
    }
  }
  for (let index = oldIndex + 1; index < session.candidate.blocks.length; index += 1) {
    const targets = result.blockRemap.get(session.candidate.blocks[index].id) ?? [];
    for (const target of targets) {
      const key = blockViewKeys.get(target);
      if (key) return { blockViewKey: key, offset: 0 };
    }
  }
  return { blockViewKey: null, offset: 0 };
}

function applyResult(
  session: DocumentSession,
  result: DocumentEditResult,
  clearSourceBuffer: boolean,
  selectionAfter: SelectionSnapshot | null,
  historyMode: "append" | "merge" = "append",
): DocumentSession {
  const remapIsValid = hasCompleteValidBlockRemap(session, result);
  const blockViewKeys = carryBlockViewKeys(session, result, remapIsValid);
  const sourceBuffer = clearSourceBuffer ? null : session.sourceBuffer;
  return {
    ...session,
    candidate: result.candidate,
    revision: session.revision + 1,
    status: editStatus(session, result.candidate, sourceBuffer),
    blockViewKeys,
    sourceBuffer,
    viewState: {
      ...session.viewState,
      scrollAnchor: reconcileViewportAfter(session, result, blockViewKeys, remapIsValid),
      selection: reconcileSelectionAfter(
        session,
        result,
        blockViewKeys,
        selectionAfter,
        remapIsValid,
      ),
    },
    history: historyMode === "merge"
      ? { past: session.history.past, future: [] }
      : { past: boundedPast([...session.history.past, snapshot(session)]), future: [] },
  };
}

function restoreHistoryEntry(
  session: DocumentSession,
  entry: DocumentHistoryEntry,
  past: DocumentHistoryEntry[],
  future: DocumentHistoryEntry[],
): DocumentSession {
  return {
    ...session,
    candidate: entry.candidate,
    blockViewKeys: new Map(entry.blockViewKeys),
    revision: session.revision + 1,
    status: editStatus(session, entry.candidate, null),
    sourceBuffer: null,
    viewState: {
      ...session.viewState,
      selection: cloneSelection(entry.selection),
    },
    history: { past, future },
  };
}

function sameWindowsPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function stableKeysForExternal(session: DocumentSession, document: SourceDocument): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  document.blocks.forEach((block, index) => {
    const previous = session.candidate.blocks[index];
    const key = previous && previous.kind === block.kind ? session.blockViewKeys.get(previous.id) : null;
    keys.set(block.id, key ?? `${session.id}:external:${block.id}`);
  });
  return keys;
}

function matchesFileIntent(
  file: DocumentSession["file"],
  intent: DocumentFileIntent,
): boolean {
  if (file.kind !== intent.kind) return false;
  if (file.kind === "untitled" && intent.kind === "untitled") {
    return file.displayName === intent.displayName;
  }
  return file.kind === "local" && intent.kind === "local" &&
    sameWindowsPath(file.canonicalPath, intent.canonicalPath) &&
    versionsEqual(file.version, intent.version);
}

function detachedReason(
  state: WorkspaceState,
  sessionId: string,
): WrittenTargetReceipt["reason"] {
  return state.tabs.some((tab) => tab.id === sessionId)
    ? "intent-replaced"
    : "session-closed";
}

export function sessionReducer(
  state: WorkspaceState,
  action: SessionAction,
): WorkspaceState {
  switch (action.type) {
    case "draft-restored": {
      if (state.tabs.some((tab) => tab.id === action.session.id)) return state;
      return {
        ...state,
        tabs: [...state.tabs, action.session],
        activeTabId: action.session.id,
      };
    }

    case "draft-cleared": {
      const session = findDocument(state, action.sessionId);
      if (!session || session.draftId !== action.draftId) return state;
      return replaceDocument(state, { ...session, draftId: null });
    }

    case "begin-operation":
      return withPending(state, (pending) => {
        pending.set(action.operation.id, snapshotOperation(action.operation));
      });

    case "operation-failed":
      if (!state.pendingOperations.has(action.operationId)) return state;
      return withPending(state, (pending) => pending.delete(action.operationId));

    case "write-receipts-seen": {
      const ids = new Set(action.operationIds);
      let changed = false;
      const writeReceipts = state.writeReceipts.map((receipt) => {
        if (receipt.seen || !ids.has(receipt.operationId)) return receipt;
        changed = true;
        return { ...receipt, seen: true };
      });
      return changed
        ? { ...state, writeReceipts: boundWriteReceipts(writeReceipts) }
        : state;
    }

    case "watch-cleanup-succeeded":
      if (!state.pendingWatchCleanupIds.includes(action.watchId)) return state;
      return {
        ...state,
        pendingWatchCleanupIds: state.pendingWatchCleanupIds.filter(
          (watchId) => watchId !== action.watchId,
        ),
      };

    case "activate-tab":
      if (
        state.activeTabId === action.tabId ||
        !state.tabs.some((tab) => tab.id === action.tabId)
      ) {
        return state;
      }
      return { ...state, activeTabId: action.tabId };

    case "open-preview": {
      const existing = state.tabs.find(
        (tab) => tab.kind === "preview" && sameWindowsPath(tab.canonicalPath, action.preview.canonicalPath),
      );
      if (existing) return { ...state, activeTabId: existing.id };
      return {
        ...state,
        tabs: [...state.tabs, { ...action.preview }],
        activeTabId: action.preview.id,
      };
    }

    case "external-reloaded": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (!session || session.externalChange?.kind !== "checking" || session.externalChange.watchId !== action.watchId) return state;
      const document = cloneSourceDocument(action.document);
      return replaceDocument(state, {
        ...session,
        baseline: document,
        candidate: document,
        revision: session.revision + 1,
        status: "clean",
        file: session.file.kind === "local" ? { ...session.file, version: cloneVersion(action.version) } : session.file,
        blockViewKeys: stableKeysForExternal(session, document),
        sourceBuffer: null,
        protectedRawBuffer: null,
        externalChange: { kind: "checking", watchId: action.watchId },
        history: { past: [], future: [] },
        viewState: { scrollAnchor: null, selection: null },
      });
    }

    case "external-conflict": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (!session || session.externalChange?.kind !== "checking" || session.externalChange.watchId !== action.watchId) return state;
      return replaceDocument(state, {
        ...session,
        status: "conflict",
        externalChange: { kind: "conflict", watchId: action.watchId, external: cloneSourceDocument(action.document), detectedVersion: cloneVersion(action.version) },
      });
    }

    case "external-marked": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (!session || session.externalChange?.kind !== "checking" || session.externalChange.watchId !== action.watchId) return state;
      return replaceDocument(state, {
        ...session,
        status: "conflict",
        externalChange: action.kind === "deleted"
          ? { kind: "deleted", watchId: action.watchId }
          : { kind: "renamed", watchId: action.watchId, suggestedPath: action.suggestedPath },
      });
    }

    case "external-keep-local": {
      const session = findDocument(state, action.sessionId);
      if (!session || session.externalChange === null || session.externalChange.kind === "checking") return state;
      return replaceDocument(state, { ...session, status: editStatus(session, session.candidate, session.sourceBuffer, session.protectedRawBuffer?.dirty), externalChange: { kind: "checking", watchId: session.externalChange.watchId } });
    }

    case "external-use-disk": {
      const session = findDocument(state, action.sessionId);
      if (!session || session.externalChange?.kind !== "conflict") return state;
      const document = cloneSourceDocument(session.externalChange.external);
      return replaceDocument(state, {
        ...session,
        baseline: document,
        candidate: document,
        revision: session.revision + 1,
        status: "clean",
        file: session.file.kind === "local" ? { ...session.file, version: cloneVersion(session.externalChange.detectedVersion) } : session.file,
        blockViewKeys: stableKeysForExternal(session, document),
        sourceBuffer: null,
        protectedRawBuffer: null,
        externalChange: { kind: "checking", watchId: session.externalChange.watchId },
        history: { past: [], future: [] },
        viewState: { scrollAnchor: null, selection: null },
      });
    }

    case "close-tab": {
      const index = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      const activeTabId =
        state.activeTabId === action.tabId
          ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
          : state.activeTabId;
      return { ...state, tabs, activeTabId };
    }

    case "open-succeeded": {
      const operation = resolveOperation(state, action.operationId, "open");
      if (!operation) return state;
      const consumed = withPending(state, (pending) => pending.delete(action.operationId));
      const incomingPath =
        action.session.file.kind === "local" ? action.session.file.canonicalPath : null;
      const existing = incomingPath
        ? consumed.tabs.find(
            (tab) =>
              tab.kind === "document" &&
              tab.file.kind === "local" &&
              sameWindowsPath(tab.file.canonicalPath, incomingPath),
          )
        : undefined;
      if (existing) return { ...consumed, activeTabId: existing.id };
      return {
        ...consumed,
        tabs: [...consumed.tabs, action.session],
        activeTabId: action.session.id,
      };
    }

    case "edit-applied": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (!session || !documentEditsAreEnabled(session) || session.sourceBuffer !== null) return state;
      return replaceDocument(
        state,
        session.mode === "source"
          ? keepPendingWriteStatus(
              state,
              applyResult(session, action.result, false, action.selectionAfter, action.historyMode),
            )
          : applyResult(session, action.result, false, action.selectionAfter, action.historyMode),
      );
    }

    case "history-undo": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (!session || !documentCommandIsEnabled(session, "undo")) return state;
      const entry = session.history.past.at(-1);
      if (!entry) return state;
      return replaceDocument(
        state,
        keepSourceHistoryWriteStatus(
          state,
          session,
          restoreHistoryEntry(
            session,
            entry,
            session.history.past.slice(0, -1),
            [...session.history.future, snapshot(session)],
          ),
        ),
      );
    }

    case "history-redo": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (!session || !documentCommandIsEnabled(session, "redo")) return state;
      const entry = session.history.future.at(-1);
      if (!entry) return state;
      return replaceDocument(
        state,
        keepSourceHistoryWriteStatus(
          state,
          session,
          restoreHistoryEntry(
            session,
            entry,
            [...session.history.past, snapshot(session)],
            session.history.future.slice(0, -1),
          ),
        ),
      );
    }

    case "set-mode": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (
        !session ||
        session.mode === action.mode ||
        (session.sourceBuffer !== null && action.mode !== "source") ||
        session.protectedRawBuffer !== null
      ) return state;
      return replaceDocument(state, { ...session, mode: action.mode });
    }

    case "document-zoom-updated": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (!session) return state;
      const zoomPercent = clampDocumentZoom(action.zoomPercent);
      if (zoomPercent === session.zoomPercent) return state;
      return replaceDocument(state, { ...session, zoomPercent });
    }

    case "source-selection-updated": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (!session) return state;
      const selection = cloneSelection(action.selection) as Extract<SelectionSnapshot, { kind: "text" }> | null;
      const current = session.viewState.selection;
      if (JSON.stringify(current) === JSON.stringify(selection)) return state;
      return replaceDocument(state, {
        ...session,
        viewState: { ...session.viewState, selection },
      });
    }

    case "source-viewport-updated": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (!session) return state;
      const anchor = action.anchor === null ? null : { ...action.anchor };
      const current = session.viewState.scrollAnchor;
      if (
        current?.blockViewKey === anchor?.blockViewKey &&
        current?.offset === anchor?.offset &&
        (current === null) === (anchor === null)
      ) return state;
      return replaceDocument(state, {
        ...session,
        viewState: { ...session.viewState, scrollAnchor: anchor },
      });
    }

    case "source-buffer-rejected": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (
        !session ||
        !documentEditsAreEnabled(session) ||
        session.mode !== "source" ||
        action.buffer.sessionId !== action.sessionId ||
        action.buffer.baseCandidateRevision !== action.expectedRevision
      ) {
        return state;
      }
      const sourceBuffer = cloneSourceBuffer(action.buffer);
      return replaceDocument(state, {
        ...session,
        status: session.status === "saving" ? "saving" : "dirty",
        sourceBuffer,
        viewState: {
          ...session.viewState,
          selection: cloneSelection(action.selectionAfter),
        },
      });
    }

    case "source-buffer-accepted": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      if (
        !session?.sourceBuffer ||
        !documentEditsAreEnabled(session) ||
        session.mode !== "source" ||
        session.sourceBuffer.sessionId !== action.sessionId ||
        session.sourceBuffer.baseCandidateRevision !== action.expectedRevision ||
        session.sourceBuffer.bufferText !== action.expectedBufferText
      ) {
        return state;
      }
      if (action.result === null) {
        return replaceDocument(state, keepPendingWriteStatus(state, {
          ...session,
          sourceBuffer: null,
          status: editStatus(session, session.candidate, null),
          viewState: {
            ...session.viewState,
            selection: cloneSelection(action.selectionAfter),
          },
        }));
      }
      return replaceDocument(
        state,
        keepPendingWriteStatus(
          state,
          applyResult(session, action.result, true, action.selectionAfter),
        ),
      );
    }

    case "protected-raw-buffer-opened": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      const block = session ? protectedBlockFor(session, action.blockViewKey) : null;
      if (
        !session ||
        session.mode !== "rich" ||
        session.sourceBuffer !== null ||
        session.protectedRawBuffer !== null ||
        session.status === "readonly" ||
        session.status === "conflict" ||
        !block
      ) return state;
      return replaceDocument(state, {
        ...session,
        protectedRawBuffer: {
          sessionId: session.id,
          baseCandidateRevision: session.revision,
          blockViewKey: action.blockViewKey,
          bufferText: block.raw,
          validationError: null,
          dirty: false,
        },
      });
    }

    case "protected-raw-buffer-updated": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      const buffer = session?.protectedRawBuffer;
      const block = session ? protectedBlockFor(session, action.blockViewKey) : null;
      if (
        !session || !buffer || !block ||
        buffer.baseCandidateRevision !== action.expectedRevision ||
        buffer.blockViewKey !== action.blockViewKey
      ) return state;
      if (buffer.bufferText === action.bufferText && buffer.validationError === null) return state;
      return replaceDocument(state, {
        ...session,
        status: "dirty",
        protectedRawBuffer: {
          ...buffer,
          bufferText: action.bufferText,
          validationError: null,
          dirty: action.bufferText !== block.raw,
        },
      });
    }

    case "protected-raw-buffer-cancelled": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      const buffer = session?.protectedRawBuffer;
      if (!session || !buffer || buffer.blockViewKey !== action.blockViewKey) return state;
      return replaceDocument(state, {
        ...session,
        protectedRawBuffer: null,
        status: editStatus(session, session.candidate, session.sourceBuffer),
      });
    }

    case "protected-raw-buffer-rejected": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      const buffer = session?.protectedRawBuffer;
      if (
        !session || !buffer ||
        buffer.blockViewKey !== action.blockViewKey ||
        buffer.bufferText !== action.expectedBufferText
      ) return state;
      return replaceDocument(state, {
        ...session,
        status: "dirty",
        protectedRawBuffer: { ...buffer, validationError: action.validationError },
      });
    }

    case "protected-raw-buffer-accepted": {
      const session = findDocument(state, action.sessionId, action.expectedRevision);
      const buffer = session?.protectedRawBuffer;
      if (
        !session || !buffer ||
        buffer.blockViewKey !== action.blockViewKey ||
        buffer.bufferText !== action.expectedBufferText
      ) return state;
      return replaceDocument(
        state,
        applyResult(
          { ...session, protectedRawBuffer: null },
          action.result,
          false,
          null,
        ),
      );
    }

    case "save-succeeded": {
      const operation = resolveOperation(state, action.operationId, "save");
      if (!operation || operation.kind !== "save") return state;
      const consumed = withPending(state, (pending) => pending.delete(action.operationId));
      const session = findDocument(consumed, operation.sessionId);
      if (
        !session ||
        session.file.kind !== "local" ||
        !sameWindowsPath(session.file.canonicalPath, operation.source.canonicalPath) ||
        !versionsEqual(session.file.version, operation.source.expectedVersion)
      ) {
        return appendWriteReceipt(
          consumed,
          operation,
          operation.source.canonicalPath,
          action.version,
          detachedReason(consumed, operation.sessionId),
        );
      }
      return replaceDocument(consumed, {
        ...session,
        file: { ...session.file, version: cloneVersion(action.version) },
        baseline: operation.savedCandidate,
        status: editStatus(
          { baseline: operation.savedCandidate, file: session.file },
          session.candidate,
          session.sourceBuffer,
        ),
      });
    }

    case "save-as-succeeded": {
      const operation = resolveOperation(state, action.operationId, "save-as");
      if (!operation || operation.kind !== "save-as") return state;
      const consumed = withPending(state, (pending) => pending.delete(action.operationId));
      const session = findDocument(consumed, operation.sessionId);
      if (
        !session ||
        !matchesFileIntent(session.file, operation.source)
      ) {
        return appendWriteReceipt(
          consumed,
          operation,
          action.canonicalPath,
          action.version,
          detachedReason(consumed, operation.sessionId),
        );
      }
      const nextSession: DocumentSession = {
        ...session,
          file: {
            kind: "local" as const,
          canonicalPath: action.canonicalPath,
          version: cloneVersion(action.version),
        },
        baseline: operation.savedCandidate,
        status: editStatus(
          {
            baseline: operation.savedCandidate,
            file: {
              kind: "local",
              canonicalPath: action.canonicalPath,
              version: action.version,
            },
          },
          session.candidate,
          session.sourceBuffer,
        ),
      };
      if (action.closeIfClean && !documentHasUnsavedWork(nextSession)) {
        return appendWriteReceipt(
          {
            ...consumed,
            tabs: consumed.tabs.filter((tab) => tab.id !== session.id),
            activeTabId: consumed.activeTabId === session.id
              ? (consumed.tabs.find((tab) => tab.id !== session.id)?.id ?? null)
              : consumed.activeTabId,
          },
          operation,
          action.canonicalPath,
          action.version,
          "session-closed",
        );
      }
      return replaceDocument(consumed, nextSession);
    }

    case "draft-succeeded": {
      const operation = resolveOperation(state, action.operationId, "draft");
      if (!operation || operation.kind !== "draft") return state;
      const consumed = withPending(state, (pending) => pending.delete(action.operationId));
      const session = findDocument(
        consumed,
        operation.sessionId,
        operation.candidateRevision,
      );
      if (!session) return consumed;
      return replaceDocument(consumed, { ...session, draftId: action.draftId });
    }

    case "watch-succeeded": {
      const operation = resolveOperation(state, action.operationId, "watch");
      if (!operation || operation.kind !== "watch") return state;
      const consumed = withPending(state, (pending) => pending.delete(action.operationId));
      const session = findDocument(consumed, operation.sessionId);
      if (
        !session ||
        session.file.kind !== "local" ||
        !sameWindowsPath(session.file.canonicalPath, operation.canonicalPath)
      ) {
        return queueWatchCleanup(consumed, action.watchId);
      }
      let next = replaceDocument(consumed, {
        ...session,
        externalChange: { kind: "checking", watchId: action.watchId },
      });
      if (
        session.externalChange?.kind === "checking" &&
        session.externalChange.watchId !== action.watchId
      ) {
        next = queueWatchCleanup(next, session.externalChange.watchId);
      }
      return next;
    }
  }
}

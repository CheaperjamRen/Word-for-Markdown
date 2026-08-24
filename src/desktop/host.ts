import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import {
  DESKTOP_COMMANDS,
  DESKTOP_EVENTS,
  DesktopFailureError,
  DesktopWireError,
  type FileVersion,
  type DeleteDraftInvoke,
  type DraftPayload,
  type DraftRecord,
  type DesktopFailure,
  type FileChangedEvent,
  type HostApi,
  type HostOpenDocument,
  type OpenDocumentEventPayload,
  type OpenDocumentInvoke,
  type ListDraftsInvoke,
  type ReadDraftInvoke,
  type RecordFirstReadablePaintInvoke,
  type ResolveTargetInvoke,
  type SaveDocumentInvoke,
  type SaveDocumentAsInvoke,
  type SaveDocumentAsRequest,
  type SaveDocumentAsResult,
  type SaveDocumentRequest,
  type TakeOpenRequestsInvoke,
  type TakeOpenRequestsResult,
  type UiContractSnapshot,
  type UnwatchDocumentInvoke,
  type WatchDocumentInvoke,
  type WatchDocumentResult,
  type WriteDraftInvoke,
} from "../contracts/desktop";
import type { SelectionSnapshot, TableCoordinate } from "../contracts/markdown";
import type { ResolvedTarget } from "./target-resolver";

export { DesktopFailureError, DesktopWireError } from "../contracts/desktop";

const MARKDOWN_FILTER = [{ name: "Markdown", extensions: ["md", "markdown"] }];

function objectWithKeys(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DesktopWireError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("|") !== [...keys].sort().join("|")) throw new DesktopWireError();
  return record;
}

function stringValue(value: unknown): string { if (typeof value !== "string") throw new DesktopWireError(); return value; }
function numberValue(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DesktopWireError(); return value; }
function nullableString(value: unknown): string | null { return value === null ? null : stringValue(value); }
function decodeUiLanguageHint(value: unknown): "zh-CN" | "en-US" | null {
  if (value === null || value === "zh-CN" || value === "en-US") return value;
  throw new DesktopWireError();
}
function bytesValue(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) throw new DesktopWireError();
  return [...value] as number[];
}
function decodeVersion(value: unknown): FileVersion {
  const record = objectWithKeys(value, ["len", "modifiedMs", "sha256"]);
  return { len: numberValue(record.len), modifiedMs: numberValue(record.modifiedMs), sha256: stringValue(record.sha256) };
}
function encodeVersion(version: FileVersion): FileVersion {
  return { len: numberValue(version.len), modifiedMs: numberValue(version.modifiedMs), sha256: stringValue(version.sha256) };
}
function decodeTableCoordinate(value: unknown): TableCoordinate {
  const record = objectWithKeys(value, ["row", "column"]);
  return {
    row: numberValue(record.row),
    column: numberValue(record.column),
  } satisfies TableCoordinate;
}
function decodeSelection(value: unknown): SelectionSnapshot | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new DesktopWireError();
  const kind = stringValue((value as Record<string, unknown>).kind);
  if (kind === "text") {
    const record = objectWithKeys(value, ["kind", "anchorBlockKey", "anchorOffset", "focusBlockKey", "focusOffset"]);
    return {
      kind,
      anchorBlockKey: nullableString(record.anchorBlockKey),
      anchorOffset: numberValue(record.anchorOffset),
      focusBlockKey: nullableString(record.focusBlockKey),
      focusOffset: numberValue(record.focusOffset),
    } satisfies SelectionSnapshot;
  }
  if (kind === "table") {
    const record = objectWithKeys(value, ["kind", "tableBlockViewKey", "anchor", "focus", "origin"]);
    return {
      kind,
      tableBlockViewKey: stringValue(record.tableBlockViewKey),
      anchor: decodeTableCoordinate(record.anchor),
      focus: decodeTableCoordinate(record.focus),
      origin: decodeTableCoordinate(record.origin),
    } satisfies SelectionSnapshot;
  }
  throw new DesktopWireError();
}
function decodeDraft(value: unknown): DraftRecord {
  const record = objectWithKeys(value, ["id", "sessionId", "canonicalPath", "baselineVersion", "bytes", "candidateRevision", "rejectedSourceBuffer", "updatedMs"]);
  let rejectedSourceBuffer = null;
  if (record.rejectedSourceBuffer !== null) {
    const rejected = objectWithKeys(record.rejectedSourceBuffer, ["baseCandidateRevision", "baseCandidateSha256", "utf16CodeUnitsBase64", "selection"]);
    rejectedSourceBuffer = { baseCandidateRevision: numberValue(rejected.baseCandidateRevision), baseCandidateSha256: stringValue(rejected.baseCandidateSha256), utf16CodeUnitsBase64: stringValue(rejected.utf16CodeUnitsBase64), selection: decodeSelection(rejected.selection) };
  }
  return { id: stringValue(record.id), sessionId: stringValue(record.sessionId), canonicalPath: nullableString(record.canonicalPath), baselineVersion: record.baselineVersion === null ? null : decodeVersion(record.baselineVersion), bytes: bytesValue(record.bytes), candidateRevision: numberValue(record.candidateRevision), rejectedSourceBuffer, updatedMs: numberValue(record.updatedMs) };
}
function decodeFailure(value: unknown): DesktopFailure {
  const record = objectWithKeys(value, ["code", "affectedPaths", "recoveryPaths", "draftId"]);
  const code = stringValue(record.code);
  const codes = new Set(["invalid-request", "invalid-path", "not-found", "already-exists", "changed", "concurrent-writer", "permission-denied", "read-only", "io", "draft-invalid", "watch-failed"]);
  if (!codes.has(code) || !Array.isArray(record.affectedPaths) || !Array.isArray(record.recoveryPaths)) throw new DesktopWireError();
  return { code: code as DesktopFailure["code"], affectedPaths: record.affectedPaths.map(stringValue), recoveryPaths: record.recoveryPaths.map(stringValue), draftId: nullableString(record.draftId) };
}

function decodeResolvedTarget(value: unknown): ResolvedTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DesktopWireError();
  const kind = stringValue((value as Record<string, unknown>).kind);
  switch (kind) {
    case "anchor": {
      const record = objectWithKeys(value, ["kind", "headingId"]);
      return { kind, headingId: stringValue(record.headingId) };
    }
    case "web": {
      const record = objectWithKeys(value, ["kind", "url"]);
      return { kind, url: stringValue(record.url) };
    }
    case "markdown":
    case "directory":
    case "system": {
      const record = objectWithKeys(value, ["kind", "canonicalPath"]);
      return { kind, canonicalPath: stringValue(record.canonicalPath) } as ResolvedTarget;
    }
    case "preview": {
      const record = objectWithKeys(value, ["kind", "canonicalPath", "mediaType"]);
      const mediaType = stringValue(record.mediaType);
      if (mediaType !== "image" && mediaType !== "pdf") throw new DesktopWireError();
      return { kind, canonicalPath: stringValue(record.canonicalPath), mediaType };
    }
    case "dangerous": {
      const record = objectWithKeys(value, ["kind", "canonicalPath", "reason"]);
      return { kind, canonicalPath: stringValue(record.canonicalPath), reason: stringValue(record.reason) };
    }
    case "blocked": {
      const record = objectWithKeys(value, ["kind", "reason"]);
      return { kind, reason: stringValue(record.reason) };
    }
    default:
      throw new DesktopWireError();
  }
}
async function invokeChecked<T>(command: string, payload: Record<string, unknown>, decode: (value: unknown) => T): Promise<T> {
  try { return decode(await invoke<unknown>(command, payload)); }
  catch (error) {
    if (error instanceof DesktopWireError) throw error;
    try { throw new DesktopFailureError(decodeFailure(error)); }
    catch (decoded) { if (decoded instanceof DesktopFailureError) throw decoded; throw new DesktopWireError(); }
  }
}
function encodeDraft(draft: DraftPayload): DraftPayload {
  const candidateRevision = numberValue(draft.candidateRevision);
  let rejectedSourceBuffer = null;
  if (draft.rejectedSourceBuffer !== null) {
    const rejected = objectWithKeys(draft.rejectedSourceBuffer, ["baseCandidateRevision", "baseCandidateSha256", "utf16CodeUnitsBase64", "selection"]);
    rejectedSourceBuffer = {
      baseCandidateRevision: numberValue(rejected.baseCandidateRevision),
      baseCandidateSha256: stringValue(rejected.baseCandidateSha256),
      utf16CodeUnitsBase64: stringValue(rejected.utf16CodeUnitsBase64),
      selection: decodeSelection(rejected.selection),
    };
  }
  return {
    id: stringValue(draft.id),
    sessionId: stringValue(draft.sessionId),
    canonicalPath: nullableString(draft.canonicalPath),
    baselineVersion: draft.baselineVersion === null ? null : encodeVersion(draft.baselineVersion), bytes: bytesValue(draft.bytes),
    candidateRevision,
    rejectedSourceBuffer,
  };
}

const LOCAL_RESOURCE_HOSTS = new Set([
  "tauri.localhost",
  "localhost",
  "127.0.0.1",
]);

function countRemoteResources(): number {
  return performance.getEntriesByType("resource").filter((entry) => {
    try {
      const url = new URL(entry.name);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !LOCAL_RESOURCE_HOSTS.has(url.hostname)
      );
    } catch {
      return false;
    }
  }).length;
}

export function wireBytesToSourceInput(bytes: readonly number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

export function wireDocumentToSourceInput(opened: HostOpenDocument) {
  return {
    canonicalPath: opened.canonicalPath,
    bytes: wireBytesToSourceInput(opened.bytes),
    version: opened.version,
  };
}

export function sourceBytesToWire(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

export function createTauriHost(): HostApi {
  const unwatching = new Map<string, Promise<void>>();
  let allowNextWindowClose = false;

  return {
    async onFileDrop(listener) {
      let active = true;
      const unlisten = await getCurrentWindow().onDragDropEvent(({ payload }) => {
        if (!active || payload.type !== "drop") return;
        listener([...payload.paths]);
      });
      return () => {
        if (!active) return;
        active = false;
        unlisten();
      };
    },

    async onWindowCloseRequested(listener) {
      let active = true;
      const unlisten = await getCurrentWindow().onCloseRequested((event) => {
        if (!active) return;
        if (allowNextWindowClose) {
          allowNextWindowClose = false;
          return;
        }
        event.preventDefault();
        listener();
      });
      return () => {
        if (!active) return;
        active = false;
        unlisten();
      };
    },

    async pickMarkdownFiles() {
      const selected = await openDialog({ multiple: true, filters: MARKDOWN_FILTER });
      if (selected === null) return null;
      return Array.isArray(selected) ? selected : [selected];
    },

    pickMarkdownSavePath(suggestedName) {
      return saveDialog({
        ...(suggestedName === undefined ? {} : { defaultPath: suggestedName }),
        filters: MARKDOWN_FILTER,
      });
    },

    async onOpenRequests(listener) {
      let active = true;
      let drainTail: Promise<void> = Promise.resolve();
      const drain = () => {
        const attempt = drainTail.then(async () => {
          const invokePayload = { request: {} } satisfies TakeOpenRequestsInvoke;
          const paths = await invokeChecked(DESKTOP_COMMANDS.takeOpenRequests, invokePayload, (value) => {
            if (!Array.isArray(value)) throw new DesktopWireError();
            return value.map(stringValue) satisfies TakeOpenRequestsResult;
          });
          if (active && paths.length > 0) listener(paths);
        });
        drainTail = attempt.catch(() => undefined);
        return attempt;
      };

      const unlisten = await listen<OpenDocumentEventPayload>(
        DESKTOP_EVENTS.openDocumentRequests,
        ({ payload }) => {
          if (payload !== null) return;
          void drain().catch(() => undefined);
        },
      );
      const stop = () => {
        if (!active) return;
        active = false;
        unlisten();
      };
      try {
        await drain();
      } catch (error) {
        stop();
        throw error;
      }

      return stop;
    },

    async onFileChanged(listener) {
      let active = true;
      const unlisten = await listen<FileChangedEvent>(
        DESKTOP_EVENTS.fileChanged,
        ({ payload }) => {
          if (!active) return;
          try {
            const record = objectWithKeys(payload, ["watchId", "canonicalPath", "kind", "newCanonicalPath"]);
            const kind = stringValue(record.kind);
            if (!new Set(["content", "deleted", "renamed"]).has(kind)) throw new DesktopWireError();
            const event: FileChangedEvent = { watchId: stringValue(record.watchId), canonicalPath: stringValue(record.canonicalPath), kind: kind as FileChangedEvent["kind"], newCanonicalPath: nullableString(record.newCanonicalPath) };
            if ((event.kind === "renamed") !== (event.newCanonicalPath !== null)) throw new DesktopWireError();
            listener(event);
          } catch (error) {
            if (!(error instanceof DesktopWireError)) throw error;
          }
        },
      );
      return () => {
        if (!active) return;
        active = false;
        unlisten();
      };
    },

    openDocument(path) {
      const payload = { request: { path } } satisfies OpenDocumentInvoke;
      return invokeChecked(DESKTOP_COMMANDS.openDocument, payload, (value) => {
        const record = objectWithKeys(value, ["canonicalPath", "bytes", "version"]);
        return { canonicalPath: stringValue(record.canonicalPath), bytes: bytesValue(record.bytes), version: decodeVersion(record.version) } satisfies HostOpenDocument;
      });
    },

    saveDocument(request: SaveDocumentRequest) {
      const payload = { request: { canonicalPath: stringValue(request.canonicalPath), bytes: bytesValue(request.bytes), expectedVersion: encodeVersion(request.expectedVersion) } } satisfies SaveDocumentInvoke;
      return invokeChecked(DESKTOP_COMMANDS.saveDocument, payload, decodeVersion);
    },

    saveDocumentAs(request: SaveDocumentAsRequest) {
      const payload = { request: { targetPath: stringValue(request.targetPath), bytes: bytesValue(request.bytes), expectedTargetVersion: request.expectedTargetVersion === null ? null : encodeVersion(request.expectedTargetVersion) } } satisfies SaveDocumentAsInvoke;
      return invokeChecked(DESKTOP_COMMANDS.saveDocumentAs, payload, (value) => {
        const record = objectWithKeys(value, ["canonicalPath", "version"]);
        return { canonicalPath: stringValue(record.canonicalPath), version: decodeVersion(record.version) } satisfies SaveDocumentAsResult;
      });
    },

    writeDraft(draft: DraftPayload) {
      const payload = { request: { draft: encodeDraft(draft) } } satisfies WriteDraftInvoke;
      return invokeChecked(DESKTOP_COMMANDS.writeDraft, payload, decodeDraft);
    },

    listDrafts() {
      const payload = { request: {} } satisfies ListDraftsInvoke;
      return invokeChecked(DESKTOP_COMMANDS.listDrafts, payload, (value) => {
        if (!Array.isArray(value)) throw new DesktopWireError();
        return value.map(decodeDraft);
      });
    },

    readDraft(id: string) {
      const payload = { request: { id } } satisfies ReadDraftInvoke;
      return invokeChecked(DESKTOP_COMMANDS.readDraft, payload, decodeDraft);
    },

    async deleteDraft(id: string) {
      const payload = { request: { id } } satisfies DeleteDraftInvoke;
      await invokeChecked(DESKTOP_COMMANDS.deleteDraft, payload, (value) => {
        if (value !== null) throw new DesktopWireError();
      });
    },

    async watchDocument(canonicalPath: string) {
      const payload = { request: { canonicalPath } } satisfies WatchDocumentInvoke;
      return invokeChecked(DESKTOP_COMMANDS.watchDocument, payload, (value) => {
        const record = objectWithKeys(value, ["watchId", "canonicalPath"]);
        return { watchId: stringValue(record.watchId), canonicalPath: stringValue(record.canonicalPath) } satisfies WatchDocumentResult;
      });
    },

    unwatchDocument(watchId: string) {
      const pending = unwatching.get(watchId);
      if (pending) return pending;
      const payload = { request: { watchId } } satisfies UnwatchDocumentInvoke;
      const operation = invokeChecked(DESKTOP_COMMANDS.unwatchDocument, payload, (value) => {
        if (value !== null) throw new DesktopWireError();
      })
        .finally(() => { unwatching.delete(watchId); });
      unwatching.set(watchId, operation);
      return operation;
    },

    setWindowTitle(title) {
      return getCurrentWindow().setTitle(title);
    },

    async closeWindow() {
      allowNextWindowClose = true;
      try {
        // `close()` emits closeRequested again and can re-enter the JS guard.
        // The controller has already resolved the save/discard decision here,
        // so destroy is the one-way finalization path.
        await getCurrentWindow().destroy();
      } catch (error) {
        allowNextWindowClose = false;
        throw error;
      }
    },

    getAppVersion() {
      return getVersion();
    },

    getUiLanguageHint() {
      return invokeChecked(DESKTOP_COMMANDS.getUiLanguageHint, {}, decodeUiLanguageHint);
    },

    recordFirstReadablePaint(path, uiContract: UiContractSnapshot) {
      const ui = objectWithKeys(uiContract, ["uiFontSize", "statusFontSize", "documentFontSize", "documentLineHeight", "toolbarIconWidth", "iconButtonHeight"]);
      const payload = {
        request: {
          path: stringValue(path),
          applicationNetworkRequests: numberValue(countRemoteResources()),
          uiContract: {
            uiFontSize: stringValue(ui.uiFontSize), statusFontSize: stringValue(ui.statusFontSize),
            documentFontSize: stringValue(ui.documentFontSize), documentLineHeight: stringValue(ui.documentLineHeight),
            toolbarIconWidth: stringValue(ui.toolbarIconWidth), iconButtonHeight: stringValue(ui.iconButtonHeight),
          },
        },
      } satisfies RecordFirstReadablePaintInvoke;
      return invokeChecked(DESKTOP_COMMANDS.recordFirstReadablePaint, payload, numberValue);
    },

    resolveTarget(basePath: string, href: string) {
      const payload = { request: { basePath: stringValue(basePath), href: stringValue(href) } } satisfies ResolveTargetInvoke;
      return invokeChecked(DESKTOP_COMMANDS.resolveTarget, payload, decodeResolvedTarget);
    },

    openSystemTarget(canonicalPath: string) {
      return openPath(stringValue(canonicalPath));
    },

    openExternalUrl(url: string) {
      return openUrl(stringValue(url));
    },
  };
}

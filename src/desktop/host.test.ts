import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import wire from "../../fixtures/contracts/desktop-wire.json";
import {
  DESKTOP_COMMANDS,
  DESKTOP_EVENTS,
  type HostApi,
  type HostOpenDocument,
  type DraftPayload,
  type DraftRecord,
  type FileChangedEvent,
  type OpenDocumentEventPayload,
} from "../contracts/desktop";
import type { SelectionSnapshot } from "../contracts/markdown";
import type { ResolvedTarget } from "./target-resolver";
import {
  createTauriHost,
  DesktopFailureError,
  DesktopWireError,
  wireDocumentToSourceInput,
} from "./host";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));

const VERSION = wire.openDocument.version;
const DRAFT_PAYLOAD = wire.draftPayload as unknown as DraftPayload;
const DRAFT_RECORD = wire.draftRecord as unknown as DraftRecord;
const SELECTION_TEXT = wire.selectionText as unknown as Extract<
  SelectionSnapshot,
  { kind: "text" }
>;
const SELECTION_TABLE = wire.selectionTable as unknown as Extract<
  SelectionSnapshot,
  { kind: "table" }
>;
const unlisten = vi.fn();
const setTitle = vi.fn();
const close = vi.fn();
const destroy = vi.fn();
const onCloseRequested = vi.fn();
const onDragDropEvent = vi.fn();
let capturedEventHandler:
  | ((event: Event<OpenDocumentEventPayload>) => void)
  | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function captureOpenWakeListener() {
  vi.mocked(listen).mockImplementation(async (_name, handler) => {
    capturedEventHandler = handler;
    return unlisten;
  });
}

function emitOpenWake(id: number): void {
  capturedEventHandler?.({
    event: DESKTOP_EVENTS.openDocumentRequests,
    id,
    payload: null,
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  vi.mocked(getCurrentWindow).mockReset();
  vi.mocked(getVersion).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(save).mockReset();
  unlisten.mockReset();
  setTitle.mockReset();
  close.mockReset();
  destroy.mockReset();
  onCloseRequested.mockReset();
  onDragDropEvent.mockReset();
  capturedEventHandler = undefined;
  vi.mocked(listen).mockResolvedValue(unlisten);
  vi.mocked(getCurrentWindow).mockReturnValue({ close, destroy, onCloseRequested, onDragDropEvent, setTitle } as never);
  vi.mocked(getVersion).mockResolvedValue("0.1.0");
});

describe("Tauri HostApi", () => {
  it("reads only supported installer language hints", async () => {
    const host = createTauriHost();
    vi.mocked(invoke)
      .mockResolvedValueOnce("zh-CN")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("fr-FR");

    await expect(host.getUiLanguageHint?.()).resolves.toBe("zh-CN");
    await expect(host.getUiLanguageHint?.()).resolves.toBeNull();
    await expect(host.getUiLanguageHint?.()).rejects.toBeInstanceOf(DesktopWireError);
    expect(invoke).toHaveBeenNthCalledWith(1, DESKTOP_COMMANDS.getUiLanguageHint, {});
  });
  it("decodes typed target resolution without exposing raw invoke payloads", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ kind: "preview", canonicalPath: "C:\\docs\\photo.png", mediaType: "image" });
    const host = createTauriHost();
    const target = await host.resolveTarget!("C:\\docs\\note.md", "./photo.png");
    expect(target satisfies ResolvedTarget).toEqual({ kind: "preview", canonicalPath: "C:\\docs\\photo.png", mediaType: "image" });
    expect(invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.resolveTarget, { request: { basePath: "C:\\docs\\note.md", href: "./photo.png" } });
  });
  it("delivers only native drop paths and suppresses delivery after idempotent cleanup", async () => {
    const host = createTauriHost() as HostApi & {
      onFileDrop(listener: (paths: string[]) => void): Promise<() => void>;
    };
    const listener = vi.fn();
    const release = vi.fn();
    let handler: ((event: { payload: { type: string; paths?: string[] } }) => void) | undefined;
    onDragDropEvent.mockImplementation(async (next) => { handler = next; return release; });

    const stop = await host.onFileDrop(listener);
    handler?.({ payload: { type: "over", paths: ["C:\\docs\\ignored.md"] } });
    handler?.({ payload: { type: "drop", paths: ["C:\\docs\\a.md"] } });
    stop();
    stop();
    handler?.({ payload: { type: "drop", paths: ["C:\\docs\\late.md"] } });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(["C:\\docs\\a.md"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("prevents native close, exposes explicit close, and returns the real app version", async () => {
    const host = createTauriHost() as HostApi & {
      onWindowCloseRequested(listener: () => void): Promise<() => void>;
      closeWindow(): Promise<void>;
      getAppVersion(): Promise<string>;
    };
    const listener = vi.fn();
    const preventDefault = vi.fn();
    const release = vi.fn();
    let handler: ((event: { preventDefault(): void }) => void) | undefined;
    onCloseRequested.mockImplementation(async (next) => { handler = next; return release; });

    const stop = await host.onWindowCloseRequested(listener);
    handler?.({ preventDefault });
    await host.closeWindow();
    handler?.({ preventDefault });
    await expect(host.getAppVersion()).resolves.toBe("0.1.0");
    stop();
    handler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("disarms the one-shot close bypass when programmatic close fails", async () => {
    const host = createTauriHost();
    const listener = vi.fn();
    const preventDefault = vi.fn();
    let handler: ((event: { preventDefault(): void }) => void) | undefined;
    onCloseRequested.mockImplementation(async (next) => { handler = next; return unlisten; });
    destroy.mockRejectedValueOnce(new Error("destroy failed"));
    await host.onWindowCloseRequested(listener);

    await expect(host.closeWindow()).rejects.toThrow("destroy failed");
    handler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });
  it("normalizes Markdown multi-open results and cancellation behind HostApi", async () => {
    const host = createTauriHost();
    vi.mocked(open)
      .mockResolvedValueOnce(["C:\\docs\\a.md", "C:\\docs\\b.markdown"])
      .mockResolvedValueOnce("C:\\docs\\single.md")
      .mockResolvedValueOnce(null);

    await expect(host.pickMarkdownFiles()).resolves.toEqual([
      "C:\\docs\\a.md", "C:\\docs\\b.markdown",
    ]);
    await expect(host.pickMarkdownFiles()).resolves.toEqual(["C:\\docs\\single.md"]);
    await expect(host.pickMarkdownFiles()).resolves.toBeNull();
    expect(open).toHaveBeenCalledWith({
      multiple: true,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
  });

  it("normalizes Markdown Save As cancellation and passes only the suggested filename", async () => {
    const host = createTauriHost();
    vi.mocked(save)
      .mockResolvedValueOnce("C:\\docs\\draft.md")
      .mockResolvedValueOnce(null);

    await expect(host.pickMarkdownSavePath("draft.md")).resolves.toBe("C:\\docs\\draft.md");
    await expect(host.pickMarkdownSavePath()).resolves.toBeNull();
    expect(save).toHaveBeenNthCalledWith(1, {
      defaultPath: "draft.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    expect(save).toHaveBeenNthCalledWith(2, {
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
  });

  it("routes every lifecycle action through its one canonical command", async () => {
    const host = createTauriHost();
    vi.mocked(invoke)
      .mockResolvedValueOnce(wire.saveAsResult)
      .mockResolvedValueOnce(wire.draftRecord)
      .mockResolvedValueOnce([wire.draftRecord])
      .mockResolvedValueOnce(wire.draftRecord)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(wire.watchDocumentResult)
      .mockResolvedValueOnce(null);

    await host.saveDocumentAs(wire.saveAsInvoke.request);
    await host.writeDraft(wire.writeDraftInvoke.request.draft);
    await host.listDrafts();
    await host.readDraft(wire.readDraftInvoke.request.id);
    await host.deleteDraft(wire.deleteDraftInvoke.request.id);
    await host.watchDocument(wire.watchDocumentInvoke.request.canonicalPath);
    await host.unwatchDocument(wire.unwatchDocumentInvoke.request.watchId);

    expect(vi.mocked(invoke).mock.calls).toEqual([
      [DESKTOP_COMMANDS.saveDocumentAs, wire.saveAsInvoke],
      [DESKTOP_COMMANDS.writeDraft, wire.writeDraftInvoke],
      [DESKTOP_COMMANDS.listDrafts, wire.listDraftsInvoke],
      [DESKTOP_COMMANDS.readDraft, wire.readDraftInvoke],
      [DESKTOP_COMMANDS.deleteDraft, wire.deleteDraftInvoke],
      [DESKTOP_COMMANDS.watchDocument, wire.watchDocumentInvoke],
      [DESKTOP_COMMANDS.unwatchDocument, wire.unwatchDocumentInvoke],
    ]);
  });

  it.each([
    ["text", SELECTION_TEXT],
    ["table", SELECTION_TABLE],
  ])("exact-decodes and re-encodes the tagged %s selection", async (_kind, selection) => {
    const host = createTauriHost();
    const draft = {
      ...DRAFT_PAYLOAD,
      rejectedSourceBuffer: {
        ...DRAFT_PAYLOAD.rejectedSourceBuffer!,
        selection,
      },
    };
    const record = {
      ...DRAFT_RECORD,
      rejectedSourceBuffer: {
        ...DRAFT_RECORD.rejectedSourceBuffer!,
        selection,
      },
    };
    vi.mocked(invoke).mockResolvedValueOnce(record).mockResolvedValueOnce([record]);

    await expect(host.writeDraft(draft)).resolves.toEqual(record);
    await expect(host.listDrafts()).resolves.toEqual([record]);
    expect(invoke).toHaveBeenNthCalledWith(1, DESKTOP_COMMANDS.writeDraft, {
      request: { draft },
    });
  });

  it("coalesces concurrent unwatch while relying on backend idempotency after completion", async () => {
    const host = createTauriHost();
    const pending = deferred<null>();
    vi.mocked(invoke).mockImplementationOnce(() => pending.promise);

    const first = host.unwatchDocument("watch-1");
    const second = host.unwatchDocument("watch-1");
    pending.resolve(null);
    await Promise.all([first, second]);
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await host.unwatchDocument("watch-1");

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, DESKTOP_COMMANDS.unwatchDocument, {
      request: { watchId: "watch-1" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, DESKTOP_COMMANDS.unwatchDocument, {
      request: { watchId: "watch-1" },
    });
  });

  it("rejects malformed lifecycle results and failures at the Host boundary", async () => {
    const host = createTauriHost();
    vi.mocked(invoke)
      .mockResolvedValueOnce({ ...wire.saveAsResult, unexpected: true })
      .mockResolvedValueOnce({ ...wire.draftRecord, rejectedSourceBuffer: {
        ...wire.draftRecord.rejectedSourceBuffer,
        selection: {
          anchorBlockKey: null,
          anchorOffset: 0,
          focusBlockKey: null,
          focusOffset: 0,
        },
      } })
      .mockResolvedValueOnce([{ ...wire.draftRecord, updatedMs: "late" }])
      .mockResolvedValueOnce({ watchId: "watch-only" })
      .mockRejectedValueOnce(wire.desktopFailure)
      .mockRejectedValueOnce("raw framework error");

    await expect(host.saveDocumentAs(wire.saveAsInvoke.request)).rejects.toBeInstanceOf(DesktopWireError);
    await expect(host.writeDraft(DRAFT_PAYLOAD)).rejects.toBeInstanceOf(DesktopWireError);
    await expect(host.listDrafts()).rejects.toBeInstanceOf(DesktopWireError);
    await expect(host.watchDocument("C:\\docs\\a.md")).rejects.toBeInstanceOf(DesktopWireError);
    await expect(host.readDraft(wire.readDraftInvoke.request.id)).rejects.toBeInstanceOf(DesktopFailureError);
    await expect(host.readDraft(wire.readDraftInvoke.request.id)).rejects.toBeInstanceOf(DesktopWireError);
  });

  it("drops malformed file-change events before the business listener", async () => {
    const host = createTauriHost();
    const listener = vi.fn();
    vi.mocked(listen).mockImplementationOnce(async (_name, handler) => {
      handler({
        event: DESKTOP_EVENTS.fileChanged,
        id: 1,
        payload: { ...wire.fileChangedEvent, newCanonicalPath: null, unexpected: true },
      } as never);
      return unlisten;
    });

    const stop = await host.onFileChanged(listener);
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it("rejects malformed old results and non-u64 lifecycle numbers", async () => {
    const host = createTauriHost();
    vi.mocked(invoke)
      .mockResolvedValueOnce(["C:\\docs\\ok.md", 7])
      .mockResolvedValueOnce({ ...wire.openDocument, version: { ...wire.openDocument.version, len: -1 } })
      .mockResolvedValueOnce({ ...VERSION, modifiedMs: 1.5 })
      .mockResolvedValueOnce(-1)
      .mockResolvedValueOnce({ ...wire.saveAsResult, version: { ...wire.saveAsResult.version, modifiedMs: Number.MAX_SAFE_INTEGER + 1 } });

    await expect(host.onOpenRequests(vi.fn())).rejects.toBeInstanceOf(DesktopWireError);
    await expect(host.openDocument("C:\\docs\\a.md")).rejects.toBeInstanceOf(DesktopWireError);
    await expect(host.saveDocument({ canonicalPath: "C:\\docs\\a.md", bytes: [1], expectedVersion: VERSION })).rejects.toBeInstanceOf(DesktopWireError);
    await expect(host.recordFirstReadablePaint("x", wire.paintInvoke.request.uiContract)).rejects.toBeInstanceOf(DesktopWireError);
    await expect(host.saveDocumentAs(wire.saveAsInvoke.request)).rejects.toBeInstanceOf(DesktopWireError);
  });

  it("rejects every JS-unsafe integer in inbound draft records without trusting Tauri coercion", async () => {
    const host = createTauriHost();
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const record = () => structuredClone(wire.draftRecord) as unknown as Record<string, any>;
    const invalidRecords = [
      (() => { const value = record(); value.candidateRevision = unsafe; return value; })(),
      (() => { const value = record(); value.updatedMs = unsafe; return value; })(),
      (() => { const value = record(); value.baselineVersion.len = unsafe; return value; })(),
      (() => { const value = record(); value.baselineVersion.modifiedMs = unsafe; return value; })(),
      (() => { const value = record(); value.rejectedSourceBuffer.baseCandidateRevision = unsafe; return value; })(),
      (() => { const value = record(); value.rejectedSourceBuffer.selection.anchorOffset = unsafe; return value; })(),
      (() => {
        const value = record();
        value.rejectedSourceBuffer.selection = {
          ...SELECTION_TABLE,
          focus: { row: 0, column: unsafe },
        };
        return value;
      })(),
    ];

    for (const invalid of invalidRecords) {
      vi.mocked(invoke)
        .mockResolvedValueOnce(invalid)
        .mockResolvedValueOnce([invalid])
        .mockResolvedValueOnce(invalid);
      await expect(host.writeDraft(DRAFT_PAYLOAD)).rejects.toBeInstanceOf(DesktopWireError);
      await expect(host.listDrafts()).rejects.toBeInstanceOf(DesktopWireError);
      await expect(host.readDraft(wire.readDraftInvoke.request.id)).rejects.toBeInstanceOf(DesktopWireError);
    }

    const maximum = record();
    maximum.candidateRevision = Number.MAX_SAFE_INTEGER;
    maximum.updatedMs = Number.MAX_SAFE_INTEGER;
    maximum.baselineVersion.len = Number.MAX_SAFE_INTEGER;
    maximum.baselineVersion.modifiedMs = Number.MAX_SAFE_INTEGER;
    maximum.rejectedSourceBuffer.baseCandidateRevision = Number.MAX_SAFE_INTEGER;
    maximum.rejectedSourceBuffer.selection = {
      ...SELECTION_TABLE,
      anchor: { row: Number.MAX_SAFE_INTEGER, column: 0 },
    };
    vi.mocked(invoke).mockResolvedValueOnce(maximum);
    await expect(host.readDraft(wire.readDraftInvoke.request.id)).resolves.toEqual(maximum);
  });

  it("strips runtime unknown keys from every outbound nested payload", async () => {
    const host = createTauriHost();
    const dirtyVersion = { ...VERSION, hidden: true } as typeof VERSION;
    const dirtySave = { canonicalPath: "C:\\docs\\a.md", bytes: [1], expectedVersion: dirtyVersion, hidden: true };
    vi.mocked(invoke).mockResolvedValueOnce(VERSION).mockResolvedValueOnce(wire.saveAsResult).mockResolvedValueOnce(wire.draftRecord);

    await host.saveDocument(dirtySave);
    await host.saveDocumentAs({ ...wire.saveAsInvoke.request, expectedTargetVersion: dirtyVersion, hidden: true } as never);
    await host.writeDraft({ ...wire.draftPayload, baselineVersion: dirtyVersion, hidden: true } as never);

    expect(invoke).toHaveBeenNthCalledWith(1, DESKTOP_COMMANDS.saveDocument, {
      request: { canonicalPath: "C:\\docs\\a.md", bytes: [1], expectedVersion: VERSION },
    });
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain("hidden");
  });

  it("rejects malformed tagged outbound selections before invoke", () => {
    const host = createTauriHost();
    const text = SELECTION_TEXT;
    const table = SELECTION_TABLE;
    const invalidDrafts = [
      {
        anchorBlockKey: null,
        anchorOffset: 0,
        focusBlockKey: null,
        focusOffset: 0,
      },
      { ...text, kind: "unknown" },
      { ...text, unexpected: true },
      { kind: "text", anchorBlockKey: null, anchorOffset: 0, focusBlockKey: null },
      { ...text, anchorOffset: -1 },
      { ...text, focusOffset: 1.5 },
      { ...text, focusOffset: Number.MAX_SAFE_INTEGER + 1 },
      { ...table, anchor: { row: -1, column: 0 } },
      { ...table, focus: { row: 0.5, column: 0 } },
      { ...table, origin: { row: 0, column: Number.MAX_SAFE_INTEGER + 1 } },
      { ...table, anchor: { row: 0, column: 0, unexpected: true } },
      { kind: "table", tableBlockViewKey: "table", anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } },
    ];
    for (const selection of invalidDrafts) {
      const draft = {
        ...DRAFT_PAYLOAD,
        rejectedSourceBuffer: {
          ...DRAFT_PAYLOAD.rejectedSourceBuffer!,
          selection,
        },
      };
      expect(() => host.writeDraft(draft as never)).toThrow(DesktopWireError);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still rejects unsafe outbound draft revisions before invoke", () => {
    const host = createTauriHost();
    const invalidDrafts = [
      { ...wire.draftPayload, candidateRevision: -1 },
      { ...wire.draftPayload, candidateRevision: 1.5 },
      { ...wire.draftPayload, candidateRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...wire.draftPayload, rejectedSourceBuffer: { ...wire.draftPayload.rejectedSourceBuffer!, baseCandidateRevision: -1 } },
      { ...wire.draftPayload, baselineVersion: { ...wire.openDocument.version, modifiedMs: -1 } },
    ];
    for (const draft of invalidDrafts) expect(() => host.writeDraft(draft as never)).toThrow(DesktopWireError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["id", { ...DRAFT_PAYLOAD, id: 42 }],
    ["sessionId", { ...DRAFT_PAYLOAD, sessionId: { value: "session" } }],
    ["canonicalPath", { ...DRAFT_PAYLOAD, canonicalPath: 42 }],
    ["canonicalPath undefined", { ...DRAFT_PAYLOAD, canonicalPath: undefined }],
  ])("rejects malformed outbound draft %s before invoke", (_case, draft) => {
    const host = createTauriHost();
    vi.mocked(invoke).mockResolvedValue(DRAFT_RECORD);

    expect(() => host.writeDraft(draft as never)).toThrow(DesktopWireError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rebuilds and validates paint payload before invoke", () => {
    const host = createTauriHost();
    const dirtyUi = { ...wire.paintInvoke.request.uiContract, uiFontSize: 12, hidden: true } as never;
    expect(() => host.recordFirstReadablePaint("C:\\docs\\a.md", dirtyUi)).toThrow(DesktopWireError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores non-null open wake payloads without draining or delivering", async () => {
    const host = createTauriHost();
    const listener = vi.fn();
    vi.mocked(invoke).mockResolvedValueOnce([]);
    vi.mocked(listen).mockImplementationOnce(async (_name, handler) => {
      capturedEventHandler = handler;
      return unlisten;
    });
    const stop = await host.onOpenRequests(listener);
    capturedEventHandler?.({ event: DESKTOP_EVENTS.openDocumentRequests, id: 9, payload: { unexpected: true } as never });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it("delivers typed file-change facts and releases the event listener once", async () => {
    const host = createTauriHost();
    const listener = vi.fn();
    const event = wire.fileChangedEvent as FileChangedEvent;
    vi.mocked(listen).mockImplementationOnce(async (name, handler) => {
      expect(name).toBe(DESKTOP_EVENTS.fileChanged);
      handler({ event: DESKTOP_EVENTS.fileChanged, id: 1, payload: event });
      return unlisten;
    });

    const stop = await host.onFileChanged(listener);
    stop();
    stop();

    expect(listener).toHaveBeenCalledWith(event);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("converts wire bytes to a non-aliased Uint8Array at one named boundary", () => {
    const opened: HostOpenDocument = {
      canonicalPath: "C:\\docs\\a.md",
      bytes: [35, 32, 65],
      version: VERSION,
    };

    const sourceInput = wireDocumentToSourceInput(opened);
    opened.bytes[0] = 0;

    expect(sourceInput.bytes).toBeInstanceOf(Uint8Array);
    expect([...sourceInput.bytes]).toEqual([35, 32, 65]);
    expect(sourceInput.canonicalPath).toBe(opened.canonicalPath);
    expect(sourceInput.version).toBe(VERSION);
  });

  it("sends the expected version with every save", async () => {
    const host = createTauriHost();
    vi.mocked(invoke).mockResolvedValueOnce(VERSION);

    await host.saveDocument({
      canonicalPath: "C:\\docs\\a.md",
      bytes: [35, 32, 65],
      expectedVersion: VERSION,
    });

    expect(invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.saveDocument, {
      request: {
        canonicalPath: "C:\\docs\\a.md",
        bytes: [35, 32, 65],
        expectedVersion: VERSION,
      },
    });
  });

  it("uses the strict nested open request from the shared fixture", async () => {
    const host = createTauriHost();
    vi.mocked(invoke).mockResolvedValueOnce(wire.openDocument);

    await host.openDocument(wire.openInvoke.request.path);

    expect(invoke).toHaveBeenCalledWith(
      DESKTOP_COMMANDS.openDocument,
      wire.openInvoke,
    );
  });

  it("sends the runtime UI snapshot and measured remote-resource count", async () => {
    const host = createTauriHost();
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { name: "http://tauri.localhost/assets/app.js" } as PerformanceResourceTiming,
      { name: "http://localhost:1420/assets/app.js" } as PerformanceResourceTiming,
      { name: "http://127.0.0.1:1420/assets/app.js" } as PerformanceResourceTiming,
      { name: "https://example.com/remote.png" } as PerformanceResourceTiming,
    ]);
    vi.mocked(invoke).mockResolvedValueOnce(500);

    await host.recordFirstReadablePaint(
      "C:\\docs\\a.md",
      wire.paintInvoke.request.uiContract,
    );

    expect(invoke).toHaveBeenCalledWith(
      DESKTOP_COMMANDS.recordFirstReadablePaint,
      {
        request: {
          ...wire.paintInvoke.request,
          path: "C:\\docs\\a.md",
          applicationNetworkRequests: 1,
        },
      },
    );
  });

  it("subscribes before draining and delivers a wake-race path exactly once", async () => {
    const host = createTauriHost();
    const listener = vi.fn();
    vi.mocked(invoke)
      .mockResolvedValueOnce(["C:\\docs\\during-subscribe.md"])
      .mockResolvedValueOnce([]);
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      expect(name).toBe(DESKTOP_EVENTS.openDocumentRequests);
      capturedEventHandler = handler;
      handler({
        event: DESKTOP_EVENTS.openDocumentRequests,
        id: 1,
        payload: null,
      });
      return unlisten;
    });

    const unsubscribe = await host.onOpenRequests(listener);

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener).toHaveBeenCalledWith([
      "C:\\docs\\during-subscribe.md",
    ]);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      DESKTOP_COMMANDS.takeOpenRequests,
      wire.takeOpenRequestsInvoke,
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      DESKTOP_COMMANDS.takeOpenRequests,
      wire.takeOpenRequestsInvoke,
    );
    expect(capturedEventHandler).toBeTypeOf("function");
    unsubscribe();
    expect(unlisten).toHaveBeenCalled();
  });

  it("cleans up the acquired listener when the initial drain rejects", async () => {
    const host = createTauriHost();
    const error = new Error("initial drain failed");
    captureOpenWakeListener();
    vi.mocked(invoke).mockRejectedValueOnce(error);

    await expect(host.onOpenRequests(vi.fn())).rejects.toBeInstanceOf(DesktopWireError);

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("recovers the serialized tail so a wake after rejection can deliver", async () => {
    const host = createTauriHost();
    const listener = vi.fn();
    captureOpenWakeListener();
    vi.mocked(invoke)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("wake drain failed"))
      .mockResolvedValueOnce(["C:\\docs\\retry.md"]);
    const stop = await host.onOpenRequests(listener);

    emitOpenWake(1);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    emitOpenWake(2);

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(["C:\\docs\\retry.md"]);
    stop();
  });

  it("makes stop idempotent and suppresses an in-flight drain result", async () => {
    const host = createTauriHost();
    const listener = vi.fn();
    const pendingPaths = deferred<string[]>();
    captureOpenWakeListener();
    vi.mocked(invoke)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => pendingPaths.promise);
    const stop = await host.onOpenRequests(listener);

    emitOpenWake(1);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    stop();
    stop();
    pendingPaths.resolve(["C:\\docs\\late.md"]);
    await pendingPaths.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("sets the current document window title through the narrow HostApi", async () => {
    const host = createTauriHost();

    await host.setWindowTitle("a.md — Markdown 文档");

    expect(getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith("a.md — Markdown 文档");
  });
});

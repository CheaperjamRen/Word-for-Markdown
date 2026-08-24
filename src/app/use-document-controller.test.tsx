import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  DesktopFailureError,
  DesktopWireError,
  type FileVersion,
  type HostApi,
  type HostOpenDocument,
} from "../contracts/desktop";
import type { SessionAction, WorkspaceState } from "../documents/session";
import type { DocumentSession } from "../documents/session";
import type { SourceBufferState } from "../contracts/markdown";
import type { SourceChangeBatch } from "../contracts/markdown";
import { buildSourceView } from "../markdown/source-view";
import { CurrentSourceViewCache } from "../markdown/current-source-view-cache";
// @ts-expect-error The tested deterministic fixture helper intentionally has no duplicate TS declaration.
import { buildSizedMarkdown } from "../../scripts/create-test-fixtures.mjs";
import { createDocumentController } from "./use-document-controller";
import App from "./App";
import * as sourceDocumentCore from "../markdown/source-document";

const VERSION_A: FileVersion = { len: 1, modifiedMs: 10, sha256: "a" };
const VERSION_B: FileVersion = { len: 2, modifiedMs: 20, sha256: "b" };
const encoder = new TextEncoder();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, reject, resolve };
}

function payload(path: string, text = "# 文档"): HostOpenDocument {
  return { canonicalPath: path, bytes: [...encoder.encode(text)], version: VERSION_A };
}

function missing(path: string) {
  return new DesktopFailureError({ code: "not-found", affectedPaths: [path], recoveryPaths: [], draftId: null });
}

function hostFixture() {
  let openListener: ((paths: string[]) => void) | undefined;
  let dropListener: ((paths: string[]) => void) | undefined;
  let closeListener: (() => void) | undefined;
  let fileChangedListener: ((event: { watchId: string; canonicalPath: string; kind: "content" | "deleted" | "renamed"; newCanonicalPath: string | null }) => void) | undefined;
  const stopOpen = vi.fn();
  const stopDrop = vi.fn();
  const stopClose = vi.fn();
  const host: HostApi = {
    onOpenRequests: vi.fn(async (listener) => { openListener = listener; return stopOpen; }),
    onFileDrop: vi.fn(async (listener) => { dropListener = listener; return stopDrop; }),
    onWindowCloseRequested: vi.fn(async (listener) => { closeListener = listener; return stopClose; }),
    closeWindow: vi.fn(async () => undefined),
    getAppVersion: vi.fn(async () => "0.1.0"),
    onFileChanged: vi.fn(async (listener) => { fileChangedListener = listener; return () => undefined; }),
    pickMarkdownFiles: vi.fn(async () => null),
    pickMarkdownSavePath: vi.fn(async () => null),
    openDocument: vi.fn(async (path) => payload(path)),
    saveDocument: vi.fn(async () => VERSION_B),
    saveDocumentAs: vi.fn(async (request) => ({ canonicalPath: request.targetPath, version: VERSION_B })),
    writeDraft: vi.fn(async () => { throw new Error("not used"); }),
    listDrafts: vi.fn(async () => []),
    readDraft: vi.fn(async () => { throw new Error("not used"); }),
    deleteDraft: vi.fn(async () => undefined),
    watchDocument: vi.fn(async (canonicalPath) => ({ watchId: "watch", canonicalPath })),
    unwatchDocument: vi.fn(async () => undefined),
    setWindowTitle: vi.fn(async () => undefined),
    recordFirstReadablePaint: vi.fn(async () => 100),
  };
  return {
    host, stopOpen, stopDrop, stopClose,
    emitOpen(paths: string[]) { openListener?.(paths); },
    emitDrop(paths: string[]) { dropListener?.(paths); },
    emitClose() { closeListener?.(); },
    emitFileChanged(event: { watchId: string; canonicalPath: string; kind: "content" | "deleted" | "renamed"; newCanonicalPath: string | null }) { fileChangedListener?.(event); },
  };
}

function dispatchSessionAction(
  controller: ReturnType<typeof createDocumentController>,
  action: SessionAction,
): void {
  (controller as unknown as { dispatch(action: SessionAction): void }).dispatch(action);
}

function controllerState(controller: ReturnType<typeof createDocumentController>): WorkspaceState {
  return (controller as unknown as { state: WorkspaceState }).state;
}

function receiptMessageScopes(controller: ReturnType<typeof createDocumentController>): string[] {
  const messages = (controller as unknown as { messages: Map<string, unknown> }).messages;
  return [...messages.keys()].filter((scope) => scope.startsWith("write-receipt:"));
}

function replaceControllerDocument(
  controller: ReturnType<typeof createDocumentController>,
  tabId: string,
  update: (session: DocumentSession) => DocumentSession,
): DocumentSession {
  const internals = controller as unknown as { state: WorkspaceState };
  let updated: DocumentSession | null = null;
  internals.state = {
    ...internals.state,
    tabs: internals.state.tabs.map((tab) => {
      if (tab.id !== tabId || tab.kind !== "document") return tab;
      updated = update(tab);
      return updated;
    }),
  };
  if (!updated) throw new Error("missing document tab");
  return updated;
}

function attachRejectedSourceBuffer(
  controller: ReturnType<typeof createDocumentController>,
  tabId: string,
  options: { status?: DocumentSession["status"]; bufferText?: string } = {},
): SourceBufferState {
  let attached!: SourceBufferState;
  replaceControllerDocument(controller, tabId, (session) => {
    const bufferText = options.bufferText ?? `${session.candidate.text}\ud800`;
    attached = {
      sessionId: session.id,
      baseCandidateRevision: session.revision,
      baseView: buildSourceView(session.candidate),
      bufferText,
      composedChanges: [{
        from: session.candidate.text.length,
        to: session.candidate.text.length,
        insert: "\ud800",
      }],
      validationError: "unpaired surrogate",
    };
    return {
      ...session,
      mode: "source",
      status: options.status ?? "dirty",
      sourceBuffer: attached,
      viewState: {
        ...session.viewState,
        selection: {
          kind: "text",
          anchorBlockKey: null,
          anchorOffset: bufferText.length,
          focusBlockKey: null,
          focusOffset: bufferText.length,
        },
      },
    };
  });
  return attached;
}

function replaceSourceText(
  controller: ReturnType<typeof createDocumentController>,
  tabId: string,
  expectedRevision: number,
  text: string,
) {
  const view = controller.getSourceView(tabId, expectedRevision)!;
  return controller.applySourceChangeBatch({
    sessionId: tabId,
    baseCandidateRevision: expectedRevision,
    baseView: view,
    changes: [{ from: 0, to: view.text.length, insert: text }],
    bufferText: text,
    selectionAfter: { anchor: text.length, head: text.length },
  });
}

describe("document controller", () => {
  it("writes one debounced recovery draft for an unsaved candidate", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.writeDraft).mockImplementation(async (draft) => ({ ...draft, updatedMs: 123 }));
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.openPaths(["C:\\docs\\draft.md"]);
    const tabId = controller.activeTabId!;
    const tab = controller.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.kind === "document" && controller.setMode(tabId, tab.revision, "source")).toBe("changed");
    replaceSourceText(controller, tabId, tab.kind === "document" ? tab.revision : 0, "# 已编辑");
    expect(controller.tabs.find((candidate) => candidate.id === tabId)?.kind === "document" && (controller.tabs.find((candidate) => candidate.id === tabId) as DocumentSession).candidate.text).toBe("# 已编辑");
    await waitFor(() => expect(fixture.host.writeDraft).toHaveBeenCalledTimes(1), { timeout: 1_500 });
    const payload = vi.mocked(fixture.host.writeDraft).mock.calls[0][0];
    expect(payload.sessionId).toBe(tabId);
    expect(payload.canonicalPath).toBe("C:\\docs\\draft.md");
    expect(payload.bytes).toEqual([...encoder.encode("# 已编辑")]);
    const drafted = controller.tabs.find((candidate): candidate is DocumentSession => candidate.kind === "document" && candidate.id === tabId);
    expect(drafted?.draftId).toBe(payload.id);
  });

  it("stores rejected source UTF-16 units in the recovery payload", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.writeDraft).mockImplementation(async (draft) => ({ ...draft, updatedMs: 123 }));
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.openPaths(["C:\\docs\\invalid.md"]);
    const tabId = controller.activeTabId!;
    const tab = controller.tabs.find((candidate): candidate is DocumentSession => candidate.kind === "document" && candidate.id === tabId)!;
    controller.setMode(tabId, tab.revision, "source");
    expect(replaceSourceText(controller, tabId, tab.revision, "# 坏\uD800")).toMatchObject({ kind: "rejected" });
    await waitFor(() => expect(fixture.host.writeDraft).toHaveBeenCalledTimes(1), { timeout: 1_500 });
    const draft = vi.mocked(fixture.host.writeDraft).mock.calls[0][0];
    expect(draft.rejectedSourceBuffer?.utf16CodeUnitsBase64).toBeDefined();
    expect(draft.bytes).toEqual([...encoder.encode("# 文档")]);
  });

  it("lists and restores a draft without writing the original file", async () => {
    const fixture = hostFixture();
    const draft = {
      id: "00000000-0000-4000-8000-000000000001",
      sessionId: "old-session",
      canonicalPath: "C:\\docs\\draft.md",
      baselineVersion: VERSION_A,
      bytes: [...encoder.encode("# 恢复内容")],
      candidateRevision: 3,
      rejectedSourceBuffer: null,
      updatedMs: 99,
    };
    vi.mocked(fixture.host.listDrafts).mockResolvedValue([draft]);
    vi.mocked(fixture.host.readDraft).mockResolvedValue(draft);
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await waitFor(() => expect(controller.recoveryDrafts).toHaveLength(1));
    await controller.restoreDraft(draft.id);
    const restored = controller.tabs.find((candidate) => candidate.kind === "document");
    expect(restored?.kind === "document" && restored.candidate.text).toBe("# 恢复内容");
    expect(restored?.kind === "document" && restored.status).toBe("dirty");
    expect(controller.recoveryDrafts).toHaveLength(0);
    expect(fixture.host.saveDocument).not.toHaveBeenCalled();
  });

  it("reloads a clean document after a real watcher content event", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.openPaths(["C:\\docs\\watch.md"]);
    const tabId = controller.activeTabId!;
    await waitFor(() => expect((controller.tabs.find((tab) => tab.id === tabId) as DocumentSession).externalChange).toMatchObject({ kind: "checking", watchId: "watch" }));
    vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\watch.md", "# 外部更新"));
    fixture.emitFileChanged({ watchId: "watch", canonicalPath: "C:\\docs\\watch.md", kind: "content", newCanonicalPath: null });
    await waitFor(() => expect((controller.tabs.find((tab) => tab.id === tabId) as DocumentSession).candidate.text).toContain("外部更新"));
    expect((controller.tabs.find((tab) => tab.id === tabId) as DocumentSession).status).toBe("clean");
    controller.dispose();
  });
  it("keeps a take-once startup path through StrictMode replay with one live subscription", async () => {
    const fixture = hostFixture();
    const firstDrain = deferred<void>();
    const initialQueue = ["C:\\docs\\take-once.md"];
    const deliveries: Array<(paths: string[]) => void> = [];
    const live = new Set<number>();
    let nextSubscription = 0;
    vi.mocked(fixture.host.onOpenRequests).mockImplementation(async (listener) => {
      const id = ++nextSubscription;
      deliveries.push(listener);
      live.add(id);
      await firstDrain.promise;
      const paths = initialQueue.splice(0);
      if (paths.length) listener(paths);
      return () => live.delete(id);
    });

    const { unmount } = render(<StrictMode><App host={fixture.host} /></StrictMode>);
    await waitFor(() => expect(fixture.host.onOpenRequests).toHaveBeenCalled());
    firstDrain.resolve();

    expect(await screen.findByRole("tab", { name: /take-once\.md/ })).toBeInTheDocument();
    expect(fixture.host.onOpenRequests).toHaveBeenCalledOnce();
    expect(live.size).toBe(1);
    unmount();
    await waitFor(() => expect(live.size).toBe(0));
    act(() => deliveries[0]?.(["C:\\docs\\late-after-unmount.md"]));
    expect(fixture.host.openDocument).not.toHaveBeenCalledWith("C:\\docs\\late-after-unmount.md");
  });

  it("survives StrictMode effect replay while retiring old subscription generations", async () => {
    const fixture = hostFixture();
    const listeners: Array<(paths: string[]) => void> = [];
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    vi.mocked(fixture.host.onOpenRequests).mockImplementation(async (listener) => {
      listeners.push(listener);
      const stop = vi.fn();
      stops.push(stop);
      listener(["C:\\docs\\strict.md"]);
      return stop;
    });
    const { unmount } = render(<StrictMode><App host={fixture.host} /></StrictMode>);

    expect(await screen.findByRole("tab", { name: /strict\.md/ })).toBeInTheDocument();
    await waitFor(() => expect(fixture.host.onOpenRequests).toHaveBeenCalledOnce());
    expect(stops[0]).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "新建文档" }));
    await userEvent.click(within(screen.getByRole("region", { name: "开始" })).getByRole("button", { name: "新建文档" }));
    expect(await screen.findByRole("tab", { name: /未命名 1/ })).toBeInTheDocument();

    unmount();
    await waitFor(() => expect(stops[0]).toHaveBeenCalledOnce());
    act(() => listeners[0]?.(["C:\\docs\\after-unmount.md"]));
    expect(fixture.host.openDocument).not.toHaveBeenCalledWith("C:\\docs\\after-unmount.md");
  });

  it("sanitizes an early Markdown Core failure, clears the failed cache, and retries New", async () => {
    const fixture = hostFixture();
    const loadCore = vi.fn()
      .mockRejectedValueOnce(new Error("raw dynamic import stack"))
      .mockResolvedValueOnce(sourceDocumentCore);
    const controller = createDocumentController(fixture.host, loadCore);

    await expect(controller.newDocument()).resolves.toBeUndefined();
    expect(controller.tabs).toHaveLength(0);
    expect(controller.persistentMessage).toEqual({ kind: "error", text: "文件操作失败，请重试" });
    await controller.newDocument();
    expect(controller.tabs).toHaveLength(1);
    expect(loadCore).toHaveBeenCalledTimes(2);
  });

  it("starts a new blank document in Rich Text while opened files remain in Reading", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);

    await controller.newDocument();
    expect(controller.tabs[0]).toMatchObject({
      file: { kind: "untitled" },
      mode: "rich",
    });

    await controller.openPaths(["C:\\docs\\existing.md"]);
    expect(controller.tabs[1]).toMatchObject({
      file: { kind: "local", canonicalPath: "C:\\docs\\existing.md" },
      mode: "reading",
    });
  });

  it("sanitizes rejected open/save dialogs and leaves the document retryable", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    vi.mocked(fixture.host.pickMarkdownFiles).mockRejectedValueOnce(new Error("raw open adapter"));
    await expect(controller.openPaths()).resolves.toBeUndefined();
    expect(controller.persistentMessage?.text).toBe("文件操作失败，请重试");
    await controller.newDocument();
    vi.mocked(fixture.host.pickMarkdownSavePath).mockRejectedValueOnce(new Error("raw save adapter"));
    await expect(controller.saveAs()).resolves.toBeUndefined();
    expect(controller.tabs[0]).toMatchObject({ status: "dirty", file: { kind: "untitled" } });
    expect(controller.persistentMessage?.text).toBe("文件操作失败，请重试");
  });

  it.each(["failure-first", "success-first"])(
    "keeps one path's persistent open failure when another path succeeds (%s)",
    async (order) => {
      const fixture = hostFixture();
      const failed = deferred<HostOpenDocument>();
      const succeeded = deferred<HostOpenDocument>();
      vi.mocked(fixture.host.openDocument).mockImplementation((path) =>
        path.endsWith("failed.md") ? failed.promise : succeeded.promise,
      );
      const controller = createDocumentController(fixture.host);

      const opening = controller.openPaths([
        "C:\\docs\\failed.md",
        "C:\\docs\\succeeded.md",
      ]);
      if (order === "failure-first") {
        failed.reject(new DesktopFailureError({
          code: "permission-denied", affectedPaths: [], recoveryPaths: [], draftId: null,
        }));
        await waitFor(() => expect(controller.persistentMessage?.text).toBe("无权访问该文件"));
        succeeded.resolve(payload("C:\\docs\\succeeded.md"));
      } else {
        succeeded.resolve(payload("C:\\docs\\succeeded.md"));
        await waitFor(() => expect(controller.tabs).toHaveLength(1));
        failed.reject(new DesktopFailureError({
          code: "permission-denied", affectedPaths: [], recoveryPaths: [], draftId: null,
        }));
      }
      await opening;

      expect(controller.tabs).toHaveLength(1);
      expect(controller.persistentMessage).toEqual({ kind: "error", text: "无权访问该文件" });
    },
  );

  it("surfaces title failures without letting an unrelated open success clear them", async () => {
    const fixture = hostFixture();
    let titleFails = true;
    vi.mocked(fixture.host.setWindowTitle).mockImplementation(async () => {
      if (titleFails) throw new Error("raw native title failure");
    });
    const controller = createDocumentController(fixture.host);

    await controller.newDocument();
    await waitFor(() => expect(controller.persistentMessage).toEqual({
      kind: "error", text: "文件操作失败，请重试",
    }));
    await controller.openPaths(["C:\\docs\\opened.md"]);
    expect(controller.persistentMessage).toEqual({ kind: "error", text: "文件操作失败，请重试" });

    titleFails = false;
    controller.activate(controller.tabs[0].id);
    await waitFor(() => expect(controller.persistentMessage).toBeNull());
  });

  it("settles the latest desired title after returning to A while the B title write is pending", async () => {
    const fixture = hostFixture();
    const pendingB = deferred<void>();
    vi.mocked(fixture.host.setWindowTitle).mockImplementation((title) =>
      title === "b.md" ? pendingB.promise : Promise.resolve(),
    );
    const controller = createDocumentController(fixture.host);

    await controller.openPaths(["C:\\docs\\a.md"]);
    await waitFor(() => expect(fixture.host.setWindowTitle).toHaveBeenLastCalledWith("a.md"));
    await waitFor(() => expect(
      (controller as unknown as { pendingWindowTitle: string | null }).pendingWindowTitle,
    ).toBeNull());
    const aId = controller.activeTabId!;
    vi.mocked(fixture.host.setWindowTitle).mockClear();
    await controller.openPaths(["C:\\docs\\b.md"]);
    await waitFor(() => expect(fixture.host.setWindowTitle).toHaveBeenLastCalledWith("b.md"));

    controller.activate(aId);
    expect(fixture.host.setWindowTitle).toHaveBeenCalledOnce();
    pendingB.resolve();

    await waitFor(() => expect(fixture.host.setWindowTitle).toHaveBeenLastCalledWith("a.md"));
    expect(vi.mocked(fixture.host.setWindowTitle).mock.calls.map(([title]) => title)).toEqual([
      "b.md",
      "a.md",
    ]);
  });

  it("does not retry one failed title intent for Source selection, viewport, or mode-only dispatches", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.setWindowTitle).mockRejectedValue(new Error("native title failed"));
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\quiet-title.md"]);
    await waitFor(() => expect(controller.persistentMessage).toEqual({
      kind: "error",
      text: "文件操作失败，请重试",
    }));
    const tabId = controller.activeTabId!;
    vi.mocked(fixture.host.setWindowTitle).mockClear();

    controller.setMode(tabId, 0, "source");
    for (let offset = 0; offset < 12; offset += 1) {
      controller.updateSourceSelection(tabId, 0, {
        kind: "text",
        anchorBlockKey: null,
        anchorOffset: offset,
        focusBlockKey: null,
        focusOffset: offset,
      });
      controller.updateSourceViewport(tabId, 0, { blockViewKey: null, offset });
    }

    await Promise.resolve();
    expect(fixture.host.setWindowTitle).not.toHaveBeenCalled();
    expect(controller.persistentMessage).toEqual({
      kind: "error",
      text: "文件操作失败，请重试",
    });
  });

  it("locks one Save As intent before the dialog and ignores overlapping triggers", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    await controller.newDocument();
    const write = deferred<{ canonicalPath: string; version: FileVersion }>();
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\only.md");
    vi.mocked(fixture.host.openDocument).mockRejectedValue(missing("C:\\docs\\only.md"));
    vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => write.promise);

    const first = controller.saveAs();
    const second = controller.saveAs();
    await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());
    expect(fixture.host.pickMarkdownSavePath).toHaveBeenCalledOnce();
    expect(controller.tabs[0]).toMatchObject({ status: "saving", file: { kind: "untitled" } });
    write.resolve({ canonicalPath: "C:\\docs\\only.md", version: VERSION_B });
    await Promise.all([first, second]);
    expect(controller.tabs[0]).toMatchObject({ status: "clean", file: { kind: "local", canonicalPath: "C:\\docs\\only.md" } });
  });

  it.each(["dialog", "target probe"] as const)(
    "blocks ordinary Save while a local Save As %s intent safely aborts after a valid Source edit",
    async (phase) => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\original.md"]);
      const tabId = controller.activeTabId!;
      controller.setMode(tabId, 0, "source");
      const initialView = controller.getSourceView(tabId, 0)!;
      expect(controller.applySourceChangeBatch({
        sessionId: tabId,
        baseCandidateRevision: 0,
        baseView: initialView,
        changes: [{ from: 0, to: initialView.text.length, insert: "B\n" }],
        bufferText: "B\n",
        selectionAfter: { anchor: 1, head: 1 },
      })).toMatchObject({ kind: "accepted", candidateRevision: 1 });

      const dialog = deferred<string | null>();
      const probe = deferred<HostOpenDocument>();
      vi.mocked(fixture.host.pickMarkdownSavePath).mockImplementation(
        phase === "dialog" ? () => dialog.promise : async () => "C:\\docs\\copy.md",
      );
      vi.mocked(fixture.host.openDocument).mockClear();
      vi.mocked(fixture.host.openDocument).mockImplementation(() => probe.promise);

      const saveAs = controller.saveAs(tabId);
      if (phase === "dialog") {
        await waitFor(() => expect(fixture.host.pickMarkdownSavePath).toHaveBeenCalledOnce());
      } else {
        await waitFor(() => expect(fixture.host.openDocument).toHaveBeenCalledOnce());
      }

      const changedView = controller.getSourceView(tabId, 1)!;
      expect(controller.applySourceChangeBatch({
        sessionId: tabId,
        baseCandidateRevision: 1,
        baseView: changedView,
        changes: [{ from: 1, to: 1, insert: "C" }],
        bufferText: "BC\n",
        selectionAfter: { anchor: 2, head: 2 },
      })).toMatchObject({ kind: "accepted", candidateRevision: 2 });
      expect(controller.tabs[0]).toMatchObject({ status: "dirty", candidate: { text: "BC\n" } });

      await controller.save(tabId);
      expect(fixture.host.saveDocument).not.toHaveBeenCalled();

      if (phase === "dialog") dialog.resolve("C:\\docs\\copy.md");
      else probe.reject(missing("C:\\docs\\copy.md"));
      await saveAs;

      expect(fixture.host.saveDocumentAs).not.toHaveBeenCalled();
      expect(fixture.host.openDocument).toHaveBeenCalledTimes(phase === "dialog" ? 0 : 1);
      expect(controller.tabs[0]).toMatchObject({ status: "dirty", candidate: { text: "BC\n" } });

      await controller.save(tabId);
      expect(fixture.host.saveDocument).toHaveBeenCalledOnce();
      expect(controller.tabs[0]).toMatchObject({ status: "clean", candidate: { text: "BC\n" } });
    },
  );

  it("keeps a persistent recovery receipt when Save As finishes after a guarded tab close", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    const write = deferred<{ canonicalPath: string; version: FileVersion }>();
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\written.md");
    vi.mocked(fixture.host.openDocument).mockRejectedValue(missing("C:\\docs\\written.md"));
    vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => write.promise);
    await controller.newDocument();
    const tabId = controller.activeTabId!;

    const saving = controller.saveAs(tabId);
    await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());
    controller.requestClose(tabId);
    expect(controller.tabs).toHaveLength(1);
    write.resolve({ canonicalPath: "C:\\docs\\written.md", version: VERSION_B });
    await saving;

    expect(controller.tabs).toHaveLength(0);
    expect(controller.persistentMessage).toEqual({
      kind: "info",
      text: expect.stringMatching(/written\.md.*(?:恢复|已写入)/),
    });
    await controller.newDocument();
    expect(controller.persistentMessage?.text).toMatch(/written\.md/);
  });

  it("keeps a clean local tab open until an explicit Save As write settles", async () => {
    const fixture = hostFixture();
    const write = deferred<{ canonicalPath: string; version: FileVersion }>();
    vi.mocked(fixture.host.openDocument).mockImplementation(async (path) => {
      if (path.endsWith("copy.md")) throw missing(path);
      return payload(path, "clean\n");
    });
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\copy.md");
    vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => write.promise);
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\clean.md"]);
    const tabId = controller.activeTabId!;
    expect(controller.tabs[0]).toMatchObject({ status: "clean" });

    const saving = controller.saveAs(tabId);
    await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());
    controller.requestClose(tabId);
    expect(controller.tabs).toHaveLength(1);
    expect(fixture.host.closeWindow).not.toHaveBeenCalled();

    write.resolve({ canonicalPath: "C:\\docs\\copy.md", version: VERSION_B });
    await saving;
    await waitFor(() => expect(controller.tabs).toHaveLength(0));
    expect(controllerState(controller).pendingOperations.size).toBe(0);
    expect(controllerState(controller).writeReceipts).toHaveLength(1);
    expect(controller.persistentMessage?.text).toMatch(/copy\.md.*(?:恢复|已写入)/);
  });

  it("preserves a newer valid Source candidate when direct close races a Save As terminal", async () => {
    const fixture = hostFixture();
    const write = deferred<{ canonicalPath: string; version: FileVersion }>();
    vi.mocked(fixture.host.openDocument)
      .mockResolvedValueOnce(payload("C:\\docs\\original.md", "A\n"))
      .mockRejectedValueOnce(missing("C:\\docs\\copy.md"));
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\copy.md");
    vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => write.promise);
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\original.md"]);
    const tabId = controller.activeTabId!;
    controller.setMode(tabId, 0, "source");
    expect(replaceSourceText(controller, tabId, 0, "B\n")).toMatchObject({
      kind: "accepted",
      candidateRevision: 1,
    });

    const saving = controller.saveAs(tabId);
    await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());
    controller.requestClose(tabId);
    expect(replaceSourceText(controller, tabId, 1, "C\n")).toMatchObject({
      kind: "accepted",
      candidateRevision: 2,
    });

    write.resolve({ canonicalPath: "C:\\docs\\copy.md", version: VERSION_B });
    await saving;

    expect(controller.tabs).toHaveLength(1);
    expect(controller.tabs[0]).toMatchObject({
      id: tabId,
      status: "dirty",
      revision: 2,
      candidate: { text: "C\n" },
      file: { kind: "local", canonicalPath: "C:\\docs\\copy.md" },
      sourceBuffer: null,
    });
    expect(controllerState(controller).writeReceipts).toHaveLength(0);
    expect(controller.closePrompt).toEqual({ tabId, exitAfterAll: false });
    expect(fixture.host.closeWindow).not.toHaveBeenCalled();
  });

  it.each(["direct", "native"] as const)(
    "preserves a rejected Source buffer when %s close races a Save As terminal",
    async (route) => {
      const fixture = hostFixture();
      const write = deferred<{ canonicalPath: string; version: FileVersion }>();
      vi.mocked(fixture.host.openDocument)
        .mockResolvedValueOnce(payload("C:\\docs\\original.md", "A\n"))
        .mockRejectedValueOnce(missing("C:\\docs\\copy.md"));
      vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\copy.md");
      vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => write.promise);
      const controller = createDocumentController(fixture.host);
      if (route === "native") await controller.start();
      await controller.openPaths(["C:\\docs\\original.md"]);
      const tabId = controller.activeTabId!;
      controller.setMode(tabId, 0, "source");
      expect(replaceSourceText(controller, tabId, 0, "B\n")).toMatchObject({
        kind: "accepted",
        candidateRevision: 1,
      });

      const saving = controller.saveAs(tabId);
      await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());
      if (route === "direct") controller.requestClose(tabId);
      else act(() => fixture.emitClose());
      const buffer = attachRejectedSourceBuffer(controller, tabId, { status: "saving" });

      write.resolve({ canonicalPath: "C:\\docs\\copy.md", version: VERSION_B });
      await saving;

      expect(controller.tabs).toHaveLength(1);
      expect(controller.tabs[0]).toMatchObject({
        id: tabId,
        status: "dirty",
        candidate: { text: "B\n" },
        file: { kind: "local", canonicalPath: "C:\\docs\\copy.md" },
        sourceBuffer: { bufferText: buffer.bufferText },
      });
      expect(controllerState(controller).writeReceipts).toHaveLength(0);
      expect(controller.closePrompt).toEqual({ tabId, exitAfterAll: route === "native" });
      expect(fixture.host.closeWindow).not.toHaveBeenCalled();
    },
  );

  it("keeps the native close-all window barrier through a clean local Save As write", async () => {
    const fixture = hostFixture();
    const write = deferred<{ canonicalPath: string; version: FileVersion }>();
    vi.mocked(fixture.host.openDocument).mockImplementation(async (path) => {
      if (path.endsWith("copy.md")) throw missing(path);
      return payload(path, "clean\n");
    });
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\copy.md");
    vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => write.promise);
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.openPaths(["C:\\docs\\clean.md"]);
    const tabId = controller.activeTabId!;
    const saving = controller.saveAs(tabId);
    await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());

    act(() => fixture.emitClose());
    expect(controller.tabs).toHaveLength(1);
    expect(fixture.host.closeWindow).not.toHaveBeenCalled();

    write.resolve({ canonicalPath: "C:\\docs\\copy.md", version: VERSION_B });
    await saving;
    await waitFor(() => expect(fixture.host.closeWindow).toHaveBeenCalledOnce());
    expect(controller.tabs).toHaveLength(0);
    expect(controllerState(controller).pendingOperations.size).toBe(0);
  });

  it.each(["tab close", "native close-all"] as const)(
    "keeps the original clean local tab and visible failure after a pending Save As fails during $route",
    async (route) => {
      const fixture = hostFixture();
      const write = deferred<{ canonicalPath: string; version: FileVersion }>();
      vi.mocked(fixture.host.openDocument).mockImplementation(async (path) => {
        if (path.endsWith("copy.md")) throw missing(path);
        return payload(path, "clean\n");
      });
      vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\copy.md");
      vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => write.promise);
      const controller = createDocumentController(fixture.host);
      if (route === "native close-all") await controller.start();
      await controller.openPaths(["C:\\docs\\clean.md"]);
      const tabId = controller.activeTabId!;
      const saving = controller.saveAs(tabId);
      await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());

      if (route === "tab close") controller.requestClose(tabId);
      else act(() => fixture.emitClose());
      write.reject(new Error("copy failed"));
      await saving;

      expect(controller.tabs).toHaveLength(1);
      expect(controller.tabs[0]).toMatchObject({ id: tabId, status: "failed" });
      expect(controller.persistentMessage).toEqual({ kind: "error", text: "文件操作失败，请重试" });
      expect(fixture.host.closeWindow).not.toHaveBeenCalled();
      expect(controller.closing).toBe(false);
      expect(controllerState(controller).pendingOperations.size).toBe(0);
      expect(controllerState(controller).writeReceipts).toHaveLength(0);
    },
  );

  it.each([
    ["drive", "\\\\?\\C:\\docs\\saved.md"],
    ["UNC", "\\\\?\\UNC\\server\\share\\saved.md"],
  ])("keeps the exact %s canonical receipt but projects only a user-readable file name", (_case, canonicalPath) => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    const savedCandidate = sourceDocumentCore.parseSourceDocument(new Uint8Array([...encoder.encode("saved\n")]));
    dispatchSessionAction(controller, {
      type: "begin-operation",
      operation: {
        id: `receipt-${_case}`,
        kind: "save-as",
        sessionId: "closed",
        savedRevision: 3,
        savedCandidate,
        source: { kind: "untitled", displayName: "未命名 1" },
        target: { requestedPath: "C:\\dialog\\saved.md", expectedVersion: null },
      },
    });
    dispatchSessionAction(controller, {
      type: "save-as-succeeded",
      operationId: `receipt-${_case}`,
      canonicalPath,
      version: VERSION_B,
    });

    expect(controllerState(controller).writeReceipts.at(-1)).toMatchObject({ canonicalPath, seen: true });
    expect(controller.persistentMessage?.text).toContain("saved.md");
    expect(controller.persistentMessage?.text).not.toContain("\\\\?\\");
  });

  it("bounds projected detached-write receipts and messages to the newest 50 operations", () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    const savedCandidate = sourceDocumentCore.parseSourceDocument(new Uint8Array([...encoder.encode("saved\n")]));
    for (let index = 0; index < 52; index += 1) {
      const operationId = `receipt-${index}`;
      const canonicalPath = `C:\\recovery\\written-${index}.md`;
      dispatchSessionAction(controller, {
        type: "begin-operation",
        operation: {
          id: operationId,
          kind: "save-as",
          sessionId: "closed",
          savedRevision: index,
          savedCandidate,
          source: { kind: "untitled", displayName: "未命名 1" },
          target: { requestedPath: canonicalPath, expectedVersion: null },
        },
      });
      dispatchSessionAction(controller, {
        type: "save-as-succeeded",
        operationId,
        canonicalPath,
        version: VERSION_B,
      });
    }

    expect(controllerState(controller).writeReceipts).toHaveLength(50);
    expect(controllerState(controller).writeReceipts[0].operationId).toBe("receipt-2");
    expect(receiptMessageScopes(controller)).toHaveLength(50);
    expect(receiptMessageScopes(controller)).not.toContain("write-receipt:receipt-0");
    expect(controller.persistentMessage?.text).toContain("written-51.md");
    const scopes = receiptMessageScopes(controller);
    dispatchSessionAction(controller, { type: "write-receipts-seen", operationIds: ["unknown"] });
    expect(receiptMessageScopes(controller)).toEqual(scopes);
  });

  it("unwatches a registration that finishes after its path-scoped session closes", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\watch.md"]);
    const tabId = controller.activeTabId!;
    dispatchSessionAction(controller, {
      type: "begin-operation",
      operation: { id: "watch-late", kind: "watch", sessionId: tabId, canonicalPath: "C:\\docs\\watch.md" },
    } as never);
    controller.requestClose(tabId);
    dispatchSessionAction(controller, {
      type: "watch-succeeded", operationId: "watch-late", watchId: "native-watch-late",
    });

    await waitFor(() => expect(fixture.host.unwatchDocument).toHaveBeenCalledWith("native-watch-late"));
    await Promise.resolve();
    await controller.newDocument();
    expect(fixture.host.unwatchDocument).toHaveBeenCalledOnce();
  });

  it("keeps failed orphan-watch cleanup pending and visibly retryable without a tight retry loop", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.unwatchDocument).mockRejectedValue(new DesktopFailureError({
      code: "watch-failed", affectedPaths: [], recoveryPaths: [], draftId: null,
    }));
    const controller = createDocumentController(fixture.host);
    dispatchSessionAction(controller, {
      type: "begin-operation",
      operation: { id: "watch-orphan", kind: "watch", sessionId: "closed", canonicalPath: "C:\\docs\\closed.md" },
    } as never);
    dispatchSessionAction(controller, {
      type: "watch-succeeded", operationId: "watch-orphan", watchId: "native-watch-orphan",
    });

    await waitFor(() => expect(controller.persistentMessage).toEqual({
      kind: "error", text: "无法监测文件变化",
    }));
    expect(fixture.host.unwatchDocument).toHaveBeenCalledOnce();
  });

  it("replaces an attached watcher, acknowledges old-watch cleanup, and never unwatches it twice", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\watch.md"]);
    const tabId = controller.activeTabId!;
    for (const [operationId, watchId] of [["watch-old-op", "watch-old"], ["watch-new-op", "watch-new"]]) {
      dispatchSessionAction(controller, {
        type: "begin-operation",
        operation: { id: operationId, kind: "watch", sessionId: tabId, canonicalPath: "C:\\docs\\watch.md" },
      });
      dispatchSessionAction(controller, {
        type: "watch-succeeded", operationId, watchId,
      });
    }

    await waitFor(() => expect(fixture.host.unwatchDocument).toHaveBeenCalledWith("watch-old"));
    await waitFor(() => expect(controllerState(controller).pendingWatchCleanupIds).toHaveLength(0));
    expect(controller.tabs[0]).toMatchObject({
      externalChange: { kind: "checking", watchId: "watch-new" },
    });
    controller.activate(tabId);
    await Promise.resolve();
    expect(vi.mocked(fixture.host.unwatchDocument).mock.calls.filter(([watchId]) => watchId === "watch-old")).toHaveLength(1);
  });

  it("commits interleaved startup/drop opens by operation identity, deduplicates canonical paths, and suppresses late delivery", async () => {
    const fixture = hostFixture();
    const pendingA = deferred<HostOpenDocument>();
    const pendingB = deferred<HostOpenDocument>();
    const pendingLate = deferred<HostOpenDocument>();
    vi.mocked(fixture.host.openDocument).mockImplementation((path) => {
      if (/late/i.test(path)) return pendingLate.promise;
      if (/a\.md/i.test(path)) return pendingA.promise;
      return pendingB.promise;
    });
    const controller = createDocumentController(fixture.host);
    await controller.newDocument();
    const dirty = controller.tabs[0];
    await controller.start();

    act(() => fixture.emitOpen(["C:\\docs\\a.md"]));
    act(() => fixture.emitDrop(["C:\\docs\\b.markdown"]));
    pendingB.resolve(payload("C:\\docs\\b.markdown", "# B"));
    await waitFor(() => expect(controller.tabs).toHaveLength(2));
    pendingA.resolve(payload("C:\\Docs\\A.md", "# A"));
    await waitFor(() => expect(controller.tabs).toHaveLength(3));
    expect(controller.tabs[0]).toBe(dirty);
    expect(controller.tabs[0]).toMatchObject({ status: "dirty", file: { kind: "untitled" } });

    vi.mocked(fixture.host.openDocument).mockResolvedValueOnce(payload("c:\\docs\\a.md", "# duplicate"));
    await controller.openPaths(["c:\\docs\\A.md"]);
    expect(controller.tabs).toHaveLength(3);
    expect(controller.activeTabId).toBe(controller.tabs[2].id);

    const late = controller.openPaths(["C:\\docs\\late.md"]);
    controller.dispose();
    controller.dispose();
    pendingLate.resolve(payload("C:\\docs\\late.md"));
    await late;
    fixture.emitOpen(["C:\\docs\\after.md"]);
    fixture.emitDrop(["C:\\docs\\after.md"]);
    expect(controller.tabs).toHaveLength(3);
    expect(fixture.stopOpen).toHaveBeenCalledOnce();
    expect(fixture.stopDrop).toHaveBeenCalledOnce();
    expect(fixture.stopClose).toHaveBeenCalledOnce();
  });

  it("routes first save through Save As and probes a missing or existing target with the exact expected version", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    await controller.newDocument();
    const firstId = controller.activeTabId!;
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValueOnce("C:\\docs\\new.md");
    vi.mocked(fixture.host.openDocument).mockRejectedValueOnce(missing("C:\\docs\\new.md"));

    await controller.save(firstId);
    expect(fixture.host.saveDocumentAs).toHaveBeenNthCalledWith(1, {
      targetPath: "C:\\docs\\new.md", bytes: [], expectedTargetVersion: null,
    });
    expect(controller.tabs[0]).toMatchObject({
      id: firstId, status: "clean", file: { kind: "local", canonicalPath: "C:\\docs\\new.md", version: VERSION_B },
    });

    await controller.newDocument();
    const secondId = controller.activeTabId!;
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValueOnce("C:\\docs\\existing.md");
    vi.mocked(fixture.host.openDocument).mockResolvedValueOnce({ ...payload("C:\\docs\\existing.md"), version: VERSION_A });
    await controller.saveAs(secondId);
    expect(fixture.host.saveDocumentAs).toHaveBeenNthCalledWith(2, {
      targetPath: "C:\\docs\\existing.md", bytes: [], expectedTargetVersion: VERSION_A,
    });
  });

  it.each([
    [new DesktopFailureError({ code: "permission-denied", affectedPaths: [], recoveryPaths: [], draftId: null }), "无权访问该文件"],
    [new DesktopFailureError({ code: "changed", affectedPaths: [], recoveryPaths: [], draftId: null }), "文件已发生变化"],
    [new DesktopWireError(), "无法读取文件响应"],
    [new Error("raw tauri stack"), "文件操作失败"],
  ])("does not overwrite when Save As target probing fails with %s", async (error, expectedText) => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    await controller.newDocument();
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\target.md");
    vi.mocked(fixture.host.openDocument).mockRejectedValue(error);

    await controller.saveAs();

    expect(fixture.host.saveDocumentAs).not.toHaveBeenCalled();
    expect(controller.tabs[0]).toMatchObject({ status: "dirty", file: { kind: "untitled" } });
    expect(controller.persistentMessage).toEqual({ kind: "error", text: expect.stringContaining(expectedText) });
    expect(controller.persistentMessage?.text).not.toContain("tauri");
  });

  it("queues a native close across clean and multiple dirty tabs without losing failed or cancelled tabs", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.openDocument).mockImplementation(async (path) => {
      if (path.endsWith("clean.md")) return payload(path);
      throw missing(path);
    });
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.openPaths(["C:\\docs\\clean.md"]);
    await controller.newDocument();
    const dirtyA = controller.activeTabId!;
    await controller.newDocument();
    const dirtyB = controller.activeTabId!;
    await controller.newDocument();
    const dirtyC = controller.activeTabId!;
    const saveA = deferred<{ canonicalPath: string; version: FileVersion }>();
    vi.mocked(fixture.host.pickMarkdownSavePath)
      .mockResolvedValueOnce("C:\\docs\\a.md")
      .mockResolvedValueOnce("C:\\docs\\b.md");
    vi.mocked(fixture.host.saveDocumentAs)
      .mockImplementationOnce(() => saveA.promise)
      .mockRejectedValueOnce(new Error("disk full raw detail"));

    act(() => fixture.emitClose());
    expect(controller.tabs.some((tab) => tab.kind === "document" && tab.file.kind === "local" && tab.file.canonicalPath.endsWith("clean.md"))).toBe(false);
    expect(controller.closePrompt).toEqual({ tabId: dirtyA, exitAfterAll: true });
    const resolvingA = controller.resolveClose("save");
    expect(controller.tabs.some((tab) => tab.id === dirtyA)).toBe(true);
    saveA.resolve({ canonicalPath: "C:\\docs\\a.md", version: VERSION_B });
    await resolvingA;
    expect(controller.tabs.some((tab) => tab.id === dirtyA)).toBe(false);
    expect(controller.closePrompt).toEqual({ tabId: dirtyB, exitAfterAll: true });

    await controller.resolveClose("save");
    expect(controller.tabs.some((tab) => tab.id === dirtyB)).toBe(true);
    expect(controller.closePrompt).toEqual({ tabId: dirtyB, exitAfterAll: true });
    await controller.resolveClose("discard");
    expect(controller.tabs.some((tab) => tab.id === dirtyB)).toBe(false);
    expect(controller.closePrompt).toEqual({ tabId: dirtyC, exitAfterAll: true });
    await controller.resolveClose("cancel");
    expect(controller.tabs.some((tab) => tab.id === dirtyC)).toBe(true);
    expect(controller.closePrompt).toBeNull();
    expect(fixture.host.closeWindow).not.toHaveBeenCalled();
  });

  it("upgrades an existing tab-close prompt when the native window close arrives", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.newDocument();
    const first = controller.activeTabId!;
    await controller.newDocument();
    const second = controller.activeTabId!;

    controller.requestClose(first);
    expect(controller.closePrompt).toEqual({ tabId: first, exitAfterAll: false });
    act(() => fixture.emitClose());
    expect(controller.closePrompt).toEqual({ tabId: first, exitAfterAll: true });

    await controller.resolveClose("discard");
    expect(controller.closePrompt).toEqual({ tabId: second, exitAfterAll: true });
    await controller.resolveClose("discard");
    expect(controller.tabs).toHaveLength(0);
    expect(fixture.host.closeWindow).toHaveBeenCalledOnce();
  });

  it("merges a native exit intent into a tab-close save already in flight", async () => {
    const fixture = hostFixture();
    const saved = deferred<{ canonicalPath: string; version: FileVersion }>();
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\first.md");
    vi.mocked(fixture.host.openDocument).mockRejectedValue(missing("C:\\docs\\first.md"));
    vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => saved.promise);
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.newDocument();
    const first = controller.activeTabId!;
    await controller.newDocument();
    const second = controller.activeTabId!;

    controller.requestClose(first);
    const resolving = controller.resolveClose("save");
    await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());
    act(() => fixture.emitClose());
    expect(controller.closePrompt).toEqual({ tabId: first, exitAfterAll: true });
    saved.resolve({ canonicalPath: "C:\\docs\\first.md", version: VERSION_B });
    await resolving;

    expect(controller.tabs.some((tab) => tab.id === first)).toBe(false);
    expect(controller.closePrompt).toEqual({ tabId: second, exitAfterAll: true });
    await controller.resolveClose("discard");
    expect(fixture.host.closeWindow).toHaveBeenCalledOnce();
  });

  it("rescans a dirty tab committed after the native-exit snapshot before closing the window", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.newDocument();
    const first = controller.activeTabId!;

    const creatingSecond = controller.newDocument();
    act(() => fixture.emitClose());
    expect(controller.closePrompt).toEqual({ tabId: first, exitAfterAll: true });
    await creatingSecond;
    const second = controller.activeTabId!;
    expect(second).not.toBe(first);

    await controller.resolveClose("discard");
    expect(fixture.host.closeWindow).not.toHaveBeenCalled();
    expect(controller.closePrompt).toEqual({ tabId: second, exitAfterAll: true });
    await controller.resolveClose("discard");
    expect(fixture.host.closeWindow).toHaveBeenCalledOnce();
  });

  it("waits for a pre-exit admitted open that settles after the last visible tab closes", async () => {
    const fixture = hostFixture();
    const opened = deferred<HostOpenDocument>();
    vi.mocked(fixture.host.openDocument).mockImplementation((path) =>
      path.endsWith("late.md") ? opened.promise : Promise.resolve(payload(path)),
    );
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.newDocument();

    const opening = controller.openPaths(["C:\\docs\\late.md"]);
    await waitFor(() => expect(fixture.host.openDocument).toHaveBeenCalledWith("C:\\docs\\late.md"));
    act(() => fixture.emitClose());
    await controller.resolveClose("discard");
    expect(controller.tabs).toHaveLength(0);
    expect(fixture.host.closeWindow).not.toHaveBeenCalled();

    opened.resolve(payload("C:\\docs\\late.md", "# Late"));
    await opening;
    await waitFor(() => expect(fixture.host.closeWindow).toHaveBeenCalledOnce());
    expect(controller.tabs).toHaveLength(0);
  });

  it.each([
    { route: "second-instance", outcome: "success" },
    { route: "second-instance", outcome: "typed-reject" },
    { route: "file-drop", outcome: "success" },
    { route: "file-drop", outcome: "typed-reject" },
  ] as const)("accepts a $route Host request while closing and releases its barrier on $outcome", async ({ route, outcome }) => {
    const fixture = hostFixture();
    const opened = deferred<HostOpenDocument>();
    vi.mocked(fixture.host.openDocument).mockImplementation(() => opened.promise);
    const controller = createDocumentController(fixture.host);
    await controller.start();
    await controller.newDocument();

    act(() => fixture.emitClose());
    expect(controller.closing).toBe(true);
    const path = route === "second-instance" ? "C:\\docs\\from-instance.md" : "C:\\docs\\from-drop.md";
    act(() => {
      if (route === "second-instance") fixture.emitOpen([path]);
      else fixture.emitDrop([path]);
    });
    await waitFor(() => expect(fixture.host.openDocument).toHaveBeenCalledWith(path));
    await controller.resolveClose("discard");
    expect(fixture.host.closeWindow).not.toHaveBeenCalled();

    if (outcome === "success") {
      opened.resolve(payload(path));
    } else {
      opened.reject(new DesktopFailureError({
        code: "permission-denied", affectedPaths: [path], recoveryPaths: [], draftId: null,
      }));
    }
    await waitFor(() => expect(fixture.host.closeWindow).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(controller.closing).toBe(true);
    controller.requestCloseAll();
    expect(fixture.host.closeWindow).toHaveBeenCalledOnce();
    expect(controller.tabs).toHaveLength(0);
    if (outcome === "typed-reject") {
      expect(controller.persistentMessage).toEqual({ kind: "error", text: "无权访问该文件" });
    }
    controller.dispose();
    expect(controller.closing).toBe(false);
  });

  it("publishes closing truth and restores it after cancel or native-close failure", async () => {
    const cancelFixture = hostFixture();
    const cancelController = createDocumentController(cancelFixture.host);
    await cancelController.newDocument();
    cancelController.requestCloseAll();
    expect(cancelController.closing).toBe(true);
    await cancelController.resolveClose("cancel");
    expect(cancelController.closing).toBe(false);

    const failureFixture = hostFixture();
    const close = deferred<void>();
    vi.mocked(failureFixture.host.closeWindow).mockImplementation(() => close.promise);
    const failureController = createDocumentController(failureFixture.host);
    await failureController.openPaths(["C:\\docs\\clean.md"]);
    failureController.requestCloseAll();
    expect(failureController.closing).toBe(true);
    close.reject(new Error("raw native close failure"));
    await waitFor(() => expect(failureController.closing).toBe(false));
    expect(failureController.persistentMessage).toEqual({
      kind: "error", text: "文件操作失败，请重试",
    });
  });

  it("keeps the native close guard installed when the file-drop subscription rejects", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.onFileDrop).mockRejectedValueOnce(new Error("drop subscription failed"));
    const controller = createDocumentController(fixture.host);

    await controller.start();
    expect(fixture.stopClose).not.toHaveBeenCalled();
    await controller.newDocument();
    const dirtyTabId = controller.activeTabId;

    act(() => fixture.emitClose());

    expect(controller.closePrompt).toEqual({ tabId: dirtyTabId, exitAfterAll: true });
    expect(fixture.host.closeWindow).not.toHaveBeenCalled();
    expect(controller.persistentMessage).toEqual({ kind: "error", text: "文件操作失败，请重试" });
  });

  it("fails closed and refuses dirty work when the native close guard cannot install", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.onWindowCloseRequested).mockRejectedValueOnce(new Error("close guard failed"));
    const controller = createDocumentController(fixture.host);

    await controller.start();

    expect(controller.closing).toBe(true);
    await controller.newDocument();
    await controller.openPaths(["C:\\docs\\unsafe.md"]);
    expect(controller.tabs).toHaveLength(0);
    expect(fixture.host.openDocument).not.toHaveBeenCalled();
    expect(controller.persistentMessage).toEqual({ kind: "error", text: "文件操作失败，请重试" });
  });

  it("re-enters native close and stays armed when an admitted Host open settles after its subscription generation retires", async () => {
    const fixture = hostFixture();
    const opened = deferred<HostOpenDocument>();
    vi.mocked(fixture.host.openDocument).mockImplementation(() => opened.promise);
    vi.mocked(fixture.host.onOpenRequests).mockImplementation(async (listener) => {
      listener(["C:\\docs\\retired.md"]);
      return fixture.stopOpen;
    });
    const controller = createDocumentController(fixture.host);

    await controller.start();
    await waitFor(() => expect(fixture.host.openDocument).toHaveBeenCalledWith("C:\\docs\\retired.md"));
    controller.stop();
    controller.requestCloseAll();
    expect(controller.closing).toBe(true);
    expect(fixture.host.closeWindow).not.toHaveBeenCalled();

    opened.resolve(payload("C:\\docs\\retired.md"));
    await waitFor(() => expect(fixture.host.closeWindow).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(controller.closing).toBe(true);
    controller.requestCloseAll();
    expect(fixture.host.closeWindow).toHaveBeenCalledOnce();
    controller.dispose();
    expect(controller.closing).toBe(false);
  });

  it("restores closing when native close rejects after its subscription generation retires", async () => {
    const fixture = hostFixture();
    const closing = deferred<void>();
    vi.mocked(fixture.host.closeWindow).mockImplementation(() => closing.promise);
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\clean.md"]);

    await controller.start();
    controller.requestCloseAll();
    expect(fixture.host.closeWindow).toHaveBeenCalledOnce();
    expect(controller.closing).toBe(true);

    controller.stop();
    closing.reject(new Error("native close failed"));
    await waitFor(() => expect(controller.closing).toBe(false));
    expect(controller.persistentMessage).toEqual({ kind: "error", text: "文件操作失败，请重试" });
  });

  it("does not publish a late native-close failure after disposal", async () => {
    const fixture = hostFixture();
    const closing = deferred<void>();
    vi.mocked(fixture.host.closeWindow).mockImplementation(() => closing.promise);
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\clean.md"]);

    controller.requestCloseAll();
    expect(fixture.host.closeWindow).toHaveBeenCalledOnce();
    controller.dispose();
    closing.reject(new Error("raw late native close failure"));
    await Promise.resolve();

    expect(controller.persistentMessage).toBeNull();
  });

  describe("Task 4 rejected Source controller gates", () => {
    it("blocks Save before Host write and exposes one stable repair reason", async () => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\source.md"]);
      const tabId = controller.activeTabId!;
      const buffer = attachRejectedSourceBuffer(controller, tabId);

      await controller.save(tabId);

      expect(fixture.host.saveDocument).not.toHaveBeenCalled();
      expect(controller.tabs[0]).toMatchObject({
        id: tabId,
        mode: "source",
        status: "dirty",
        sourceBuffer: { bufferText: buffer.bufferText },
      });
      expect(controller.persistentMessage).toEqual({
        kind: "info",
        text: "修复字符后保存",
      });
    });

    it("blocks Save As before opening the dialog when a rejected buffer already exists", async () => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.newDocument();
      const tabId = controller.activeTabId!;
      attachRejectedSourceBuffer(controller, tabId);

      await controller.saveAs(tabId);

      expect(fixture.host.pickMarkdownSavePath).not.toHaveBeenCalled();
      expect(fixture.host.openDocument).not.toHaveBeenCalled();
      expect(fixture.host.saveDocumentAs).not.toHaveBeenCalled();
    });

    it("rechecks a rejected buffer after the Save As dialog before probing the target", async () => {
      const fixture = hostFixture();
      const selected = deferred<string | null>();
      vi.mocked(fixture.host.pickMarkdownSavePath).mockImplementation(() => selected.promise);
      const controller = createDocumentController(fixture.host);
      await controller.newDocument();
      const tabId = controller.activeTabId!;

      const saving = controller.saveAs(tabId);
      await waitFor(() => expect(fixture.host.pickMarkdownSavePath).toHaveBeenCalledOnce());
      attachRejectedSourceBuffer(controller, tabId, { status: "saving" });
      selected.resolve("C:\\docs\\source.md");
      await saving;

      expect(fixture.host.openDocument).not.toHaveBeenCalled();
      expect(fixture.host.saveDocumentAs).not.toHaveBeenCalled();
    });

    it("rechecks a rejected buffer after target probing before admitting or writing Save As", async () => {
      const fixture = hostFixture();
      const probe = deferred<HostOpenDocument>();
      vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\source.md");
      vi.mocked(fixture.host.openDocument).mockImplementation(() => probe.promise);
      const controller = createDocumentController(fixture.host);
      await controller.newDocument();
      const tabId = controller.activeTabId!;

      const saving = controller.saveAs(tabId);
      await waitFor(() => expect(fixture.host.openDocument).toHaveBeenCalledOnce());
      attachRejectedSourceBuffer(controller, tabId, { status: "saving" });
      probe.reject(missing("C:\\docs\\source.md"));
      await saving;

      expect(fixture.host.saveDocumentAs).not.toHaveBeenCalled();
      expect(controllerState(controller).pendingOperations.size).toBe(0);
    });

    it("rechecks a rejected buffer between Save As operation admission and Host write", async () => {
      const fixture = hostFixture();
      vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\source.md");
      vi.mocked(fixture.host.openDocument).mockRejectedValue(missing("C:\\docs\\source.md"));
      const controller = createDocumentController(fixture.host);
      await controller.newDocument();
      const tabId = controller.activeTabId!;
      const internals = controller as unknown as {
        dispatch(action: SessionAction): void;
      };
      const originalDispatch = internals.dispatch.bind(controller);
      internals.dispatch = (action) => {
        originalDispatch(action);
        if (action.type === "begin-operation" && action.operation.kind === "save-as") {
          attachRejectedSourceBuffer(controller, tabId, { status: "saving" });
        }
      };

      await controller.saveAs(tabId);

      expect(fixture.host.saveDocumentAs).not.toHaveBeenCalled();
      expect(controllerState(controller).pendingOperations.size).toBe(0);
    });

    it("keeps a buffer and dirty truth when Save As completes after rejection during the write", async () => {
      const fixture = hostFixture();
      const write = deferred<{ canonicalPath: string; version: FileVersion }>();
      vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\source.md");
      vi.mocked(fixture.host.openDocument).mockRejectedValue(missing("C:\\docs\\source.md"));
      vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => write.promise);
      const controller = createDocumentController(fixture.host);
      await controller.newDocument();
      const tabId = controller.activeTabId!;

      const saving = controller.saveAs(tabId);
      await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());
      const buffer = attachRejectedSourceBuffer(controller, tabId, { status: "saving" });
      write.resolve({ canonicalPath: "\\\\?\\C:\\docs\\source.md", version: VERSION_B });
      await saving;

      expect(controller.tabs[0]).toMatchObject({
        id: tabId,
        status: "dirty",
        sourceBuffer: { bufferText: buffer.bufferText },
        file: { kind: "local", canonicalPath: "\\\\?\\C:\\docs\\source.md" },
      });
    });

    it("treats a clean candidate with a rejected buffer as unsaved during close", async () => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\source.md"]);
      const tabId = controller.activeTabId!;
      attachRejectedSourceBuffer(controller, tabId, { status: "clean" });

      controller.requestClose(tabId);

      expect(controller.tabs).toHaveLength(1);
      expect(controller.closePrompt).toEqual({ tabId, exitAfterAll: false });
    });

    it("cannot close a rejected buffer through Save and only explicit Discard drops it", async () => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\source.md"]);
      const tabId = controller.activeTabId!;
      attachRejectedSourceBuffer(controller, tabId);
      controller.requestClose(tabId);

      await controller.resolveClose("save");
      expect(fixture.host.saveDocument).not.toHaveBeenCalled();
      expect(controller.tabs).toHaveLength(1);
      expect(controller.closePrompt).toEqual({ tabId, exitAfterAll: false });

      await controller.resolveClose("discard");
      expect(controller.tabs).toHaveLength(0);
    });

    it("returns changed, unchanged, blocked-buffer, and stale mode results without conflation", async () => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\source.md"]);
      const tabId = controller.activeTabId!;
      const setMode = (controller as unknown as {
        setMode?: (id: string, revision: number, mode: string) => string;
      }).setMode?.bind(controller);

      expect(setMode?.(tabId, 0, "source") ?? "missing").toBe("changed");
      expect(setMode?.(tabId, 0, "source")).toBe("unchanged");
      attachRejectedSourceBuffer(controller, tabId);
      expect(setMode?.(tabId, 0, "reading")).toBe("blocked-buffer");
      expect(setMode?.(tabId, 1, "reading")).toBe("stale");
    });

    it("builds each current 102400-byte canonical view once and parses one accepted Source candidate once", async () => {
      const fixture = hostFixture();
      const markdown = buildSizedMarkdown(102_400);
      expect(Buffer.byteLength(markdown)).toBe(102_400);
      vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\large.md", markdown));
      const parse = vi.fn(sourceDocumentCore.parseSourceDocument);
      const build = vi.fn(buildSourceView);
      const cache = new CurrentSourceViewCache(build);
      const createWithCache = createDocumentController as unknown as (
        host: HostApi,
        loadCore: () => Promise<typeof sourceDocumentCore>,
        options: { sourceViewCache: CurrentSourceViewCache },
      ) => ReturnType<typeof createDocumentController>;
      const controller = createWithCache(
        fixture.host,
        async () => ({ ...sourceDocumentCore, parseSourceDocument: parse }),
        { sourceViewCache: cache },
      );
      await controller.openPaths(["C:\\docs\\large.md"]);
      const tabId = controller.activeTabId!;
      const sourceController = controller as unknown as {
        setMode(id: string, revision: number, mode: "source"): string;
        getSourceView(id: string, revision: number): ReturnType<typeof buildSourceView> | null;
        applySourceChangeBatch(batch: SourceChangeBatch): { kind: string; candidateRevision?: number };
        updateSourceSelection(id: string, revision: number, selection: null): void;
        updateSourceViewport(id: string, revision: number, anchor: { blockViewKey: null; offset: number }): void;
      };
      expect(sourceController.setMode(tabId, 0, "source")).toBe("changed");
      parse.mockClear();
      const view = sourceController.getSourceView(tabId, 0)!;
      expect(sourceController.getSourceView(tabId, 0)).not.toBe(view);
      const changes = Array.from({ length: 100 }, (_, index) => ({
        from: index * 1_024,
        to: index * 1_024 + 1,
        insert: "x",
      }));
      const expectedUnits = [...view.text];
      for (const change of changes) expectedUnits[change.from] = change.insert;
      const expectedText = expectedUnits.join("");
      const batch: SourceChangeBatch = {
        sessionId: tabId,
        baseCandidateRevision: 0,
        baseView: view,
        changes,
        bufferText: expectedText,
        selectionAfter: { anchor: expectedText.length, head: expectedText.length },
      };

      expect(sourceController.applySourceChangeBatch(batch)).toMatchObject({
        kind: "accepted",
        candidateRevision: 1,
      });
      expect(build).toHaveBeenCalledTimes(2);
      expect(parse).toHaveBeenCalledOnce();
      const accepted = controller.tabs[0];
      expect(accepted).toMatchObject({ kind: "document", revision: 1 });
      if (accepted.kind !== "document") throw new Error("missing accepted document");
      expect(Buffer.byteLength(accepted.candidate.text)).toBe(102_400);
      expect(accepted.candidate.text).toBe(expectedText);
      expect(accepted.history.past).toHaveLength(1);
      expect(sourceController.getSourceView(tabId, 1)).not.toBeNull();
      expect(build).toHaveBeenCalledTimes(2);
      sourceController.updateSourceSelection(tabId, 1, null);
      sourceController.updateSourceViewport(tabId, 1, { blockViewKey: null, offset: 10 });
      expect(build).toHaveBeenCalledTimes(2);
      expect(parse).toHaveBeenCalledOnce();

      let revision = 1;
      for (let index = 0; index < 52; index += 1) {
        const currentView = sourceController.getSourceView(tabId, revision)!;
        const next = `${currentView.text}x`;
        expect(sourceController.applySourceChangeBatch({
          sessionId: tabId,
          baseCandidateRevision: revision,
          baseView: currentView,
          changes: [{ from: currentView.text.length, to: currentView.text.length, insert: "x" }],
          bufferText: next,
          selectionAfter: { anchor: next.length, head: next.length },
        })).toMatchObject({ kind: "accepted", candidateRevision: revision + 1 });
        revision += 1;
      }
      const afterHistory = controller.tabs[0];
      if (afterHistory.kind !== "document") throw new Error("missing Source document");
      expect(afterHistory.revision).toBe(53);
      expect(afterHistory.history.past.length + afterHistory.history.future.length).toBe(50);
      expect(afterHistory.history.past.every((entry) => !("view" in entry))).toBe(true);
      expect((cache as unknown as { entries: Map<string, unknown> }).entries.size).toBe(1);
      expect(sourceController.getSourceView(tabId, 53)).not.toBeNull();
      expect(build).toHaveBeenCalledTimes(54);
      expect(parse).toHaveBeenCalledTimes(53);
    }, 30_000);

    it("deduplicates native title IPC across Source mode, selection, and viewport dispatches", async () => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\title.md"]);
      await waitFor(() => expect(fixture.host.setWindowTitle).toHaveBeenCalledWith("title.md"));
      vi.mocked(fixture.host.setWindowTitle).mockClear();
      const tabId = controller.activeTabId!;

      expect(controller.setMode(tabId, 0, "source")).toBe("changed");
      controller.updateSourceSelection(tabId, 0, {
        kind: "text", anchorBlockKey: null, anchorOffset: 0,
        focusBlockKey: null, focusOffset: 0,
      });
      controller.updateSourceViewport(tabId, 0, { blockViewKey: null, offset: 0 });
      await Promise.resolve();

      expect(fixture.host.setWindowTitle).not.toHaveBeenCalled();
    });

    it("repairs a rejected Source buffer through the real controller with exact-canonical zero history or different-valid one history entry", async () => {
      const fixture = hostFixture();
      vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\repair.md", "A\n"));
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\repair.md"]);
      const tabId = controller.activeTabId!;
      controller.setMode(tabId, 0, "source");

      const reject = (): ReturnType<typeof controller.applySourceChangeBatch> => {
        const view = controller.getSourceView(tabId, 0)!;
        return controller.applySourceChangeBatch({
          sessionId: tabId,
          baseCandidateRevision: 0,
          baseView: view,
          changes: [{ from: 1, to: 1, insert: "\ud800" }],
          bufferText: "A\ud800\n",
          selectionAfter: { anchor: 2, head: 2 },
        });
      };

      expect(reject()).toMatchObject({ kind: "rejected" });
      const beforeExact = controller.tabs[0];
      if (beforeExact.kind !== "document") throw new Error("missing rejected document");
      expect(beforeExact.sourceBuffer?.bufferText.charCodeAt(1)).toBe(0xd800);
      expect(controller.applySourceChangeBatch({
        sessionId: tabId,
        baseCandidateRevision: 0,
        baseView: controller.getSourceView(tabId, 0)!,
        changes: [],
        bufferText: "A\n",
        selectionAfter: { anchor: 1, head: 1 },
      })).toMatchObject({ kind: "accepted", candidateRevision: 0 });
      const exact = controller.tabs[0];
      if (exact.kind !== "document") throw new Error("missing exact repair document");
      expect(exact.sourceBuffer).toBeNull();
      expect(exact.revision).toBe(0);
      expect(exact.history).toEqual({ past: [], future: [] });
      expect(exact.viewState.selection).toMatchObject({
        kind: "text", anchorBlockKey: null, anchorOffset: 1,
        focusBlockKey: null, focusOffset: 1,
      });

      expect(reject()).toMatchObject({ kind: "rejected" });
      expect(controller.applySourceChangeBatch({
        sessionId: tabId,
        baseCandidateRevision: 0,
        baseView: controller.getSourceView(tabId, 0)!,
        changes: [{ from: 1, to: 1, insert: "B" }],
        bufferText: "AB\n",
        selectionAfter: { anchor: 2, head: 2 },
      })).toMatchObject({ kind: "accepted", candidateRevision: 1 });
      const different = controller.tabs[0];
      if (different.kind !== "document") throw new Error("missing different repair document");
      expect(different.sourceBuffer).toBeNull();
      expect(different.candidate.text).toBe("AB\n");
      expect(different.revision).toBe(1);
      expect(different.history.past).toHaveLength(1);
      expect(different.history.future).toHaveLength(0);
      const originalKey = [...exact.blockViewKeys.values()][0];
      expect(different.viewState.selection).toMatchObject({
        kind: "text", anchorBlockKey: originalKey, anchorOffset: 2,
        focusBlockKey: originalKey, focusOffset: 2,
      });
    });

    it.each(["same-text replacement", "empty ChangeSet"] as const)(
      "accepts an ordinary canonical no-op %s without Core work or history while updating selection",
      async (route) => {
        const fixture = hostFixture();
        vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\no-op.md", "A\n"));
        const parseSourceDocument = vi.fn(sourceDocumentCore.parseSourceDocument);
        const applyDocumentEdit = vi.fn(sourceDocumentCore.applyDocumentEdit);
        const core = { ...sourceDocumentCore, parseSourceDocument, applyDocumentEdit };
        const controller = createDocumentController(fixture.host, async () => core);
        await controller.openPaths(["C:\\docs\\no-op.md"]);
        const tabId = controller.activeTabId!;
        controller.setMode(tabId, 0, "source");
        const view = controller.getSourceView(tabId, 0)!;
        const before = controller.tabs[0] as DocumentSession;
        parseSourceDocument.mockClear();
        applyDocumentEdit.mockClear();

        const ack = controller.applySourceChangeBatch({
          sessionId: tabId,
          baseCandidateRevision: 0,
          baseView: view,
          changes: route === "same-text replacement"
            ? [{ from: 0, to: 1, insert: "A" }]
            : [],
          bufferText: view.text,
          selectionAfter: { anchor: 1, head: 1 },
        });

        expect(ack).toMatchObject({ kind: "accepted", candidateRevision: 0 });
        expect(applyDocumentEdit).not.toHaveBeenCalled();
        expect(parseSourceDocument).not.toHaveBeenCalled();
        const after = controller.tabs[0] as DocumentSession;
        expect(after).toMatchObject({
          candidate: before.candidate,
          baseline: before.baseline,
          blockViewKeys: before.blockViewKeys,
          revision: before.revision,
          history: before.history,
          status: before.status,
          draftId: before.draftId,
          sourceBuffer: null,
          viewState: { selection: {
            kind: "text", anchorBlockKey: null, anchorOffset: 1,
            focusBlockKey: null, focusOffset: 1,
          } },
        });
        if (ack.kind !== "accepted") throw new Error("missing accepted no-op ack");
        expect(ack.view).not.toBe(view);
        expect(ack.view).toEqual(view);
      },
    );

    it("keeps an exact-repaired empty untitled document unsaved while an empty local file remains clean", async () => {
      const fixture = hostFixture();
      vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\empty.md", ""));
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\empty.md"]);
      const localId = controller.activeTabId!;
      controller.requestClose(localId);
      expect(controller.closePrompt).toBeNull();
      expect(controller.tabs).toHaveLength(0);

      await controller.newDocument();
      const untitledId = controller.activeTabId!;
      expect(controller.tabs[0]).toMatchObject({
        file: { kind: "untitled" }, status: "dirty", candidate: { text: "" },
      });
      controller.setMode(untitledId, 0, "source");
      const view = controller.getSourceView(untitledId, 0)!;
      expect(controller.applySourceChangeBatch({
        sessionId: untitledId, baseCandidateRevision: 0, baseView: view,
        changes: [{ from: 0, to: 0, insert: "\ud800" }],
        bufferText: "\ud800", selectionAfter: { anchor: 1, head: 1 },
      })).toMatchObject({ kind: "rejected" });
      expect(controller.applySourceChangeBatch({
        sessionId: untitledId, baseCandidateRevision: 0,
        baseView: controller.getSourceView(untitledId, 0)!,
        changes: [], bufferText: "", selectionAfter: { anchor: 0, head: 0 },
      })).toMatchObject({ kind: "accepted", candidateRevision: 0 });
      expect(controller.tabs[0]).toMatchObject({
        file: { kind: "untitled" }, status: "dirty", sourceBuffer: null,
      });
      controller.requestClose(untitledId);
      expect(controller.closePrompt).toEqual({ tabId: untitledId, exitAfterAll: false });
    });

    it("returns stale when an exact repair dispatch loses the captured rejected-buffer identity", async () => {
      const fixture = hostFixture();
      vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\stale-repair.md", "A\n"));
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\stale-repair.md"]);
      const tabId = controller.activeTabId!;
      controller.setMode(tabId, 0, "source");
      const view = controller.getSourceView(tabId, 0)!;
      expect(controller.applySourceChangeBatch({
        sessionId: tabId, baseCandidateRevision: 0, baseView: view,
        changes: [{ from: 1, to: 1, insert: "\ud800" }],
        bufferText: "A\ud800\n", selectionAfter: { anchor: 2, head: 2 },
      })).toMatchObject({ kind: "rejected" });

      const internals = controller as unknown as { dispatch(action: SessionAction): void };
      const originalDispatch = internals.dispatch.bind(controller);
      internals.dispatch = (action) => {
        if (action.type === "source-buffer-accepted") {
          attachRejectedSourceBuffer(controller, tabId, {
            status: "dirty",
            bufferText: "A\ud800X\n",
          });
        }
        originalDispatch(action);
      };
      const beforeRevision = controller.tabs[0].kind === "document"
        ? controller.tabs[0].revision
        : -1;

      expect(controller.applySourceChangeBatch({
        sessionId: tabId, baseCandidateRevision: 0,
        baseView: controller.getSourceView(tabId, 0)!,
        changes: [], bufferText: "A\n", selectionAfter: { anchor: 1, head: 1 },
      })).toEqual({ kind: "stale" });
      expect(controller.tabs[0]).toMatchObject({
        revision: beforeRevision,
        sourceBuffer: { bufferText: "A\ud800X\n" },
      });
    });

    it("installs direct split selection atomically and keeps the accepted ack view defensive", async () => {
      const fixture = hostFixture();
      vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\split.md", "A\n\nB\n"));
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\split.md"]);
      const tabId = controller.activeTabId!;
      controller.setMode(tabId, 0, "source");
      const view = controller.getSourceView(tabId, 0)!;
      const insert = "A1\n\nA2";
      const bufferText = `${insert}${view.text.slice(1)}`;
      const endpoint = bufferText.indexOf("A2") + 1;

      const ack = controller.applySourceChangeBatch({
        sessionId: tabId,
        baseCandidateRevision: 0,
        baseView: view,
        changes: [{ from: 0, to: 1, insert }],
        bufferText,
        selectionAfter: { anchor: endpoint, head: endpoint },
      });
      expect(ack).toMatchObject({ kind: "accepted", candidateRevision: 1 });
      expect(controller.tabs[0]).toMatchObject({
        revision: 1,
        viewState: { selection: {
          kind: "text", anchorBlockKey: null, anchorOffset: endpoint,
          focusBlockKey: null, focusOffset: endpoint,
        } },
      });
      if (ack.kind !== "accepted") throw new Error("missing accepted split ack");
      ack.view.byteOffsetAtViewOffset[0] = 999;
      ack.view.text = "mutated caller text";
      const canonical = controller.getSourceView(tabId, 1)!;
      expect(canonical.text).toBe(bufferText);
      expect(canonical.byteOffsetAtViewOffset[0]).toBe(0);
    });

    it("fails caller-owned Source view, projection, range, and surrogate-boundary mismatches with zero state mutation", async () => {
      const fixture = hostFixture();
      vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\emoji.md", "A😀\n"));
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\emoji.md"]);
      const tabId = controller.activeTabId!;
      const sourceController = controller as unknown as {
        setMode(id: string, revision: number, mode: "source"): string;
        getSourceView(id: string, revision: number): ReturnType<typeof buildSourceView>;
        applySourceChangeBatch(batch: SourceChangeBatch): { kind: string };
      };
      expect(sourceController.setMode(tabId, 0, "source")).toBe("changed");
      const canonical = sourceController.getSourceView(tabId, 0);
      const batch = (overrides: Partial<SourceChangeBatch>): SourceChangeBatch => ({
        sessionId: tabId,
        baseCandidateRevision: 0,
        baseView: { text: canonical.text, byteOffsetAtViewOffset: canonical.byteOffsetAtViewOffset.slice() },
        changes: [],
        bufferText: canonical.text,
        selectionAfter: { anchor: 0, head: 0 },
        ...overrides,
      });
      const cases = [
        batch({ baseView: { text: `${canonical.text}x`, byteOffsetAtViewOffset: canonical.byteOffsetAtViewOffset.slice() } }),
        (() => {
          const map = canonical.byteOffsetAtViewOffset.slice();
          map[0] += 1;
          return batch({ baseView: { text: canonical.text, byteOffsetAtViewOffset: map } });
        })(),
        batch({ changes: [{ from: 0, to: 1, insert: "B" }], bufferText: "not-the-projection" }),
        batch({
          changes: [{ from: 0, to: 2, insert: "x" }, { from: 1, to: 3, insert: "y" }],
          bufferText: "invalid",
        }),
        batch({ changes: [{ from: 2, to: 2, insert: "x" }], bufferText: "A\ud83dx\ude00\n" }),
      ];

      for (const invalid of cases) {
        const before = controllerState(controller);
        expect(sourceController.applySourceChangeBatch(invalid).kind).toBe("stale");
        expect(controllerState(controller)).toBe(before);
      }
    });

    it("defensively stores rejected batch maps, edits, buffer code units, and selection", async () => {
      const fixture = hostFixture();
      vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\source.md", "A\n"));
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\source.md"]);
      const tabId = controller.activeTabId!;
      const sourceController = controller as unknown as {
        setMode(id: string, revision: number, mode: "source"): string;
        getSourceView(id: string, revision: number): ReturnType<typeof buildSourceView>;
        applySourceChangeBatch(batch: SourceChangeBatch): { kind: string };
      };
      sourceController.setMode(tabId, 0, "source");
      const view = sourceController.getSourceView(tabId, 0);
      const changes = [{ from: 1, to: 1, insert: "\ud800" }];
      const selectionAfter = { anchor: 2, head: 2 };
      const batch: SourceChangeBatch = {
        sessionId: tabId,
        baseCandidateRevision: 0,
        baseView: { text: view.text, byteOffsetAtViewOffset: view.byteOffsetAtViewOffset.slice() },
        changes,
        bufferText: "A\ud800\n",
        selectionAfter,
      };

      expect(sourceController.applySourceChangeBatch(batch).kind).toBe("rejected");
      changes[0].insert = "mutated";
      selectionAfter.anchor = 0;
      batch.baseView.byteOffsetAtViewOffset[0] = 999;
      const stored = controller.tabs[0].kind === "document" ? controller.tabs[0].sourceBuffer : null;
      expect(stored?.bufferText.charCodeAt(1)).toBe(0xd800);
      expect(stored?.composedChanges).toEqual([{ from: 1, to: 1, insert: "\ud800" }]);
      expect(stored?.baseView.byteOffsetAtViewOffset[0]).toBe(0);
      expect(controller.tabs[0]).toMatchObject({
        viewState: { selection: { kind: "text", anchorOffset: 2, focusOffset: 2 } },
      });
    });

    it("rechecks a rejected buffer between ordinary Save admission and Host write", async () => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\source.md"]);
      const tabId = controller.activeTabId!;
      replaceControllerDocument(controller, tabId, (session) => ({ ...session, mode: "source", status: "dirty" }));
      const internals = controller as unknown as { dispatch(action: SessionAction): void };
      const originalDispatch = internals.dispatch.bind(controller);
      internals.dispatch = (action) => {
        originalDispatch(action);
        if (action.type === "begin-operation" && action.operation.kind === "save") {
          attachRejectedSourceBuffer(controller, tabId, { status: "dirty" });
        }
      };

      await controller.save(tabId);

      expect(fixture.host.saveDocument).not.toHaveBeenCalled();
      expect(controllerState(controller).pendingOperations.size).toBe(0);
      expect(controller.tabs[0]).toMatchObject({ status: "dirty", sourceBuffer: { validationError: "unpaired surrogate" } });
    });

    it.each(["exact", "different"] as const)(
      "keeps an in-flight Save locked through %s Source repair until its terminal recomputes truth",
      async (repairKind) => {
        const fixture = hostFixture();
        const write = deferred<FileVersion>();
        vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\saving-repair.md", "A\n"));
        vi.mocked(fixture.host.saveDocument).mockImplementation(() => write.promise);
        const controller = createDocumentController(fixture.host);
        await controller.openPaths(["C:\\docs\\saving-repair.md"]);
        const tabId = controller.activeTabId!;
        controller.setMode(tabId, 0, "source");
        let view = controller.getSourceView(tabId, 0)!;
        expect(controller.applySourceChangeBatch({
          sessionId: tabId, baseCandidateRevision: 0, baseView: view,
          changes: [{ from: 0, to: 1, insert: "B" }], bufferText: "B\n",
          selectionAfter: { anchor: 1, head: 1 },
        })).toMatchObject({ kind: "accepted", candidateRevision: 1 });
        const saving = controller.save(tabId);
        await waitFor(() => expect(fixture.host.saveDocument).toHaveBeenCalledOnce());

        view = controller.getSourceView(tabId, 1)!;
        expect(controller.applySourceChangeBatch({
          sessionId: tabId, baseCandidateRevision: 1, baseView: view,
          changes: [{ from: 1, to: 1, insert: "\ud800" }], bufferText: "B\ud800\n",
          selectionAfter: { anchor: 2, head: 2 },
        })).toMatchObject({ kind: "rejected" });
        const repairText = repairKind === "exact" ? "B\n" : "BC\n";
        expect(controller.applySourceChangeBatch({
          sessionId: tabId, baseCandidateRevision: 1,
          baseView: controller.getSourceView(tabId, 1)!,
          changes: repairKind === "exact" ? [] : [{ from: 1, to: 1, insert: "C" }],
          bufferText: repairText,
          selectionAfter: { anchor: repairKind === "exact" ? 1 : 2, head: repairKind === "exact" ? 1 : 2 },
        })).toMatchObject({
          kind: "accepted",
          candidateRevision: repairKind === "exact" ? 1 : 2,
        });
        expect(controller.tabs[0]).toMatchObject({ status: "saving", sourceBuffer: null });

        await controller.save(tabId);
        await controller.saveAs(tabId);
        expect(fixture.host.saveDocument).toHaveBeenCalledOnce();
        expect(fixture.host.pickMarkdownSavePath).not.toHaveBeenCalled();

        write.resolve(VERSION_B);
        await saving;
        expect(controller.tabs[0]).toMatchObject({
          status: repairKind === "exact" ? "clean" : "dirty",
          candidate: { text: repairText },
          baseline: { text: "B\n" },
        });
      },
    );

    it.each(["edit", "undo", "different repair"] as const)(
      "settles a failed in-flight Save after a newer Source %s without ghost saving",
      async (changeKind) => {
        const fixture = hostFixture();
        const firstWrite = deferred<FileVersion>();
        vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\failed-newer.md", "A\n"));
        vi.mocked(fixture.host.saveDocument)
          .mockImplementationOnce(() => firstWrite.promise)
          .mockResolvedValueOnce(VERSION_B);
        const controller = createDocumentController(fixture.host);
        await controller.openPaths(["C:\\docs\\failed-newer.md"]);
        const tabId = controller.activeTabId!;
        controller.setMode(tabId, 0, "source");
        expect(replaceSourceText(controller, tabId, 0, "B\n")).toMatchObject({
          kind: "accepted",
          candidateRevision: 1,
        });
        const saving = controller.save(tabId);
        await waitFor(() => expect(fixture.host.saveDocument).toHaveBeenCalledOnce());

        if (changeKind === "edit") {
          expect(replaceSourceText(controller, tabId, 1, "C\n")).toMatchObject({
            kind: "accepted",
            candidateRevision: 2,
          });
        } else if (changeKind === "undo") {
          expect(controller.undo(tabId, 1)).toBe(true);
        } else {
          const view = controller.getSourceView(tabId, 1)!;
          expect(controller.applySourceChangeBatch({
            sessionId: tabId,
            baseCandidateRevision: 1,
            baseView: view,
            changes: [{ from: 1, to: 1, insert: "\ud800" }],
            bufferText: "B\ud800\n",
            selectionAfter: { anchor: 2, head: 2 },
          })).toMatchObject({ kind: "rejected" });
          expect(controller.applySourceChangeBatch({
            sessionId: tabId,
            baseCandidateRevision: 1,
            baseView: controller.getSourceView(tabId, 1)!,
            changes: [{ from: 1, to: 1, insert: "C" }],
            bufferText: "BC\n",
            selectionAfter: { anchor: 2, head: 2 },
          })).toMatchObject({ kind: "accepted", candidateRevision: 2 });
        }
        const beforeFailure = controller.tabs[0];
        expect(beforeFailure).toMatchObject({ status: "saving", revision: 2 });

        firstWrite.reject(new Error("disk failure"));
        await saving;

        expect(controllerState(controller).pendingOperations.size).toBe(0);
        expect(controller.tabs[0]).toMatchObject({
          revision: 2,
          status: changeKind === "undo" ? "clean" : "dirty",
          candidate: { text: beforeFailure.kind === "document" ? beforeFailure.candidate.text : "" },
        });
        expect(controller.persistentMessage).toEqual({
          kind: "error",
          text: "文件操作失败，请重试",
        });

        await controller.save(tabId);
        expect(fixture.host.saveDocument).toHaveBeenCalledTimes(changeKind === "undo" ? 1 : 2);
        expect(controller.tabs[0]).toMatchObject({ status: "clean" });
      },
    );

    it("settles a failed Save As write against the newer Source candidate and keeps the original file intent", async () => {
      const fixture = hostFixture();
      const write = deferred<{ canonicalPath: string; version: FileVersion }>();
      vi.mocked(fixture.host.openDocument)
        .mockResolvedValueOnce(payload("C:\\docs\\original.md", "A\n"))
        .mockRejectedValueOnce(missing("C:\\docs\\copy.md"));
      vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\copy.md");
      vi.mocked(fixture.host.saveDocumentAs).mockImplementation(() => write.promise);
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\original.md"]);
      const tabId = controller.activeTabId!;
      controller.setMode(tabId, 0, "source");
      expect(replaceSourceText(controller, tabId, 0, "B\n")).toMatchObject({ candidateRevision: 1 });
      const saving = controller.saveAs(tabId);
      await waitFor(() => expect(fixture.host.saveDocumentAs).toHaveBeenCalledOnce());
      expect(replaceSourceText(controller, tabId, 1, "C\n")).toMatchObject({ candidateRevision: 2 });

      write.reject(new Error("save as failed"));
      await saving;

      expect(controllerState(controller).pendingOperations.size).toBe(0);
      expect(controller.tabs[0]).toMatchObject({
        revision: 2,
        status: "dirty",
        candidate: { text: "C\n" },
        file: { kind: "local", canonicalPath: "C:\\docs\\original.md" },
      });
      await controller.save(tabId);
      expect(fixture.host.saveDocument).toHaveBeenCalledOnce();
      expect(controller.tabs[0]).toMatchObject({ status: "clean" });
    });

    it.each(["target probe", "operation admission"] as const)(
      "keeps a clean local document dirty when Save As %s sees a rejected Source buffer",
      async (phase) => {
        const fixture = hostFixture();
        vi.mocked(fixture.host.openDocument).mockResolvedValueOnce(payload("C:\\docs\\clean.md", "A\n"));
        const controller = createDocumentController(fixture.host);
        await controller.openPaths(["C:\\docs\\clean.md"]);
        const tabId = controller.activeTabId!;
        controller.setMode(tabId, 0, "source");
        vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\copy.md");
        if (phase === "target probe") {
          const probe = deferred<HostOpenDocument>();
          vi.mocked(fixture.host.openDocument).mockImplementation(() => probe.promise);
          const saving = controller.saveAs(tabId);
          await waitFor(() => expect(fixture.host.openDocument).toHaveBeenCalledTimes(2));
          attachRejectedSourceBuffer(controller, tabId, { status: "saving" });
          probe.reject(missing("C:\\docs\\copy.md"));
          await saving;
        } else {
          vi.mocked(fixture.host.openDocument).mockRejectedValue(missing("C:\\docs\\copy.md"));
          const internals = controller as unknown as { dispatch(action: SessionAction): void };
          const originalDispatch = internals.dispatch.bind(controller);
          internals.dispatch = (action) => {
            originalDispatch(action);
            if (action.type === "begin-operation" && action.operation.kind === "save-as") {
              attachRejectedSourceBuffer(controller, tabId, { status: "saving" });
            }
          };
          await controller.saveAs(tabId);
        }

        expect(fixture.host.saveDocumentAs).not.toHaveBeenCalled();
        expect(controllerState(controller).pendingOperations.size).toBe(0);
        expect(controller.tabs[0]).toMatchObject({
          revision: 0,
          status: "dirty",
          candidate: { text: "A\n" },
          baseline: { text: "A\n" },
          sourceBuffer: { validationError: "unpaired surrogate" },
          file: { kind: "local", canonicalPath: "C:\\docs\\clean.md" },
        });
      },
    );

    it("protects a rejected buffer through Close All Save and Cancel until explicit Discard", async () => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\source.md"]);
      const tabId = controller.activeTabId!;
      const buffer = attachRejectedSourceBuffer(controller, tabId, { status: "clean" });

      controller.requestCloseAll();
      expect(controller.closePrompt).toEqual({ tabId, exitAfterAll: true });
      await controller.resolveClose("save");
      expect(fixture.host.saveDocument).not.toHaveBeenCalled();
      expect(controller.closePrompt).toEqual({ tabId, exitAfterAll: true });
      expect(controller.tabs[0]).toMatchObject({ sourceBuffer: { bufferText: buffer.bufferText } });
      await controller.resolveClose("cancel");
      expect(controller.closing).toBe(false);
      expect(controller.tabs).toHaveLength(1);

      controller.requestCloseAll();
      await controller.resolveClose("discard");
      expect(controller.tabs).toHaveLength(0);
      expect(fixture.host.closeWindow).toHaveBeenCalledOnce();
    });

    it.each(["set-mode", "selection", "viewport", "accepted", "rejected"] as const)(
      "projects receipts and drains watcher cleanup exactly once through the new %s dispatch path",
      async (route) => {
        const fixture = hostFixture();
        const controller = createDocumentController(fixture.host);
        vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\source.md", "A\n"));
        await controller.openPaths(["C:\\docs\\source.md"]);
        const tabId = controller.activeTabId!;
        const sourceController = controller as unknown as {
          setMode(id: string, revision: number, mode: "source"): string;
          getSourceView(id: string, revision: number): ReturnType<typeof buildSourceView>;
          applySourceChangeBatch(batch: SourceChangeBatch): { kind: string };
          updateSourceSelection(id: string, revision: number, selection: {
            kind: "text"; anchorBlockKey: null; anchorOffset: number; focusBlockKey: null; focusOffset: number;
          } | null): void;
          updateSourceViewport(id: string, revision: number, anchor: { blockViewKey: null; offset: number }): void;
        };
        if (route !== "set-mode") {
          replaceControllerDocument(controller, tabId, (session) => ({ ...session, mode: "source" }));
        }
        const state = controllerState(controller);
        const operationId = `receipt-${route}`;
        const watchId = `watch-${route}`;
        (controller as unknown as { state: WorkspaceState }).state = {
          ...state,
          writeReceipts: [...state.writeReceipts, {
            operationId,
            kind: "save-as",
            sessionId: tabId,
            canonicalPath: `C:\\recovery\\${route}.md`,
            version: VERSION_B,
            reason: "intent-replaced",
            savedRevision: 0,
            byteLength: 2,
            seen: false,
          }],
          pendingWatchCleanupIds: [watchId],
        };

        if (route === "set-mode") {
          expect(sourceController.setMode(tabId, 0, "source")).toBe("changed");
        } else if (route === "selection") {
          sourceController.updateSourceSelection(tabId, 0, {
            kind: "text", anchorBlockKey: null, anchorOffset: 1,
            focusBlockKey: null, focusOffset: 1,
          });
        } else if (route === "viewport") {
          sourceController.updateSourceViewport(tabId, 0, { blockViewKey: null, offset: 1 });
        } else {
          const view = sourceController.getSourceView(tabId, 0);
          const insert = route === "accepted" ? "B" : "\ud800";
          const text = route === "accepted" ? "B\n" : `A${insert}\n`;
          expect(sourceController.applySourceChangeBatch({
            sessionId: tabId,
            baseCandidateRevision: 0,
            baseView: view,
            changes: [{ from: route === "accepted" ? 0 : 1, to: route === "accepted" ? 1 : 1, insert }],
            bufferText: text,
            selectionAfter: { anchor: 1, head: 1 },
          }).kind).toBe(route);
        }

        await waitFor(() => expect(fixture.host.unwatchDocument).toHaveBeenCalledWith(watchId));
        await waitFor(() => expect(controllerState(controller).pendingWatchCleanupIds).toEqual([]));
        expect(controllerState(controller).writeReceipts.find((receipt) => receipt.operationId === operationId)?.seen).toBe(true);
        expect(controller.persistentMessage?.text).toContain(`${route}.md`);
        controller.activate(tabId);
        await Promise.resolve();
        expect(fixture.host.unwatchDocument).toHaveBeenCalledOnce();
        expect(receiptMessageScopes(controller).filter((scope) => scope.endsWith(operationId))).toHaveLength(1);
      },
    );
  });
});

describe("Task 4 shared document command eligibility", () => {
  it.each([
    ["readonly", "save"], ["readonly", "undo"], ["readonly", "redo"],
    ["conflict", "save"], ["conflict", "undo"], ["conflict", "redo"],
  ] as const)("keeps %s Source %s inert at the controller boundary", async (status, command) => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\protected.md", "A\n"));
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\protected.md"]);
    const tabId = controller.activeTabId!;
    controller.setMode(tabId, 0, "source");
    expect(replaceSourceText(controller, tabId, 0, "B\n")).toMatchObject({ candidateRevision: 1 });
    expect(replaceSourceText(controller, tabId, 1, "C\n")).toMatchObject({ candidateRevision: 2 });
    expect(controller.undo(tabId, 2)).toBe(true);
    replaceControllerDocument(controller, tabId, (session) => ({ ...session, status }));
    const before = controller.tabs[0];
    const beforeState = controllerState(controller);
    const beforeMessages = new Map(
      (controller as unknown as { messages: Map<string, unknown> }).messages,
    );

    if (command === "save") await controller.save(tabId);
    else expect(controller[command](tabId, 3)).toBe(false);

    expect(fixture.host.saveDocument).not.toHaveBeenCalled();
    expect(controller.tabs[0]).toBe(before);
    expect(controllerState(controller)).toBe(beforeState);
    expect(controllerState(controller).pendingOperations.size).toBe(0);
    expect(controllerState(controller).writeReceipts).toBe(beforeState.writeReceipts);
    expect(controllerState(controller).pendingWatchCleanupIds).toBe(beforeState.pendingWatchCleanupIds);
    expect((controller as unknown as { messages: Map<string, unknown> }).messages).toEqual(beforeMessages);
  });

  it.each(["readonly", "conflict"] as const)(
    "rejects a programmatic Source edit while %s without converting the protected status to dirty",
    async (status) => {
      const fixture = hostFixture();
      vi.mocked(fixture.host.openDocument).mockResolvedValue(payload("C:\\docs\\protected.md", "A\n"));
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\protected.md"]);
      const tabId = controller.activeTabId!;
      controller.setMode(tabId, 0, "source");
      replaceControllerDocument(controller, tabId, (session) => ({ ...session, status }));
      const beforeState = controllerState(controller);

      expect(replaceSourceText(controller, tabId, 0, "B\n")).toEqual({ kind: "stale" });
      expect(controllerState(controller)).toBe(beforeState);
      expect(controller.tabs[0]).toMatchObject({ status, revision: 0, candidate: { text: "A\n" } });
    },
  );

  it.each(["readonly", "conflict"] as const)(
    "keeps Save As available as the explicit %s recovery path",
    async (status) => {
      const fixture = hostFixture();
      const controller = createDocumentController(fixture.host);
      await controller.openPaths(["C:\\docs\\protected.md"]);
      const tabId = controller.activeTabId!;
      replaceControllerDocument(controller, tabId, (session) => ({ ...session, status }));

      await controller.saveAs(tabId);

      expect(fixture.host.pickMarkdownSavePath).toHaveBeenCalledWith("protected.md");
      expect(controller.tabs[0]).toMatchObject({ status });
      expect(fixture.host.saveDocumentAs).not.toHaveBeenCalled();
    },
  );

  it("commits a Rich mutation through one revision-scoped controller boundary", async () => {
    const fixture = hostFixture();
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\rich.md"]);
    const tab = controller.tabs[0];
    expect(tab?.kind).toBe("document");
    if (tab?.kind !== "document") return;

    expect(controller.setMode(tab.id, tab.revision, "rich")).toBe("changed");
    const richController = controller as unknown as {
      commitRichEdit?: (request: {
        sessionId: string;
        baseCandidateRevision: number;
        mutations: readonly [{ kind: "replace-block"; blockViewKey: string; markdown: string }];
        selectionAfter: null;
      }) => { kind: string; candidateRevision?: number };
    };
    expect(typeof richController.commitRichEdit).toBe("function");
    const current = controller.tabs[0];
    if (current?.kind !== "document") return;
    const key = current.blockViewKeys.get(current.candidate.blocks[0]!.id)!;
    const ack = richController.commitRichEdit!({
      sessionId: current.id,
      baseCandidateRevision: current.revision,
      mutations: [{ kind: "replace-block", blockViewKey: key, markdown: "# Rich" }],
      selectionAfter: null,
    });

    expect(ack).toMatchObject({ kind: "accepted", candidateRevision: current.revision + 1 });
    const accepted = controller.tabs[0];
    expect(accepted.kind === "document" ? accepted.candidate.text : "").toContain("# Rich");
  });

  it("commits a continuous Rich document range as one revision and one history entry", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.openDocument).mockResolvedValue(payload(
      "C:\\docs\\continuous.md",
      "# First\r\n\r\nSecond\r\n\r\nThird\r\n",
    ));
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\continuous.md"]);
    const opened = controller.tabs[0];
    if (opened?.kind !== "document") throw new Error("missing document");
    controller.setMode(opened.id, opened.revision, "rich");
    const current = controller.tabs[0];
    if (current?.kind !== "document") throw new Error("missing document");
    const firstKey = current.blockViewKeys.get(current.candidate.blocks[0]!.id)!;
    const lastKey = current.blockViewKeys.get(current.candidate.blocks[2]!.id)!;

    const ack = controller.commitRichEdit({
      sessionId: current.id,
      baseCandidateRevision: current.revision,
      mutations: [{
        kind: "replace-range",
        firstBlockViewKey: firstKey,
        lastBlockViewKey: lastKey,
        markdown: "# First\r\n\r\nSecond joined\r\n\r\nNew paragraph",
      }],
      selectionAfter: null,
    } as never);

    expect(ack).toMatchObject({ kind: "accepted", candidateRevision: 1 });
    const accepted = controller.tabs[0];
    expect(accepted).toMatchObject({ revision: 1, history: { past: [{}] } });
    expect(accepted.kind === "document" ? accepted.candidate.text : "").toBe(
      "# First\r\n\r\nSecond joined\r\n\r\nNew paragraph\r\n",
    );
  });

  it("moves one Rich object by stable key as one history entry and keeps an original-position drop exact no-op", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.openDocument).mockResolvedValue(payload(
      "C:\\docs\\move.md",
      "A\r\n\r\n| H |\r\n| --- |\r\n| x |\r\n\r\nB\r\n",
    ));
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\move.md"]);
    const opened = controller.tabs[0];
    if (opened?.kind !== "document") throw new Error("missing document");
    controller.setMode(opened.id, opened.revision, "rich");
    const current = controller.tabs[0];
    if (current?.kind !== "document") throw new Error("missing document");
    const first = current.candidate.blocks[0]!;
    const table = current.candidate.blocks.find((block) => block.kind === "table")!;
    const firstKey = current.blockViewKeys.get(first.id)!;
    const tableKey = current.blockViewKeys.get(table.id)!;

    const moved = controller.commitRichEdit({
      sessionId: current.id,
      baseCandidateRevision: current.revision,
      mutations: [{ kind: "move-block", blockViewKey: tableKey, beforeBlockViewKey: firstKey }],
      selectionAfter: null,
    });

    expect(moved).toEqual({ kind: "accepted", candidateRevision: 1 });
    const accepted = controller.tabs[0];
    if (accepted?.kind !== "document") throw new Error("missing accepted document");
    expect(accepted.candidate.blocks[0]?.kind).toBe("table");
    expect(accepted.candidate.text).toBe("| H |\r\n| --- |\r\n| x |\r\n\r\nA\r\n\r\nB\r\n");
    expect(accepted.history.past).toHaveLength(1);

    const acceptedTable = accepted.candidate.blocks[0]!;
    const acceptedFirst = accepted.candidate.blocks[1]!;
    const noOp = controller.commitRichEdit({
      sessionId: accepted.id,
      baseCandidateRevision: accepted.revision,
      mutations: [{
        kind: "move-block",
        blockViewKey: accepted.blockViewKeys.get(acceptedTable.id)!,
        beforeBlockViewKey: accepted.blockViewKeys.get(acceptedFirst.id)!,
      }],
      selectionAfter: null,
    });
    expect(noOp).toEqual({ kind: "accepted", candidateRevision: 1 });
    expect((controller.tabs[0] as DocumentSession).revision).toBe(1);
    expect((controller.tabs[0] as DocumentSession).history.past).toHaveLength(1);

    expect(controller.commitRichEdit({
      sessionId: accepted.id,
      baseCandidateRevision: accepted.revision,
      mutations: [{ kind: "move-block", blockViewKey: "missing", beforeBlockViewKey: null }],
      selectionAfter: null,
    })).toEqual({ kind: "stale" });
  });

  it("rejects a whole-object move while an explicit file write is pending", async () => {
    const fixture = hostFixture();
    const write = deferred<FileVersion>();
    vi.mocked(fixture.host.openDocument).mockResolvedValue(payload(
      "C:\\docs\\saving-move.md",
      "A\n\n| H |\n| --- |\n| x |\n\nB\n",
    ));
    vi.mocked(fixture.host.saveDocument).mockImplementation(() => write.promise);
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\saving-move.md"]);
    const opened = controller.tabs[0];
    if (opened?.kind !== "document") throw new Error("missing document");
    controller.setMode(opened.id, opened.revision, "rich");
    const current = controller.tabs[0] as DocumentSession;
    const first = current.candidate.blocks[0]!;
    const firstKey = current.blockViewKeys.get(first.id)!;
    expect(controller.commitRichEdit({
      sessionId: current.id,
      baseCandidateRevision: current.revision,
      mutations: [{ kind: "replace-block", blockViewKey: firstKey, markdown: "AA" }],
      selectionAfter: null,
    })).toMatchObject({ kind: "accepted" });

    const dirty = controller.tabs[0] as DocumentSession;
    const save = controller.save(dirty.id);
    await vi.waitFor(() => expect((controller.tabs[0] as DocumentSession).status).toBe("saving"));
    const saving = controller.tabs[0] as DocumentSession;
    const table = saving.candidate.blocks.find((block) => block.kind === "table")!;
    const firstSavingBlock = saving.candidate.blocks[0]!;
    expect(controller.commitRichEdit({
      sessionId: saving.id,
      baseCandidateRevision: saving.revision,
      mutations: [{
        kind: "move-block",
        blockViewKey: saving.blockViewKeys.get(table.id)!,
        beforeBlockViewKey: saving.blockViewKeys.get(firstSavingBlock.id)!,
      }],
      selectionAfter: null,
    })).toEqual({ kind: "stale" });

    write.resolve(VERSION_A);
    await save;
  });

  it("retains invalid Protected Raw input and commits the repaired exact block once", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.openDocument).mockResolvedValue(payload(
      "C:\\docs\\raw.md",
      "<custom-widget>keep</custom-widget>\n\nParagraph\n",
    ));
    const controller = createDocumentController(fixture.host);
    await controller.openPaths(["C:\\docs\\raw.md"]);
    const tab = controller.tabs[0];
    if (tab?.kind !== "document") throw new Error("missing document");
    controller.setMode(tab.id, tab.revision, "rich");
    const current = controller.tabs[0];
    if (current?.kind !== "document") throw new Error("missing document");
    const protectedBlock = current.candidate.blocks.find((block) => block.protected)!;
    const blockViewKey = current.blockViewKeys.get(protectedBlock.id)!;
    const rawController = controller as unknown as {
      beginProtectedRawEdit(id: string, revision: number, key: string): boolean;
      updateProtectedRawBuffer(id: string, revision: number, key: string, text: string): boolean;
      commitProtectedRawEdit(id: string, revision: number, key: string): { kind: string };
    };

    expect(rawController.beginProtectedRawEdit(current.id, current.revision, blockViewKey)).toBe(true);
    expect(rawController.updateProtectedRawBuffer(current.id, current.revision, blockViewKey, "bad\ud800")).toBe(true);
    await controller.save(current.id);
    await controller.saveAs(current.id);
    expect(fixture.host.saveDocument).not.toHaveBeenCalled();
    expect(fixture.host.pickMarkdownSavePath).not.toHaveBeenCalled();
    expect(controller.setMode(current.id, current.revision, "reading")).toBe("blocked-buffer");
    expect(rawController.commitProtectedRawEdit(current.id, current.revision, blockViewKey)).toMatchObject({
      kind: "rejected",
    });
    expect((controller.tabs[0] as DocumentSession).protectedRawBuffer?.bufferText).toBe("bad\ud800");

    expect(rawController.updateProtectedRawBuffer(
      current.id,
      current.revision,
      blockViewKey,
      "<custom-widget>changed</custom-widget>",
    )).toBe(true);
    expect(rawController.commitProtectedRawEdit(current.id, current.revision, blockViewKey)).toMatchObject({
      kind: "accepted",
    });
    const accepted = controller.tabs[0] as DocumentSession;
    expect(accepted.protectedRawBuffer).toBeNull();
    expect(accepted.candidate.text).toContain("<custom-widget>changed</custom-widget>");
    expect(accepted.history.past).toHaveLength(1);
  });

  it("prunes only a discarded tab's Source/save scopes and preserves detached-write receipts", async () => {
    const fixture = hostFixture();
    vi.mocked(fixture.host.saveDocument).mockRejectedValue(new Error("write failed"));
    const controller = createDocumentController(fixture.host);
    const savedCandidate = sourceDocumentCore.parseSourceDocument(new Uint8Array(encoder.encode("saved\n")));
    dispatchSessionAction(controller, {
      type: "begin-operation",
      operation: {
        id: "receipt-kept", kind: "save-as", sessionId: "closed", savedRevision: 1,
        savedCandidate, source: { kind: "untitled", displayName: "未命名 1" },
        target: { requestedPath: "C:\\recovery\\kept.md", expectedVersion: null },
      },
    });
    dispatchSessionAction(controller, {
      type: "save-as-succeeded", operationId: "receipt-kept",
      canonicalPath: "C:\\recovery\\kept.md", version: VERSION_B,
    });
    await controller.openPaths(["C:\\docs\\one.md", "C:\\docs\\two.md"]);
    const liveId = controller.tabs[0].id;
    const discardedId = controller.activeTabId!;

    controller.setMode(liveId, 0, "source");
    expect(replaceSourceText(controller, liveId, 0, "live dirty\n")).toMatchObject({ candidateRevision: 1 });
    await controller.save(liveId);
    controller.setMode(discardedId, 0, "source");
    expect(replaceSourceText(controller, discardedId, 0, "discard dirty\n")).toMatchObject({ candidateRevision: 1 });
    await controller.save(discardedId);
    vi.mocked(fixture.host.pickMarkdownSavePath).mockResolvedValue("C:\\docs\\not-markdown.txt");
    await controller.saveAs(discardedId);
    attachRejectedSourceBuffer(controller, discardedId);

    await controller.save(discardedId);
    const beforeScopes = [...(controller as unknown as { messages: Map<string, unknown> }).messages.keys()];
    expect(beforeScopes).toEqual(expect.arrayContaining([
      `save:${liveId}`,
      `save:${discardedId}`,
      `save-as:${discardedId}`,
      `source-buffer:${discardedId}`,
      "write-receipt:receipt-kept",
    ]));
    controller.requestClose(discardedId);
    await controller.resolveClose("discard");

    expect(controller.tabs).toHaveLength(1);
    const messages = (controller as unknown as { messages: Map<string, { text: string }> }).messages;
    const scopes = [...messages.keys()];
    expect(scopes).toContain("write-receipt:receipt-kept");
    expect(messages.get("write-receipt:receipt-kept")?.text).toContain("kept.md");
    expect(scopes).toContain(`save:${liveId}`);
    expect(scopes).not.toContain(`source-buffer:${discardedId}`);
    expect(scopes).not.toContain(`save:${discardedId}`);
    expect(scopes).not.toContain(`save-as:${discardedId}`);
  });
});

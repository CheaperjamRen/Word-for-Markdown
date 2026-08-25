// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { FileVersion } from "../contracts/desktop";
import type {
  DocumentEditResult,
  SelectionSnapshot,
  SourceBufferState,
  SourceDocument,
  SourceTextEdit,
  SourceViewModel,
} from "../contracts/markdown";
import { applyDocumentEdit, parseSourceDocument } from "../markdown/source-document";
import { buildBlockViewSpans, buildSourceView } from "../markdown/source-view";
import { sourceOffsetForViewportAnchor } from "../source/source-selection";
import type {
  DocumentSession,
  ResourcePreviewSession,
  WorkspaceState,
} from "./session";
import { sessionReducer } from "./session-reducer";

const VERSION: FileVersion = { len: 1, modifiedMs: 10, sha256: "v1" };
const SAVED_VERSION: FileVersion = { len: 2, modifiedMs: 20, sha256: "v2" };

function makeDocumentSession(
  id: string,
  canonicalPath: string,
  text = "A\n\nB\n",
  overrides: Partial<DocumentSession> = {},
): DocumentSession {
  const source = parseSourceDocument(new TextEncoder().encode(text));
  return {
    kind: "document",
    id,
    file: { kind: "local", canonicalPath, version: VERSION },
    baseline: source,
    candidate: source,
    status: "clean",
    mode: "reading",
    revision: 0,
    zoomPercent: 100,
    draftId: null,
    externalChange: null,
    blockViewKeys: new Map(source.blocks.map((block) => [block.id, `${id}:${block.id}`])),
    sourceBuffer: null,
    protectedRawBuffer: null,
    viewState: { scrollAnchor: null, selection: null },
    history: { past: [], future: [] },
    ...overrides,
  };
}

function makeState(...tabs: WorkspaceState["tabs"]): WorkspaceState {
  return {
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    pendingOperations: new Map(),
    writeReceipts: [],
    pendingWatchCleanupIds: [],
  };
}

function documentTab(state: WorkspaceState, id: string): DocumentSession {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab || tab.kind !== "document") throw new Error("missing document tab");
  return tab;
}

function applySourceChanges(
  candidate: SourceDocument,
  view: SourceViewModel,
  changes: readonly SourceTextEdit[],
): DocumentEditResult {
  return applyDocumentEdit(candidate, {
    kind: "source-changes",
    view,
    changes,
  }, {
    sessionId: "test",
    candidateRevision: 0,
    candidate,
    view,
  });
}

function saveOperation(
  session: DocumentSession,
  id = "save-1",
  savedCandidate: SourceDocument = session.candidate,
) {
  if (session.file.kind !== "local") throw new Error("save requires a local document");
  return {
    id,
    kind: "save" as const,
    sessionId: session.id,
    savedRevision: session.revision,
    savedCandidate,
    source: {
      canonicalPath: session.file.canonicalPath,
      expectedVersion: session.file.version,
    },
  };
}

function saveAsOperation(
  session: DocumentSession,
  targetPath: string,
  id = "save-as-1",
  savedCandidate: SourceDocument = session.candidate,
) {
  return {
    id,
    kind: "save-as" as const,
    sessionId: session.id,
    savedRevision: session.revision,
    savedCandidate,
    source: session.file.kind === "local"
      ? {
          kind: "local" as const,
          canonicalPath: session.file.canonicalPath,
          version: session.file.version,
        }
      : { kind: "untitled" as const, displayName: session.file.displayName },
    target: { requestedPath: targetPath, expectedVersion: null },
  };
}

describe("sessionReducer async identity", () => {
  it.each([
    ["untitled", { kind: "untitled", displayName: "未命名 1" } as const],
    ["local", { kind: "local", canonicalPath: "C:\\docs\\old.md", version: VERSION } as const],
  ])("promotes the exact dirty %s candidate after Save As without replacing tab identity", (_case, file) => {
    const original = makeDocumentSession("one", "C:\\docs\\old.md");
    const edit = applyDocumentEdit(original.candidate, {
      kind: "replace-block", blockId: original.candidate.blocks[0].id, markdown: "changed",
    });
    const dirty = { ...original, file, candidate: edit.candidate, revision: 1, status: "dirty" as const };
    const begun = sessionReducer(makeState(dirty), {
      type: "begin-operation",
      operation: saveAsOperation(dirty, "C:\\docs\\new.md") as never,
    });

    const state = sessionReducer(begun, {
      type: "save-as-succeeded", operationId: "save-as-1", canonicalPath: "C:\\docs\\new.md", version: SAVED_VERSION,
    } as never);

    const saved = documentTab(state, "one");
    expect(saved.id).toBe("one");
    expect(saved.file).toEqual({ kind: "local", canonicalPath: "C:\\docs\\new.md", version: SAVED_VERSION });
    expect(saved.baseline).not.toBe(dirty.candidate);
    expect(saved.baseline.bytes).toEqual(dirty.candidate.bytes);
    expect(saved.candidate).toBe(dirty.candidate);
    expect(saved.status).toBe("clean");
    expect(saved.viewState).toBe(dirty.viewState);
    expect(state.pendingOperations.has("save-as-1")).toBe(false);
  });

  it.each([
    ["drive namespace", "C:\\docs\\saved.md", "\\\\?\\C:\\docs\\saved.md"],
    ["UNC namespace", "\\\\server\\share\\saved.md", "\\\\?\\UNC\\server\\share\\saved.md"],
    ["junction target", "C:\\alias\\saved.md", "\\\\?\\D:\\physical\\saved.md"],
  ])("accepts the Host-authoritative %s canonical Save As path", (_case, requestedPath, canonicalPath) => {
    const session = makeDocumentSession("one", "C:\\docs\\old.md", "saved bytes\n", {
      file: { kind: "untitled", displayName: "未命名 1" },
      status: "saving",
    });
    let state = sessionReducer(makeState(session), {
      type: "begin-operation",
      operation: saveAsOperation(session, requestedPath, `save-as-${_case}`) as never,
    });

    state = sessionReducer(state, {
      type: "save-as-succeeded",
      operationId: `save-as-${_case}`,
      canonicalPath,
      version: SAVED_VERSION,
    });

    const saved = documentTab(state, "one");
    expect(saved.file).toEqual({ kind: "local", canonicalPath, version: SAVED_VERSION });
    expect(saved.baseline.bytes).toEqual(session.candidate.bytes);
    expect(saved.candidate).toBe(session.candidate);
    expect(saved.status).toBe("clean");
    expect(state.writeReceipts).toHaveLength(0);
    expect(state.pendingOperations.has(`save-as-${_case}`)).toBe(false);
  });

  it("promotes the exact Save As bytes after Undo while keeping the current candidate dirty", () => {
    const original = makeDocumentSession("one", "C:\\docs\\old.md", "A\n", {
      file: { kind: "untitled", displayName: "未命名 1" },
      status: "dirty",
    });
    const edit = applyDocumentEdit(original.candidate, {
      kind: "replace-block", blockId: original.candidate.blocks[0].id, markdown: "B",
    });
    let state = sessionReducer(makeState(original), {
      type: "edit-applied", sessionId: "one", expectedRevision: 0, result: edit, selectionAfter: null,
    });
    const savedCandidate = documentTab(state, "one").candidate;
    state = sessionReducer(state, {
      type: "begin-operation",
      operation: saveAsOperation(documentTab(state, "one"), "C:\\docs\\saved.md", "save-as-undo") as never,
    });
    state = sessionReducer(state, {
      type: "history-undo", sessionId: "one", expectedRevision: 1,
    });
    expect(documentTab(state, "one").candidate.text).toBe("A\n");
    expect(documentTab(state, "one").status).toBe("dirty");

    state = sessionReducer(state, {
      type: "save-as-succeeded",
      operationId: "save-as-undo",
      canonicalPath: "C:\\docs\\saved.md",
      version: SAVED_VERSION,
    });

    const saved = documentTab(state, "one");
    expect(saved.file).toEqual({ kind: "local", canonicalPath: "C:\\docs\\saved.md", version: SAVED_VERSION });
    expect(saved.baseline.bytes).toEqual(savedCandidate.bytes);
    expect(saved.candidate.text).toBe("A\n");
    expect(saved.status).toBe("dirty");
    expect(state.pendingOperations.has("save-as-undo")).toBe(false);
  });

  it.each([
    ["session-closed", true],
    ["intent-replaced", false],
  ] as const)("retains a persistent Save As written-target receipt when the %s intent is gone", (reason, close) => {
    const original = makeDocumentSession("one", "C:\\docs\\old.md", "A\n", { status: "dirty" });
    let state = sessionReducer(makeState(original), {
      type: "begin-operation",
      operation: saveAsOperation(original, "C:\\docs\\written.md", "save-as-detached") as never,
    });
    state = close
      ? sessionReducer(state, { type: "close-tab", tabId: "one" })
      : {
          ...state,
          tabs: [{
            ...original,
            file: { kind: "local" as const, canonicalPath: "C:\\docs\\replacement.md", version: SAVED_VERSION },
          }],
        };

    state = sessionReducer(state, {
      type: "save-as-succeeded",
      operationId: "save-as-detached",
      canonicalPath: "C:\\docs\\written.md",
      version: SAVED_VERSION,
    });

    expect(state.pendingOperations.has("save-as-detached")).toBe(false);
    expect(state.writeReceipts).toEqual([{
      operationId: "save-as-detached",
      kind: "save-as",
      sessionId: "one",
      canonicalPath: "C:\\docs\\written.md",
      version: SAVED_VERSION,
      reason,
      savedRevision: 0,
      byteLength: original.candidate.bytes.length,
      seen: false,
    }]);
  });

  it("retains only the newest 50 seen write receipts without dropping the latest recovery fact", () => {
    const template = makeDocumentSession("closed", "C:\\docs\\source.md", "bytes\n", { status: "dirty" });
    let state = makeState();
    for (let index = 0; index < 52; index += 1) {
      const operationId = `receipt-${index}`;
      const canonicalPath = `C:\\recovery\\written-${index}.md`;
      state = sessionReducer(state, {
        type: "begin-operation",
        operation: saveAsOperation(template, canonicalPath, operationId) as never,
      });
      state = sessionReducer(state, {
        type: "save-as-succeeded",
        operationId,
        canonicalPath,
        version: SAVED_VERSION,
      });
      state = sessionReducer(state, {
        type: "write-receipts-seen",
        operationIds: [operationId],
      });
    }

    expect(state.writeReceipts).toHaveLength(50);
    expect(state.writeReceipts[0].operationId).toBe("receipt-2");
    expect(state.writeReceipts.at(-1)).toMatchObject({
      operationId: "receipt-51",
      canonicalPath: "C:\\recovery\\written-51.md",
      seen: true,
    });
    expect(sessionReducer(state, {
      type: "write-receipts-seen",
      operationIds: ["unknown"],
    })).toBe(state);
  });

  it("ignores unknown and wrong-kind completion ids without consuming another operation", () => {
    const session = makeDocumentSession("one", "C:\\docs\\one.md");
    const begun = sessionReducer(makeState(session), {
      type: "begin-operation",
      operation: { id: "draft-1", kind: "draft", sessionId: "one", candidateRevision: 0 },
    });

    const unknown = sessionReducer(begun, {
      type: "draft-succeeded", operationId: "unknown", draftId: "draft-x",
    });
    const wrongKind = sessionReducer(unknown, {
      type: "watch-succeeded", operationId: "draft-1", watchId: "watch-x",
    });

    expect(wrongKind).toBe(unknown);
    expect(wrongKind.pendingOperations.has("draft-1")).toBe(true);
    expect(documentTab(wrongKind, "one").draftId).toBeNull();
    expect(documentTab(wrongKind, "one").externalChange).toBeNull();
  });

  it("consumes recognized terminals, keeps drafts revision-scoped, and keeps watchers path-scoped", () => {
    const source = makeDocumentSession("one", "C:\\docs\\one.md", "A\n", {
      revision: 2,
      status: "dirty",
    });
    let state = makeState(source);
    for (const operation of [
      { id: "draft-stale", kind: "draft" as const, sessionId: "one", candidateRevision: 1 },
      { id: "watch-stale-revision", kind: "watch" as const, sessionId: "one", canonicalPath: "C:\\docs\\ONE.md" },
      {
        ...saveOperation(source, "save-other"),
        sessionId: "other",
      },
    ]) {
      state = sessionReducer(state, { type: "begin-operation", operation: operation as never });
    }

    state = sessionReducer(state, {
      type: "draft-succeeded", operationId: "draft-stale", draftId: "stale-draft",
    });
    expect(state.pendingOperations.has("draft-stale")).toBe(false);
    expect(documentTab(state, "one").draftId).toBeNull();
    state = sessionReducer(state, {
      type: "watch-succeeded", operationId: "watch-stale-revision", watchId: "watch-2",
    });
    expect(state.pendingOperations.has("watch-stale-revision")).toBe(false);
    expect(documentTab(state, "one").externalChange).toEqual({ kind: "checking", watchId: "watch-2" });
    state = sessionReducer(state, {
      type: "save-succeeded", operationId: "save-other", version: SAVED_VERSION,
    });
    expect(state.pendingOperations.has("save-other")).toBe(false);
    expect(state.writeReceipts.at(-1)).toMatchObject({
      operationId: "save-other", canonicalPath: "C:\\docs\\one.md", reason: "session-closed",
    });
  });

  it("consumes stale or closed draft/watch terminals and queues every unadopted watch for cleanup", () => {
    const session = makeDocumentSession("one", "C:\\docs\\one.md", "A\n", { revision: 2 });
    let state = makeState(session);
    state = sessionReducer(state, {
      type: "begin-operation",
      operation: { id: "draft-stale", kind: "draft", sessionId: "one", candidateRevision: 1 },
    });
    state = sessionReducer(state, {
      type: "begin-operation",
      operation: { id: "watch-other", kind: "watch", sessionId: "other", canonicalPath: "C:\\docs\\other.md" } as never,
    });
    state = sessionReducer(state, {
      type: "draft-succeeded", operationId: "draft-stale", draftId: "stale",
    });
    expect(state.pendingOperations.has("draft-stale")).toBe(false);
    expect(documentTab(state, "one").draftId).toBeNull();
    state = sessionReducer(state, {
      type: "watch-succeeded", operationId: "watch-other", watchId: "orphan-watch",
    });
    expect(state.pendingOperations.has("watch-other")).toBe(false);
    expect(state.pendingWatchCleanupIds).toEqual(["orphan-watch"]);
    expect(documentTab(state, "one").externalChange).toBeNull();
  });

  it("replaces an attached watcher and queues the old id exactly once", () => {
    const session = makeDocumentSession("one", "C:\\docs\\one.md", "A\n", {
      externalChange: { kind: "checking", watchId: "watch-old" },
    });
    let state = sessionReducer(makeState(session), {
      type: "begin-operation",
      operation: { id: "watch-replacement", kind: "watch", sessionId: "one", canonicalPath: "C:\\DOCS\\ONE.md" },
    } as never);
    state = sessionReducer(state, {
      type: "watch-succeeded", operationId: "watch-replacement", watchId: "watch-new",
    });

    expect(documentTab(state, "one").externalChange).toEqual({ kind: "checking", watchId: "watch-new" });
    expect(state.pendingWatchCleanupIds).toEqual(["watch-old"]);
    const afterReplacement = state;
    state = sessionReducer(state, {
      type: "watch-succeeded", operationId: "watch-replacement", watchId: "watch-new",
    });
    expect(state).toBe(afterReplacement);
    expect(state.pendingWatchCleanupIds).toEqual(["watch-old"]);
  });

  it("promotes the bytes actually written when Save(B) resolves after Undo restored A", () => {
    const original = makeDocumentSession("one", "C:\\docs\\one.md", "A\n");
    const edit = applyDocumentEdit(original.candidate, {
      kind: "replace-block", blockId: original.candidate.blocks[0].id, markdown: "B",
    });
    let state = sessionReducer(makeState(original), {
      type: "edit-applied", sessionId: "one", expectedRevision: 0, result: edit, selectionAfter: null,
    });
    const savedCandidate = documentTab(state, "one").candidate;
    state = sessionReducer(state, {
      type: "begin-operation", operation: saveOperation(documentTab(state, "one"), "save-undo") as never,
    });
    state = sessionReducer(state, {
      type: "history-undo", sessionId: "one", expectedRevision: 1,
    });
    expect(documentTab(state, "one")).toMatchObject({ revision: 2, status: "clean" });

    state = sessionReducer(state, {
      type: "save-succeeded", operationId: "save-undo", version: SAVED_VERSION,
    });

    const saved = documentTab(state, "one");
    expect(saved.file).toEqual({ kind: "local", canonicalPath: "C:\\docs\\one.md", version: SAVED_VERSION });
    expect(saved.baseline.bytes).toEqual(savedCandidate.bytes);
    expect(saved.baseline.text).toBe("B\n");
    expect(saved.candidate.text).toBe("A\n");
    expect(saved.status).toBe("dirty");
    expect(state.pendingOperations.has("save-undo")).toBe(false);
  });

  it("keeps Source Undo and Redo visibly saving until the admitted write reaches a terminal state", () => {
    const original = makeDocumentSession("source", "C:\\docs\\source.md", "A\n", {
      mode: "source",
    });
    const editB = applyDocumentEdit(original.candidate, {
      kind: "replace-block",
      blockId: original.candidate.blocks[0].id,
      markdown: "B",
    });
    let state = sessionReducer(makeState(original), {
      type: "edit-applied",
      sessionId: original.id,
      expectedRevision: 0,
      result: editB,
      selectionAfter: null,
    });
    const afterB = documentTab(state, original.id);
    const editC = applyDocumentEdit(afterB.candidate, {
      kind: "replace-block",
      blockId: afterB.candidate.blocks[0].id,
      markdown: "C",
    });
    state = sessionReducer(state, {
      type: "edit-applied",
      sessionId: original.id,
      expectedRevision: 1,
      result: editC,
      selectionAfter: null,
    });
    const savedCandidate = documentTab(state, original.id).candidate;
    state = sessionReducer(state, {
      type: "begin-operation",
      operation: saveOperation(documentTab(state, original.id), "source-save-history", savedCandidate) as never,
    });
    state = {
      ...state,
      tabs: state.tabs.map((tab) => tab.id === original.id ? { ...tab, status: "saving" as const } : tab),
    };

    state = sessionReducer(state, {
      type: "history-undo",
      sessionId: original.id,
      expectedRevision: 2,
    });
    expect(documentTab(state, original.id)).toMatchObject({
      revision: 3,
      status: "saving",
      candidate: { text: "B\n" },
    });

    state = sessionReducer(state, {
      type: "history-redo",
      sessionId: original.id,
      expectedRevision: 3,
    });
    expect(documentTab(state, original.id)).toMatchObject({
      revision: 4,
      status: "saving",
      candidate: { text: "C\n" },
    });

    state = sessionReducer(state, {
      type: "history-undo",
      sessionId: original.id,
      expectedRevision: 4,
    });
    state = sessionReducer(state, {
      type: "save-succeeded",
      operationId: "source-save-history",
      version: SAVED_VERSION,
    });
    expect(documentTab(state, original.id)).toMatchObject({
      status: "dirty",
      baseline: { text: "C\n" },
      candidate: { text: "B\n" },
    });
  });

  it("merges later edits in one Source history group into the original snapshot", () => {
    const original = makeDocumentSession("source-group", "C:\\docs\\source-group.md", "A\n", {
      mode: "source",
    });
    const editB = applyDocumentEdit(original.candidate, {
      kind: "replace-block",
      blockId: original.candidate.blocks[0].id,
      markdown: "B",
    });
    let state = sessionReducer(makeState(original), {
      type: "edit-applied",
      sessionId: original.id,
      expectedRevision: 0,
      result: editB,
      selectionAfter: null,
      historyMode: "append",
    } as never);
    const afterB = documentTab(state, original.id);
    const editC = applyDocumentEdit(afterB.candidate, {
      kind: "replace-block",
      blockId: afterB.candidate.blocks[0].id,
      markdown: "C",
    });
    state = sessionReducer(state, {
      type: "edit-applied",
      sessionId: original.id,
      expectedRevision: 1,
      result: editC,
      selectionAfter: null,
      historyMode: "merge",
    } as never);

    expect(documentTab(state, original.id).history.past).toHaveLength(1);
    state = sessionReducer(state, {
      type: "history-undo",
      sessionId: original.id,
      expectedRevision: 2,
    });
    expect(documentTab(state, original.id).candidate.text).toBe("A\n");
    state = sessionReducer(state, {
      type: "history-redo",
      sessionId: original.id,
      expectedRevision: 3,
    });
    expect(documentTab(state, original.id).candidate.text).toBe("C\n");
  });

  it("keeps a branch edit C dirty against the exact saved B baseline", () => {
    const original = makeDocumentSession("one", "C:\\docs\\branch.md", "A\n");
    const editB = applyDocumentEdit(original.candidate, {
      kind: "replace-block", blockId: original.candidate.blocks[0].id, markdown: "B",
    });
    let state = sessionReducer(makeState(original), {
      type: "edit-applied", sessionId: "one", expectedRevision: 0, result: editB, selectionAfter: null,
    });
    state = sessionReducer(state, {
      type: "begin-operation", operation: saveOperation(documentTab(state, "one"), "save-branch") as never,
    });
    state = sessionReducer(state, {
      type: "history-undo", sessionId: "one", expectedRevision: 1,
    });
    const undone = documentTab(state, "one");
    const editC = applyDocumentEdit(undone.candidate, {
      kind: "replace-block", blockId: undone.candidate.blocks[0].id, markdown: "C",
    });
    state = sessionReducer(state, {
      type: "edit-applied", sessionId: "one", expectedRevision: 2, result: editC, selectionAfter: null,
    });
    state = sessionReducer(state, {
      type: "save-succeeded", operationId: "save-branch", version: SAVED_VERSION,
    });

    const saved = documentTab(state, "one");
    expect(saved.baseline.text).toBe("B\n");
    expect(saved.candidate.text).toBe("C\n");
    expect(saved.status).toBe("dirty");
    expect(saved.history.future).toHaveLength(0);
    expect(state.pendingOperations.has("save-branch")).toBe(false);
  });

  it("records rather than applies a save completion after the source path or version intent is replaced", () => {
    const original = makeDocumentSession("one", "C:\\docs\\one.md", "B\n", { status: "dirty", revision: 4 });
    let state = sessionReducer(makeState(original), {
      type: "begin-operation", operation: saveOperation(original, "save-replaced") as never,
    });
    const replacementVersion = { len: 99, modifiedMs: 99, sha256: "newer" };
    state = {
      ...state,
      tabs: [{
        ...original,
        file: { kind: "local", canonicalPath: "C:\\docs\\one.md", version: replacementVersion },
      }],
    };

    state = sessionReducer(state, {
      type: "save-succeeded", operationId: "save-replaced", version: SAVED_VERSION,
    });

    expect(documentTab(state, "one").file).toEqual({
      kind: "local", canonicalPath: "C:\\docs\\one.md", version: replacementVersion,
    });
    expect(documentTab(state, "one").baseline).toBe(original.baseline);
    expect(state.writeReceipts.at(-1)).toMatchObject({
      operationId: "save-replaced",
      canonicalPath: "C:\\docs\\one.md",
      reason: "intent-replaced",
      savedRevision: 4,
      byteLength: original.candidate.bytes.length,
    });
    expect(state.pendingOperations.has("save-replaced")).toBe(false);
  });

  it("promotes the exact captured candidate on an immediate save success", () => {
    const baseline = makeDocumentSession("one", "C:\\docs\\one.md");
    const edit = applyDocumentEdit(baseline.candidate, {
      kind: "replace-block", blockId: baseline.candidate.blocks[0].id, markdown: "changed",
    });
    let state = sessionReducer(makeState(baseline), {
      type: "edit-applied", sessionId: "one", expectedRevision: 0, result: edit, selectionAfter: null,
    });
    state = sessionReducer(state, {
      type: "begin-operation",
      operation: saveOperation(documentTab(state, "one")) as never,
    });
    state = sessionReducer(state, {
      type: "save-succeeded", operationId: "save-1", version: SAVED_VERSION,
    });

    const saved = documentTab(state, "one");
    expect(saved.baseline).not.toBe(saved.candidate);
    expect(saved.baseline.bytes).toEqual(saved.candidate.bytes);
    expect(saved.status).toBe("clean");
    expect(saved.file).toEqual({ kind: "local", canonicalPath: "C:\\docs\\one.md", version: SAVED_VERSION });
  });
});

describe("sessionReducer source buffers and stable block keys", () => {
  it("keeps rejected buffers session/revision scoped and prevents ordinary edits or stale repair text", () => {
    const one = makeDocumentSession("one", "C:\\docs\\one.md", "A\n\nB\n", {
      mode: "source",
    });
    const two = makeDocumentSession("two", "C:\\docs\\two.md");
    const baseView = buildSourceView(one.candidate);
    const buffer: SourceBufferState = {
      sessionId: "one",
      baseCandidateRevision: 0,
      baseView,
      bufferText: "broken",
      composedChanges: [{ from: 0, to: 1, insert: "broken" }],
      validationError: "invalid source",
    };
    let state = sessionReducer(makeState(one, two), {
      type: "source-buffer-rejected", sessionId: "one", expectedRevision: 0, buffer,
      selectionAfter: { kind: "text", anchorBlockKey: null, anchorOffset: 0, focusBlockKey: null, focusOffset: 0 },
    });
    state = sessionReducer(state, { type: "activate-tab", tabId: "two" });
    expect(documentTab(state, "one").sourceBuffer).toEqual(buffer);
    expect(documentTab(state, "one").sourceBuffer).not.toBe(buffer);

    const otherEdit = applyDocumentEdit(documentTab(state, "one").candidate, {
      kind: "replace-block",
      blockId: documentTab(state, "one").candidate.blocks[1].id,
      markdown: "changed elsewhere",
    });
    state = sessionReducer(state, {
      type: "edit-applied", sessionId: "one", expectedRevision: 0, result: otherEdit, selectionAfter: null,
    });
    const afterEdit = state;
    expect(documentTab(state, "one").revision).toBe(0);
    const staleBufferEdit = applyDocumentEdit(one.candidate, {
      kind: "replace-block", blockId: one.candidate.blocks[0].id, markdown: "from stale buffer",
    });
    state = sessionReducer(state, {
      type: "source-buffer-accepted", sessionId: "one", expectedRevision: 0,
      expectedBufferText: "stale-buffer", result: staleBufferEdit,
      selectionAfter: { kind: "text", anchorBlockKey: null, anchorOffset: 0, focusBlockKey: null, focusOffset: 0 },
    });

    expect(state).toBe(afterEdit);
    expect(documentTab(state, "one").sourceBuffer).toEqual(buffer);
    expect(documentTab(state, "one").revision).toBe(0);
  });

  it("clears a rejected buffer only when its exact candidate revision is accepted", () => {
    const session = makeDocumentSession("one", "C:\\docs\\one.md", "A\n\nB\n", {
      mode: "source",
    });
    const buffer: SourceBufferState = {
      sessionId: "one",
      baseCandidateRevision: 0,
      baseView: buildSourceView(session.candidate),
      bufferText: "accepted\n\nB\n",
      composedChanges: [{ from: 0, to: 1, insert: "accepted" }],
      validationError: "was rejected",
    };
    let state = sessionReducer(makeState(session), {
      type: "source-buffer-rejected", sessionId: "one", expectedRevision: 0, buffer,
      selectionAfter: { kind: "text", anchorBlockKey: null, anchorOffset: 0, focusBlockKey: null, focusOffset: 0 },
    });
    const result = applySourceChanges(session.candidate, buffer.baseView, buffer.composedChanges);
    state = sessionReducer(state, {
      type: "source-buffer-accepted", sessionId: "one", expectedRevision: 0,
      expectedBufferText: buffer.bufferText, result,
      selectionAfter: { kind: "text", anchorBlockKey: null, anchorOffset: 0, focusBlockKey: null, focusOffset: 0 },
    });

    expect(documentTab(state, "one").sourceBuffer).toBeNull();
    expect(documentTab(state, "one").revision).toBe(1);
    expect(documentTab(state, "one").candidate.text).toContain("accepted");
  });

  it("refuses to apply a source buffer unless the session is explicitly in source mode", () => {
    const session = makeDocumentSession("one", "C:\\docs\\one.md");
    const buffer: SourceBufferState = {
      sessionId: "one",
      baseCandidateRevision: 0,
      baseView: buildSourceView(session.candidate),
      bufferText: "changed\n\nB\n",
      composedChanges: [{ from: 0, to: 1, insert: "changed" }],
      validationError: null,
    };
    const initial = makeState(session);
    let state = sessionReducer(initial, {
      type: "source-buffer-rejected", sessionId: "one", expectedRevision: 0, buffer,
      selectionAfter: { kind: "text", anchorBlockKey: null, anchorOffset: 0, focusBlockKey: null, focusOffset: 0 },
    });
    expect(state).toBe(initial);
    expect(documentTab(state, "one").sourceBuffer).toBeNull();
    const result = applySourceChanges(session.candidate, buffer.baseView, buffer.composedChanges);
    const before = state;
    state = sessionReducer(state, {
      type: "source-buffer-accepted", sessionId: "one", expectedRevision: 0,
      expectedBufferText: buffer.bufferText, result,
      selectionAfter: { kind: "text", anchorBlockKey: null, anchorOffset: 0, focusBlockKey: null, focusOffset: 0 },
    });

    expect(state).toBe(before);
    expect(documentTab(state, "one").candidate).toBe(session.candidate);
  });

  it("carries only exclusive same-kind view keys and gives every split block a fresh key", () => {
    const session = makeDocumentSession("one", "C:\\docs\\one.md", "A\n\nB\n");
    const [oldA, oldB] = session.candidate.blocks;
    const result = applyDocumentEdit(session.candidate, {
      kind: "replace-block", blockId: oldA.id, markdown: "A1\n\nA2",
    });
    const state = sessionReducer(makeState(session), {
      type: "edit-applied", sessionId: "one", expectedRevision: 0, result, selectionAfter: null,
    });
    const edited = documentTab(state, "one");
    const [newA1, newA2, newB] = result.candidate.blocks;

    expect(edited.blockViewKeys.get(newA1.id)).not.toBe(session.blockViewKeys.get(oldA.id));
    expect(edited.blockViewKeys.get(newB.id)).toBe(session.blockViewKeys.get(oldB.id));
    expect(edited.blockViewKeys.get(newA2.id)).toMatch(/^one:block:1:/);
    expect(edited.blockViewKeys.get(newA1.id)).toMatch(/^one:block:1:/);
    expect(new Set(edited.blockViewKeys.values()).size).toBe(3);
    expect(edited.history.past).toEqual([{
      candidate: session.candidate,
      blockViewKeys: session.blockViewKeys,
      selection: null,
    }]);
  });

  it("does not transfer a deleted block key onto the block that shifts into its position", () => {
    const session = makeDocumentSession("one", "C:\\docs\\one.md", "A\n\nB\n\nC\n", {
      mode: "source",
    });
    const [, oldB, oldC] = session.candidate.blocks;
    const view = buildSourceView(session.candidate);
    const result = applySourceChanges(
      session.candidate,
      view,
      [{ from: oldB.start, to: oldC.start, insert: "" }],
    );
    const state = sessionReducer(makeState(session), {
      type: "edit-applied", sessionId: "one", expectedRevision: 0, result, selectionAfter: null,
    });
    const newC = result.candidate.blocks[1];

    expect(documentTab(state, "one").blockViewKeys.get(newC.id)).toBe(
      session.blockViewKeys.get(oldC.id),
    );
    expect(documentTab(state, "one").blockViewKeys.get(newC.id)).not.toBe(
      session.blockViewKeys.get(oldB.id),
    );
  });

  it("keeps a block key through adjacent replacement and insertion source changes", () => {
    const session = makeDocumentSession("one", "C:\\docs\\one.md", "A\n\nB\n", {
      mode: "source",
    });
    const oldB = session.candidate.blocks[1];
    const view = buildSourceView(session.candidate);
    const result = applySourceChanges(session.candidate, view, [
        { from: 0, to: oldB.start, insert: "AA\n\n" },
        { from: oldB.start, to: oldB.start, insert: "X\n\n" },
      ]);
    const state = sessionReducer(makeState(session), {
      type: "edit-applied", sessionId: "one", expectedRevision: 0, result, selectionAfter: null,
    });
    const newB = result.candidate.blocks.at(-1)!;

    expect(result.candidate.text).toBe("AA\n\nX\n\nB\n");
    expect(result.blockRemap.get(oldB.id)).toEqual([newB.id]);
    expect(documentTab(state, "one").blockViewKeys.get(newB.id)).toBe(
      session.blockViewKeys.get(oldB.id),
    );
  });
});

describe("sessionReducer atomic document history", () => {
  it("remaps a text selection to a fresh key when a Rich block changes kind", () => {
    const session = makeDocumentSession("one", "C:\\docs\\one.md", "paragraph 😀\n");
    const oldBlock = session.candidate.blocks[0]!;
    const oldKey = session.blockViewKeys.get(oldBlock.id)!;
    const beforeSelection: SelectionSnapshot = {
      kind: "text",
      anchorBlockKey: oldKey,
      anchorOffset: 10,
      focusBlockKey: oldKey,
      focusOffset: 10,
    };
    const result = applyDocumentEdit(session.candidate, {
      kind: "replace-block", blockId: oldBlock.id, markdown: "# heading 😀",
    });
    const next = documentTab(sessionReducer(makeState(session), {
      type: "edit-applied", sessionId: session.id, expectedRevision: 0,
      result, selectionAfter: beforeSelection,
    }), session.id);

    expect(next.viewState.selection).toMatchObject({ kind: "text" });
    const selection = next.viewState.selection!;
    expect(selection.kind).toBe("text");
    if (selection.kind !== "text") return;
    expect(selection.anchorBlockKey).not.toBe(oldKey);
    expect(selection.anchorOffset).toBe(10);
    expect(selection.focusBlockKey).toBe(selection.anchorBlockKey);
  });

  it("restores candidate, stable keys, and tagged selection atomically while revisions stay monotonic", () => {
    const beforeSelection: SelectionSnapshot = {
      kind: "text",
      anchorBlockKey: "one:block-before",
      anchorOffset: 1,
      focusBlockKey: "one:block-before",
      focusOffset: 2,
    };
    const session = makeDocumentSession("one", "C:\\docs\\one.md", "A\n\nB\n", {
      viewState: { scrollAnchor: { blockViewKey: "heading", offset: 0 }, selection: beforeSelection },
    });
    const result = applyDocumentEdit(session.candidate, {
      kind: "replace-block",
      blockId: session.candidate.blocks[0].id,
      markdown: "changed",
    });
    const afterSelection: SelectionSnapshot = {
      kind: "text",
      anchorBlockKey: session.blockViewKeys.get(session.candidate.blocks[0].id)!,
      anchorOffset: 3,
      focusBlockKey: session.blockViewKeys.get(session.candidate.blocks[0].id)!,
      focusOffset: 3,
    };

    let state = sessionReducer(makeState(session), {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 0,
      result,
      selectionAfter: afterSelection,
    } as never);
    const edited = documentTab(state, "one");
    expect(edited.revision).toBe(1);
    expect(edited.viewState.selection).toEqual(afterSelection);
    expect(edited.history.past[0]).toMatchObject({
      candidate: session.candidate,
      selection: beforeSelection,
    });
    expect([...edited.history.past[0].blockViewKeys]).toEqual([...session.blockViewKeys]);

    const secondResult = applyDocumentEdit(edited.candidate, {
      kind: "replace-block",
      blockId: edited.candidate.blocks[1].id,
      markdown: "changed again",
    });
    const secondSelection: SelectionSnapshot = {
      ...afterSelection,
      anchorOffset: 4,
      focusOffset: 4,
    };
    state = sessionReducer(state, {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 1,
      result: secondResult,
      selectionAfter: secondSelection,
    });
    const editedTwice = documentTab(state, "one");
    expect(editedTwice.revision).toBe(2);
    expect(editedTwice.viewState.selection).toEqual(secondSelection);

    state = sessionReducer(state, {
      type: "history-undo",
      sessionId: "one",
      expectedRevision: 2,
    });
    const undone = documentTab(state, "one");
    expect(undone.revision).toBe(3);
    expect(undone.candidate.bytes).toEqual(result.candidate.bytes);
    expect([...undone.blockViewKeys]).toEqual([...edited.blockViewKeys]);
    expect(undone.viewState.selection).toEqual(afterSelection);

    state = sessionReducer(state, {
      type: "history-redo",
      sessionId: "one",
      expectedRevision: 3,
    });
    const redone = documentTab(state, "one");
    expect(redone.revision).toBe(4);
    expect(redone.candidate.bytes).toEqual(secondResult.candidate.bytes);
    expect([...redone.blockViewKeys]).toEqual([...editedTwice.blockViewKeys]);
    expect(redone.viewState.selection).toEqual(secondSelection);
  });

  it("deep-snapshots maps and table coordinates across edit, Undo, and Redo", () => {
    const session = makeDocumentSession(
      "one",
      "C:\\docs\\table.md",
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    );
    const table = session.candidate.blocks[0];
    const stableKey = session.blockViewKeys.get(table.id)!;
    const originalMap = session.blockViewKeys as Map<string, string>;
    const beforeSelection: SelectionSnapshot = {
      kind: "table",
      tableBlockViewKey: stableKey,
      anchor: { row: 0, column: 0 },
      focus: { row: 1, column: 1 },
      origin: { row: 0, column: 0 },
    };
    const source = { ...session, viewState: { scrollAnchor: null, selection: beforeSelection } };
    const result = applyDocumentEdit(source.candidate, {
      kind: "replace-block",
      blockId: table.id,
      markdown: "| A | B |\n| --- | --- |\n| x | 2 |",
    });
    const afterSelection: SelectionSnapshot = {
      kind: "table",
      tableBlockViewKey: stableKey,
      anchor: { row: 1, column: 0 },
      focus: { row: 1, column: 1 },
      origin: { row: 1, column: 0 },
    };
    let state = sessionReducer(makeState(source), {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 0,
      result,
      selectionAfter: afterSelection,
    } as never);

    originalMap.clear();
    beforeSelection.focus.row = 99;
    afterSelection.anchor.column = 99;
    state = sessionReducer(state, {
      type: "history-undo",
      sessionId: "one",
      expectedRevision: 1,
    } as never);
    const undone = documentTab(state, "one");
    expect([...undone.blockViewKeys]).toEqual([[table.id, stableKey]]);
    expect(undone.viewState.selection).toMatchObject({
      kind: "table",
      focus: { row: 1, column: 1 },
    });

    (undone.blockViewKeys as Map<string, string>).clear();
    if (undone.viewState.selection?.kind === "table") undone.viewState.selection.focus.row = 77;
    state = sessionReducer(state, {
      type: "history-redo",
      sessionId: "one",
      expectedRevision: 2,
    } as never);
    expect(documentTab(state, "one").viewState.selection).toMatchObject({
      kind: "table",
      anchor: { row: 1, column: 0 },
      focus: { row: 1, column: 1 },
    });
  });

  it("settles async completions after Undo while keeping both history stacks bounded", () => {
    let session = makeDocumentSession("one", "C:\\docs\\one.md", "start\n");
    let state = makeState(session);
    for (let index = 0; index < 52; index += 1) {
      session = documentTab(state, "one");
      const result = applyDocumentEdit(session.candidate, {
        kind: "replace-block",
        blockId: session.candidate.blocks[0].id,
        markdown: `edit-${index}`,
      });
      state = sessionReducer(state, {
        type: "edit-applied",
        sessionId: "one",
        expectedRevision: session.revision,
        result,
        selectionAfter: null,
      } as never);
    }
    expect(documentTab(state, "one").history.past).toHaveLength(50);
    state = sessionReducer(state, {
      type: "begin-operation",
      operation: saveOperation(documentTab(state, "one"), "stale-save") as never,
    });
    state = sessionReducer(state, {
      type: "begin-operation",
      operation: { id: "stale-draft", kind: "draft", sessionId: "one", candidateRevision: 52 },
    });
    state = sessionReducer(state, {
      type: "begin-operation",
      operation: { id: "stale-watch", kind: "watch", sessionId: "one", canonicalPath: "C:\\docs\\one.md" } as never,
    });
    state = sessionReducer(state, {
      type: "history-undo",
      sessionId: "one",
      expectedRevision: 52,
    } as never);
    expect(documentTab(state, "one").revision).toBe(53);
    state = sessionReducer(state, {
      type: "save-succeeded",
      operationId: "stale-save",
      version: SAVED_VERSION,
    });
    expect(state.pendingOperations.has("stale-save")).toBe(false);
    expect(documentTab(state, "one").status).toBe("dirty");
    state = sessionReducer(state, {
      type: "draft-succeeded",
      operationId: "stale-draft",
      draftId: "wrong-draft",
    });
    expect(state.pendingOperations.has("stale-draft")).toBe(false);
    state = sessionReducer(state, {
      type: "watch-succeeded",
      operationId: "stale-watch",
      watchId: "wrong-watch",
    });
    expect(state.pendingOperations.has("stale-watch")).toBe(false);
    expect(documentTab(state, "one").draftId).toBeNull();
    expect(documentTab(state, "one").externalChange).toEqual({ kind: "checking", watchId: "wrong-watch" });
    expect(sessionReducer(state, {
      type: "history-undo",
      sessionId: "one",
      expectedRevision: 52,
    })).toBe(state);
    expect(sessionReducer(state, {
      type: "history-redo",
      sessionId: "other",
      expectedRevision: 53,
    })).toBe(state);

    for (let index = 0; index < 49; index += 1) {
      const revision = documentTab(state, "one").revision;
      state = sessionReducer(state, {
        type: "history-undo",
        sessionId: "one",
        expectedRevision: revision,
      } as never);
    }
    const oldestRetained = documentTab(state, "one");
    expect(oldestRetained.history.past).toHaveLength(0);
    expect(oldestRetained.history.future).toHaveLength(50);
    expect(oldestRetained.history.past.length + oldestRetained.history.future.length).toBe(50);
    expect(oldestRetained.candidate.text).toContain("edit-1");

    for (let index = 0; index < 50; index += 1) {
      const revision = documentTab(state, "one").revision;
      state = sessionReducer(state, {
        type: "history-redo",
        sessionId: "one",
        expectedRevision: revision,
      } as never);
      const session = documentTab(state, "one");
      expect(session.history.past.length + session.history.future.length).toBeLessThanOrEqual(50);
    }
    expect(documentTab(state, "one").candidate.text).toContain("edit-51");
  });

  it("clears the redo branch when a new accepted edit follows Undo", () => {
    const session = makeDocumentSession("one", "C:\\docs\\branch.md", "A\n");
    const first = applyDocumentEdit(session.candidate, {
      kind: "replace-block",
      blockId: session.candidate.blocks[0].id,
      markdown: "B",
    });
    let state = sessionReducer(makeState(session), {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 0,
      result: first,
      selectionAfter: null,
    });
    state = sessionReducer(state, {
      type: "history-undo",
      sessionId: "one",
      expectedRevision: 1,
    });
    expect(documentTab(state, "one").history.future).toHaveLength(1);
    const undone = documentTab(state, "one");
    const branch = applyDocumentEdit(undone.candidate, {
      kind: "replace-block",
      blockId: undone.candidate.blocks[0].id,
      markdown: "C",
    });
    state = sessionReducer(state, {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 2,
      result: branch,
      selectionAfter: null,
    });

    expect(documentTab(state, "one").revision).toBe(3);
    expect(documentTab(state, "one").candidate.text).toContain("C");
    expect(documentTab(state, "one").history.future).toHaveLength(0);
  });

  it.each(["history-undo", "history-redo"] as const)(
    "keeps a rejected source buffer byte-for-byte when %s is requested",
    (type) => {
      const session = makeDocumentSession("one", "C:\\docs\\source.md", "A\n", {
        mode: "source",
      });
      const result = applyDocumentEdit(session.candidate, {
        kind: "replace-block",
        blockId: session.candidate.blocks[0].id,
        markdown: "changed",
      });
      let state = sessionReducer(makeState(session), {
        type: "edit-applied",
        sessionId: "one",
        expectedRevision: 0,
        result,
        selectionAfter: null,
      });
      if (type === "history-redo") {
        state = sessionReducer(state, {
          type: "history-undo",
          sessionId: "one",
          expectedRevision: 1,
        });
      }
      const edited = documentTab(state, "one");
      const buffer: SourceBufferState = {
        sessionId: "one",
        baseCandidateRevision: edited.revision,
        baseView: buildSourceView(edited.candidate),
        bufferText: "\ud800",
        composedChanges: [{ from: 0, to: edited.candidate.text.length, insert: "\ud800" }],
        validationError: "unpaired surrogate",
      };
      state = sessionReducer(state, {
        type: "source-buffer-rejected",
        sessionId: "one",
        expectedRevision: edited.revision,
        buffer,
        selectionAfter: { kind: "text", anchorBlockKey: null, anchorOffset: 0, focusBlockKey: null, focusOffset: 0 },
      });
      const beforeHistory = state;

      state = sessionReducer(state, {
        type,
        sessionId: "one",
        expectedRevision: edited.revision,
      });

      expect(state).toBe(beforeHistory);
      expect(documentTab(state, "one").sourceBuffer).toEqual(buffer);
      expect(documentTab(state, "one").sourceBuffer).not.toBe(buffer);
      expect(documentTab(state, "one").revision).toBe(edited.revision);
    },
  );

  it.each([
    ["many-to-one", [[0], [0]]],
    ["one-to-many", [[0, 1], []]],
  ] as const)("degrades a stale table selection for an ambiguous %s remap", (_case, remaps) => {
    const session = makeDocumentSession(
      "one",
      "C:\\docs\\tables.md",
      "| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |\n",
    );
    const [oldA, oldB] = session.candidate.blocks;
    const selectedKey = session.blockViewKeys.get(oldA.id)!;
    const candidate = remaps[0].length === 1
      ? parseSourceDocument(new TextEncoder().encode("plain\n\n| C |\n| --- |\n| 3 |\n"))
      : parseSourceDocument(new TextEncoder().encode("| C |\n| --- |\n| 3 |\n\n| D |\n| --- |\n| 4 |\n"));
    const tables = candidate.blocks.filter((block) => block.kind === "table");
    const result: DocumentEditResult = {
      candidate,
      blockRemap: new Map([
        [oldA.id, remaps[0].map((index) => tables[index].id)],
        [oldB.id, remaps[1].map((index) => tables[index].id)],
      ]),
    };
    const selectionAfter: SelectionSnapshot = {
      kind: "table",
      tableBlockViewKey: selectedKey,
      anchor: { row: 0, column: 0 },
      focus: { row: 1, column: 0 },
      origin: { row: 0, column: 0 },
    };
    const state = sessionReducer(makeState(session), {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 0,
      result,
      selectionAfter,
    } as never);
    const selection = documentTab(state, "one").viewState.selection;

    expect(selection).toBeNull();
  });

  it.each([
    ["missing unselected source", (_oldA: string, oldB: string, _newA: string, newB: string) => new Map([[oldB, [newB]]])],
    ["missing selected source", (oldA: string, _oldB: string, newA: string, _newB: string) => new Map([[oldA, [newA]]])],
    ["unknown source", (oldA: string, oldB: string, newA: string, newB: string) => new Map([
      [oldA, [newA]], [oldB, [newB]], ["not-an-old-block", [newA]],
    ])],
    ["unknown target", (oldA: string, oldB: string, newA: string, _newB: string) => new Map([
      [oldA, [newA]], [oldB, ["not-a-result-block"]],
    ])],
  ] as const)("fails every stable-key carry closed for a remap with %s", (_case, makeRemap) => {
    const session = makeDocumentSession(
      "one",
      "C:\\docs\\tables.md",
      "| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |\n",
    );
    const [oldA, oldB] = session.candidate.blocks;
    const selectedKey = session.blockViewKeys.get(oldB.id)!;
    const candidate = parseSourceDocument(new TextEncoder().encode(
      "| A2 |\n| --- |\n| x |\n\n| B2 |\n| --- |\n| y |\n",
    ));
    const [newA, newB] = candidate.blocks;
    const result: DocumentEditResult = {
      candidate,
      blockRemap: makeRemap(oldA.id, oldB.id, newA.id, newB.id),
    };

    const state = sessionReducer(makeState(session), {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 0,
      result,
      selectionAfter: {
        kind: "table",
        tableBlockViewKey: selectedKey,
        anchor: { row: 0, column: 0 },
        focus: { row: 1, column: 0 },
        origin: { row: 0, column: 0 },
      },
    });
    const edited = documentTab(state, "one");
    const oldKeys = new Set(session.blockViewKeys.values());

    expect(edited.viewState.selection).toBeNull();
    for (const key of edited.blockViewKeys.values()) {
      expect(oldKeys.has(key)).toBe(false);
      expect(key).toMatch(/^one:block:1:/);
    }
  });

  it("keeps table coordinates only through exclusive table identity and degrades a kind change to its fresh paragraph key", () => {
    const session = makeDocumentSession(
      "one",
      "C:\\docs\\tables.md",
      "| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |\n",
    );
    const [oldA, oldB] = session.candidate.blocks;
    const selectedKey = session.blockViewKeys.get(oldA.id)!;
    const selectionAfter: SelectionSnapshot = {
      kind: "table",
      tableBlockViewKey: selectedKey,
      anchor: { row: 0, column: 0 },
      focus: { row: 1, column: 0 },
      origin: { row: 0, column: 0 },
    };
    const changedTables = parseSourceDocument(new TextEncoder().encode(
      "| A |\n| --- |\n| x |\n\n| B |\n| --- |\n| y |\n",
    ));
    let state = sessionReducer(makeState(session), {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 0,
      result: {
        candidate: changedTables,
        blockRemap: new Map([
          [oldA.id, [changedTables.blocks[0].id]],
          [oldB.id, [changedTables.blocks[1].id]],
        ]),
      },
      selectionAfter,
    } as never);
    expect(documentTab(state, "one").viewState.selection).toEqual(selectionAfter);
    expect(documentTab(state, "one").blockViewKeys.get(changedTables.blocks[0].id)).toBe(selectedKey);

    const paragraphAndTable = parseSourceDocument(new TextEncoder().encode(
      "A became text\n\n| B |\n| --- |\n| y |\n",
    ));
    state = sessionReducer(makeState(session), {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 0,
      result: {
        candidate: paragraphAndTable,
        blockRemap: new Map([
          [oldA.id, [paragraphAndTable.blocks[0].id]],
          [oldB.id, [paragraphAndTable.blocks[1].id]],
        ]),
      },
      selectionAfter,
    } as never);
    const degraded = documentTab(state, "one").viewState.selection;
    expect(degraded).toEqual({
      kind: "text",
      anchorBlockKey: documentTab(state, "one").blockViewKeys.get(paragraphAndTable.blocks[0].id),
      anchorOffset: 0,
      focusBlockKey: documentTab(state, "one").blockViewKeys.get(paragraphAndTable.blocks[0].id),
      focusOffset: 0,
    });
    expect(degraded?.kind).toBe("text");
    expect(documentTab(state, "one").blockViewKeys.get(paragraphAndTable.blocks[1].id))
      .toBe(session.blockViewKeys.get(oldB.id));
  });

  it("drops a deleted table selection without transferring it to the adjacent table", () => {
    const session = makeDocumentSession(
      "one",
      "C:\\docs\\tables.md",
      "| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |\n",
    );
    const [oldA, oldB] = session.candidate.blocks;
    const selectedKey = session.blockViewKeys.get(oldA.id)!;
    const candidate = parseSourceDocument(new TextEncoder().encode(
      "| B |\n| --- |\n| 2 |\n",
    ));
    const state = sessionReducer(makeState(session), {
      type: "edit-applied",
      sessionId: "one",
      expectedRevision: 0,
      result: {
        candidate,
        blockRemap: new Map([
          [oldA.id, []],
          [oldB.id, [candidate.blocks[0].id]],
        ]),
      },
      selectionAfter: {
        kind: "table",
        tableBlockViewKey: selectedKey,
        anchor: { row: 0, column: 0 },
        focus: { row: 1, column: 0 },
        origin: { row: 0, column: 0 },
      },
    });

    expect(documentTab(state, "one").viewState.selection).toBeNull();
    expect(documentTab(state, "one").blockViewKeys.get(candidate.blocks[0].id))
      .toBe(session.blockViewKeys.get(oldB.id));
  });
});

describe("Task 4 source state and data-loss contract", () => {
  function rejectedBuffer(
    session: DocumentSession,
    bufferText = `${session.candidate.text}\ud800`,
  ): SourceBufferState {
    return {
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
  }

  const absoluteSelection = (offset: number): SelectionSnapshot => ({
    kind: "text",
    anchorBlockKey: null,
    anchorOffset: offset,
    focusBlockKey: null,
    focusOffset: offset,
  });

  it("marks a clean rejected Source buffer unsaved while preserving exact UTF-16 and accepted state", () => {
    const session = makeDocumentSession("source", "C:\\docs\\source.md", "A\n", {
      mode: "source",
      zoomPercent: 150,
    });
    const buffer = rejectedBuffer(session);
    const selectionAfter = absoluteSelection(buffer.bufferText.length);
    const initial = makeState(session);

    const state = sessionReducer(initial, {
      type: "source-buffer-rejected",
      sessionId: session.id,
      expectedRevision: session.revision,
      buffer,
      selectionAfter,
    } as never);
    const rejected = documentTab(state, session.id);

    expect(rejected.status).toBe("dirty");
    expect(rejected.candidate).toBe(session.candidate);
    expect(rejected.baseline).toBe(session.baseline);
    expect(rejected.revision).toBe(session.revision);
    expect(rejected.history).toBe(session.history);
    expect(rejected.zoomPercent).toBe(150);
    expect(rejected.sourceBuffer?.bufferText.charCodeAt(buffer.bufferText.length - 1)).toBe(0xd800);
    expect(rejected.viewState.selection).toEqual(selectionAfter);
  });

  it.each(["save", "save-as"] as const)(
    "keeps a rejected buffer dirty after an in-flight %s completion promotes its immutable saved candidate",
    (kind) => {
      const original = makeDocumentSession("source", "C:\\docs\\source.md", "A\n", {
        mode: "source",
      });
      const edit = applyDocumentEdit(original.candidate, {
        kind: "replace-block",
        blockId: original.candidate.blocks[0].id,
        markdown: "B",
      });
      let state = sessionReducer(makeState(original), {
        type: "edit-applied",
        sessionId: original.id,
        expectedRevision: 0,
        result: edit,
        selectionAfter: absoluteSelection(1),
      });
      const savedCandidate = documentTab(state, original.id).candidate;
      const saving = { ...documentTab(state, original.id), status: "saving" as const };
      state = { ...state, tabs: [saving] };
      const operationId = `${kind}-buffered`;
      state = sessionReducer(state, {
        type: "begin-operation",
        operation: kind === "save"
          ? saveOperation(saving, operationId, savedCandidate)
          : saveAsOperation(saving, "C:\\docs\\saved.md", operationId, savedCandidate),
      } as never);
      const buffer = rejectedBuffer(saving);
      state = sessionReducer(state, {
        type: "source-buffer-rejected",
        sessionId: saving.id,
        expectedRevision: saving.revision,
        buffer,
        selectionAfter: absoluteSelection(buffer.bufferText.length),
      } as never);
      expect(documentTab(state, saving.id).status).toBe("saving");

      state = kind === "save"
        ? sessionReducer(state, {
            type: "save-succeeded",
            operationId,
            version: SAVED_VERSION,
          })
        : sessionReducer(state, {
            type: "save-as-succeeded",
            operationId,
            canonicalPath: "\\\\?\\C:\\docs\\saved.md",
            version: SAVED_VERSION,
          });
      const completed = documentTab(state, saving.id);

      expect(completed.baseline.bytes).toEqual(savedCandidate.bytes);
      expect(completed.candidate).toBe(savedCandidate);
      expect(completed.sourceBuffer?.bufferText.charCodeAt(buffer.bufferText.length - 1)).toBe(0xd800);
      expect(completed.status).toBe("dirty");
      expect(state.pendingOperations.has(operationId)).toBe(false);
    },
  );

  it.each(["edit-applied", "history-undo", "history-redo"] as const)(
    "keeps WorkspaceState identity when %s is requested while a Source buffer exists",
    (type) => {
      const session = makeDocumentSession("source", "C:\\docs\\source.md", "A\n", {
        mode: "source",
      });
      const first = applyDocumentEdit(session.candidate, {
        kind: "replace-block",
        blockId: session.candidate.blocks[0].id,
        markdown: "B",
      });
      let state = sessionReducer(makeState(session), {
        type: "edit-applied",
        sessionId: session.id,
        expectedRevision: 0,
        result: first,
        selectionAfter: absoluteSelection(1),
      });
      if (type === "history-redo") {
        state = sessionReducer(state, {
          type: "history-undo",
          sessionId: session.id,
          expectedRevision: 1,
        });
      }
      const current = documentTab(state, session.id);
      const buffer = rejectedBuffer(current);
      state = sessionReducer(state, {
        type: "source-buffer-rejected",
        sessionId: current.id,
        expectedRevision: current.revision,
        buffer,
        selectionAfter: absoluteSelection(buffer.bufferText.length),
      } as never);
      const before = state;
      const result = applyDocumentEdit(current.candidate, {
        kind: "replace-block",
        blockId: current.candidate.blocks[0].id,
        markdown: "must not apply",
      });
      const action = type === "edit-applied"
        ? {
            type,
            sessionId: current.id,
            expectedRevision: current.revision,
            result,
            selectionAfter: absoluteSelection(2),
          }
        : { type, sessionId: current.id, expectedRevision: current.revision };

      expect(sessionReducer(state, action as never)).toBe(before);
    },
  );

  it("clears an exact-canonical repair with tagged selection and zero revision or history", () => {
    const session = makeDocumentSession("source", "C:\\docs\\source.md", "A\n", {
      mode: "source",
    });
    const buffer: SourceBufferState = {
      ...rejectedBuffer(session),
      bufferText: session.candidate.text,
      composedChanges: [],
    };
    let state = sessionReducer(makeState(session), {
      type: "source-buffer-rejected",
      sessionId: session.id,
      expectedRevision: session.revision,
      buffer,
      selectionAfter: absoluteSelection(1),
    } as never);
    const beforeRepair = documentTab(state, session.id);
    let repaired: WorkspaceState | undefined;

    expect(() => {
      repaired = sessionReducer(state, {
        type: "source-buffer-accepted",
        sessionId: session.id,
        expectedRevision: session.revision,
        expectedBufferText: session.candidate.text,
        result: null,
        selectionAfter: absoluteSelection(0),
      } as never);
    }).not.toThrow();
    const accepted = documentTab(repaired!, session.id);
    expect(accepted.sourceBuffer).toBeNull();
    expect(accepted.revision).toBe(beforeRepair.revision);
    expect(accepted.history).toBe(beforeRepair.history);
    expect(accepted.candidate).toBe(beforeRepair.candidate);
    expect(accepted.viewState.selection).toEqual(absoluteSelection(0));
    expect(accepted.status).toBe("clean");
  });

  it("keeps an untitled document dirty when direct edit or Undo returns to its empty baseline", () => {
    const empty = makeDocumentSession("source", "C:\\docs\\unused.md", "", {
      file: { kind: "untitled", displayName: "未命名 1" },
      mode: "source",
      status: "dirty",
    });
    const inserted = applyDocumentEdit(empty.candidate, {
      kind: "insert-after", blockId: null, markdown: "A",
    });
    const edited = sessionReducer(makeState(empty), {
      type: "edit-applied", sessionId: empty.id, expectedRevision: 0,
      result: inserted, selectionAfter: absoluteSelection(1),
    });

    const undone = sessionReducer(edited, {
      type: "history-undo", sessionId: empty.id, expectedRevision: 1,
    });
    expect(documentTab(undone, empty.id)).toMatchObject({
      status: "dirty", candidate: { text: "" }, file: { kind: "untitled" },
    });

    const current = documentTab(edited, empty.id);
    const removed = applyDocumentEdit(current.candidate, {
      kind: "replace-block", blockId: current.candidate.blocks[0].id, markdown: "",
    });
    const deleted = sessionReducer(edited, {
      type: "edit-applied", sessionId: empty.id, expectedRevision: 1,
      result: removed, selectionAfter: absoluteSelection(0),
    });
    expect(documentTab(deleted, empty.id)).toMatchObject({
      status: "dirty", candidate: { text: "" }, file: { kind: "untitled" },
    });
  });

  it.each([
    ["first", 0, "successor", "B"],
    ["middle", 1, "predecessor", "A"],
    ["final", 2, "predecessor", "B"],
  ] as const)("remaps a deleted %s viewport block to the nearest %s neighborhood", (_case, index, direction, survivorRaw) => {
    const session = makeDocumentSession("source", "C:\\docs\\viewport.md", "A\n\nB\n\nC\n", {
      mode: "source",
    });
    const selected = session.candidate.blocks[index];
    const selectedKey = session.blockViewKeys.get(selected.id)!;
    const withViewport: DocumentSession = {
      ...session,
      viewState: {
        selection: null,
        scrollAnchor: { blockViewKey: selectedKey, offset: 1 },
      },
    };
    const result = applyDocumentEdit(session.candidate, {
      kind: "replace-block", blockId: selected.id, markdown: "",
    });
    const state = sessionReducer(makeState(withViewport), {
      type: "edit-applied", sessionId: session.id, expectedRevision: 0,
      result, selectionAfter: null,
    });
    const updated = documentTab(state, session.id);
    const view = buildSourceView(updated.candidate);
    const spans = buildBlockViewSpans(updated.candidate, view, updated.blockViewKeys);
    const survivor = updated.candidate.blocks.find((block) => block.raw === survivorRaw)!;
    const survivorSpan = spans.find((span) => span.blockId === survivor.id)!;

    expect(updated.viewState.scrollAnchor?.blockViewKey).toBe(
      updated.blockViewKeys.get(survivor.id),
    );
    expect(sourceOffsetForViewportAnchor(
      updated.viewState.scrollAnchor,
      spans,
      view.text,
    )).toBe(direction === "successor" ? survivorSpan.start : survivorSpan.end);
  });

  it("rejects stale repair text and accepts a different valid repair exactly once with tagged selection", () => {
    const session = makeDocumentSession("source", "C:\\docs\\source.md", "A\n", {
      mode: "source",
    });
    const buffer: SourceBufferState = {
      ...rejectedBuffer(session),
      bufferText: "B\n",
      composedChanges: [{ from: 0, to: 1, insert: "B" }],
    };
    let state = sessionReducer(makeState(session), {
      type: "source-buffer-rejected",
      sessionId: session.id,
      expectedRevision: 0,
      buffer,
      selectionAfter: absoluteSelection(1),
    } as never);
    const result = applySourceChanges(session.candidate, buffer.baseView, buffer.composedChanges);

    expect(sessionReducer(state, {
      type: "source-buffer-accepted",
      sessionId: session.id,
      expectedRevision: 0,
      expectedBufferText: "stale text",
      result,
      selectionAfter: absoluteSelection(1),
    } as never)).toBe(state);

    state = sessionReducer(state, {
      type: "source-buffer-accepted",
      sessionId: session.id,
      expectedRevision: 0,
      expectedBufferText: buffer.bufferText,
      result,
      selectionAfter: absoluteSelection(1),
    } as never);
    const accepted = documentTab(state, session.id);
    expect(accepted.sourceBuffer).toBeNull();
    expect(accepted.candidate.text).toBe("B\n");
    expect(accepted.revision).toBe(1);
    expect(accepted.history.past).toHaveLength(1);
    expect(accepted.viewState.selection).toEqual(absoluteSelection(1));
  });

  it("updates Source selection without overwriting the structured viewport or content state", () => {
    const anchor = { blockViewKey: "source:block", offset: 2 };
    const session = makeDocumentSession("source", "C:\\docs\\source.md", "A\n", {
      mode: "source",
      viewState: { scrollAnchor: anchor, selection: null } as never,
    });
    const selection = absoluteSelection(1);
    const initial = makeState(session);

    const state = sessionReducer(initial, {
      type: "source-selection-updated",
      sessionId: session.id,
      expectedRevision: session.revision,
      selection,
    } as never);
    expect(state).toBeDefined();
    if (!state) return;
    const updated = documentTab(state, session.id);

    expect(updated.viewState).toEqual({ scrollAnchor: anchor, selection });
    expect(updated.candidate).toBe(session.candidate);
    expect(updated.baseline).toBe(session.baseline);
    expect(updated.revision).toBe(session.revision);
    expect(updated.history).toBe(session.history);
    expect(updated.status).toBe(session.status);
    expect(updated.zoomPercent).toBe(session.zoomPercent);
    expect(state.pendingOperations).toBe(initial.pendingOperations);
  });

  it("updates Source viewport without overwriting tagged selection and rejects stale identity", () => {
    const selection = absoluteSelection(1);
    const session = makeDocumentSession("source", "C:\\docs\\source.md", "A\n", {
      mode: "source",
      viewState: { scrollAnchor: null, selection },
    });
    const initial = makeState(session);
    const anchor = { blockViewKey: null, offset: 1 };

    const state = sessionReducer(initial, {
      type: "source-viewport-updated",
      sessionId: session.id,
      expectedRevision: session.revision,
      anchor,
    } as never);
    expect(state).toBeDefined();
    if (!state) return;
    expect(documentTab(state, session.id).viewState).toEqual({ scrollAnchor: anchor, selection });
    expect(sessionReducer(state, {
      type: "source-viewport-updated",
      sessionId: session.id,
      expectedRevision: session.revision + 1,
      anchor: { blockViewKey: null, offset: 0 },
    } as never)).toBe(state);
  });

  it("changes only mode for an exact session revision and keeps stale mode actions as exact no-ops", () => {
    const session = makeDocumentSession("source", "C:\\docs\\source.md", "A\n", {
      mode: "reading",
      zoomPercent: 150,
    });
    const initial = makeState(session);

    const state = sessionReducer(initial, {
      type: "set-mode",
      sessionId: session.id,
      expectedRevision: session.revision,
      mode: "source",
    } as never);
    expect(state).toBeDefined();
    if (!state) return;
    const changed = documentTab(state, session.id);
    expect(changed.mode).toBe("source");
    expect(changed.candidate).toBe(session.candidate);
    expect(changed.revision).toBe(session.revision);
    expect(changed.history).toBe(session.history);
    expect(changed.zoomPercent).toBe(150);
    expect(sessionReducer(state, {
      type: "set-mode",
      sessionId: session.id,
      expectedRevision: session.revision + 1,
      mode: "reading",
    } as never)).toBe(state);
  });
});

describe("sessionReducer tabs", () => {
  it("activates an existing case-insensitive canonical Windows path and appends a different one", () => {
    const dirty = makeDocumentSession("dirty", "C:\\Docs\\One.md", "dirty\n", { status: "dirty" });
    let state = sessionReducer(makeState(dirty), {
      type: "begin-operation", operation: { id: "open-same", kind: "open", requestedPath: "c:\\docs\\ONE.md" },
    });
    state = sessionReducer(state, {
      type: "open-succeeded",
      operationId: "open-same",
      session: makeDocumentSession("duplicate", "c:\\docs\\one.md", "fresh\n"),
    });
    expect(state.tabs).toEqual([dirty]);
    expect(state.activeTabId).toBe("dirty");

    state = sessionReducer(state, {
      type: "begin-operation", operation: { id: "open-two", kind: "open", requestedPath: "C:\\docs\\two.md" },
    });
    const two = makeDocumentSession("two", "C:\\docs\\two.md", "two\n");
    state = sessionReducer(state, { type: "open-succeeded", operationId: "open-two", session: two });
    expect(state.tabs).toEqual([dirty, two]);
    expect(state.activeTabId).toBe("two");
    expect(documentTab(state, "dirty").status).toBe("dirty");
  });

  it("activates a preview tab without changing document session state", () => {
    const document = makeDocumentSession("doc", "C:\\docs\\one.md", "dirty\n", { status: "dirty" });
    const preview: ResourcePreviewSession = {
      kind: "preview",
      id: "preview",
      canonicalPath: "C:\\docs\\image.png",
      displayName: "image.png",
      mediaType: "image",
      zoomPercent: 125,
    };
    const state = sessionReducer(
      { ...makeState(document), tabs: [document, preview] },
      { type: "activate-tab", tabId: "preview" },
    );

    expect(state.activeTabId).toBe("preview");
    expect(state.tabs[0]).toBe(document);
    expect(documentTab(state, "doc").status).toBe("dirty");
  });
});

describe("document command eligibility at the reducer boundary", () => {
  it.each(["readonly", "conflict"] as const)(
    "keeps %s application Undo and Redo as exact no-ops even with both history branches",
    (status) => {
      const base = makeDocumentSession("protected", "C:\\docs\\protected.md", "A\n");
      const previous = makeDocumentSession("previous", "C:\\docs\\previous.md", "P\n").candidate;
      const next = makeDocumentSession("next", "C:\\docs\\next.md", "N\n").candidate;
      const protectedSession: DocumentSession = {
        ...base,
        status,
        revision: 4,
        history: {
          past: [{ candidate: previous, blockViewKeys: new Map(), selection: null }],
          future: [{ candidate: next, blockViewKeys: new Map(), selection: null }],
        },
      };
      const state = makeState(protectedSession);

      expect(sessionReducer(state, {
        type: "history-undo", sessionId: protectedSession.id, expectedRevision: 4,
      })).toBe(state);
      expect(sessionReducer(state, {
        type: "history-redo", sessionId: protectedSession.id, expectedRevision: 4,
      })).toBe(state);
    },
  );

  it.each(["readonly", "conflict"] as const)(
    "keeps %s edit-applied as an exact no-op",
    (status) => {
      const session = makeDocumentSession("protected-edit", "C:\\docs\\protected.md", "A\n", {
        status,
        mode: "source",
      });
      const view = buildSourceView(session.candidate);
      const result = applySourceChanges(session.candidate, view, [{ from: 0, to: 1, insert: "B" }]);
      const state = makeState(session);

      expect(sessionReducer(state, {
        type: "edit-applied", sessionId: session.id, expectedRevision: 0,
        result, selectionAfter: null,
      })).toBe(state);
    },
  );
});

describe("Protected Raw transient buffer", () => {
  it("keeps typed raw visible while unrelated history, mode and candidate edits fail closed", () => {
    const session = makeDocumentSession(
      "raw",
      "C:\\docs\\raw.md",
      "<custom-widget>keep</custom-widget>\n\nParagraph\n",
      { mode: "rich" },
    );
    const protectedBlock = session.candidate.blocks.find((block) => block.protected)!;
    const blockViewKey = session.blockViewKeys.get(protectedBlock.id)!;
    let state = sessionReducer(makeState(session), {
      type: "protected-raw-buffer-opened",
      sessionId: session.id,
      expectedRevision: 0,
      blockViewKey,
    } as never);
    state = sessionReducer(state, {
      type: "protected-raw-buffer-updated",
      sessionId: session.id,
      expectedRevision: 0,
      blockViewKey,
      bufferText: "<custom-widget>typed</custom-widget>",
    } as never);
    const buffered = documentTab(state, session.id);
    expect(buffered.protectedRawBuffer).toMatchObject({
      blockViewKey,
      bufferText: "<custom-widget>typed</custom-widget>",
      dirty: true,
    });
    expect(state === sessionReducer(state, {
      type: "set-mode", sessionId: session.id, expectedRevision: 0, mode: "reading",
    })).toBe(true);
    expect(state === sessionReducer(state, {
      type: "history-undo", sessionId: session.id, expectedRevision: 0,
    })).toBe(true);

    const cancelled = sessionReducer(state, {
      type: "protected-raw-buffer-cancelled",
      sessionId: session.id,
      expectedRevision: 0,
      blockViewKey,
    } as never);
    expect(documentTab(cancelled, session.id).protectedRawBuffer).toBeNull();
    expect(documentTab(cancelled, session.id).candidate).toBe(session.candidate);
    expect(documentTab(cancelled, session.id).revision).toBe(0);
  });
});

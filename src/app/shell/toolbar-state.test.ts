// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { DocumentSession } from "../../documents/session";
import { parseSourceDocument } from "../../markdown/source-document";
import type { DocumentController } from "../use-document-controller";
import { createToolbarStateById } from "./toolbar-state";
import { createActiveEditorRegistry, type ActiveEditorBridge } from "../../editor/active-editor";

function document(overrides: Partial<DocumentSession> = {}): DocumentSession {
  const candidate = parseSourceDocument(new TextEncoder().encode("A\n"));
  return {
    kind: "document", id: "one",
    file: { kind: "local", canonicalPath: "C:\\docs\\one.md", version: { len: 1, modifiedMs: 1, sha256: "a" } },
    baseline: candidate, candidate, status: "clean", mode: "reading", revision: 0,
    zoomPercent: 100, draftId: null, externalChange: null,
    blockViewKeys: new Map(candidate.blocks.map((block) => [block.id, block.id])),
    sourceBuffer: null, protectedRawBuffer: null,
    viewState: { scrollAnchor: null, selection: null },
    history: { past: [], future: [] }, ...overrides,
  };
}

function controller(tab: DocumentSession): DocumentController {
  return {
    tabs: [tab], activeTabId: tab.id, closePrompt: null, closing: false, persistentMessage: null,
    newDocument: vi.fn(async () => undefined), openPaths: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined), saveAs: vi.fn(async () => undefined),
    requestClose: vi.fn(), requestCloseAll: vi.fn(), resolveClose: vi.fn(async () => undefined),
    activate: vi.fn(), setMode: vi.fn(() => "changed" as const), getSourceView: vi.fn(() => null),
    commitRichEdit: vi.fn(() => ({ kind: "stale" as const })),
    beginProtectedRawEdit: vi.fn(() => false), updateProtectedRawBuffer: vi.fn(() => false),
    cancelProtectedRawEdit: vi.fn(() => false), commitProtectedRawEdit: vi.fn(() => ({ kind: "stale" as const })),
    applySourceChangeBatch: vi.fn(() => ({ kind: "stale" as const })), updateSourceSelection: vi.fn(),
    updateSourceViewport: vi.fn(), undo: vi.fn(() => true), redo: vi.fn(() => true),
  };
}

describe("shared toolbar state", () => {
  it("allows object insertion at the start of an empty Rich document", () => {
    const candidate = parseSourceDocument(new Uint8Array());
    const tab = document({
      baseline: candidate,
      candidate,
      blockViewKeys: new Map(),
      mode: "rich",
      status: "dirty",
    });
    const app = controller(tab);
    vi.mocked(app.commitRichEdit).mockReturnValue({ kind: "accepted", candidateRevision: 1 });
    const registry = createActiveEditorRegistry();
    registry.register({
      sessionId: tab.id,
      candidateRevision: tab.revision,
      blockViewKey: `${tab.id}:empty`,
      mountToken: Symbol("empty"),
      getInsertionBlockViewKey: () => null,
      getState: () => ({
        canUndo: false,
        canRedo: false,
        canLink: false,
        block: "paragraph",
        formats: { bold: "off", italic: "off", strikethrough: "off", code: "off" },
        list: "none",
        linkUrl: null,
      }),
      restoreSelection: () => "unsupported",
      run: () => "ran",
      focus: () => "focused",
    });

    const states = createToolbarStateById(app, registry);
    expect(states.table.enabled).toBe(true);
    expect(states.formula.enabled).toBe(true);
    expect(states.mermaid.enabled).toBe(true);
    expect(states["horizontal-rule"].enabled).toBe(true);

    states.table.execute();
    expect(app.commitRichEdit).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [{ kind: "insert-after", blockViewKey: null, markdown: expect.stringContaining("| --- |") }],
    }));
  });

  it("projects the live Rich bridge into one mixed-state force-target command map", () => {
    const tab = document({ mode: "rich" });
    const app = controller(tab);
    const registry = createActiveEditorRegistry();
    const run = vi.fn(() => "ran" as const);
    const blockViewKey = tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!;
    const insertionBlockViewKey = "stable-second";
    const bridge: ActiveEditorBridge = {
      sessionId: tab.id,
      candidateRevision: tab.revision,
      blockViewKey,
      mountToken: Symbol("rich"),
      getInsertionBlockViewKey: () => insertionBlockViewKey,
      getState: () => ({
        canUndo: false,
        canRedo: false,
        canLink: true,
        block: "h1",
        formats: { bold: "mixed", italic: "on", strikethrough: "off", code: "off" },
        list: "none",
        linkUrl: null,
      }),
      restoreSelection: () => "restored",
      run,
      focus: () => "focused",
    };
    registry.register(bridge);

    const states = createToolbarStateById(app, registry);
    expect(states["block-style"]).toMatchObject({ enabled: true, text: "标题 1" });
    expect(states.bold).toMatchObject({ enabled: true, toggleState: "mixed" });
    expect(states.italic).toMatchObject({ enabled: true, toggleState: "on" });
    expect(states["bullet-list"]).toMatchObject({ enabled: true, toggleState: "off" });
    expect(states.quote).toMatchObject({ enabled: true, toggleState: "off" });
    states.bold.execute();
    expect(run).toHaveBeenCalledWith({ kind: "format", value: "bold", desired: "on" });
    states["bullet-list"].execute();
    expect(run).toHaveBeenLastCalledWith({ kind: "list", value: "bullet" });
    expect(states["horizontal-rule"].enabled).toBe(true);
    states["horizontal-rule"].execute();
    expect(app.commitRichEdit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: tab.id,
      baseCandidateRevision: tab.revision,
      mutations: [{ kind: "insert-after", blockViewKey: insertionBlockViewKey, markdown: "\n\n---" }],
    }));
    expect(states.formula.enabled).toBe(true);
    expect(states.mermaid.enabled).toBe(true);
    states.formula.execute();
    states.mermaid.execute();
    expect(app.commitRichEdit).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [{ kind: "insert-after", blockViewKey: insertionBlockViewKey, markdown: expect.stringContaining("$$") }],
    }));
    expect(app.commitRichEdit).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [{ kind: "insert-after", blockViewKey: insertionBlockViewKey, markdown: expect.stringContaining("```mermaid") }],
    }));
  });

  it("keeps block/list controls honest while a table editor owns the selection", () => {
    const tab = document({ mode: "rich" });
    const app = controller(tab);
    const registry = createActiveEditorRegistry();
    const blockViewKey = tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!;
    registry.register({
      sessionId: tab.id,
      candidateRevision: tab.revision,
      blockViewKey,
      mountToken: Symbol("table"),
      getInsertionBlockViewKey: () => blockViewKey,
      getState: () => ({
        canUndo: false,
        canRedo: false,
        canLink: false,
        canBlock: false,
        canList: false,
        block: "paragraph",
        formats: { bold: "off", italic: "off", strikethrough: "off", code: "off" },
        list: "none",
        linkUrl: null,
      }),
      restoreSelection: () => "unsupported",
      run: () => "rejected",
      focus: () => "focused",
    });

    const states = createToolbarStateById(app, registry);
    expect(states["bullet-list"].enabled).toBe(false);
    expect(states["block-style"].enabled).toBe(false);
    expect(states.table.enabled).toBe(true);
    states.table.execute();
    expect(app.commitRichEdit).toHaveBeenCalledWith(expect.objectContaining({
      mutations: [{
        kind: "insert-after",
        blockViewKey,
        markdown: "\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |",
      }],
    }));
  });

  it("projects one Reading selection into the same exact-once Rich command ids", () => {
    const tab = document({ mode: "reading" });
    const app = controller(tab);
    const run = vi.fn();
    const blockViewKey = tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!;
    const states = createToolbarStateById(app, undefined, {
      selection: {
        sessionId: tab.id,
        candidateRevision: tab.revision,
        blockViewKey,
        anchorTextOffset: 0,
        focusTextOffset: 1,
        state: {
          canUndo: false,
          canRedo: false,
          canLink: true,
          block: "paragraph",
          formats: { bold: "off", italic: "off", strikethrough: "off", code: "off" },
          list: "none",
          linkUrl: null,
        },
      },
      run,
    });

    expect(states.bold.enabled).toBe(true);
    states.bold.execute();
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({ kind: "format", value: "bold", desired: "on" });
  });

  it("uses one truthful command map for accepted Source Save and document history", () => {
    const source = document({
      mode: "source", status: "dirty",
      history: { past: [{ candidate: document().candidate, blockViewKeys: new Map(), selection: null }], future: [] },
    });
    const app = controller(source);
    const states = createToolbarStateById(app);

    expect(states.save.enabled).toBe(true);
    expect(states.undo.enabled).toBe(true);
    expect(states.redo.enabled).toBe(false);
    expect(states.bold).toMatchObject({ enabled: false, toggleState: "off" });
    expect(states.link.toggleState).toBeNull();
    states.undo.execute();
    expect(app.undo).toHaveBeenCalledWith("one", 0);
  });

  it("disables application Save/Undo/Redo for rejected Source while preserving exact repair copy", () => {
    const source = document({
      mode: "source", status: "dirty",
      sourceBuffer: {
        sessionId: "one", baseCandidateRevision: 0,
        baseView: { text: "A\n", byteOffsetAtViewOffset: Uint32Array.from([0, 1, 2]) },
        bufferText: "A\ud800\n", composedChanges: [{ from: 1, to: 1, insert: "\ud800" }],
        validationError: "invalid",
      },
      history: { past: [{ candidate: document().candidate, blockViewKeys: new Map(), selection: null }], future: [] },
    });
    const states = createToolbarStateById(controller(source));

    expect(states.save).toMatchObject({ enabled: false, title: "修复字符后保存" });
    expect(states.undo.enabled).toBe(false);
    expect(states.redo.enabled).toBe(false);
  });

  it("uses discoverable Chinese labels instead of leaking internal action ids", () => {
    const states = createToolbarStateById(controller(document()));

    expect(states["block-style"].title).toBe("段落样式");
    expect(states["inline-code"].title).toBe("行内代码");
    expect(states["bullet-list"].title).toBe("项目列表");
    expect(states["horizontal-rule"].title).toBe("分隔线");
    expect(states.undo.title).toBe("撤销 (Ctrl+Z)");
    expect(states.redo.title).toBe("重做 (Ctrl+Y)");
    for (const [id, state] of Object.entries(states)) {
      expect(state.title).not.toBe(id);
    }
  });

  it("keeps Save locked but exposes the same Undo and Redo truth during an admitted Source save", () => {
    const past = { candidate: document().candidate, blockViewKeys: new Map(), selection: null };
    const future = { candidate: document().candidate, blockViewKeys: new Map(), selection: null };
    const states = createToolbarStateById(controller(document({
      mode: "source",
      status: "saving",
      history: { past: [past], future: [future] },
    })));

    expect(states.save).toMatchObject({ enabled: false, busy: true });
    expect(states.undo.enabled).toBe(true);
    expect(states.redo.enabled).toBe(true);
  });

  it.each(["readonly", "conflict"] as const)(
    "keeps shared Save, Undo, and Redo disabled for %s documents",
    (status) => {
      const entry = { candidate: document().candidate, blockViewKeys: new Map(), selection: null };
      const states = createToolbarStateById(controller(document({
        mode: "source",
        status,
        history: { past: [entry], future: [entry] },
      })));

      expect(states.save.enabled).toBe(false);
      expect(states.undo.enabled).toBe(false);
      expect(states.redo.enabled).toBe(false);
    },
  );
});

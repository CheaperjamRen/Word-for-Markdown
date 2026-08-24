import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { DocumentController } from "../app/use-document-controller";
import type { DocumentSession } from "../documents/session";
import { parseSourceDocument } from "../markdown/source-document";
import { RichDocumentSurface } from "./RichDocumentSurface";
import { createActiveEditorRegistry } from "./active-editor";

const encoder = new TextEncoder();

function session(): DocumentSession {
  const candidate = parseSourceDocument(new Uint8Array(encoder.encode(
    "# First\n\nSecond\n\nThird **bold**\n",
  )));
  return {
    kind: "document",
    id: "one",
    file: { kind: "untitled", displayName: "未命名 1" },
    baseline: candidate,
    candidate,
    status: "dirty",
    mode: "rich",
    revision: 0,
    zoomPercent: 100,
    draftId: null,
    externalChange: null,
    blockViewKeys: new Map(candidate.blocks.map((block, index) => [block.id, `stable-${index}`])),
    sourceBuffer: null,
    protectedRawBuffer: null,
    viewState: { scrollAnchor: null, selection: null },
    history: { past: [], future: [] },
  };
}

function controller(tab: DocumentSession): DocumentController {
  return {
    tabs: [tab], activeTabId: tab.id, closePrompt: null, closing: false, persistentMessage: null,
    newDocument: async () => undefined, openPaths: async () => undefined,
    save: async () => undefined, saveAs: async () => undefined,
    requestClose: () => undefined, requestCloseAll: () => undefined,
    resolveClose: async () => undefined, activate: () => undefined,
    setMode: () => "unchanged", getSourceView: () => null,
    commitRichEdit: vi.fn(() => ({ kind: "accepted" as const, candidateRevision: 1 })),
    beginProtectedRawEdit: vi.fn(() => false), updateProtectedRawBuffer: vi.fn(() => false),
    cancelProtectedRawEdit: vi.fn(() => false), commitProtectedRawEdit: vi.fn(() => ({ kind: "stale" as const })),
    applySourceChangeBatch: () => ({ kind: "stale" }),
    updateSourceSelection: () => undefined, updateSourceViewport: () => undefined,
    undo: () => false, redo: () => false,
  };
}

function tableSession(): DocumentSession {
  const candidate = parseSourceDocument(Uint8Array.from(encoder.encode(
    "# First\n\n| A | B |\n| --- | --- |\n| one | two |\n",
  )));
  return {
    kind: "document", id: "table", file: { kind: "untitled", displayName: "未命名 1" }, baseline: candidate,
    candidate, status: "dirty", mode: "rich", revision: 0, zoomPercent: 100, draftId: null, externalChange: null,
    blockViewKeys: new Map(candidate.blocks.map((block, index) => [block.id, `table-stable-${index}`])),
    sourceBuffer: null, protectedRawBuffer: null, viewState: { scrollAnchor: null, selection: null }, history: { past: [], future: [] },
  };
}

function emptySession(): DocumentSession {
  const candidate = parseSourceDocument(new Uint8Array());
  return {
    kind: "document", id: "empty", file: { kind: "untitled", displayName: "未命名 1" }, baseline: candidate,
    candidate, status: "dirty", mode: "rich", revision: 0, zoomPercent: 100, draftId: null, externalChange: null,
    blockViewKeys: new Map(), sourceBuffer: null, protectedRawBuffer: null,
    viewState: { scrollAnchor: null, selection: null }, history: { past: [], future: [] },
  };
}

function objectSession(): DocumentSession {
  const candidate = parseSourceDocument(Uint8Array.from(encoder.encode([
    "First",
    "",
    "| H |",
    "| --- |",
    "| x |",
    "",
    "```mermaid",
    "graph TD",
    "  A --> B",
    "```",
    "",
    "<widget>keep exact</widget>",
    "",
    "$$",
    "x^2",
    "$$",
    "",
    "```ts",
    "const value = 1;",
    "```",
    "",
    "Last",
  ].join("\n"))));
  return {
    kind: "document", id: "objects", file: { kind: "untitled", displayName: "objects.md" }, baseline: candidate,
    candidate, status: "dirty", mode: "rich", revision: 0, zoomPercent: 100, draftId: null, externalChange: null,
    blockViewKeys: new Map(candidate.blocks.map((block, index) => [block.id, `object-stable-${index}`])),
    sourceBuffer: null, protectedRawBuffer: null, viewState: { scrollAnchor: null, selection: null }, history: { past: [], future: [] },
  };
}

afterEach(cleanup);
afterEach(() => {
  if (!(globalThis as { __richSurfaceClipboardShim?: boolean }).__richSurfaceClipboardShim) return;
  delete (globalThis as { __richSurfaceClipboardShim?: boolean }).__richSurfaceClipboardShim;
  delete (globalThis as { DragEvent?: typeof DragEvent }).DragEvent;
  delete (globalThis as { ClipboardEvent?: typeof ClipboardEvent }).ClipboardEvent;
});

it("mounts ordinary Markdown blocks as one continuous document editor", async () => {
  const tab = session();
  const registry = createActiveEditorRegistry();
  const documentController = controller(tab);
  const rendered = render(
    <RichDocumentSurface controller={documentController} registry={registry} tab={tab} />,
  );
  const editor = screen.getByRole("textbox", { name: "编辑 Markdown 文档" });
  expect(editor).toBeInTheDocument();
  expect(editor.querySelectorAll("h1, p")).toHaveLength(3);
  expect(editor).toHaveTextContent("FirstSecondThird bold");
  expect(editor.querySelector("strong")).toHaveTextContent("bold");
  expect(rendered.container.querySelectorAll("[contenteditable='true']")).toHaveLength(1);

  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent.keyDown(editor, { ctrlKey: true, key: "b" });

  await vi.waitFor(() => expect(documentController.commitRichEdit).toHaveBeenCalledOnce());
  expect(vi.mocked(documentController.commitRichEdit).mock.calls[0]?.[0]).toMatchObject({
    sessionId: tab.id,
    baseCandidateRevision: tab.revision,
    mutations: [{
      kind: "replace-range",
      firstBlockViewKey: "stable-0",
      lastBlockViewKey: "stable-2",
    }],
  });
  expect(registry.getActive(tab.id, tab.revision)).not.toBeNull();
});

it("mounts and focuses an empty Rich document and inserts its first Markdown at the document start", async () => {
  const tab = emptySession();
  const documentController = controller(tab);
  render(
    <RichDocumentSurface
      controller={documentController}
      registry={createActiveEditorRegistry()}
      tab={tab}
    />,
  );

  const editor = screen.getByRole("textbox", { name: "编辑 Markdown 文档" });
  await vi.waitFor(() => expect(editor).toHaveFocus());
  if (!globalThis.DragEvent || !globalThis.ClipboardEvent) {
    (globalThis as { __richSurfaceClipboardShim?: boolean }).__richSurfaceClipboardShim = true;
    Object.defineProperty(globalThis, "DragEvent", {
      configurable: true,
      value: class TestDragEvent extends Event {},
    });
    Object.defineProperty(globalThis, "ClipboardEvent", {
      configurable: true,
      value: class TestClipboardEvent extends Event {},
    });
  }
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? "First line" : "",
    },
  });

  await vi.waitFor(() => expect(documentController.commitRichEdit).toHaveBeenCalledWith({
    sessionId: tab.id,
    baseCandidateRevision: tab.revision,
    mutations: [{ kind: "insert-after", blockViewKey: null, markdown: "First line" }],
    selectionAfter: null,
  }));
});

it("remounts continuous editor runs when an inserted object changes their stable boundaries", async () => {
  const initial = session();
  const updatedCandidate = parseSourceDocument(Uint8Array.from(encoder.encode(
    "# First\n\nSecond\n\n| A | B |\n| --- | --- |\n| one | two |\n\nThird **bold**\n",
  )));
  const stableKeyFor = (raw: string) => {
    if (raw.startsWith("# First")) return "stable-0";
    if (raw.startsWith("Second")) return "stable-1";
    if (raw.startsWith("| A | B |")) return "inserted-table";
    if (raw.startsWith("Third")) return "stable-2";
    throw new Error(`unexpected block: ${raw}`);
  };
  const updated: DocumentSession = {
    ...initial,
    candidate: updatedCandidate,
    revision: 1,
    blockViewKeys: new Map(updatedCandidate.blocks.map((block) => [block.id, stableKeyFor(block.raw)])),
  };
  const registry = createActiveEditorRegistry();
  const documentController = controller(initial);
  const rendered = render(
    <RichDocumentSurface controller={documentController} registry={registry} tab={initial} />,
  );

  rendered.rerender(
    <RichDocumentSurface controller={documentController} registry={registry} tab={updated} />,
  );

  await vi.waitFor(() => expect(screen.getAllByRole("textbox", { name: "编辑 Markdown 文档" })).toHaveLength(2));
  const editors = screen.getAllByRole("textbox", { name: "编辑 Markdown 文档" });
  expect(editors.filter((editor) => editor.textContent?.includes("Third bold"))).toHaveLength(1);
  const dropKeys = editors.flatMap((editor) =>
    [...editor.children].map((child) => (child as HTMLElement).dataset.richDropBlockKey),
  );
  expect(dropKeys).toEqual(["stable-0", "stable-1", "stable-2"]);
});

it("keeps the continuous editor and focus when ordinary text blocks split and receive new stable keys", async () => {
  const initial = session();
  const updatedCandidate = parseSourceDocument(Uint8Array.from(encoder.encode(
    "# First\n\nSec\n\nond\n\nThird **bold**\n",
  )));
  const updated: DocumentSession = {
    ...initial,
    candidate: updatedCandidate,
    revision: 1,
    blockViewKeys: new Map(updatedCandidate.blocks.map((block, index) => [block.id, `remapped-${index}`])),
  };
  const registry = createActiveEditorRegistry();
  const documentController = controller(initial);
  const rendered = render(
    <RichDocumentSurface controller={documentController} registry={registry} tab={initial} />,
  );
  const textbox = screen.getByRole("textbox", { name: "编辑 Markdown 文档" });
  textbox.focus();

  rendered.rerender(
    <RichDocumentSurface controller={documentController} registry={registry} tab={updated} />,
  );

  await vi.waitFor(() => expect(textbox).toHaveTextContent("FirstSecondThird bold"));
  expect(screen.getByRole("textbox", { name: "编辑 Markdown 文档" })).toBe(textbox);
  expect(textbox).toHaveFocus();
});

it("adds a paragraph inside the continuous document editor without switching block editors", async () => {
  const tab = session();
  const documentController = controller(tab);
  const registry = createActiveEditorRegistry();
  render(<RichDocumentSurface controller={documentController} registry={registry} tab={tab} />);
  const editor = screen.getByRole("textbox", { name: "编辑 Markdown 文档" });
  const second = editor.querySelectorAll("p")[0]!;
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(second);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  if (!globalThis.DragEvent || !globalThis.ClipboardEvent) {
    (globalThis as { __richSurfaceClipboardShim?: boolean }).__richSurfaceClipboardShim = true;
    Object.defineProperty(globalThis, "DragEvent", {
      configurable: true,
      value: class TestDragEvent extends Event {},
    });
    Object.defineProperty(globalThis, "ClipboardEvent", {
      configurable: true,
      value: class TestClipboardEvent extends Event {},
    });
  }
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? "Second\n\nInserted" : "",
    },
  });

  await vi.waitFor(() => {
    const mutation = vi.mocked(documentController.commitRichEdit).mock.lastCall?.[0].mutations[0];
    const markdown = mutation && "markdown" in mutation ? mutation.markdown : undefined;
    expect(markdown).toContain("Second\n\nInserted\n\nThird **bold**");
  });
  const mutation = vi.mocked(documentController.commitRichEdit).mock.lastCall?.[0].mutations[0];
  expect(mutation).toMatchObject({ kind: "replace-range" });
});

it("opens a table in place and exposes a rectangular batch command", async () => {
  const tab = tableSession();
  const tableController = controller(tab);
  const registry = createActiveEditorRegistry();
  const rendered = render(<RichDocumentSurface controller={tableController} registry={registry} tab={tab} />);
  const tableBlock = rendered.container.querySelector("[data-rich-block-kind='table']")!;
  const passiveTable = tableBlock.querySelector(".rich-document-surface__passive-table-wrap");
  expect(passiveTable).toBeInTheDocument();
  expect(passiveTable?.querySelector("table")).toBeInTheDocument();
  expect(passiveTable).toHaveStyle({ overflowX: "auto" });
  await userEvent.click(tableBlock);
  expect(await screen.findByTestId("table-editor")).toBeInTheDocument();
  const cells = screen.getAllByRole("gridcell");
  fireEvent.mouseDown(cells[2]!);
  fireEvent.mouseEnter(cells[3]!);
  fireEvent.mouseUp(window);
  const bridge = registry.getActive(tab.id, tab.revision);
  expect(bridge).not.toBeNull();
  expect(bridge!.run({ kind: "format", value: "bold", desired: "on" })).toBe("ran");
  expect(tableController.commitRichEdit).toHaveBeenCalledOnce();
  const mutation = vi.mocked(tableController.commitRichEdit).mock.calls[0]?.[0].mutations[0];
  const markdown = mutation && "markdown" in mutation ? mutation.markdown : undefined;
  expect(markdown).toContain("**one**");
  expect(markdown).toContain("**two**");
});

it("selects complex objects by one handle and drops the whole block at a document boundary", async () => {
  const tab = objectSession();
  const objectController = controller(tab);
  const rendered = render(
    <RichDocumentSurface controller={objectController} registry={createActiveEditorRegistry()} tab={tab} />,
  );
  const tableHandle = screen.getByRole("button", { name: "移动表格" });
  expect(screen.getByRole("button", { name: "移动 Mermaid" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "移动受保护内容" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "移动公式" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "移动代码块" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "移动段落" })).not.toBeInTheDocument();

  await userEvent.click(tableHandle);
  const selected = tableHandle.closest(".rich-object-shell")!;
  expect(selected).toHaveClass("rich-object-shell--selected");
  const lastBlock = tab.candidate.blocks.at(-1)!;
  const lastKey = tab.blockViewKeys.get(lastBlock.id)!;
  const lastParagraph = await vi.waitFor(() => {
    const element = rendered.container.querySelector<HTMLElement>(`[data-rich-drop-block-key="${lastKey}"]`);
    expect(element).toBeInTheDocument();
    return element!;
  });
  Object.defineProperty(selected, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, bottom: 200, left: 0, right: 600, width: 600, height: 100, x: 0, y: 100, toJSON: () => ({}) }),
  });
  Object.defineProperty(lastParagraph, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 400, bottom: 500, left: 0, right: 600, width: 600, height: 100, x: 0, y: 400, toJSON: () => ({}) }),
  });
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.defineProperties(tableHandle, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  const pointerEvent = (type: string, properties: Record<string, number>) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, { value }]),
    ));
    return event;
  };
  fireEvent(tableHandle, pointerEvent("pointerdown", { button: 0, clientX: 20, clientY: 120, pointerId: 7 }));
  expect(setPointerCapture).toHaveBeenCalledWith(7);
  fireEvent(rendered.getByTestId("rich-document-surface"), pointerEvent("pointermove", {
    clientX: 20,
    clientY: 410,
    pointerId: 7,
  }));
  expect(rendered.container.querySelector("[data-rich-drop-indicator]")).toBeInTheDocument();
  fireEvent(rendered.getByTestId("rich-document-surface"), pointerEvent("pointerup", {
    clientX: 20,
    clientY: 410,
    pointerId: 7,
  }));
  expect(releasePointerCapture).toHaveBeenCalledWith(7);

  const tableBlock = tab.candidate.blocks.find((block) => block.kind === "table")!;
  expect(objectController.commitRichEdit).toHaveBeenCalledWith({
    sessionId: tab.id,
    baseCandidateRevision: tab.revision,
    mutations: [{
      kind: "move-block",
      blockViewKey: tab.blockViewKeys.get(tableBlock.id),
      beforeBlockViewKey: lastKey,
    }],
    selectionAfter: null,
  });
  expect(objectController.commitRichEdit).toHaveBeenCalledOnce();

  vi.mocked(objectController.commitRichEdit).mockClear();
  fireEvent.keyDown(tableHandle, { altKey: true, key: "ArrowUp" });
  const firstBlock = tab.candidate.blocks[0]!;
  expect(objectController.commitRichEdit).toHaveBeenCalledWith({
    sessionId: tab.id,
    baseCandidateRevision: tab.revision,
    mutations: [{
      kind: "move-block",
      blockViewKey: tab.blockViewKeys.get(tableBlock.id),
      beforeBlockViewKey: tab.blockViewKeys.get(firstBlock.id),
    }],
    selectionAfter: null,
  });
});

it("does not move a complex object for a click, short pointer motion, or cancelled drag", () => {
  const tab = objectSession();
  const objectController = controller(tab);
  render(
    <RichDocumentSurface controller={objectController} registry={createActiveEditorRegistry()} tab={tab} />,
  );
  const handle = screen.getByRole("button", { name: "移动表格" });
  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  const surface = screen.getByTestId("rich-document-surface");
  const pointerEvent = (type: string, properties: Record<string, number>) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, { value }]),
    ));
    return event;
  };

  fireEvent(handle, pointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 8 }));
  fireEvent(surface, pointerEvent("pointermove", { clientX: 12, clientY: 12, pointerId: 8 }));
  fireEvent(surface, pointerEvent("pointerup", { clientX: 12, clientY: 12, pointerId: 8 }));
  expect(objectController.commitRichEdit).not.toHaveBeenCalled();

  fireEvent(handle, pointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 9 }));
  fireEvent(surface, pointerEvent("pointermove", { clientX: 10, clientY: 30, pointerId: 9 }));
  fireEvent(surface, pointerEvent("pointercancel", { pointerId: 9 }));
  expect(objectController.commitRichEdit).not.toHaveBeenCalled();
  expect(document.querySelector("[data-rich-drop-indicator]")).not.toBeInTheDocument();
});

it("keeps an ordinary code object editable while reserving drag for its handle", async () => {
  const tab = objectSession();
  const rendered = render(
    <RichDocumentSurface controller={controller(tab)} registry={createActiveEditorRegistry()} tab={tab} />,
  );
  const codeHandle = screen.getByRole("button", { name: "移动代码块" });
  const codeBlock = codeHandle.closest(".rich-object-shell")!.querySelector("[data-rich-block-kind='code']")!;
  await userEvent.click(codeBlock);

  const editor = await screen.findByRole("textbox", { name: "编辑当前 Markdown 块" });
  await vi.waitFor(() => expect(editor).toHaveFocus());
  expect(editor).toHaveTextContent("const value = 1;");
  expect(rendered.container.querySelectorAll(".rich-object-shell__handle")).not.toHaveLength(0);
});

it("disables whole-object movement while a file write is in flight", () => {
  const tab = { ...objectSession(), status: "saving" as const };
  render(<RichDocumentSurface controller={controller(tab)} registry={createActiveEditorRegistry()} tab={tab} />);

  expect(screen.getByRole("button", { name: "移动表格" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "移动受保护内容" })).toBeDisabled();
});

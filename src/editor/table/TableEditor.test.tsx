import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentController } from "../../app/use-document-controller";
import type { DocumentSession } from "../../documents/session";
import { parseSourceDocument } from "../../markdown/source-document";
import type { ActiveEditorBridge } from "../active-editor";
import { TableEditor } from "./TableEditor";

const encoder = new TextEncoder();

function session(): DocumentSession {
  const candidate = parseSourceDocument(Uint8Array.from(encoder.encode("| A | B |\n| --- | --- |\n| one | two |\n| three | four |")));
  return {
    kind: "document", id: "table-session", file: { kind: "untitled", displayName: "未命名 1" },
    baseline: candidate, candidate, status: "dirty", mode: "rich", revision: 0, zoomPercent: 100,
    draftId: null, externalChange: null,
    blockViewKeys: new Map(candidate.blocks.map((block) => [block.id, `stable-${block.id}`])),
    sourceBuffer: null, protectedRawBuffer: null, viewState: { scrollAnchor: null, selection: null },
    history: { past: [], future: [] },
  };
}

function controller(tab: DocumentSession): DocumentController {
  return {
    tabs: [tab], activeTabId: tab.id, closePrompt: null, closing: false, persistentMessage: null,
    newDocument: async () => undefined, openPaths: async () => undefined,
    save: async () => undefined, saveAs: async () => undefined, requestClose: () => undefined,
    requestCloseAll: () => undefined, resolveClose: async () => undefined, activate: () => undefined,
    setMode: () => "unchanged", getSourceView: () => null,
    commitRichEdit: vi.fn(() => ({ kind: "accepted" as const, candidateRevision: 1 })),
    beginProtectedRawEdit: vi.fn(() => false), updateProtectedRawBuffer: vi.fn(() => false),
    cancelProtectedRawEdit: vi.fn(() => false), commitProtectedRawEdit: vi.fn(() => ({ kind: "stale" as const })),
    applySourceChangeBatch: () => ({ kind: "stale" }), updateSourceSelection: () => undefined,
    updateSourceViewport: () => undefined, undo: () => false, redo: () => false,
  };
}

function committedMarkdown(host: DocumentController): string | undefined {
  const mutation = vi.mocked(host.commitRichEdit).mock.lastCall?.[0].mutations[0];
  return mutation && "markdown" in mutation ? mutation.markdown : undefined;
}

afterEach(cleanup);

describe("TableEditor", () => {
  it("commits a cell with Tab and continues editing in the next cell", async () => {
    const tab = session();
    const host = controller(tab);
    const rendered = render(<TableEditor
      block={tab.candidate.blocks[0]!}
      blockViewKey={tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!}
      candidateRevision={tab.revision}
      controller={host}
      sessionId={tab.id}
      tab={tab}
    />);
    const cells = screen.getAllByRole("gridcell");
    fireEvent.doubleClick(cells[2]!);
    const editor = screen.getByRole("textbox", { name: "编辑单元格" });
    editor.textContent = "edited one";
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: "Tab" });

    await waitFor(() => expect(committedMarkdown(host)).toContain("edited one"));
    const nextEditor = screen.getByRole("textbox", { name: "编辑单元格" });
    expect(nextEditor).not.toBe(editor);
    expect(nextEditor).toHaveTextContent("two");
    expect(cells[3]).toHaveAttribute("aria-selected", "true");

    const acceptedCandidate = parseSourceDocument(Uint8Array.from(encoder.encode(committedMarkdown(host)!)));
    rendered.rerender(<TableEditor
      block={acceptedCandidate.blocks[0]!}
      blockViewKey={tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!}
      candidateRevision={1}
      controller={host}
      sessionId={tab.id}
      tab={{ ...tab, candidate: acceptedCandidate, revision: 1 }}
    />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "编辑单元格" })).toHaveTextContent("two"));
  });

  it("commits with Enter to the cell below and keeps arrow keys inside cell text", async () => {
    const tab = session();
    const host = controller(tab);
    render(<TableEditor
      block={tab.candidate.blocks[0]!}
      blockViewKey={tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!}
      candidateRevision={tab.revision}
      controller={host}
      sessionId={tab.id}
      tab={tab}
    />);
    const cells = screen.getAllByRole("gridcell");
    fireEvent.doubleClick(cells[2]!);
    const editor = screen.getByRole("textbox", { name: "编辑单元格" });
    expect(fireEvent.keyDown(editor, { key: "ArrowRight" })).toBe(true);
    expect(cells[2]).toHaveAttribute("aria-selected", "true");
    editor.textContent = "entered";
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(committedMarkdown(host)).toContain("entered"));
    expect(screen.getByRole("textbox", { name: "编辑单元格" })).toHaveTextContent("three");
    expect(cells[4]).toHaveAttribute("aria-selected", "true");
  });

  it("cancels the current cell edit with Escape without committing", async () => {
    const tab = session();
    const host = controller(tab);
    render(<TableEditor
      block={tab.candidate.blocks[0]!}
      blockViewKey={tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!}
      candidateRevision={tab.revision}
      controller={host}
      sessionId={tab.id}
      tab={tab}
    />);
    const cells = screen.getAllByRole("gridcell");
    fireEvent.doubleClick(cells[2]!);
    const editor = screen.getByRole("textbox", { name: "编辑单元格" });
    editor.textContent = "discard me";
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑单元格" })).not.toBeInTheDocument());
    expect(host.commitRichEdit).not.toHaveBeenCalled();
    expect(cells[2]?.textContent).toBe("one");
  });

  it("drag-selects a rectangle and applies one batch format transaction", () => {
    const tab = session();
    const host = controller(tab);
    let bridge: ActiveEditorBridge | null = null;
    render(<TableEditor
      block={tab.candidate.blocks[0]!}
      blockViewKey={tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!}
      candidateRevision={tab.revision}
      controller={host}
      registerBridge={(value) => { bridge = value; return () => undefined; }}
      sessionId={tab.id}
      tab={tab}
    />);
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[2]!);
    fireEvent.mouseEnter(cells[5]!);
    fireEvent.mouseUp(window);
    expect(screen.getByRole("grid")).toHaveFocus();
    expect(screen.getByText("已选 4 个单元格")).toBeInTheDocument();
    expect(screen.getByTestId("table-selection-overlay")).toBeInTheDocument();
    expect(bridge).not.toBeNull();
    expect(bridge!.getState().formats.bold).toBe("off");
    expect(bridge!.run({ kind: "format", value: "bold", desired: "on" })).toBe("ran");
    expect(host.commitRichEdit).toHaveBeenCalledOnce();
    expect(committedMarkdown(host)).toContain("**one**");
  });

  it("owns TSV copy and exact-shape paste without a second mutation path", () => {
    const tab = session();
    const host = controller(tab);
    render(<TableEditor
      block={tab.candidate.blocks[0]!}
      blockViewKey={tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!}
      candidateRevision={tab.revision}
      controller={host}
      sessionId={tab.id}
      tab={tab}
    />);
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[2]!);
    fireEvent.mouseEnter(cells[5]!);
    fireEvent.mouseUp(window);
    const setData = vi.fn();
    fireEvent.copy(screen.getByRole("grid"), { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "one\ttwo\nthree\tfour");
    fireEvent.paste(screen.getByRole("grid"), {
      clipboardData: { getData: () => "一\t二\r\n三\t四\r\n" },
    });
    expect(host.commitRichEdit).toHaveBeenCalledOnce();
    expect(committedMarkdown(host)).toContain("一");
  });

  it("cuts only after both clipboard formats are written and commits one clear", () => {
    const tab = session();
    const host = controller(tab);
    render(<TableEditor
      block={tab.candidate.blocks[0]!}
      blockViewKey={tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!}
      candidateRevision={tab.revision}
      controller={host}
      sessionId={tab.id}
      tab={tab}
    />);
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[2]!);
    fireEvent.mouseEnter(cells[5]!);
    fireEvent.mouseUp(window);
    const setData = vi.fn();
    fireEvent.cut(screen.getByRole("grid"), { clipboardData: { setData } });
    expect(setData).toHaveBeenNthCalledWith(1, "text/plain", "one\ttwo\nthree\tfour");
    expect(setData).toHaveBeenNthCalledWith(2, "text/html", expect.stringContaining("<table>"));
    expect(host.commitRichEdit).toHaveBeenCalledOnce();
    const markdown = committedMarkdown(host);
    expect(markdown).not.toContain("one");
    expect(markdown).not.toContain("four");
  });

  it("keeps HTML semantics on keyboard cut when the Clipboard API supports rich items", async () => {
    const tab = session();
    const host = controller(tab);
    class TestClipboardItem {
      constructor(public readonly data: Record<string, Blob>) {}
    }
    const write = vi.fn(async (_items: readonly TestClipboardItem[]) => undefined);
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { write } });
    render(<TableEditor
      block={tab.candidate.blocks[0]!}
      blockViewKey={tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!}
      candidateRevision={tab.revision}
      controller={host}
      sessionId={tab.id}
      tab={tab}
    />);
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[2]!);
    fireEvent.mouseEnter(cells[5]!);
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { ctrlKey: true, key: "x" });
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    const item = write.mock.calls[0]![0]![0]!;
    expect(Object.keys(item.data)).toEqual(expect.arrayContaining(["text/plain", "text/html"]));
    expect(host.commitRichEdit).toHaveBeenCalledOnce();
  });

  it("deletes the selected body rows as one clearly scoped table operation", () => {
    const tab = session();
    const host = controller(tab);
    render(<TableEditor
      block={tab.candidate.blocks[0]!}
      blockViewKey={tab.blockViewKeys.get(tab.candidate.blocks[0]!.id)!}
      candidateRevision={tab.revision}
      controller={host}
      sessionId={tab.id}
      tab={tab}
    />);
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[2]!);
    fireEvent.mouseEnter(cells[5]!);
    fireEvent.mouseUp(window);
    fireEvent.click(screen.getByRole("button", { name: "删除选中行" }));
    expect(host.commitRichEdit).toHaveBeenCalledOnce();
    const markdown = committedMarkdown(host);
    expect(markdown).not.toContain("three");
    expect(markdown).not.toContain("four");
  });
});

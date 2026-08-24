import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceBlock } from "../contracts/markdown";
import {
  LexicalBlockEditor,
  LexicalMarkdownEditor,
  type LexicalMarkdownEditorProps,
} from "./LexicalBlockEditor";
import type { ActiveEditorBridge } from "./active-editor";

const block = (overrides: Partial<SourceBlock>): SourceBlock => ({
  id: "paragraph-1",
  kind: "paragraph",
  start: 0,
  end: 3,
  byteStart: 0,
  byteEnd: 9,
  raw: "原段落",
  protected: false,
  ...overrides,
});

const editableParagraph = (raw: string) => block({ raw });
const protectedDirective = () =>
  block({
    id: "directive-1",
    kind: "paragraph",
    raw: ":::private\nraw\n:::",
    protected: true,
  });
const editableCodeBlock = () =>
  block({ id: "code-1", kind: "code", raw: "```ts\n1\n```" });
const editableQuote = () =>
  block({ id: "quote-1", kind: "blockquote", raw: "> quoted" });
const editableList = () =>
  block({ id: "list-1", kind: "list", raw: "- first\n- second" });

function selectEditorContents(editor: HTMLElement): void {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

afterEach(cleanup);
afterEach(() => {
  if ((globalThis as { __testDragEvent?: unknown }).__testDragEvent) {
    delete (globalThis as { __testDragEvent?: unknown }).__testDragEvent;
    delete (globalThis as { DragEvent?: unknown }).DragEvent;
    delete (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent;
  }
});

describe("LexicalBlockEditor", () => {
  it("reports the exact stable block under the live caret for insert commands", async () => {
    let bridge: ActiveEditorBridge | null = null;
    const ContinuousEditor = LexicalMarkdownEditor as ComponentType<
      LexicalMarkdownEditorProps & { blockViewKeys: readonly string[] }
    >;
    render(
      <ContinuousEditor
        ariaLabel="连续文档"
        blockViewKey="stable-first"
        blockViewKeys={["stable-first", "stable-second", "stable-third"]}
        candidateRevision={3}
        editorKey="continuous-anchor"
        markdown={"# First\n\nSecond\n\nThird"}
        onMarkdownChange={() => undefined}
        registerBridge={(value) => {
          bridge = value;
          return () => undefined;
        }}
        sessionId="session-anchor"
      />,
    );
    const editor = screen.getByRole("textbox", { name: "连续文档" });
    const second = editor.querySelectorAll("p")[0]!;
    const range = document.createRange();
    range.selectNodeContents(second);
    range.collapse(true);
    editor.focus();
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    await waitFor(() => expect(
      (bridge as unknown as ActiveEditorBridge & { getInsertionBlockViewKey(): string | null })
        .getInsertionBlockViewKey(),
    ).toBe("stable-second"));
  });

  it("refuses to guess an insert anchor when Lexical blocks no longer match stable keys", () => {
    let bridge: ActiveEditorBridge | null = null;
    const ContinuousEditor = LexicalMarkdownEditor as ComponentType<
      LexicalMarkdownEditorProps & { blockViewKeys: readonly string[] }
    >;
    render(
      <ContinuousEditor
        ariaLabel="映射失配文档"
        blockViewKey="stable-first"
        blockViewKeys={["stable-first", "stable-second"]}
        candidateRevision={3}
        editorKey="continuous-mismatch"
        markdown={"# First\n\nSecond\n\nThird"}
        onMarkdownChange={() => undefined}
        registerBridge={(value) => {
          bridge = value;
          return () => undefined;
        }}
        sessionId="session-mismatch"
      />,
    );

    expect(
      (bridge as unknown as ActiveEditorBridge & { getInsertionBlockViewKey(): string | null })
        .getInsertionBlockViewKey(),
    ).toBeNull();
  });

  it("does not emit a patch merely by hydrating", async () => {
    const onPatch = vi.fn();
    render(
      <LexicalBlockEditor
        block={editableParagraph("原段落")}
        onPatch={onPatch}
      />,
    );
    await screen.findByRole("textbox", { name: "编辑当前 Markdown 块" });
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("restores blank-document autofocus when an async WebView mount returns focus to the page", async () => {
    render(
      <LexicalMarkdownEditor
        ariaLabel="空白文档"
        autoFocus
        blockViewKey="empty"
        candidateRevision={0}
        editorKey="empty-run"
        markdown=""
        onMarkdownChange={() => undefined}
        sessionId="empty-session"
      />,
    );
    const editor = screen.getByRole("textbox", { name: "空白文档" });
    await waitFor(() => expect(editor).toHaveFocus());

    document.body.tabIndex = -1;
    document.body.focus();
    expect(editor).not.toHaveFocus();

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(editor).toHaveFocus();
    document.body.removeAttribute("tabindex");
  });

  it("commits one completed IME composition and no intermediate composition updates", async () => {
    const onPatch = vi.fn();
    render(<LexicalBlockEditor block={editableParagraph("")} onPatch={onPatch} />);
    const editor = screen.getByRole("textbox", { name: "编辑当前 Markdown 块" });

    editor.focus();
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    await userEvent.type(editor, "中文😀");
    editor.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中文😀" }));
    expect(onPatch).not.toHaveBeenCalled();

    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文😀" }));
    await waitFor(() => expect(onPatch).toHaveBeenCalledOnce());
    expect(onPatch).toHaveBeenLastCalledWith({ blockId: "paragraph-1", markdown: "中文😀" });
  });

  it("serializes a multi-block paste as one semantic block transaction", async () => {
    const onPatch = vi.fn();
    const nativeDragEvent = globalThis.DragEvent;
    if (!nativeDragEvent) {
      (globalThis as { __testDragEvent?: unknown }).__testDragEvent = true;
      Object.defineProperty(globalThis, "DragEvent", {
        configurable: true,
        value: class TestDragEvent extends Event {},
      });
      Object.defineProperty(globalThis, "ClipboardEvent", {
        configurable: true,
        value: class TestClipboardEvent extends Event {},
      });
    } else if (!globalThis.ClipboardEvent) {
      (globalThis as { __testDragEvent?: unknown }).__testDragEvent = true;
      Object.defineProperty(globalThis, "ClipboardEvent", {
        configurable: true,
        value: class TestClipboardEvent extends Event {},
      });
    }
    render(<LexicalBlockEditor block={editableParagraph("原文")} onPatch={onPatch} />);
    const editor = screen.getByRole("textbox", { name: "编辑当前 Markdown 块" });
    selectEditorContents(editor);
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => type === "text/plain" ? "第一段\n\n第二段" : "",
      },
    });
    await waitFor(() => expect(onPatch).toHaveBeenCalledOnce());
    expect(onPatch).toHaveBeenLastCalledWith({
      blockId: "paragraph-1",
      markdown: "第一段\n\n第二段",
    });
  });

  it("keeps the same editor instance when only the parse-local block id changes", async () => {
    const onPatch = vi.fn();
    const rendered = render(
      <LexicalBlockEditor
        block={block({ id: "parse-1", raw: "same" })}
        blockViewKey="stable-block"
        onPatch={onPatch}
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "编辑当前 Markdown 块" });

    rendered.rerender(
      <LexicalBlockEditor
        block={block({ id: "parse-2", raw: "same" })}
        blockViewKey="stable-block"
        onPatch={onPatch}
      />,
    );

    expect(screen.getByRole("textbox", { name: "编辑当前 Markdown 块" })).toBe(textbox);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("rehydrates an external candidate in place without emitting it back", async () => {
    const onMarkdownChange = vi.fn();
    const rendered = render(
      <LexicalMarkdownEditor
        ariaLabel="候选同步文档"
        blockViewKey="stable-sync"
        candidateRevision={1}
        editorKey="stable-run"
        markdown="Before"
        onMarkdownChange={onMarkdownChange}
        sessionId="session-sync"
      />,
    );
    const textbox = screen.getByRole("textbox", { name: "候选同步文档" });
    textbox.focus();

    rendered.rerender(
      <LexicalMarkdownEditor
        ariaLabel="候选同步文档"
        blockViewKey="stable-sync"
        candidateRevision={2}
        editorKey="stable-run"
        markdown="After external change"
        onMarkdownChange={onMarkdownChange}
        sessionId="session-sync"
      />,
    );

    await waitFor(() => expect(textbox).toHaveTextContent("After external change"));
    expect(screen.getByRole("textbox", { name: "候选同步文档" })).toBe(textbox);
    expect(onMarkdownChange).not.toHaveBeenCalled();
  });

  it("emits only the selected block after Ctrl+B-style formatting", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(
      <LexicalBlockEditor
        block={editableParagraph("原段落")}
        onPatch={onPatch}
      />,
    );
    const editor = screen.getByRole("textbox", {
      name: "编辑当前 Markdown 块",
    });
    selectEditorContents(editor);
    fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
    await waitFor(() =>
      expect(onPatch).toHaveBeenLastCalledWith({
        blockId: "paragraph-1",
        markdown: "**原段落**",
      }),
    );
  });

  it("registers one exact bridge that force-formats the live selection and retires on unmount", async () => {
    const onPatch = vi.fn();
    let bridge: ActiveEditorBridge | null = null;
    const unregister = vi.fn();
    const rendered = render(
      <LexicalBlockEditor
        block={editableParagraph("bridge text")}
        blockViewKey="stable-a"
        candidateRevision={4}
        onPatch={onPatch}
        registerBridge={(value) => {
          bridge = value;
          return unregister;
        }}
        sessionId="session-a"
      />,
    );
    screen.getByRole("textbox", { name: "编辑当前 Markdown 块" });
    expect(bridge!.restoreSelection({
      blockViewKey: "stable-a",
      anchorTextOffset: 0,
      focusTextOffset: "bridge text".length,
    })).toBe("restored");

    expect(bridge).toMatchObject({
      sessionId: "session-a",
      candidateRevision: 4,
      blockViewKey: "stable-a",
    });
    expect(bridge!.run({ kind: "format", value: "bold", desired: "on" })).toBe("ran");
    await waitFor(() => expect(onPatch).toHaveBeenLastCalledWith({
      blockId: "paragraph-1",
      markdown: "**bridge text**",
    }));
    expect(bridge!.run({ kind: "block", value: "h2" })).toBe("ran");
    await waitFor(() => expect(onPatch).toHaveBeenLastCalledWith({
      blockId: "paragraph-1",
      markdown: "## **bridge text**",
    }));
    expect(bridge!.run({ kind: "block", value: "paragraph" })).toBe("ran");
    expect(bridge!.run({ kind: "list", value: "bullet" })).toBe("ran");
    await waitFor(() => expect(onPatch).toHaveBeenLastCalledWith({
      blockId: "paragraph-1",
      markdown: "- **bridge text**",
    }));

    rendered.unmount();
    expect(unregister).toHaveBeenCalledOnce();
    expect(bridge!.focus()).toBe("stale");
  });

  it("formats only the exact selected substring inside one text node", async () => {
    const onPatch = vi.fn();
    let bridge: ActiveEditorBridge | null = null;
    render(
      <LexicalBlockEditor
        block={editableParagraph("abcdef")}
        blockViewKey="stable-partial"
        candidateRevision={1}
        onPatch={onPatch}
        registerBridge={(value) => {
          bridge = value;
          return () => undefined;
        }}
        sessionId="session-partial"
      />,
    );
    screen.getByRole("textbox", { name: "编辑当前 Markdown 块" });
    expect(bridge!.restoreSelection({
      blockViewKey: "stable-partial",
      anchorTextOffset: 2,
      focusTextOffset: 4,
    })).toBe("restored");

    expect(bridge!.run({ kind: "format", value: "bold", desired: "on" })).toBe("ran");

    await waitFor(() => expect(onPatch).toHaveBeenLastCalledWith({
      blockId: "paragraph-1",
      markdown: "ab**cd**ef",
    }));
  });

  it("applies and removes a link through the same live selection bridge", async () => {
    const onPatch = vi.fn();
    let bridge: ActiveEditorBridge | null = null;
    render(
      <LexicalBlockEditor
        block={editableParagraph("link text")}
        blockViewKey="stable-link"
        candidateRevision={2}
        onPatch={onPatch}
        registerBridge={(value) => {
          bridge = value;
          return () => undefined;
        }}
        sessionId="session-link"
      />,
    );
    screen.getByRole("textbox", { name: "编辑当前 Markdown 块" });
    expect(bridge!.restoreSelection({
      blockViewKey: "stable-link",
      anchorTextOffset: 0,
      focusTextOffset: "link text".length,
    })).toBe("restored");

    expect(bridge!.getState().canLink).toBe(true);
    expect(bridge!.run({ kind: "link", url: "https://example.com" })).toBe("ran");
    await waitFor(() => expect(onPatch).toHaveBeenLastCalledWith({
      blockId: "paragraph-1",
      markdown: "[link text](https://example.com)",
    }));
    expect(bridge!.run({ kind: "link", url: null })).toBe("ran");
    await waitFor(() => expect(onPatch).toHaveBeenLastCalledWith({
      blockId: "paragraph-1",
      markdown: "link text",
    }));
  });

  it("hydrates legal single-tilde GFM deletion and serializes a touched block with double tildes", async () => {
    const onPatch = vi.fn();
    render(<LexicalBlockEditor block={editableParagraph("~one~")} onPatch={onPatch} />);
    const editor = screen.getByRole("textbox", { name: "编辑当前 Markdown 块" });
    selectEditorContents(editor);
    fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
    await waitFor(() => expect(onPatch).toHaveBeenCalled());
    const markdown = onPatch.mock.lastCall?.[0].markdown as string;
    expect(markdown).toContain("~~one~~");
    expect(markdown).not.toMatch(/(^|[^~])~one~([^~]|$)/);
  });

  it("emits the original markdown when the user reverts a prior change", async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(
      <LexicalBlockEditor
        block={editableParagraph("原段落")}
        onPatch={onPatch}
      />,
    );
    const editor = screen.getByRole("textbox", {
      name: "编辑当前 Markdown 块",
    });
    selectEditorContents(editor);
    fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
    await waitFor(() =>
      expect(onPatch).toHaveBeenLastCalledWith({
        blockId: "paragraph-1",
        markdown: "**原段落**",
      }),
    );

    selectEditorContents(editor);
    fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
    await waitFor(() =>
      expect(onPatch).toHaveBeenLastCalledWith({
        blockId: "paragraph-1",
        markdown: "原段落",
      }),
    );
  });

  it("refuses a protected block at the component boundary", () => {
    expect(() =>
      render(
        <LexicalBlockEditor
          block={protectedDirective()}
          onPatch={vi.fn()}
        />,
      ),
    ).toThrow("protected block");
  });

  it.each([
    [editableQuote(), "quoted"],
    [editableList(), "firstsecond"],
    [editableCodeBlock(), "1"],
  ])("hydrates every supported whole-document block kind in place", (sourceBlock, text) => {
    const { container } = render(<LexicalBlockEditor block={sourceBlock} onPatch={vi.fn()} />);
    expect(container.querySelector("[contenteditable='true']")?.textContent).toContain(text);
  });

  it("exports the default module contract required by the Task 7 lazy import", async () => {
    const module = await import("./LexicalBlockEditor");
    expect(module.default).toBe(module.LexicalBlockEditor);
  });
});

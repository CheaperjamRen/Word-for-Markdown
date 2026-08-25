import { EditorView } from "@codemirror/view";
import { redo as codeMirrorRedo, undo as codeMirrorUndo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { Transaction } from "@codemirror/state";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  SourceBufferState,
  SourceChangeAck,
  SourceChangeBatch,
  SourceViewModel,
} from "../contracts/markdown";
import type { SourceEditorBridge } from "../app/active-source-editor";
import { SourceEditor } from "./SourceEditor";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function sourceView(text: string): SourceViewModel {
  return {
    text,
    byteOffsetAtViewOffset: Uint32Array.from({ length: text.length + 1 }, (_, index) => index),
  };
}

function editorFrom(container: HTMLElement): EditorView {
  const content = container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("missing real CodeMirror content");
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("missing real EditorView");
  return view;
}

function props(overrides: Partial<React.ComponentProps<typeof SourceEditor>> = {}) {
  return {
    sessionId: "one",
    candidateRevision: 0,
    view: sourceView("A"),
    buffer: null,
    readOnly: false,
    zoomPercent: 100,
    initialSelection: { anchor: 0, head: 0 },
    initialViewportOffset: null,
    onChangeBatch: vi.fn((batch: SourceChangeBatch): SourceChangeAck => ({
      kind: "accepted",
      candidateRevision: batch.baseCandidateRevision + 1,
      view: sourceView(batch.bufferText),
    })),
    onSelectionChange: vi.fn(),
    onViewportOffsetChange: vi.fn(),
    onUndo: vi.fn(() => false),
    onRedo: vi.fn(() => false),
    onSave: vi.fn(),
    registerBridge: vi.fn(() => () => undefined),
    ...overrides,
  } satisfies React.ComponentProps<typeof SourceEditor>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourceEditor real CodeMirror integration", () => {
  it("uses global theme tokens instead of a fixed light CodeMirror palette", () => {
    const source = readFileSync(resolve(process.cwd(), "src/source/SourceEditor.tsx"), "utf8");
    const css = readFileSync(resolve(process.cwd(), "src/source/source-editor.css"), "utf8");

    expect(source).not.toContain('backgroundColor: "#ffffff"');
    expect(source).not.toContain('color: "#46586a"');
    expect(css).not.toMatch(/background:\s*#fff(?:fff)?\s*;/i);
    for (const token of [
      "--paper", "--text-primary", "--reader-selection", "--source-heading",
      "--source-emphasis", "--source-strong", "--source-monospace", "--source-link",
      "--source-comment", "--source-invalid",
    ]) {
      expect(`${source}\n${css}`).toContain(`var(${token})`);
    }
  });

  it("destroys every real StrictMode EditorView and invalidates each exact mount registration", () => {
    const destroy = vi.spyOn(EditorView.prototype, "destroy");
    const tokens = new Set<symbol>();
    const unregister = vi.fn();
    const rendered = render(<StrictMode><SourceEditor {...props({
      registerBridge: (bridge) => { tokens.add(bridge.mountToken); return unregister; },
    })} /></StrictMode>);
    expect(rendered.container.querySelectorAll(".cm-editor")).toHaveLength(1);

    rendered.unmount();

    expect(tokens.size).toBeGreaterThan(0);
    expect(destroy).toHaveBeenCalledTimes(tokens.size);
    expect(unregister).toHaveBeenCalledTimes(tokens.size);
  });

  it("accepts two edits before React props arrive without losing the synchronous canonical base", () => {
    const componentProps = props();
    const rendered = render(<StrictMode><SourceEditor {...componentProps} /></StrictMode>);
    const view = editorFrom(rendered.container);

    act(() => view.dispatch({ changes: { from: 1, insert: "B" } }));
    act(() => view.dispatch({ changes: { from: 2, insert: "C" } }));

    expect(componentProps.onChangeBatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(componentProps.onChangeBatch).mock.calls.map(([batch]) => ({
      base: batch.baseCandidateRevision,
      text: batch.bufferText,
    }))).toEqual([
      { base: 0, text: "AB" },
      { base: 1, text: "ABC" },
    ]);
    expect(rendered.container.querySelectorAll(".cm-editor")).toHaveLength(1);
  });

  it("keeps an invalid surrogate editable, uses local history to repair it, then returns to app history", async () => {
    const onUndo = vi.fn(() => true);
    const onChangeBatch = vi.fn((batch: SourceChangeBatch): SourceChangeAck => {
      if ([...batch.bufferText].some((character) => character.charCodeAt(0) === 0xd800)) {
        return { kind: "rejected", validationError: "invalid" };
      }
      return {
        kind: "accepted",
        candidateRevision: batch.baseCandidateRevision + (batch.bufferText === "A" ? 0 : 1),
        view: sourceView(batch.bufferText),
      };
    });
    const rendered = render(<SourceEditor {...props({ onChangeBatch, onUndo })} />);
    const view = editorFrom(rendered.container);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;

    act(() => view.dispatch({ changes: { from: 1, insert: "\ud800" } }));
    expect(view.state.doc.toString().charCodeAt(1)).toBe(0xd800);
    expect(content).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("note")).toHaveTextContent("有字符无法保存。内容已保留，请删除或替换。");

    content.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z" }));
    await waitFor(() => expect(view.state.doc.toString()).toBe("A"));
    expect(onUndo).not.toHaveBeenCalled();
    expect(content).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    content.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z" }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("keeps multiple invalid Ctrl+Z/Y transitions in local history before exact repair returns both keys to app history", async () => {
    const onUndo = vi.fn(() => true);
    const onRedo = vi.fn(() => true);
    const onChangeBatch = vi.fn((batch: SourceChangeBatch): SourceChangeAck => {
      if (batch.bufferText.includes("\ud800")) {
        return { kind: "rejected", validationError: "invalid" };
      }
      return { kind: "accepted", candidateRevision: 0, view: sourceView(batch.bufferText) };
    });
    const rendered = render(<SourceEditor {...props({
      view: sourceView("B"),
      onChangeBatch,
      onUndo,
      onRedo,
    })} />);
    const view = editorFrom(rendered.container);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const key = (value: "z" | "y") => content.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: value,
    }));

    act(() => view.dispatch({ changes: { from: 1, insert: "\ud800" } }));
    act(() => view.dispatch({ changes: [
      { from: 0, insert: "X" },
      { from: 2, insert: "Y" },
    ] }));
    key("z");
    await waitFor(() => expect(view.state.doc.toString()).toBe("B\ud800"));
    key("y");
    await waitFor(() => expect(view.state.doc.toString()).toBe("XB\ud800Y"));
    key("z");
    await waitFor(() => expect(view.state.doc.toString()).toBe("B\ud800"));
    key("z");
    await waitFor(() => expect(view.state.doc.toString()).toBe("B"));
    expect(onUndo).not.toHaveBeenCalled();
    expect(onRedo).not.toHaveBeenCalled();
    expect(onChangeBatch.mock.calls.map(([batch]) => batch.bufferText)).toEqual([
      "B\ud800", "XB\ud800Y", "B\ud800", "XB\ud800Y", "B\ud800", "B",
    ]);
    expect(codeMirrorRedo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("B");

    key("y");
    expect(onRedo).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("B");
    key("z");
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it.each([
    ["s", "onSave"],
    ["z", "onUndo"],
    ["y", "onRedo"],
  ] as const)("solely consumes Source Ctrl+%s even when the application action is a no-op", (key, callback) => {
    const componentProps = props();
    const rendered = render(<SourceEditor {...componentProps} />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = editorFrom(rendered.container);
    const before = view.state.doc.toString();
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key,
    });

    content.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(componentProps[callback]).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe(before);
  });

  it("does not bind Ctrl+Shift+S so the shell remains its sole owner", () => {
    const componentProps = props();
    const rendered = render(<SourceEditor {...componentProps} />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      shiftKey: true,
      key: "s",
    });

    content.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(componentProps.onSave).not.toHaveBeenCalled();
  });

  it.each(["查找", "替换"] as const)(
    "owns Source S/Z/Y exactly once while the real %s field has focus",
    async (fieldName) => {
      const componentProps = props();
      const rendered = render(<SourceEditor {...componentProps} />);
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      content.focus();
      content.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, ctrlKey: true, key: "f",
      }));
      const field = await screen.findByRole("textbox", { name: fieldName });
      field.focus();

      for (const [key, callback] of [
        ["s", "onSave"],
        ["z", "onUndo"],
        ["y", "onRedo"],
      ] as const) {
        const event = new KeyboardEvent("keydown", {
          bubbles: true, cancelable: true, ctrlKey: true, key,
        });
        field.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(componentProps[callback]).toHaveBeenCalledOnce();
      }
    },
  );

  it("uses local Source history from Find focus while rejected and leaves app Undo untouched", async () => {
    const onUndo = vi.fn(() => true);
    const onChangeBatch = vi.fn((batch: SourceChangeBatch): SourceChangeAck =>
      batch.bufferText.includes("\ud800")
        ? { kind: "rejected", validationError: "invalid" }
        : { kind: "accepted", candidateRevision: 0, view: sourceView(batch.bufferText) },
    );
    const rendered = render(<SourceEditor {...props({ onChangeBatch, onUndo })} />);
    const view = editorFrom(rendered.container);
    act(() => view.dispatch({ changes: { from: 1, insert: "\ud800" } }));
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    content.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "f",
    }));
    const find = await screen.findByRole("textbox", { name: "查找" });
    const undoEvent = new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "z",
    });

    find.dispatchEvent(undoEvent);

    expect(undoEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(view.state.doc.toString()).toBe("A"));
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("soft-wraps one logical line without changing its text or line count", () => {
    const text = `中文 long-url https://example.com/${"segment/".repeat(200)}`;
    const componentProps = props({ view: sourceView(text) });
    const rendered = render(<SourceEditor {...componentProps} />);
    const view = editorFrom(rendered.container);

    expect(view.lineWrapping).toBe(true);
    expect(view.state.doc.lines).toBe(1);
    expect(view.state.doc.toString()).toBe(text);
    expect(rendered.container.querySelector(".cm-content")).toHaveClass("cm-lineWrapping");
    expect(rendered.container.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(componentProps.onChangeBatch).not.toHaveBeenCalled();
  });

  it("marks invisible control characters and shows an exact cursor only while dragging", async () => {
    const rendered = render(<SourceEditor {...props({ view: sourceView("A\u200bB") })} />);
    const view = editorFrom(rendered.container);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;

    await waitFor(() => expect(rendered.container.querySelector(".cm-specialChar")).not.toBeNull());
    vi.spyOn(view, "posAtCoords").mockReturnValue(1);
    content.dispatchEvent(new MouseEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: 8,
      clientY: 8,
    }));
    await waitFor(() => expect(rendered.container.querySelector(".cm-dropCursor")).not.toBeNull());

    content.dispatchEvent(new MouseEvent("dragleave", { bubbles: true, relatedTarget: document.body }));
    await waitFor(() => expect(rendered.container.querySelector(".cm-dropCursor")).toBeNull());
  });

  it("uses Tab for indentation without consuming unsupported multi-selection shortcuts", () => {
    const rendered = render(<SourceEditor {...props({ view: sourceView("- item") })} />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = editorFrom(rendered.container);
    act(() => view.dispatch({ selection: { anchor: 0 } }));

    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
    content.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toMatch(/^\s+- item$/);

    act(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }));
    const multi = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "d",
    });
    content.dispatchEvent(multi);
    expect(multi.defaultPrevented).toBe(false);
    expect(view.state.selection.ranges).toHaveLength(1);
  });

  it("installs exact GFM syntax, localized search, and direct zoom pixels on the real editor", async () => {
    const markdown = "# 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] done\n\n~~删除线~~ <https://example.com>";
    const rendered = render(<SourceEditor {...props({ view: sourceView(markdown), zoomPercent: 150 })} />);
    const view = editorFrom(rendered.container);
    const names: string[] = [];
    syntaxTree(view.state).iterate({ enter: (node) => { names.push(node.name); } });

    expect(names.some((name) => /Table/.test(name))).toBe(true);
    expect(names.some((name) => /Task/.test(name))).toBe(true);
    expect(names.some((name) => /Strikethrough/.test(name))).toBe(true);
    expect(names.some((name) => /Autolink|URL/.test(name))).toBe(true);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    expect(getComputedStyle(content).fontSize).toBe("21px");
    expect(getComputedStyle(content).lineHeight).toBe("33px");

    content.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "f" }));
    const find = await screen.findByRole("textbox", { name: "查找" });
    expect(find).toHaveFocus();
    expect(screen.getByRole("button", { name: "上一个匹配项" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一个匹配项" })).toBeInTheDocument();
    for (const name of ["替换", "全部替换", "全部选择匹配项", "关闭查找", "区分大小写", "正则表达式", "全字匹配"]) {
      expect(screen.getByRole(/区分大小写|正则表达式|全字匹配/.test(name) ? "checkbox" : "button", { name })).toBeInTheDocument();
    }
    expect(rendered.container.querySelector(".cm-search")?.textContent).not.toMatch(/\b(?:Find|Replace|next|previous|all)\b/);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "查找" })).not.toBeInTheDocument();
    expect(content).toHaveFocus();
  });

  it("keeps real line numbers, bracket matching, virtualized scrolling, and CJK/emoji selection replacement", async () => {
    const longDocument = `${Array.from({ length: 400 }, (_, index) => `line ${index} (${index})`).join("\n")}\n${"x".repeat(4_000)}`;
    const componentProps = props({ view: sourceView(longDocument) });
    const rendered = render(<SourceEditor {...componentProps} />);
    const view = editorFrom(rendered.container);
    expect(rendered.container.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(rendered.container.querySelectorAll(".cm-line").length).toBeLessThan(401);
    expect(getComputedStyle(rendered.container.querySelector(".cm-scroller")!).overflow).toMatch(/auto/);
    const firstParen = longDocument.indexOf("(");
    act(() => view.dispatch({ selection: { anchor: firstParen + 1 } }));
    await waitFor(() => expect(rendered.container.querySelectorAll(".cm-matchingBracket").length).toBeGreaterThan(0));

    act(() => view.dispatch({
      changes: { from: 0, to: 6, insert: "中文😀" },
      selection: { anchor: 4, head: 4 },
    }));
    expect(view.state.doc.toString().startsWith("中文😀")).toBe(true);
    expect(componentProps.onChangeBatch).toHaveBeenLastCalledWith(expect.objectContaining({
      bufferText: expect.stringMatching(/^中文😀/),
      selectionAfter: { anchor: 4, head: 4 },
    }));
  });

  it("publishes guarded Copy, Select All, and Focus operations that become stale on unmount", async () => {
    let bridge: SourceEditorBridge | null = null;
    const unregister = vi.fn();
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const onSelectionChange = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    const rendered = render(<SourceEditor {...props({
      view: sourceView("Alpha"),
      onSelectionChange,
      registerBridge: (next) => { bridge = next; return unregister; },
    })} />);
    const view = editorFrom(rendered.container);
    act(() => view.dispatch({ selection: { anchor: 1, head: 4 } }));
    const live = bridge as unknown as SourceEditorBridge;

    expect(live.hasSelection()).toBe(true);
    await expect(live.copy()).resolves.toBe("copied");
    expect(clipboard.writeText).toHaveBeenCalledWith("lph");
    expect(live.selectAll()).toBe("selected");
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
    expect(onSelectionChange).toHaveBeenLastCalledWith(0, { anchor: 0, head: 5 });
    const findBridge = live as SourceEditorBridge & { openFind?: () => "opened" | "stale" };
    expect(findBridge.openFind).toEqual(expect.any(Function));
    expect(findBridge.openFind?.()).toBe("opened");
    expect(await screen.findByRole("textbox", { name: "查找" })).toHaveFocus();

    rendered.unmount();
    expect(unregister).toHaveBeenCalledOnce();
    expect(live.focus()).toBe("stale");
    await expect(live.copy()).resolves.toBe("stale");
  });

  it("uses synchronous document copy before the permission-gated Clipboard API", async () => {
    let bridge: SourceEditorBridge | null = null;
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const copyCommand = vi.fn(() => true);
    const previous = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(document, "execCommand", { configurable: true, value: copyCommand });
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    try {
      const rendered = render(<SourceEditor {...props({
        view: sourceView("Alpha"),
        registerBridge: (next) => { bridge = next; return () => undefined; },
      })} />);
      const view = editorFrom(rendered.container);
      act(() => view.dispatch({ selection: { anchor: 1, head: 4 } }));

      await expect((bridge as unknown as SourceEditorBridge).copy()).resolves.toBe("copied");

      expect(copyCommand).toHaveBeenCalledWith("copy");
      expect(clipboard.writeText).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(document, "execCommand", previous);
      else Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("keeps clipboard failure atomic and refocuses only the still-current editor", async () => {
    let bridge: SourceEditorBridge | null = null;
    const clipboard = { writeText: vi.fn(async () => { throw new Error("denied"); }) };
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    const componentProps = props({
      view: sourceView("Alpha"),
      registerBridge: (next) => { bridge = next; return () => undefined; },
    });
    const rendered = render(<SourceEditor {...componentProps} />);
    const view = editorFrom(rendered.container);
    act(() => view.dispatch({ selection: { anchor: 1, head: 4 } }));
    const beforeDoc = view.state.doc.toString();
    const beforeSelection = view.state.selection.main;

    await expect((bridge as unknown as SourceEditorBridge).copy()).resolves.toBe("failed");

    expect(view.state.doc.toString()).toBe(beforeDoc);
    expect(view.state.selection.main).toEqual(beforeSelection);
    expect(componentProps.onChangeBatch).not.toHaveBeenCalled();
    expect(rendered.container.querySelector(".cm-content")).toHaveFocus();
  });

  it("returns stale without focusing when an asynchronous clipboard failure settles after revision replacement", async () => {
    let bridge: SourceEditorBridge | null = null;
    const clipboardWrite = deferred<void>();
    const clipboard = { writeText: vi.fn(() => clipboardWrite.promise) };
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    const componentProps = props({
      view: sourceView("Alpha"),
      registerBridge: (next) => { bridge = next; return () => undefined; },
    });
    const rendered = render(<SourceEditor {...componentProps} />);
    const view = editorFrom(rendered.container);
    const focus = vi.spyOn(view, "focus");
    act(() => view.dispatch({ selection: { anchor: 1, head: 4 } }));
    const copy = (bridge as unknown as SourceEditorBridge).copy();

    rendered.rerender(<SourceEditor
      {...componentProps}
      candidateRevision={1}
      view={sourceView("Canonical")}
    />);
    clipboardWrite.reject(new Error("denied late"));

    await expect(copy).resolves.toBe("stale");
    expect(focus).not.toHaveBeenCalled();
  });

  it("rebases canonical props without emitting a feedback batch or restoring an old local redo branch", () => {
    const componentProps = props();
    const rendered = render(<SourceEditor {...componentProps} />);
    const original = editorFrom(rendered.container);
    rendered.rerender(<SourceEditor {...componentProps} candidateRevision={1} view={sourceView("Canonical")} />);

    expect(editorFrom(rendered.container)).toBe(original);
    expect(original.state.doc.toString()).toBe("Canonical");
    expect(componentProps.onChangeBatch).not.toHaveBeenCalled();
  });

  it("applies programmatic candidate, selection, and zoom props without a batch or history feedback", () => {
    const componentProps = props({ view: sourceView("Alpha") });
    const rendered = render(<SourceEditor {...componentProps} />);
    const view = editorFrom(rendered.container);
    rendered.rerender(<SourceEditor
      {...componentProps}
      candidateRevision={1}
      view={sourceView("Canonical")}
      initialSelection={{ anchor: 2, head: 5 }}
      zoomPercent={150}
    />);

    expect(editorFrom(rendered.container)).toBe(view);
    expect(view.state.doc.toString()).toBe("Canonical");
    expect(view.state.selection.main).toMatchObject({ anchor: 2, head: 5 });
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    expect(getComputedStyle(content)).toMatchObject({ fontSize: "21px", lineHeight: "33px" });
    expect(componentProps.onChangeBatch).not.toHaveBeenCalled();
    expect(componentProps.onSelectionChange).not.toHaveBeenCalled();
    expect(componentProps.onViewportOffsetChange).not.toHaveBeenCalled();
  });

  it("keeps the same EditorView and bridge without reconfigure, measure, or scroll rollback on state echoes", () => {
    const unregister = vi.fn();
    const registerBridge = vi.fn(() => unregister);
    const stableView = sourceView("Alpha");
    const componentProps = props({ view: stableView, registerBridge });
    const rendered = render(<SourceEditor {...componentProps} />);
    const view = editorFrom(rendered.container);
    const dispatch = vi.spyOn(view, "dispatch");
    const requestMeasure = vi.spyOn(view, "requestMeasure");

    act(() => view.dispatch({ selection: { anchor: 2, head: 2 } }));
    dispatch.mockClear();
    requestMeasure.mockClear();
    rendered.rerender(<SourceEditor
      {...componentProps}
      initialSelection={{ anchor: 2, head: 2 }}
      initialViewportOffset={0}
    />);

    expect(editorFrom(rendered.container)).toBe(view);
    expect(registerBridge).toHaveBeenCalledOnce();
    expect(unregister).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(requestMeasure).not.toHaveBeenCalled();
  });

  it("invalidates a real local redo branch when a canonical candidate replaces it", async () => {
    const onRedo = vi.fn(() => true);
    const onChangeBatch = vi.fn((batch: SourceChangeBatch): SourceChangeAck =>
      batch.bufferText.includes("\ud800")
        ? { kind: "rejected", validationError: "invalid" }
        : { kind: "accepted", candidateRevision: 0, view: sourceView(batch.bufferText) },
    );
    const componentProps = props({ onChangeBatch, onRedo });
    const rendered = render(<SourceEditor {...componentProps} />);
    const view = editorFrom(rendered.container);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    act(() => view.dispatch({ changes: { from: 1, insert: "\ud800" } }));
    content.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z" }));
    await waitFor(() => expect(view.state.doc.toString()).toBe("A"));

    rendered.rerender(<SourceEditor {...componentProps} candidateRevision={1} view={sourceView("Canonical")} />);
    expect(codeMirrorRedo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("Canonical");
    content.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "y" }));

    expect(onRedo).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("Canonical");
  });

  it("accepts CJK and emoji through a real composition event sequence", async () => {
    const componentProps = props({ view: sourceView("") });
    const rendered = render(<SourceEditor {...componentProps} />);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    content.focus();
    content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    await userEvent.type(content, "中文😀");
    content.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中文😀" }));
    expect(componentProps.onChangeBatch).not.toHaveBeenCalled();
    content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文😀" }));

    await waitFor(() => expect(editorFrom(rendered.container).state.doc.toString()).toBe("中文😀"));
    await waitFor(() => expect(componentProps.onChangeBatch).toHaveBeenCalledOnce());
    expect(vi.mocked(componentProps.onChangeBatch).mock.calls.at(-1)?.[0]).toMatchObject({
      bufferText: "中文😀",
      selectionAfter: { anchor: 4, head: 4 },
    });
  });

  it("repairs a rejected multi-transaction composition to the accepted base with one local Undo", async () => {
    const onUndo = vi.fn(() => true);
    const onChangeBatch = vi.fn((batch: SourceChangeBatch): SourceChangeAck =>
      batch.bufferText === "A"
        ? { kind: "accepted", candidateRevision: 0, view: sourceView("A") }
        : { kind: "rejected", validationError: "invalid" },
    );
    const rendered = render(<SourceEditor {...props({ onChangeBatch, onUndo })} />);
    const view = editorFrom(rendered.container);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    act(() => view.dispatch({
      changes: { from: 1, insert: "中" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    }));
    content.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中文" }));
    act(() => view.dispatch({
      changes: { from: 2, insert: "文" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    }));
    expect(onChangeBatch).not.toHaveBeenCalled();
    content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    await waitFor(() => expect(onChangeBatch).toHaveBeenCalledOnce());
    expect(view.state.doc.toString()).toBe("A中文");
    expect(content).toHaveAttribute("aria-invalid", "true");

    act(() => expect(codeMirrorUndo(view)).toBe(true));

    await waitFor(() => expect(view.state.doc.toString()).toBe("A"));
    await waitFor(() => expect(content).not.toHaveAttribute("aria-invalid", "true"));
    expect(onChangeBatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(onChangeBatch).mock.calls.at(-1)?.[0].bufferText).toBe("A");
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("remounts an exact rejected buffer and selection without re-encoding its code units", () => {
    const buffer: SourceBufferState = {
      sessionId: "one",
      baseCandidateRevision: 0,
      baseView: sourceView("A"),
      bufferText: "A\ud800",
      composedChanges: [{ from: 1, to: 1, insert: "\ud800" }],
      validationError: "invalid",
    };
    const rendered = render(<SourceEditor {...props({
      buffer,
      initialSelection: { anchor: 2, head: 2 },
    })} />);
    const view = editorFrom(rendered.container);

    expect(view.state.doc.toString().charCodeAt(1)).toBe(0xd800);
    expect(view.state.selection.main.anchor).toBe(2);
    expect(rendered.container.querySelector(".cm-content")).toHaveAttribute("aria-invalid", "true");
  });
});

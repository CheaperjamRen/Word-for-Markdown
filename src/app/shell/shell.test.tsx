import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { DraftRecord, FileVersion, HostApi } from "../../contracts/desktop";
import type { DocumentSession, ResourcePreviewSession, WorkspaceTab } from "../../documents/session";
import { parseSourceDocument } from "../../markdown/source-document";
import { buildSourceView } from "../../markdown/source-view";
import App from "../App";
import { createActiveSourceEditorRegistry } from "../active-source-editor";
import { collectComputedShellContract } from "../ui-contract";
import type { DocumentController } from "../use-document-controller";
import { RECENT_DOCUMENTS_STORAGE_KEY } from "../recent-documents";
import { READING_PREFERENCES_STORAGE_KEY } from "../../reading/preferences";
import { DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY } from "../../document/presentation-preferences";
import { fitWidthZoom } from "../../document/zoom-geometry";
import { FormatToolbar } from "./FormatToolbar";
import { AppShell } from "./AppShell";
import { MenuBar } from "./MenuBar";
import * as toolbarCommands from "./toolbar-commands";

const VERSION: FileVersion = { len: 1, modifiedMs: 1, sha256: "v1" };
const WIDE_PRIMARY_IDS = [
  "save", "block-style", "bold", "italic", "strike", "inline-code", "link",
  "bullet-list", "number-list", "task-list", "quote", "code-block",
  "table", "image", "formula", "history-spacer", "undo", "redo", "more",
] as const;
const COMPACT_PRIMARY_IDS = [
  "save", "block-style", "bold", "italic", "link",
  "bullet-list", "number-list", "task-list", "quote", "table",
  "history-spacer", "undo", "redo", "more",
] as const;
const COMPACT_OVERFLOW = [
  ["format", ["strike", "inline-code"]],
  ["block", ["code-block", "horizontal-rule"]],
  ["insert", ["image", "formula", "mermaid"]],
] as const;
const ORIGINAL_EXEC_COMMAND = Object.getOwnPropertyDescriptor(document, "execCommand");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function hostFixture(initialPaths: string[] = []): HostApi {
  return {
    onOpenRequests: vi.fn(async (listener) => { if (initialPaths.length) listener(initialPaths); return () => undefined; }),
    onFileDrop: vi.fn(async () => () => undefined),
    onWindowCloseRequested: vi.fn(async () => () => undefined),
    closeWindow: vi.fn(async () => undefined),
    getAppVersion: vi.fn(async () => "0.1.0"),
    onFileChanged: vi.fn(async () => () => undefined),
    pickMarkdownFiles: vi.fn(async () => null),
    pickMarkdownSavePath: vi.fn(async () => null),
    openDocument: vi.fn(async (path) => ({ canonicalPath: path, bytes: [35, 32, 65], version: VERSION })),
    saveDocument: vi.fn(async () => VERSION),
    saveDocumentAs: vi.fn(async (request) => ({ canonicalPath: request.targetPath, version: VERSION })),
    writeDraft: vi.fn(async () => { throw new Error("unused"); }),
    listDrafts: vi.fn(async () => []),
    readDraft: vi.fn(async () => { throw new Error("unused"); }),
    deleteDraft: vi.fn(async () => undefined),
    watchDocument: vi.fn(async (canonicalPath) => ({ watchId: "watch", canonicalPath })),
    unwatchDocument: vi.fn(async () => undefined),
    setWindowTitle: vi.fn(async () => undefined),
    recordFirstReadablePaint: vi.fn(async () => 100),
  };
}

function hostWithCloseEmitter(initialPaths: string[] = []) {
  let closeRequested: (() => void) | undefined;
  const host = hostFixture(initialPaths);
  vi.mocked(host.onWindowCloseRequested).mockImplementation(async (listener) => {
    closeRequested = listener;
    return () => undefined;
  });
  return { host, emitClose: () => closeRequested?.() };
}

function readingSession(id: string, text: string): DocumentSession {
  const source = parseSourceDocument(Uint8Array.from(`# ${text}`, (character) => character.charCodeAt(0)));
  return {
    kind: "document",
    id,
    file: { kind: "untitled", displayName: `${text}.md` },
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
  };
}

function menuController(tabs: readonly WorkspaceTab[], activeTabId: string): DocumentController {
  return {
    tabs,
    activeTabId,
    closing: false,
    closePrompt: null,
    persistentMessage: null,
    newDocument: vi.fn(async () => undefined),
    openPaths: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
    saveAs: vi.fn(async () => undefined),
    requestClose: vi.fn(),
    requestCloseAll: vi.fn(),
    resolveClose: vi.fn(async () => undefined),
    activate: vi.fn(),
    setMode: vi.fn(() => "changed" as const),
    getSourceView: vi.fn(() => null),
    commitRichEdit: vi.fn(() => ({ kind: "stale" as const })),
    beginProtectedRawEdit: vi.fn(() => false),
    updateProtectedRawBuffer: vi.fn(() => false),
    cancelProtectedRawEdit: vi.fn(() => false),
    commitProtectedRawEdit: vi.fn(() => ({ kind: "stale" as const })),
    applySourceChangeBatch: vi.fn(() => ({ kind: "stale" as const })),
    updateSourceSelection: vi.fn(),
    updateSourceViewport: vi.fn(),
    undo: vi.fn(() => false),
    redo: vi.fn(() => false),
  };
}

function resolveCssVariables(): void {
  const native = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const computed = native(element);
    return new Proxy(computed, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "string") return value;
        const variable = /^var\((--[^)]+)\)$/.exec(value)?.[1];
        return variable ? native(document.documentElement).getPropertyValue(variable).trim() : value;
      },
    });
  });
}

function installToolbarMedia(initialCompact: boolean) {
  let compact = initialCompact;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() { return compact; },
    media: "(max-width: 1023px)",
    onchange: null,
    addEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") listeners.delete(listener);
    }),
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    dispatchEvent: vi.fn(() => true),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => mediaQuery as unknown as MediaQueryList),
  });
  return {
    mediaQuery,
    setCompact(next: boolean) {
      compact = next;
      const event = new Event("change") as MediaQueryListEvent;
      Object.defineProperties(event, {
        matches: { value: compact },
        media: { value: mediaQuery.media },
      });
      act(() => listeners.forEach((listener) => listener(event)));
    },
  };
}

function primaryToolbarIds(toolbar: HTMLElement): string[] {
  return [...toolbar.querySelectorAll<HTMLElement>("[data-toolbar-placement='primary']")]
    .map((element) => element.dataset.toolbarId!);
}

function overflowToolbarIds(toolbar: HTMLElement): string[] {
  return [...toolbar.querySelectorAll<HTMLElement>("[data-toolbar-placement='overflow']")]
    .map((element) => element.dataset.toolbarId!);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (ORIGINAL_EXEC_COMMAND) Object.defineProperty(document, "execCommand", ORIGINAL_EXEC_COMMAND);
  else Reflect.deleteProperty(document, "execCommand");
});

describe("light desktop shell", () => {
  it("keeps the empty shell free of an invalid-source alert", async () => {
    render(<App host={hostFixture()} />);

    await screen.findByRole("region", { name: "开始" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("就绪")).toBeInTheDocument();
  });

  it("renders stable shell landmarks, exact computed geometry, and no retired chrome", async () => {
    resolveCssVariables();
    const { container } = render(<App host={hostFixture()} />);
    await screen.findByRole("tablist", { name: "打开的文档" });

    expect(screen.getByRole("menubar", { name: "应用菜单" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "文档工具" })).toBeInTheDocument();
    expect(container.querySelector(".workspace .document-viewport")).toBeInTheDocument();
    expect(collectComputedShellContract(container)).toEqual({
      tabbarHeight: "36px", menubarHeight: "28px", toolbarHeight: "44px", statusbarHeight: "28px",
      uiFontSize: "12px", statusFontSize: "11px", documentFontSize: "16px", documentLineHeight: "28px",
      toolbarIconWidth: "20px", toolbarIconHeight: "20px", iconButtonWidth: "32px", iconButtonHeight: "32px",
    });
    expect(container.querySelector(".titlebar, .commandbar, .document-editor-panel")).toBeNull();
    expect(container.querySelector(".menu-bar__product")).toBeNull();
    expect(container.querySelector("main main")).toBeNull();
    expect(container.textContent).not.toMatch(/编辑(第一个普通)?段落|仅手动保存写回原文件|等待文档路径|\\\\\?\\/);
    expect(getComputedStyle(container.querySelector(".document-tabs")!).backgroundColor).not.toBe("rgb(14, 26, 41)");
    expect(getComputedStyle(container.querySelector(".statusbar")!).backgroundColor).not.toBe("rgb(14, 26, 41)");
    expect(getComputedStyle(container.querySelector(".document-viewport")!).backgroundImage).toBe("none");
  });

  it("never emits a dangling document aria-controls for an active resource preview", () => {
    const documentTab = readingSession("document", "Document");
    const preview: ResourcePreviewSession = {
      kind: "preview", id: "preview", canonicalPath: "C:\\docs\\image.png",
      displayName: "image.png", mediaType: "image", zoomPercent: 100,
    };
    render(<AppShell
      controller={menuController([documentTab, preview], preview.id)}
      host={hostFixture()}
      registry={createActiveSourceEditorRegistry()}
      renderDocument={() => <div>Reading</div>}
    />);

    expect(screen.getByRole("tab", { name: "image.png" })).not.toHaveAttribute("aria-controls");
    for (const tab of screen.getAllByRole("tab")) {
      const controlled = tab.getAttribute("aria-controls");
      if (controlled) expect(document.getElementById(controlled)).not.toBeNull();
    }
  });

  it("shows six menus, restores Help trigger focus, and opens About with the real version", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture()} />);
    const labels = ["文件", "编辑", "插入", "格式", "查看", "帮助"];
    for (const label of labels) expect(await screen.findByRole("menuitem", { name: label })).toBeInTheDocument();
    const help = screen.getByRole("menuitem", { name: "帮助" });
    await user.click(help);
    await user.click(screen.getByRole("menuitem", { name: "关于 Markdown 文档" }));
    expect(await screen.findByRole("dialog", { name: "关于 Markdown 文档" })).toHaveTextContent("版本 0.1.0");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "关于 Markdown 文档" })).not.toBeInTheDocument();
    expect(help).toHaveFocus();
  });

  it("renders the complete wide document command bar in the approved order", async () => {
    installToolbarMedia(false);
    const user = userEvent.setup();
    render(<App host={hostFixture()} />);
    const toolbar = await screen.findByRole("toolbar", { name: "文档工具" });

    expect(primaryToolbarIds(toolbar)).toEqual(WIDE_PRIMARY_IDS);
    expect(within(toolbar).getByRole("button", { name: "段落样式" })).toHaveTextContent("正文");
    expect(within(toolbar).getByRole("button", { name: "更多" })).toHaveTextContent("更多");
    for (const id of ["block-style", "bullet-list", "task-list", "quote", "table"]) {
      expect(toolbar.querySelector(`[data-toolbar-id='${id}'][data-toolbar-placement='primary']`)).toBeInTheDocument();
    }
    await user.click(within(toolbar).getByRole("button", { name: "更多" }));
    expect(overflowToolbarIds(toolbar)).toEqual(["horizontal-rule", "mermaid"]);
    const wideOverflow = screen.getByRole("menu", { name: "更多" });
    expect(within(wideOverflow).getByText("块")).not.toHaveAttribute("tabindex");
    expect(within(wideOverflow).getByText("插入")).not.toHaveAttribute("tabindex");
    expect(getComputedStyle(toolbar).flexWrap).toBe("nowrap");
  });

  it("partitions only low-frequency commands into grouped compact overflow", () => {
    type RuntimeToolbarLayout = {
      primary: readonly { id: string }[];
      overflowGroups: readonly { id: string; commands: readonly { id: string }[] }[];
    };
    const createLayout = (toolbarCommands as unknown as {
      createToolbarLayout?: (compact: boolean) => RuntimeToolbarLayout;
    }).createToolbarLayout;

    expect(createLayout).toBeTypeOf("function");
    if (!createLayout) return;
    const layout = createLayout(true);
    expect(layout.primary.map((item) => item.id)).toEqual(COMPACT_PRIMARY_IDS);
    expect(layout.overflowGroups.map((group) => [group.id, group.commands.map((command) => command.id)])).toEqual(COMPACT_OVERFLOW);
    const primary = new Set(layout.primary.map((item) => item.id));
    expect(layout.overflowGroups.flatMap((group) => group.commands).every((command) => !primary.has(command.id))).toBe(true);
  });

  it("keeps table, style, link, core formatting, lists, history and labelled More discoverable at 700px", async () => {
    installToolbarMedia(true);
    const user = userEvent.setup();
    render(<App host={hostFixture()} />);
    const toolbar = await screen.findByRole("toolbar", { name: "文档工具" });

    expect(primaryToolbarIds(toolbar)).toEqual(COMPACT_PRIMARY_IDS);
    for (const id of COMPACT_PRIMARY_IDS.filter((id) => id !== "history-spacer")) {
      const control = toolbar.querySelector<HTMLElement>(`[data-toolbar-id='${id}']`);
      expect(control).toBeInTheDocument();
      expect(control instanceof HTMLButtonElement && (control.disabled || control.tabIndex >= -1)).toBe(true);
    }
    const more = within(toolbar).getByRole("button", { name: "更多" });
    await user.click(more);
    const overflow = screen.getByRole("menu", { name: "更多" });
    expect(overflowToolbarIds(toolbar)).toEqual(COMPACT_OVERFLOW.flatMap(([, ids]) => ids));
    for (const item of within(overflow).getAllByRole("menuitem")) {
      expect(item).toHaveAttribute("aria-disabled", "true");
    }
    for (const label of ["格式", "块", "插入"]) {
      expect(within(overflow).getByText(label)).not.toHaveAttribute("tabindex");
    }
    const primary = new Set(primaryToolbarIds(toolbar));
    expect(overflowToolbarIds(toolbar).every((id) => !primary.has(id))).toBe(true);
  });

  it("renders separators only between non-empty visible groups", async () => {
    const media = installToolbarMedia(false);
    render(<App host={hostFixture()} />);
    const toolbar = await screen.findByRole("toolbar", { name: "文档工具" });
    const assertSeparators = () => {
      const children = [...toolbar.children] as HTMLElement[];
      const separators = children.filter((child) => child.classList.contains("toolbar-separator"));
      expect(separators).toHaveLength(4);
      expect(children[0]).not.toHaveClass("toolbar-separator");
      expect(children.at(-1)).not.toHaveClass("toolbar-separator");
      for (const separator of separators) {
        const previous = separator.previousElementSibling as HTMLElement | null;
        const next = separator.nextElementSibling as HTMLElement | null;
        expect(previous).not.toHaveClass("toolbar-separator");
        expect(next).not.toHaveClass("toolbar-separator");
        expect(previous?.dataset.toolbarGroup).toBeTruthy();
        expect(next?.dataset.toolbarGroup).toBeTruthy();
        expect(previous?.dataset.toolbarGroup).not.toBe(next?.dataset.toolbarGroup);
      }
    };

    assertSeparators();
    media.setCompact(true);
    assertSeparators();
  });

  it("renders exclusively from the layout and preserves one stateById across breakpoint moves", async () => {
    const media = installToolbarMedia(false);
    const user = userEvent.setup();
    render(<App host={hostFixture()} />);
    const toolbar = await screen.findByRole("toolbar", { name: "文档工具" });
    const wideStrike = toolbar.querySelector<HTMLButtonElement>("[data-toolbar-id='strike']");
    expect(wideStrike).not.toBeNull();
    if (!wideStrike) return;
    const wideState = {
      disabled: wideStrike.disabled,
      toggle: wideStrike.getAttribute("aria-pressed"),
      busy: wideStrike.dataset.busy,
      title: wideStrike.title,
    };

    media.setCompact(true);
    expect(primaryToolbarIds(toolbar)).toEqual(COMPACT_PRIMARY_IDS);
    await user.click(within(toolbar).getByRole("button", { name: "更多" }));
    const compactStrike = within(screen.getByRole("menu", { name: "更多" })).getByRole("menuitemcheckbox", { name: "删除线" });
    expect({
      disabled: compactStrike.getAttribute("aria-disabled") === "true",
      toggle: compactStrike.getAttribute("aria-checked"),
      busy: compactStrike.dataset.busy,
      title: compactStrike.title,
    }).toEqual(wideState);
    expect(primaryToolbarIds(toolbar)).toEqual(COMPACT_PRIMARY_IDS);
  });

  it("keeps every unavailable visible command truthfully disabled without fading or misleading titles", async () => {
    installToolbarMedia(false);
    resolveCssVariables();
    const empty = menuController([], "");
    const reading = menuController([readingSession("reading", "Reading")], "reading");
    const sourceSession = { ...readingSession("source", "Source"), mode: "source" as const };
    const source = menuController([sourceSession], "source");
    const rendered = render(<FormatToolbar controller={empty} />);
    const toolbar = screen.getByRole("toolbar", { name: "文档工具" });

    const assertTruth = () => {
      const controls = [...toolbar.querySelectorAll<HTMLButtonElement>("button[data-toolbar-placement='primary']")]
        .filter((control) => control.dataset.toolbarId !== "more");
      expect(controls).not.toHaveLength(0);
      for (const control of controls) {
        expect(control).toBeDisabled();
        expect(getComputedStyle(control).opacity).toBe("1");
        expect(getComputedStyle(control).color).toBe("#89939d");
        expect(control.title).not.toMatch(/阅读模式不可用|Task\s*[456]|即将支持/i);
      }
    };

    assertTruth();
    rendered.rerender(<FormatToolbar controller={reading} />);
    assertTruth();
    rendered.rerender(<FormatToolbar controller={source} />);
    assertTruth();
  });

  it("keeps New immediately after the last tab instead of pinning it to the far edge", async () => {
    const opened = render(<App host={hostFixture(["C:\\docs\\one.md", "C:\\docs\\two.md"])} />);
    const tablist = await screen.findByRole("tablist", { name: "打开的文档" });
    await screen.findByRole("tab", { name: /two\.md/ });
    const row = tablist.parentElement!;
    expect([...row.children].map((child) => (child as HTMLElement).className)).toEqual([
      "document-tabs__scroll", "document-tabs__new", "document-tabs__spacer", "document-tabs__mode-control",
    ]);
    expect(getComputedStyle(tablist).flexGrow).toBe("0");
    expect(getComputedStyle(screen.getByRole("button", { name: "新建文档" })).position).not.toBe("absolute");

    opened.unmount();
    render(<App host={hostFixture()} />);
    const emptyTablist = await screen.findByRole("tablist", { name: "打开的文档" });
    expect(emptyTablist).toBeEmptyDOMElement();
    expect(emptyTablist.nextElementSibling).toHaveClass("document-tabs__new");
    expect(emptyTablist.nextElementSibling?.nextElementSibling).toHaveClass("document-tabs__spacer");
    expect(emptyTablist.nextElementSibling?.nextElementSibling?.nextElementSibling).toHaveClass("document-tabs__mode-control");
  });

  it("opens a start page from the tab plus without creating a document immediately", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("tab", { name: /one\.md/ });
    await user.click(screen.getByRole("button", { name: "新建文档" }));

    expect(screen.getByRole("heading", { name: "开始一个 Markdown 文档" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    await user.click(within(screen.getByRole("region", { name: "开始" })).getByRole("button", { name: "新建文档" }));
    expect(await screen.findByRole("tab", { name: /未命名 1/ })).toBeInTheDocument();
  });

  it("inserts a three-column table after the live Rich caret and focuses its first cell", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\insert.md"]);
    vi.mocked(host.openDocument).mockImplementation(async (path) => ({
      canonicalPath: path,
      bytes: Array.from(new TextEncoder().encode("First paragraph\n\nSecond paragraph\n\nThird paragraph\n")),
      version: VERSION,
    }));
    render(<App host={host} />);
    await screen.findByText("Second paragraph");
    await user.click(screen.getByRole("button", { name: "富文本" }));
    const editor = await screen.findByRole("textbox", { name: "编辑 Markdown 文档" });
    const second = editor.querySelectorAll("p")[1]!;
    const range = document.createRange();
    range.selectNodeContents(second);
    range.collapse(true);
    editor.focus();
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    await user.click(screen.getByRole("button", { name: "插入表格" }));

    const grid = await screen.findByRole("grid", { name: "表格编辑器" });
    expect(grid).toHaveFocus();
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(6);
    const surface = grid.closest(".rich-document-surface")!;
    const segments = [...surface.children];
    expect(segments[0]).toHaveTextContent("First paragraphSecond paragraph");
    expect(segments[1]).toContainElement(grid.closest("[data-rich-block-kind='table']"));
    expect(segments[2]).toHaveTextContent("Third paragraph");
  });

  it("lists a successfully opened local document on the start page and reopens it without Explorer", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\one.md"]);
    render(<App host={host} />);
    await screen.findByRole("tab", { name: /one\.md/ });

    await user.click(screen.getByRole("button", { name: "新建文档" }));
    const recent = screen.getByRole("region", { name: "历史文档" });
    expect(within(recent).getByText("one.md")).toBeVisible();
    expect(within(recent).getByText("C:\\docs")).toBeVisible();

    await user.click(within(recent).getByRole("button", { name: "打开 one.md" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "开始一个 Markdown 文档" })).not.toBeInTheDocument());
    expect(host.openDocument).toHaveBeenCalledOnce();
    expect(host.pickMarkdownFiles).not.toHaveBeenCalled();
  });

  it("keeps a failed recent open on the start page and removes it only through its own action", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(RECENT_DOCUMENTS_STORAGE_KEY, JSON.stringify([{
      canonicalPath: "C:\\missing\\gone.md",
      displayName: "gone.md",
      openedAt: 20,
    }]));
    const host = hostFixture();
    vi.mocked(host.openDocument).mockRejectedValue(new Error("missing"));
    render(<App host={host} />);
    const start = await screen.findByRole("region", { name: "开始" });
    const recent = within(start).getByRole("region", { name: "历史文档" });
    const row = within(recent).getByRole("button", { name: "打开 gone.md" });

    await user.click(row);
    expect(screen.getByRole("region", { name: "开始" })).toBeVisible();
    expect(within(recent).getByText("gone.md")).toBeVisible();

    fireEvent.contextMenu(row);
    const remove = within(recent).getByRole("button", { name: "从历史移除 gone.md" });
    await user.click(remove);
    expect(within(recent).queryByText("gone.md")).not.toBeInTheDocument();
    expect(host.openDocument).toHaveBeenCalledOnce();
  });

  it("defaults to Canvas and remembers layout plus zoom mode across remounts", async () => {
    const user = userEvent.setup();
    const first = render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    const layout = screen.getByRole("combobox", { name: "文档版式" });
    expect(layout).toHaveValue("canvas");
    expect(screen.getByRole("article")).toHaveClass("document-paper--canvas");
    await user.selectOptions(layout, "a3");
    expect(screen.getByRole("article")).toHaveClass("document-paper--a3");
    const zoom = screen.getByRole("slider", { name: "文档缩放" });
    fireEvent.change(zoom, { target: { value: "170" } });
    expect(zoom).toHaveValue("170");
    await user.click(screen.getByRole("menuitem", { name: "查看" }));
    const zoomMode = screen.getByRole("menuitem", { name: "整体缩放" });
    await user.click(zoomMode);
    expect(screen.getByRole("article").style.zoom).toBe("");
    await user.click(screen.getByRole("menuitem", { name: "查看" }));
    expect(screen.getByRole("menuitem", { name: "文字缩放" })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel").style.getPropertyValue("--document-zoom")).toBe("1.7");
    expect(JSON.parse(localStorage.getItem(DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY) ?? "null")).toEqual({
      version: 1,
      layout: "a3",
      zoomMode: "text",
    });

    first.unmount();
    render(<App host={hostFixture(["C:\\docs\\two.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    expect(screen.getByRole("combobox", { name: "文档版式" })).toHaveValue("a3");
    await user.click(screen.getByRole("menuitem", { name: "查看" }));
    expect(screen.getByRole("menuitem", { name: "文字缩放" })).toBeInTheDocument();

    const css = readFileSync(resolve(process.cwd(), "src/app/app.css"), "utf8");
    expect(css).toContain("font-size: calc(17px * var(--document-zoom, 1));");
  });

  it("fits the active paper width once and disables that command in Source", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.selectOptions(screen.getByRole("combobox", { name: "文档版式" }), "a4");
    const viewport = document.querySelector<HTMLElement>(".document-viewport--reading")!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 900 });

    await user.click(screen.getByRole("menuitem", { name: "查看" }));
    await user.click(screen.getByRole("menuitem", { name: "整体缩放" }));
    await user.click(screen.getByRole("menuitem", { name: "查看" }));
    expect(screen.getByRole("menuitem", { name: "文字缩放" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "适合宽度" }));
    expect(screen.getByRole("slider", { name: "文档缩放" }))
      .toHaveValue(String(fitWidthZoom(900, 794)));
    expect(JSON.parse(localStorage.getItem(DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY) ?? "null"))
      .toMatchObject({ zoomMode: "canvas" });
    await user.click(screen.getByRole("menuitem", { name: "查看" }));
    expect(screen.getByRole("menuitem", { name: "整体缩放" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "源码" }));
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    await user.click(screen.getByRole("menuitem", { name: "查看" }));
    expect(screen.getByRole("menuitem", { name: "适合宽度" })).toBeDisabled();
  });

  it("uses one toolbar tab stop and roves enabled primary controls", async () => {
    installToolbarMedia(false);
    const user = userEvent.setup();
    const host = hostFixture();
    render(<App host={host} />);
    await user.click((await screen.findByRole("region", { name: "开始" })).querySelector(".empty-state__primary")!);
    const toolbar = screen.getByRole("toolbar", { name: "文档工具" });
    const save = within(toolbar).getByRole("button", { name: "保存" });
    const blockStyle = within(toolbar).getByRole("button", { name: "段落样式" });
    const more = within(toolbar).getByRole("button", { name: "更多" });
    await waitFor(() => expect(blockStyle).toBeEnabled());
    const primaryControls = [...toolbar.querySelectorAll<HTMLButtonElement>("[data-toolbar-placement='primary']")]
      .filter((control) => control.dataset.toolbarId !== "history-spacer");
    expect(primaryControls.filter((control) => control.tabIndex === 0)).toHaveLength(1);
    expect(primaryControls.filter((control) => control.disabled).every((control) => control.tabIndex === -1)).toBe(true);

    const help = screen.getByRole("menuitem", { name: "帮助" });
    help.focus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(blockStyle).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(within(toolbar).getByRole("button", { name: "加粗" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(more).toHaveFocus();
    await user.keyboard("{Home}{Enter}");
    expect(host.pickMarkdownSavePath).toHaveBeenCalledOnce();
  });

  it("moves real focus when the focused toolbar command becomes disabled", async () => {
    installToolbarMedia(false);
    const user = userEvent.setup();
    const savePath = deferred<string | null>();
    const host = hostFixture();
    vi.mocked(host.pickMarkdownSavePath).mockImplementation(() => savePath.promise);
    render(<App host={host} />);
    await user.click((await screen.findByRole("region", { name: "开始" })).querySelector(".empty-state__primary")!);
    const toolbar = screen.getByRole("toolbar", { name: "文档工具" });
    const save = within(toolbar).getByRole("button", { name: "保存" });
    const more = within(toolbar).getByRole("button", { name: "更多" });

    save.focus();
    expect(save).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(host.pickMarkdownSavePath).toHaveBeenCalledOnce());
    expect(save).toBeDisabled();
    await waitFor(() => expect(more).toHaveFocus());

    await act(async () => { savePath.resolve(null); await savePath.promise; });
  });

  it("recovers focus when a responsive change moves a command between overflow and primary", async () => {
    const media = installToolbarMedia(true);
    const user = userEvent.setup();
    const rendered = render(<App host={hostFixture()} />);
    const toolbar = await screen.findByRole("toolbar", { name: "文档工具" });
    const more = within(toolbar).getByRole("button", { name: "更多" });
    await user.click(more);
    const overflowStrike = within(screen.getByRole("menu", { name: "更多" })).getByRole("menuitemcheckbox", { name: "删除线" });
    overflowStrike.focus();
    media.setCompact(false);
    expect(screen.queryByRole("menu", { name: "更多" })).not.toBeInTheDocument();
    expect(more).toHaveFocus();

    const wideStrike = toolbar.querySelector<HTMLButtonElement>("[data-toolbar-id='strike']")!;
    wideStrike.disabled = false;
    wideStrike.focus();
    media.setCompact(true);
    expect(more).toHaveFocus();

    rendered.unmount();
    expect(media.mediaQuery.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(media.mediaQuery.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it.each(["分隔线", "Mermaid"])(
    "returns focus to More when a responsive change keeps permanent-overflow command %s out of primary",
    async (label) => {
      const media = installToolbarMedia(true);
      const user = userEvent.setup();
      render(<App host={hostFixture()} />);
      const toolbar = await screen.findByRole("toolbar", { name: "文档工具" });
      const more = within(toolbar).getByRole("button", { name: "更多" });
      await user.click(more);
      const overflowItem = within(screen.getByRole("menu", { name: "更多" })).getByRole("menuitem", { name: label });
      overflowItem.focus();

      media.setCompact(false);

      expect(screen.queryByRole("menu", { name: "更多" })).not.toBeInTheDocument();
      expect(more).toHaveFocus();
    },
  );

  it("omits the redundant native tooltip from the labelled More trigger", async () => {
    installToolbarMedia(true);
    render(<App host={hostFixture()} />);
    const toolbar = await screen.findByRole("toolbar", { name: "文档工具" });

    expect(within(toolbar).getByRole("button", { name: "更多" })).not.toHaveAttribute("title");
  });

  it("exposes placement-appropriate state only for toggle commands", async () => {
    installToolbarMedia(true);
    const user = userEvent.setup();
    render(<App host={hostFixture()} />);
    const toolbar = await screen.findByRole("toolbar", { name: "文档工具" });
    const more = within(toolbar).getByRole("button", { name: "更多" });

    await user.click(more);

    for (const id of [
      "bold", "italic", "strike", "inline-code", "bullet-list", "number-list", "task-list", "quote", "code-block",
    ]) {
      const control = toolbar.querySelector(`[data-toolbar-id='${id}']`)!;
      if (control.getAttribute("role") === "menuitemcheckbox") {
        expect(control).toHaveAttribute("aria-checked", "false");
        expect(control).not.toHaveAttribute("aria-pressed");
      } else {
        expect(control).toHaveAttribute("aria-pressed", "false");
        expect(control).not.toHaveAttribute("aria-checked");
      }
    }
    for (const id of [
      "save", "block-style", "link", "table", "image", "formula", "horizontal-rule", "mermaid", "undo", "redo",
    ]) {
      const control = toolbar.querySelector(`[data-toolbar-id='${id}']`);
      expect(control).not.toHaveAttribute("aria-pressed");
      expect(control).not.toHaveAttribute("aria-checked");
    }
  });

  it("keeps tab activation and keyboard-close as sibling controls", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md", "C:\\docs\\two.md"])} />);
    const one = await screen.findByRole("tab", { name: /one\.md/ });
    const closeOne = screen.getByRole("button", { name: "关闭 one.md" });
    expect(one.parentElement).toBe(closeOne.parentElement);
    expect(one).not.toContainElement(closeOne);
    closeOne.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("tab", { name: /one\.md/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /two\.md/ })).toHaveAttribute("aria-selected", "true");
  });

  it("cycles enabled menu items and Escape restores the exact trigger", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture()} />);
    const file = await screen.findByRole("menuitem", { name: "文件" });
    file.focus();
    await user.keyboard("{ArrowDown}");
    const create = await screen.findByRole("menuitem", { name: /^新建/ });
    expect(create).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: /^打开…/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "文件菜单" })).not.toBeInTheDocument();
    expect(file).toHaveFocus();
  });

  it("exposes an explicit File exit command for the native close path", async () => {
    const user = userEvent.setup();
    const host = hostFixture();
    render(<App host={host} />);
    const file = await screen.findByRole("menuitem", { name: "文件" });
    await user.click(file);
    await user.click(screen.getByRole("menuitem", { name: /^退出/ }));
    expect(host.closeWindow).toHaveBeenCalledOnce();
  });

  it("keeps recovery drafts out of the document and opens them only from File", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\one.md"]);
    const draft: DraftRecord = {
      id: "00000000-0000-4000-8000-000000000001",
      sessionId: "session-1",
      canonicalPath: "C:\\docs\\draft.md",
      baselineVersion: null,
      bytes: [35, 32, 65],
      candidateRevision: 1,
      rejectedSourceBuffer: null,
      updatedMs: Date.UTC(2026, 7, 24, 2, 30),
    };
    vi.mocked(host.listDrafts).mockResolvedValue([draft]);
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "A" });

    expect(screen.queryByRole("complementary", { name: "可恢复编辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "恢复未保存编辑" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "文件" }));
    await user.click(screen.getByRole("menuitem", { name: "恢复未保存编辑…（1）" }));
    expect(screen.getByRole("dialog", { name: "恢复未保存编辑" })).toHaveTextContent("draft.md");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "恢复未保存编辑" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "文件" })).toHaveFocus();
  });

  it("omits the recovery command when no drafts exist", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("menuitem", { name: "文件" }));
    expect(screen.queryByRole("menuitem", { name: /恢复未保存编辑/ })).not.toBeInTheDocument();
  });

  it("applies one persisted app theme across Reading, Rich Text, Source, and Start", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });

    const view = screen.getByRole("menuitem", { name: "查看" });
    await user.click(view);
    await user.click(screen.getByRole("menuitem", { name: "阅读外观…" }));

    expect(within(screen.getByRole("navigation", { name: "设置" })).getByRole("button", { name: "阅读" }))
      .toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("radio", { name: "暖纸" }));
    const shell = document.querySelector(".app-shell")!;
    await waitFor(() => expect(shell)
      .toHaveAttribute("data-reading-theme", "warm-paper"));
    expect(shell).toHaveAttribute("data-theme", "light");
    await waitFor(() => expect(screen.getByRole("article", { name: "one.md" }))
      .toHaveAttribute("data-reading-theme", "warm-paper"));
    expect(JSON.parse(localStorage.getItem(READING_PREFERENCES_STORAGE_KEY) ?? "null")).toMatchObject({
      version: 1,
      theme: "warm-paper",
    });

    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(view).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "富文本" }));
    expect(shell).toHaveAttribute("data-reading-theme", "warm-paper");
    await user.click(screen.getByRole("button", { name: "源码" }));
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    expect(shell).toHaveAttribute("data-reading-theme", "warm-paper");

    await user.click(screen.getByRole("button", { name: "新建文档" }));
    expect(await screen.findByRole("region", { name: "开始" })).toBeVisible();
    expect(shell).toHaveAttribute("data-reading-theme", "warm-paper");

    await user.click(screen.getByRole("menuitem", { name: "查看" }));
    await user.click(screen.getByRole("menuitem", { name: "阅读外观…" }));
    await user.click(screen.getByRole("radio", { name: "夜间" }));
    expect(shell).toHaveAttribute("data-reading-theme", "night");
    expect(shell).toHaveAttribute("data-theme", "dark");
    const appCss = readFileSync(resolve(process.cwd(), "src/app/app.css"), "utf8");
    expect(appCss).toMatch(/\.app-shell\s*\{[^}]*color:\s*var\(--text-primary\);/s);
  });

  it("keeps Reading free of the disabled format toolbar and restores editing tools in Rich Text", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });

    expect(screen.queryByRole("toolbar", { name: "文档工具" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "富文本" }));
    expect(await screen.findByRole("toolbar", { name: "文档工具" })).toBeInTheDocument();
  });

  it("enters and exits Focus Reading without replacing the reading viewport", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\one.md"]);
    const draft: DraftRecord = {
      id: "00000000-0000-4000-8000-000000000001",
      sessionId: "session-1",
      canonicalPath: "C:\\docs\\draft.md",
      baselineVersion: null,
      bytes: [35, 32, 65],
      candidateRevision: 1,
      rejectedSourceBuffer: null,
      updatedMs: 1,
    };
    vi.mocked(host.listDrafts).mockResolvedValue([draft]);
    const rendered = render(<App host={host} />);
    await screen.findByRole("heading", { name: "A" });
    expect(screen.queryByRole("complementary", { name: "可恢复编辑" })).not.toBeInTheDocument();
    const viewport = rendered.container.querySelector(".document-viewport--reading");

    await user.click(screen.getByRole("menuitem", { name: "查看" }));
    await user.click(screen.getByRole("menuitem", { name: /^专注阅读/ }));

    expect(screen.queryByRole("menubar", { name: "应用菜单" })).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "文档工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "可恢复编辑" })).not.toBeInTheDocument();
    expect(rendered.container.querySelector(".statusbar")).toBeNull();
    expect(screen.getByRole("tablist", { name: "打开的文档" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "one.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出专注阅读" })).toBeInTheDocument();
    expect(rendered.container.querySelector(".document-viewport--reading")).toBe(viewport);

    await user.keyboard("{Escape}");
    expect(screen.getByRole("menubar", { name: "应用菜单" })).toBeInTheDocument();
    expect(rendered.container.querySelector(".statusbar")).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "可恢复编辑" })).not.toBeInTheDocument();
    expect(rendered.container.querySelector(".document-viewport--reading")).toBe(viewport);

    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    await user.click(screen.getByRole("button", { name: "退出专注阅读" }));
    expect(screen.getByRole("menubar", { name: "应用菜单" })).toBeInTheDocument();

    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    await user.click(screen.getByRole("button", { name: "新建文档" }));
    expect(await screen.findByRole("region", { name: "开始" })).toBeInTheDocument();
    expect(screen.getByRole("menubar", { name: "应用菜单" })).toBeInTheDocument();
  });

  it("removes a collapsed outline from layout, hands off focus, and restores its tree state", async () => {
    const user = userEvent.setup();
    const { host } = hostWithCloseEmitter(["C:\\docs\\one.md"]);
    vi.mocked(host.openDocument).mockResolvedValue({
      canonicalPath: "C:\\docs\\one.md",
      bytes: [...new TextEncoder().encode("# Intro\n\n## Child\n\n# Next")],
      version: VERSION,
    });
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "Intro" });
    const layout = document.querySelector(".workspace__document-layout")!;
    expect(layout).toHaveClass("workspace__document-layout--with-outline");
    const intro = screen.getByRole("button", { name: "Intro" });
    intro.focus();
    await user.keyboard("{ArrowLeft}");
    expect(intro).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Child" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "收起大纲" }));
    expect(layout).not.toHaveClass("workspace__document-layout--with-outline");
    expect(layout).not.toHaveClass("workspace__document-layout--outline-collapsed");
    expect(screen.queryByRole("complementary", { name: "文档大纲" })).not.toBeInTheDocument();
    expect(document.querySelector(".outline-pane[hidden]")).not.toBeVisible();
    const reveal = screen.getByRole("button", { name: "展开大纲" });
    expect(reveal).toHaveAttribute("aria-expanded", "false");
    expect(reveal).toHaveFocus();

    await user.click(reveal);
    expect(screen.getByRole("complementary", { name: "文档大纲" })).toBeVisible();
    expect(screen.getByRole("button", { name: "收起大纲" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Intro" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Child" })).not.toBeInTheDocument();
  });

  it("keeps keyboard control while crossing all-disabled menus and restores the current trigger", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture()} />);
    const file = await screen.findByRole("menuitem", { name: "文件" });
    file.focus();
    await user.keyboard("{ArrowDown}{ArrowRight}");
    const edit = screen.getByRole("menuitem", { name: "编辑" });
    expect(screen.getByRole("menu", { name: "编辑菜单" })).toBeInTheDocument();
    expect(edit).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    const insert = screen.getByRole("menuitem", { name: "插入" });
    expect(screen.getByRole("menu", { name: "插入菜单" })).toBeInTheDocument();
    expect(insert).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "插入菜单" })).not.toBeInTheDocument();
    expect(insert).toHaveFocus();
  });

  it("returns focus after a normal command and exposes truthful reading Copy and Select All", async () => {
    const user = userEvent.setup();
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    const paper = await screen.findByRole("article", { name: "one.md" });
    const heading = screen.getByRole("heading", { name: "A" });
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(heading);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    const edit = screen.getByRole("menuitem", { name: "编辑" });
    await user.click(edit);
    const editMenu = screen.getByRole("menu", { name: "编辑菜单" });
    expect(within(editMenu).getByRole("menuitem", { name: /^复制/ })).toBeEnabled();
    expect(within(editMenu).getByRole("menuitem", { name: /^全选/ })).toBeEnabled();
    expect(within(editMenu).getByRole("menuitem", { name: /^剪切/ })).toBeDisabled();
    expect(within(editMenu).getByRole("menuitem", { name: /^粘贴/ })).toBeDisabled();
    await user.click(within(editMenu).getByRole("menuitem", { name: /^复制/ }));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(edit).toHaveFocus();

    await user.click(edit);
    await user.click(screen.getByRole("menuitem", { name: /^全选/ }));
    expect(selection.toString()).toContain("A");
    expect(selection.anchorNode === paper || paper.contains(selection.anchorNode)).toBe(true);
    expect(edit).toHaveFocus();
  });

  it("clears a saved Reading selection when the active tab changes", async () => {
    const user = userEvent.setup();
    const copiedSelections: Array<{ insideBeta: boolean; text: string }> = [];
    const execCommand = vi.fn(() => {
      const current = window.getSelection();
      const betaPaper = screen.getByRole("article", { name: "b.md" });
      copiedSelections.push({
        insideBeta: Boolean(current?.anchorNode && (current.anchorNode === betaPaper || betaPaper.contains(current.anchorNode))),
        text: current?.toString() ?? "",
      });
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const tabs = [readingSession("a", "Alpha"), readingSession("b", "Beta")];
    const rendered = render(
      <>
        <MenuBar controller={menuController(tabs, "a")} onAbout={() => undefined} onToggleToolbar={() => undefined} toolbarVisible />
        <article aria-label="a.md" id="document-a"><h1>Alpha</h1></article>
        <article aria-label="b.md" id="document-b"><h1>Beta</h1></article>
      </>,
    );
    const alpha = screen.getByRole("heading", { name: "Alpha" });
    const selection = window.getSelection()!;
    const alphaRange = document.createRange();
    alphaRange.selectNodeContents(alpha);
    selection.removeAllRanges();
    selection.addRange(alphaRange);
    act(() => document.dispatchEvent(new Event("selectionchange")));
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    expect(screen.getByRole("menuitem", { name: /^复制/ })).toBeEnabled();

    rendered.rerender(
      <>
        <MenuBar controller={menuController(tabs, "b")} onAbout={() => undefined} onToggleToolbar={() => undefined} toolbarVisible />
        <article aria-label="a.md" id="document-a"><h1>Alpha</h1></article>
        <article aria-label="b.md" id="document-b"><h1>Beta</h1></article>
      </>,
    );
    expect(screen.getByRole("menuitem", { name: /^复制/ })).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));

    const beta = screen.getByRole("heading", { name: "Beta" });
    const betaRange = document.createRange();
    betaRange.selectNodeContents(beta);
    selection.removeAllRanges();
    selection.addRange(betaRange);
    act(() => document.dispatchEvent(new Event("selectionchange")));
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    await user.click(screen.getByRole("menuitem", { name: /^复制/ }));

    expect(execCommand).toHaveBeenCalledOnce();
    expect(copiedSelections).toEqual([{ insideBeta: true, text: "Beta" }]);
  });

  it("disables New and Open entry points and shortcuts while native closing is pending", async () => {
    const user = userEvent.setup();
    const { host, emitClose } = hostWithCloseEmitter();
    render(<App host={host} />);
    const empty = await screen.findByRole("region", { name: "开始" });
    await user.click(within(empty).getByRole("button", { name: "新建文档" }));
    await screen.findByRole("tab", { name: /未命名 1/ });

    act(() => emitClose());
    expect(await screen.findByRole("dialog", { name: "保存更改？" })).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "新建文档" });
    expect(add).toBeDisabled();
    await user.keyboard("{Control>}n{/Control}{Control>}o{/Control}");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(host.pickMarkdownFiles).not.toHaveBeenCalled();

    const file = screen.getByRole("menuitem", { name: "文件" });
    await user.click(file);
    expect(screen.getByRole("menuitem", { name: /^新建 Ctrl\+N/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /^打开… Ctrl\+O/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(add).toBeEnabled();
    await user.keyboard("{Control>}n{/Control}{Control>}o{/Control}");
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(host.pickMarkdownFiles).toHaveBeenCalledOnce();
  });

  it("disables Save and Save As together while one Save As intent is pending", async () => {
    const user = userEvent.setup();
    const savePath = deferred<string | null>();
    const host = hostFixture();
    vi.mocked(host.pickMarkdownSavePath).mockImplementation(() => savePath.promise);
    render(<App host={host} />);
    const empty = await screen.findByRole("region", { name: "开始" });
    await user.click(within(empty).getByRole("button", { name: "新建文档" }));

    const file = screen.getByRole("menuitem", { name: "文件" });
    await user.click(file);
    await user.click(screen.getByRole("menuitem", { name: /^另存为/ }));
    await waitFor(() => expect(host.pickMarkdownSavePath).toHaveBeenCalledOnce());
    await user.click(file);
    expect(screen.getByRole("menuitem", { name: /^保存 Ctrl\+S/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /^另存为/ })).toBeDisabled();
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    expect(host.pickMarkdownSavePath).toHaveBeenCalledOnce();

    await act(async () => { savePath.resolve(null); await savePath.promise; });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /^另存为/ })).toBeEnabled());
  });

  it("focuses and roves the grouped overflow menu, then returns to its exact trigger", async () => {
    installToolbarMedia(true);
    const user = userEvent.setup();
    render(<App host={hostFixture()} />);
    const more = await screen.findByRole("button", { name: "更多" });
    more.focus();
    await user.keyboard("{ArrowDown}");
    const overflow = screen.getByRole("menu", { name: "更多" });
    expect(within(overflow).getByText("格式")).not.toHaveAttribute("tabindex");
    const strike = within(overflow).getByRole("menuitemcheckbox", { name: "删除线" });
    const inlineCode = within(overflow).getByRole("menuitemcheckbox", { name: "行内代码" });
    for (const item of overflow.querySelectorAll("[data-toolbar-placement='overflow']")) {
      expect(item).toHaveAttribute("tabindex", "-1");
    }
    expect(strike).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(inlineCode).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(strike).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "更多" })).not.toBeInTheDocument();
    expect(more).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(within(screen.getByRole("menu", { name: "更多" })).getByRole("menuitemcheckbox", { name: "删除线" })).toHaveFocus();
    await user.tab();
    expect(screen.queryByRole("menu", { name: "更多" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "开始" })).getByRole("button", { name: "新建文档" })).toHaveFocus();
  });

  it("keeps the three reachable modes solely in the tab row with complete roving keys", async () => {
    const user = userEvent.setup();
    const rendered = render(<App host={hostFixture()} />);
    await screen.findByRole("tablist", { name: "打开的文档" });
    const group = screen.getByRole("group", { name: "文档模式" });
    for (const label of ["阅读", "富文本", "源码"]) {
      expect(within(group).getByRole("button", { name: label })).toBeDisabled();
    }
    expect(rendered.container.querySelector(".format-toolbar .document-tabs__mode-control")).toBeNull();
    expect(rendered.container.querySelector(".toolbar-overflow__menu .document-tabs__mode-control")).toBeNull();

    await user.click(within(screen.getByRole("region", { name: "开始" })).getByRole("button", { name: "新建文档" }));
    const reading = within(group).getByRole("button", { name: "阅读" });
    const rich = within(group).getByRole("button", { name: "富文本" });
    const source = within(group).getByRole("button", { name: "源码" });
    expect(reading).toBeEnabled();
    expect(rich).toBeEnabled();
    expect(source).toBeEnabled();
    expect([reading, rich, source].filter((button) => button.tabIndex === 0)).toHaveLength(1);
    reading.focus();
    await user.keyboard("{ArrowRight}");
    expect(rich).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(source).toHaveFocus();
    await user.keyboard("{Home}");
    expect(reading).toHaveFocus();
    await user.keyboard("{End}{Enter}");
    expect(source).toHaveFocus();
    expect(source).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the mode group fixed and visible while the tablist owns shrinking at compact width", async () => {
    installToolbarMedia(true);
    const user = userEvent.setup();
    const rendered = render(<App host={hostFixture(["C:\\docs\\one.md", "C:\\docs\\two.md"])} />);
    const tablist = await screen.findByRole("tablist", { name: "打开的文档" });
    const group = screen.getByRole("group", { name: "文档模式" });

    expect(getComputedStyle(group).flexShrink).toBe("0");
    expect(getComputedStyle(group).height).toBe("36px");
    expect(getComputedStyle(group).fontSize).toBe("12px");
    expect(getComputedStyle(group).lineHeight).toBe("16px");
    for (const label of ["阅读", "源码"]) {
      const mode = within(group).getByRole("button", { name: label });
      expect(getComputedStyle(mode).minWidth).toBe("60px");
      expect(getComputedStyle(mode).height).toBe("30px");
      expect(mode.querySelector("svg")).toHaveClass("document-tabs__mode-icon");
      mode.focus();
      expect(mode).toHaveFocus();
    }
    const css = readFileSync(resolve(process.cwd(), "src/app/app.css"), "utf8");
    expect(css).toMatch(/\.document-tabs__mode-control button:focus-visible\s*\{[^}]*outline-width:\s*2px;[^}]*outline-offset:\s*-2px;/s);
    expect(css).toMatch(/\.document-tabs__mode-control button:hover:not\(:disabled\):not\(\[aria-pressed="true"\]\)\s*\{[^}]*background:\s*var\(--line-subtle\)/s);
    expect(css).toMatch(/\.document-tabs__mode-control button:active:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent-subtle\)/s);
    expect(getComputedStyle(within(group).getByRole("button", { name: "阅读" })).fontWeight).toBe("600");
    expect(within(group).getByRole("button", { name: "阅读" })).toHaveAttribute("title", "阅读视图");
    expect(within(group).getByRole("button", { name: "富文本" })).toHaveAttribute("title", "富文本编辑");
    expect(within(group).getByRole("button", { name: "源码" })).toHaveAttribute("title", "Markdown 源码");
    await user.click(within(group).getByRole("button", { name: "富文本" }));
    expect(getComputedStyle(screen.getByRole("toolbar", { name: "文档工具" })).height).toBe("44px");
    expect(getComputedStyle(tablist).overflowX).toBe("auto");
    expect(rendered.container.querySelector(".document-tabs")?.lastElementChild).toBe(group);
    expect(primaryToolbarIds(screen.getByRole("toolbar", { name: "文档工具" }))).toEqual(COMPACT_PRIMARY_IDS);
  });

  it("keeps mounted shell and Find chrome fixed while Source document zoom is 150%", async () => {
    resolveCssVariables();
    const tab = { ...readingSession("zoom", "Zoom"), mode: "source" as const, zoomPercent: 150 };
    const controller = menuController([tab], tab.id);
    controller.getSourceView = vi.fn((_tabId, revision) => revision === tab.revision
      ? buildSourceView(tab.candidate)
      : null);
    const rendered = render(<AppShell
      controller={controller}
      host={hostFixture()}
      registry={createActiveSourceEditorRegistry()}
      renderDocument={() => <div>Reading</div>}
    />);
    const content = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    expect(getComputedStyle(content)).toMatchObject({ fontSize: "21px", lineHeight: "33px" });
    content.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "f",
    }));
    const find = await screen.findByRole("textbox", { name: "查找" });
    expect(getComputedStyle(find)).toMatchObject({
      fontSize: "12px",
      lineHeight: "16px",
      minHeight: "28px",
    });
    expect(getComputedStyle(find).fontFamily).toContain("Segoe UI Variable Text");

    expect(getComputedStyle(rendered.container.querySelector(".document-tabs")!).height).toBe("36px");
    expect(getComputedStyle(screen.getByRole("menubar", { name: "应用菜单" })).height).toBe("28px");
    expect(getComputedStyle(screen.getByRole("toolbar", { name: "文档工具" })).height).toBe("44px");
    expect(getComputedStyle(rendered.container.querySelector("footer.statusbar")!).height).toBe("28px");
    expect(getComputedStyle(screen.getByRole("group", { name: "文档模式" }))).toMatchObject({
      height: "36px",
      fontSize: "12px",
      lineHeight: "16px",
    });
    expect(getComputedStyle(screen.getByRole("status"))).toMatchObject({
      fontSize: "11px",
      lineHeight: "16px",
    });
  });

  it("returns focus to the exact current Source editor only when a buffered mode change is blocked", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\ud800" } }));
    const reading = screen.getByRole("button", { name: "阅读" });
    reading.focus();

    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "源码" })).toHaveAttribute("aria-pressed", "true");
    expect(textbox).toHaveFocus();
  });

  it("keeps the active tab idref bound to one stable tabpanel across Reading and Source", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md", "C:\\docs\\two.md"])} />);
    const activeTab = await screen.findByRole("tab", { name: /two\.md/ });
    const inactiveTab = screen.getByRole("tab", { name: /one\.md/ });
    const controlledId = activeTab.getAttribute("aria-controls")!;
    expect(controlledId).toMatch(/^document-/);
    expect(inactiveTab).not.toHaveAttribute("aria-controls");
    expect(document.getElementById(controlledId)).toHaveAttribute("role", "tabpanel");
    expect(document.getElementById(controlledId)).toHaveAttribute("aria-labelledby", activeTab.id);
    expect(screen.getAllByRole("article")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "源码" }));
    expect(await screen.findByRole("textbox", { name: "Markdown 源码编辑器" })).toBeInTheDocument();
    expect(document.getElementById(controlledId)).toHaveAttribute("role", "tabpanel");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".cm-scroller")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "阅读" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(document.getElementById(controlledId)).toHaveAttribute("role", "tabpanel");
  });

  it("formats NT drive and UNC paths for tab labels, names, and tooltips without changing internal identity", async () => {
    for (const canonicalPath of [
      "\\\\?\\C:\\docs\\one.md",
      "\\\\?\\UNC\\server\\share\\one.md",
    ]) {
      const rendered = render(<App host={hostFixture([canonicalPath])} />);
      const tab = await screen.findByRole("tab", { name: "one.md" });
      expect(tab.getAttribute("aria-label")).not.toContain("\\\\?\\");
      expect(tab.closest(".document-tab")).toHaveAttribute(
        "title",
        canonicalPath.includes("UNC") ? "\\\\server\\share\\one.md" : "C:\\docs\\one.md",
      );
      rendered.unmount();
    }
  });

  it("binds Source Edit-menu Copy and Select All to the exact live CodeMirror bridge", async () => {
    const user = userEvent.setup();
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    const rendered = render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ selection: { anchor: 2, head: 3 } }));

    const edit = screen.getByRole("menuitem", { name: "编辑" });
    await user.click(edit);
    const menu = screen.getByRole("menu", { name: "编辑菜单" });
    const copy = within(menu).getByRole("menuitem", { name: /^复制/ });
    expect(copy).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: /^剪切/ })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /^粘贴/ })).toBeDisabled();
    await user.click(copy);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(textbox).toHaveFocus();

    await user.click(edit);
    await user.click(screen.getByRole("menuitem", { name: /^全选/ }));
    expect(view.state.selection.main).toMatchObject({ from: 0, to: view.state.doc.length });
    expect(rendered.container.querySelector("article")).toBeNull();
  });

  it("prepares the exact Source bridge when keyboard arrows enter Edit and preserves editor focus ownership", async () => {
    const user = userEvent.setup();
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ selection: { anchor: 2, head: 3 } }));

    const file = screen.getByRole("menuitem", { name: "文件" });
    file.focus();
    await user.keyboard("{ArrowDown}{ArrowRight}");
    const editMenu = screen.getByRole("menu", { name: "编辑菜单" });
    const copy = within(editMenu).getByRole("menuitem", { name: /^复制/ });
    expect(copy).toBeEnabled();
    expect(within(editMenu).getByRole("menuitem", { name: /^全选/ })).toBeEnabled();
    await user.click(copy);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(textbox).toHaveFocus();

    file.focus();
    await user.keyboard("{ArrowDown}{ArrowRight}");
    await user.click(screen.getByRole("menuitem", { name: /^全选/ }));
    await Promise.resolve();
    expect(view.state.selection.main).toMatchObject({ from: 0, to: view.state.doc.length });
    expect(textbox).toHaveFocus();
  });

  it("routes Source Edit-menu Undo and Redo through the same canonical command state exactly once", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    const original = view.state.doc.toString();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${original}B`));
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "C" } }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${original}BC`));

    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    const undo = screen.getByRole("menuitem", { name: /^撤销/ });
    expect(undo).toBeEnabled();
    await user.click(undo);
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${original}B`));

    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    await user.click(screen.getByRole("menuitem", { name: /^撤销/ }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(original));

    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    const redo = screen.getByRole("menuitem", { name: /^重做/ });
    expect(redo).toBeEnabled();
    await user.click(redo);
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${original}B`));

    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    await user.click(screen.getByRole("menuitem", { name: /^重做/ }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${original}BC`));
  });

  it("makes an initially enabled Source Copy action stale after revision replacement", async () => {
    const user = userEvent.setup();
    const clipboard = { writeText: vi.fn(async () => undefined) };
    vi.stubGlobal("navigator", { ...navigator, clipboard });
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ selection: { anchor: 2, head: 3 } }));
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    const retainedCopy = screen.getByRole("menuitem", { name: /^复制/ });
    expect(retainedCopy).toBeEnabled();

    const before = view.state.doc.toString();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${before}B`));
    retainedCopy.click();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "编辑" })).toHaveFocus());

    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(`${before}B`);
    expect(view.state.selection.main).toMatchObject({ from: 2, to: 3 });
  });

  it("keeps focus on the new tab when a disconnected tab-stale Source Select All callback is attacked", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md", "C:\\docs\\two.md"])} />);
    const one = await screen.findByRole("tab", { name: /one\.md/ });
    await user.click(one);
    await user.click(screen.getByRole("button", { name: "源码" }));
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    const retainedSelectAll = screen.getByRole("menuitem", { name: /^全选/ });
    expect(retainedSelectAll).toBeEnabled();

    const two = screen.getByRole("tab", { name: /two\.md/ });
    await user.click(two);
    retainedSelectAll.click();

    expect(two).toHaveFocus();
    expect(screen.getByRole("article", { name: "two.md" })).toBeInTheDocument();
  });

  it("keeps Source Copy disabled without clipboard and makes a stale menu action an exact no-op", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(<App host={hostFixture(["C:\\docs\\one.md", "C:\\docs\\two.md"])} />);
    const one = await screen.findByRole("tab", { name: /one\.md/ });
    await user.click(one);
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ selection: { anchor: 2, head: 3 } }));
    const edit = screen.getByRole("menuitem", { name: "编辑" });
    await user.click(edit);
    const copy = screen.getByRole("menuitem", { name: /^复制/ });
    expect(copy).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: /two\.md/ }));
    copy.click();
    expect(view.state.selection.main).toMatchObject({ from: 2, to: 3 });
  });

  it("uses a non-live footer with one polite status and one non-nested invalid alert", async () => {
    const user = userEvent.setup();
    const rendered = render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\ud800" } }));

    const footer = rendered.container.querySelector<HTMLElement>("footer.statusbar")!;
    expect(footer).not.toHaveAttribute("role");
    expect(within(footer).getByRole("status")).toBeInTheDocument();
    const alerts = within(footer).getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("源码有字符无法保存");
    expect(alerts[0].parentElement?.closest("[role='status'], [aria-live]")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("有字符无法保存。内容已保留，请删除或替换。");
    expect(rendered.container.querySelector(".statusbar__meta")).toHaveTextContent("4 字符 · 标准 GFM");
  });

  it("keeps character count, mode, and zoom outside the polite status while ordinary Source typing stays quiet", async () => {
    const user = userEvent.setup();
    const rendered = render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    const live = within(rendered.container.querySelector("footer.statusbar")!).getByRole("status");
    expect(live).not.toHaveTextContent(/字符|源码|%/);

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } }));
    await waitFor(() => expect(live).toHaveTextContent("未保存"));
    const afterFirstEdit = live.textContent;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "C" } }));
    await waitFor(() => expect(rendered.container.querySelector(".statusbar__meta")).toHaveTextContent("5 字符"));

    expect(live.textContent).toBe(afterFirstEdit);
    expect(rendered.container.querySelector(".statusbar__modes")).toHaveTextContent("源码");
    expect(rendered.container.querySelector(".statusbar__zoom")).toHaveTextContent("100%");
  });

  it("opens the real localized Source Find panel from the familiar Edit menu", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md"])} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    const find = screen.getByRole("menuitem", { name: /^查找/ });
    expect(find).toBeEnabled();

    await user.click(find);

    expect(await screen.findByRole("textbox", { name: "查找" })).toHaveFocus();
  });

  it("lets Source consume Save once and makes a pre-prevented chrome shortcut a shell no-op", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\one.md"]);
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nchanged" } }));
    textbox.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "s" }));
    await waitFor(() => expect(host.saveDocument).toHaveBeenCalledOnce());

    const prevented = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "n" });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("keeps toolbar, Edit-menu, and Source-key history equally enabled during one deferred Save", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\one.md"]);
    const write = deferred<FileVersion>();
    vi.mocked(host.saveDocument).mockImplementation(() => write.promise);
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    const original = view.state.doc.toString();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } }));
    textbox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "s",
    }));
    await waitFor(() => expect(host.saveDocument).toHaveBeenCalledOnce());

    const toolbarUndo = screen.getByRole("button", { name: "撤销" });
    expect(toolbarUndo).toBeEnabled();
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));
    const menuUndo = screen.getByRole("menuitem", { name: /^撤销/ });
    expect(menuUndo).toBeEnabled();
    await user.click(menuUndo);
    await waitFor(() => expect(view.state.doc.toString()).toBe(original));

    textbox.focus();
    textbox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "y",
    }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${original}B`));
    await user.click(toolbarUndo);
    await waitFor(() => expect(view.state.doc.toString()).toBe(original));
    textbox.focus();
    textbox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "y",
    }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${original}B`));
    textbox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "z",
    }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(original));

    write.resolve(VERSION);
  });

  it("routes real Source S/Z/Y through exactly one canonical transition and never falls through to CM history", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\one.md"]);
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nchanged" } }));
    expect(view.state.doc.toString()).toContain("changed");

    const undo = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z" });
    textbox.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    await waitFor(() => expect(view.state.doc.toString()).toBe("# A"));
    const redo = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "y" });
    textbox.dispatchEvent(redo);
    expect(redo.defaultPrevented).toBe(true);
    await waitFor(() => expect(view.state.doc.toString()).toContain("changed"));
    const save = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "s" });
    textbox.dispatchEvent(save);
    expect(save.defaultPrevented).toBe(true);
    await waitFor(() => expect(host.saveDocument).toHaveBeenCalledOnce());
  });

  it("routes unconsumed Reading S/Z/Y through the same command state exactly once", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\one.md"]);
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n\nchanged" } }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /未保存/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "阅读" }));
    await waitFor(() => expect(screen.getByText("changed")).toBeInTheDocument());

    const undo = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z" });
    act(() => window.dispatchEvent(undo));
    expect(undo.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByText("changed")).not.toBeInTheDocument());
    const redo = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "y" });
    act(() => window.dispatchEvent(redo));
    expect(redo.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByText("changed")).toBeInTheDocument());
    const save = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "s" });
    act(() => window.dispatchEvent(save));
    expect(save.defaultPrevented).toBe(true);
    await waitFor(() => expect(host.saveDocument).toHaveBeenCalledOnce());
  });

  it("keeps Ctrl+Shift+S shell-owned exactly once from Source and Reading", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\one.md"]);
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const fromSource = new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, shiftKey: true, key: "s",
    });
    textbox.dispatchEvent(fromSource);
    expect(fromSource.defaultPrevented).toBe(true);
    await waitFor(() => expect(host.pickMarkdownSavePath).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "阅读" }));
    const fromReading = new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, shiftKey: true, key: "s",
    });
    window.dispatchEvent(fromReading);
    expect(fromReading.defaultPrevented).toBe(true);
    await waitFor(() => expect(host.pickMarkdownSavePath).toHaveBeenCalledTimes(2));
  });

  it("ignores pre-prevented Reading S/Z/Y without Host calls or candidate transitions", async () => {
    const user = userEvent.setup();
    const host = hostFixture(["C:\\docs\\one.md"]);
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "A" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n\nchanged" } }));
    await user.click(screen.getByRole("button", { name: "阅读" }));
    await waitFor(() => expect(screen.getByText("changed")).toBeInTheDocument(), { timeout: 5_000 });

    for (const key of ["s", "z", "y"]) {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key });
      event.preventDefault();
      window.dispatchEvent(event);
    }
    expect(host.saveDocument).not.toHaveBeenCalled();
    expect(screen.getByText("changed")).toBeInTheDocument();
  });

  it("restores exact rejected code units and Source selection after tab-away and remount", async () => {
    const user = userEvent.setup();
    render(<App host={hostFixture(["C:\\docs\\one.md", "C:\\docs\\two.md"])} />);
    const one = await screen.findByRole("tab", { name: /one\.md/ });
    await screen.findByRole("tab", { name: /two\.md/ });
    await user.click(one);
    await user.click(screen.getByRole("button", { name: "源码" }));
    let textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    let view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({
      changes: { from: view.state.doc.length, insert: "\ud800" },
      selection: { anchor: view.state.doc.length + 1, head: view.state.doc.length + 1 },
    }));
    expect(view.state.doc.toString().charCodeAt(view.state.doc.length - 1)).toBe(0xd800);

    await user.click(screen.getByRole("tab", { name: /two\.md/ }));
    await user.click(screen.getByRole("tab", { name: /one\.md，未保存/ }));
    textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    view = EditorView.findFromDOM(textbox)!;
    expect(view.state.doc.toString().charCodeAt(view.state.doc.length - 1)).toBe(0xd800);
    expect(view.state.selection.main).toMatchObject({
      anchor: view.state.doc.length,
      head: view.state.doc.length,
    });
  });

  it("restores the actual Reading viewport neighborhood through Source and tab-away independently of caret selection", async () => {
    const user = userEvent.setup();
    const encoder = new TextEncoder();
    const host = hostFixture(["C:\\docs\\one.md", "C:\\docs\\two.md"]);
    vi.mocked(host.openDocument).mockImplementation(async (path) => ({
      canonicalPath: path,
      bytes: [...encoder.encode(path.endsWith("one.md")
        ? "# First\n\nParagraph one\n\nParagraph two\n"
        : "# Other\n")],
      version: VERSION,
    }));
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const start = Number(this.dataset.sourceViewStart);
      return Number.isFinite(start) ? start * 20 : 0;
    });
    const rendered = render(<App host={host} />);
    await screen.findByRole("tab", { name: /two\.md/ });
    await user.click(screen.getByRole("tab", { name: /one\.md/ }));
    const firstHeading = await screen.findByRole("heading", { name: "First" });
    const reading = rendered.container.querySelector<HTMLElement>(".document-viewport--reading");
    expect(reading).not.toBeNull();
    if (!reading) return;
    const blocks = [...reading.querySelectorAll<HTMLElement>("[data-block-view-key]")];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const neighborhood = blocks[1];
    const neighborhoodKey = neighborhood.dataset.blockViewKey;
    reading.scrollTop = neighborhood.offsetTop;
    fireEvent.scroll(reading);

    const range = document.createRange();
    range.selectNodeContents(firstHeading);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    await user.click(screen.getByRole("button", { name: "阅读" }));
    let restored = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    await waitFor(() => expect(restored.scrollTop).toBe(
      restored.querySelector<HTMLElement>(`[data-block-view-key="${neighborhoodKey}"]`)!.offsetTop,
    ));

    await user.click(screen.getByRole("tab", { name: /two\.md/ }));
    await user.click(screen.getByRole("tab", { name: /one\.md/ }));
    restored = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    await waitFor(() => expect(restored.scrollTop).toBe(
      restored.querySelector<HTMLElement>(`[data-block-view-key="${neighborhoodKey}"]`)!.offsetTop,
    ));
    expect(document.getSelection()?.toString()).not.toBe("Paragraph one");
  });
});

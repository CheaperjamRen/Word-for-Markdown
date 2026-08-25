import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";

import type { FileVersion, HostApi, HostOpenDocument } from "../contracts/desktop";
import App from "./App";
import { LOCALE_STORAGE_KEY } from "../i18n/locale";

const VERSION: FileVersion = { len: 9, modifiedMs: 1_700_000_000_000, sha256: "baseline-sha256" };
const encoder = new TextEncoder();

function opened(path: string, markdown = "# 文档\n\n正文"): HostOpenDocument {
  return { canonicalPath: path, bytes: [...encoder.encode(markdown)], version: VERSION };
}

function findDocumentTab(name: RegExp) {
  return screen.findByRole("tab", { name }, { timeout: 3_000 });
}

function selectEditorContents(editor: HTMLElement): void {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function testHost(initialPaths: string[] = []) {
  let secondInstance: ((paths: string[]) => void) | undefined;
  let fileDrop: ((paths: string[]) => void) | undefined;
  let closeRequested: (() => void) | undefined;
  const files = new Map([
    ["C:\\docs\\first.md", opened("C:\\docs\\first.md", "# 第一篇")],
    ["C:\\docs\\second.markdown", opened("C:\\docs\\second.markdown", "# 第二篇")],
  ]);
  const host = {
    onOpenRequests: vi.fn(async (listener: (paths: string[]) => void) => {
      secondInstance = listener;
      if (initialPaths.length) listener(initialPaths);
      return () => undefined;
    }),
    onFileDrop: vi.fn(async (listener: (paths: string[]) => void) => {
      fileDrop = listener;
      return () => undefined;
    }),
    onWindowCloseRequested: vi.fn(async (listener: () => void) => {
      closeRequested = listener;
      return () => undefined;
    }),
    closeWindow: vi.fn(async () => undefined),
    getAppVersion: vi.fn(async () => "0.1.0"),
    onFileChanged: vi.fn(async () => () => undefined),
    pickMarkdownFiles: vi.fn(async () => ["C:\\docs\\first.md"]),
    pickMarkdownSavePath: vi.fn(async () => null),
    openDocument: vi.fn(async (path: string) => {
      const result = files.get(path) ?? files.get(path.replace("c:\\DOCS", "C:\\docs").replace("FIRST", "first"));
      if (!result) throw new Error("找不到文件");
      return result;
    }),
    saveDocument: vi.fn(async () => VERSION),
    saveDocumentAs: vi.fn(async () => ({ canonicalPath: "C:\\docs\\saved.md", version: VERSION })),
    writeDraft: vi.fn(), listDrafts: vi.fn(async () => []), readDraft: vi.fn(), deleteDraft: vi.fn(),
    watchDocument: vi.fn(), unwatchDocument: vi.fn(), setWindowTitle: vi.fn(async () => undefined),
    recordFirstReadablePaint: vi.fn(async () => 100),
  } as unknown as HostApi;
  return {
    host,
    emitSecondInstance(paths: string[]) { secondInstance?.(paths); },
    drop(paths: string[]) { fileDrop?.(paths); },
    requestWindowClose() { closeRequested?.(); },
  };
}

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe("desktop document shell", () => {
  it("switches the complete shell language immediately from Settings", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en-US");
    const user = userEvent.setup();
    const { host } = testHost();
    render(<App host={host} />);

    expect(await screen.findByRole("region", { name: "Start" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Start" })).getByRole("button", { name: "New Document" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Document Tools" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[\p{Script=Han}]/u);
    await waitFor(() => expect(host.setWindowTitle).toHaveBeenCalledWith("Markdown Document"));
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Settings…" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "简体中文" }));

    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "开始" })).getByRole("button", { name: "新建文档" })).toBeInTheDocument();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    await waitFor(() => expect(host.setWindowTitle).toHaveBeenCalledWith("Markdown 文档"));
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("menuitem", { name: "文件" })).toHaveFocus();
  });

  it("offers Chinese and English in the NSIS language selector", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
    const hooks = readFileSync(resolve(process.cwd(), "src-tauri/windows/installer-hooks.nsh"), "utf8");

    expect(config.bundle.windows.nsis).toMatchObject({
      displayLanguageSelector: true,
      languages: ["SimpChinese", "English"],
    });
    expect(hooks).toContain('"InstallerLanguage" "zh-CN"');
    expect(hooks).toContain('"InstallerLanguage" "en-US"');
    expect(hooks).toContain("MUI_LANGDLL_ALWAYSSHOW");
  });
  it("preserves a middle Reading selection while the toolbar snapshot updates", async () => {
    const { host } = testHost(["C:\\docs\\first.md"]);
    vi.mocked(host.openDocument).mockResolvedValue(
      opened("C:\\docs\\first.md", "# 第一篇\n\n- **容量：**上下文窗口按 Token 计。"),
    );
    render(<App host={host} />);
    const item = await screen.findByRole("listitem");
    const text = item.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 8);
    selection.removeAllRanges();
    selection.addRange(range);

    act(() => document.dispatchEvent(new Event("selectionchange")));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(selection.toString()).toBe("：上下文窗口");
    expect(selection.anchorOffset).toBe(2);
    expect(selection.focusOffset).toBe(8);
  });

  it("uses the product identity in npm, Cargo, Tauri, runtime, and integration imports", () => {
    const root = resolve(process.cwd());
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const cargo = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
    const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
    const runtime = [
      readFileSync(resolve(root, "src-tauri/src/main.rs"), "utf8"),
      readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8"),
      readFileSync(resolve(root, "src-tauri/tests/generated_handler.rs"), "utf8"),
      readFileSync(resolve(root, "src-tauri/tests/lifecycle.rs"), "utf8"),
      readFileSync(resolve(root, "index.html"), "utf8"),
      readFileSync(resolve(root, "README.md"), "utf8"),
    ].join("\n");
    expect(packageJson).toMatchObject({ name: "markdown-document-app", version: "0.1.0" });
    expect(cargo).toContain('name = "markdown-document-app"');
    expect(cargo).toContain('name = "markdown_document_app_lib"');
    expect(config).toMatchObject({
      productName: "Markdown 文档", version: "0.1.0", identifier: "app.markdown-document",
      app: { windows: [{ title: "Markdown 文档" }] },
    });
    expect(runtime).toContain("markdown_document_app_lib");
    expect(runtime).not.toMatch(/Markdown Document Spike|markdown_document_spike_lib/);
  });

  it("ships separate Markdown file and application icon masters", () => {
    const root = resolve(process.cwd(), "src-tauri/icons");
    const fileIcon = readFileSync(resolve(root, "markdown-file.svg"), "utf8");
    const appIcon = readFileSync(resolve(root, "markdown-app.svg"), "utf8");
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
    const installerHooks = readFileSync(resolve(process.cwd(), "src-tauri/windows/installer-hooks.nsh"), "utf8");

    expect(fileIcon).toMatch(/folded Markdown file/i);
    expect(fileIcon).toContain('data-icon-role="markdown-file"');
    expect(fileIcon).toContain('data-icon-part="paper"');
    expect(fileIcon).toContain('data-icon-part="markdown-mark"');
    expect(fileIcon).toContain('data-icon-part="markdown-arrow"');
    expect(fileIcon).not.toContain('data-icon-part="editing-pencil"');

    expect(appIcon).toContain('data-icon-role="markdown-app"');
    expect(appIcon).toContain('data-icon-part="paper"');
    expect(appIcon).toContain('data-icon-part="markdown-mark"');
    expect(appIcon).toContain('data-icon-part="editing-pencil"');
    expect(appIcon).not.toContain('data-icon-part="markdown-arrow"');

    for (const icon of [appIcon, fileIcon]) {
      const normalized = icon.toLowerCase();
      expect(normalized).toContain("#22323d");
      expect(normalized).toContain("#ef8737");
      expect(normalized).not.toMatch(/<rect\b/);
      expect(normalized).not.toContain("leemo");
    }

    expect(appIcon).not.toEqual(fileIcon);
    expect(config.bundle.resources).toContain("icons/markdown-file.ico");
    expect(config.bundle.windows.nsis.installerHooks).toBe("windows/installer-hooks.nsh");
    expect(config.bundle.windows.nsis.installerIcon).toBe("icons/icon.ico");
    expect(config.bundle.windows.nsis.uninstallerIcon).toBe("icons/icon.ico");
    expect(installerHooks).toContain("Markdown Document\\DefaultIcon");
    expect(installerHooks).toContain("markdown-file.ico");
  });

  it("creates an untitled tab from the empty state", async () => {
    const user = userEvent.setup();
    const { host } = testHost();
    render(<App host={host} />);
    const empty = await screen.findByRole("region", { name: "开始" });
    await user.click(within(empty).getByRole("button", { name: "新建文档" }));
    expect(await findDocumentTab(/未命名 1/)).toHaveAttribute("aria-selected", "true");
  });

  it("opens a selected Markdown file from the empty state", async () => {
    const user = userEvent.setup();
    const { host } = testHost();
    render(<App host={host} />);
    const empty = await screen.findByRole("region", { name: "开始" });
    await user.click(within(empty).getByRole("button", { name: "打开文档" }));
    expect(await findDocumentTab(/first\.md/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "第一篇" })).toBeInTheDocument();
  });

  it("uses the same deduplicating tab path for second-instance and file-drop requests", async () => {
    const { host, emitSecondInstance, drop } = testHost(["C:\\docs\\first.md"]);
    render(<App host={host} />);
    expect(await findDocumentTab(/first\.md/)).toBeInTheDocument();
    act(() => emitSecondInstance(["c:\\DOCS\\FIRST.md", "C:\\docs\\second.markdown"]));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    act(() => drop(["C:\\docs\\first.md", "C:\\docs\\notes.txt"]));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getByRole("status")).toHaveTextContent("仅支持 .md 和 .markdown 文件");
  });

  it("routes desktop shortcuts to real file actions", async () => {
    const { host } = testHost();
    render(<App host={host} />);
    await screen.findByRole("region", { name: "开始" });
    await userEvent.keyboard("{Control>}n{/Control}");
    expect(screen.getByRole("tab", { name: /未命名 1/ })).toBeInTheDocument();
    await userEvent.keyboard("{Control>}o{/Control}");
    expect(await findDocumentTab(/first\.md/)).toBeInTheDocument();
    await userEvent.keyboard("{Control>}w{/Control}");
    expect(screen.queryByRole("tab", { name: /first\.md/ })).not.toBeInTheDocument();
  });

  it("keeps only the native title and omits banned dark-shell copy", async () => {
    const { host } = testHost(["C:\\docs\\first.md"]);
    const { container } = render(<App host={host} />);
    await screen.findByRole("heading", { name: "第一篇" });
    expect(host.setWindowTitle).toHaveBeenLastCalledWith("first.md");
    expect(container.querySelector(".titlebar")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("编辑段落");
    expect(container).not.toHaveTextContent("仅手动保存写回原文件");
    expect(container.textContent).not.toContain("\\\\?\\");
  });

  it("makes the Rich mode reachable for an opened document", async () => {
    const { host } = testHost(["C:\\docs\\first.md"]);
    const user = userEvent.setup();
    const rendered = render(<App host={host} />);
    await findDocumentTab(/first\.md/);

    const rich = screen.getByRole("button", { name: "富文本" });
    expect(rich).toBeEnabled();
    await user.click(rich);
    expect(rich).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByTestId("rich-document-surface")).toBeInTheDocument();

    await user.click(screen.getByRole("heading", { name: "第一篇" }));
    const editor = await screen.findByRole("textbox", { name: "编辑 Markdown 文档" });
    selectEditorContents(editor);
    const globalBold = rendered.container.querySelector<HTMLButtonElement>(
      '.format-toolbar button[aria-label="加粗"]',
    )!;
    await waitFor(() => expect(globalBold).toBeEnabled());
    await user.click(globalBold);
    await waitFor(() => expect(screen.getByRole("tab", { name: /first\.md，未保存/ })).toBeInTheDocument());
    expect(rendered.container.querySelector(".lexical-block-editor__toolbar")).toBeNull();
  });

  it("moves one Reading selection into Rich and runs the global format command once", async () => {
    const { host } = testHost(["C:\\docs\\first.md"]);
    const user = userEvent.setup();
    const rendered = render(<App host={host} />);
    const heading = await screen.findByRole("heading", { name: "第一篇" });
    selectEditorContents(heading);
    const globalBold = rendered.container.querySelector<HTMLButtonElement>(
      '.format-toolbar button[aria-label="加粗"]',
    )!;
    await waitFor(() => expect(globalBold).toBeEnabled());

    await user.click(globalBold);

    await waitFor(() => expect(screen.getByRole("button", { name: "富文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    ), { timeout: 3_000 });
    const editor = await screen.findByRole("textbox", { name: "编辑 Markdown 文档" });
    await waitFor(() => expect(editor).toHaveFocus(), { timeout: 3_000 });
    await waitFor(() => expect(screen.getByRole("tab", { name: /first\.md，未保存/ })).toBeInTheDocument());
    expect(host.saveDocument).not.toHaveBeenCalled();
  });

  it("uses the same Reading-to-Rich command path from the Format menu", async () => {
    const { host } = testHost(["C:\\docs\\first.md"]);
    const user = userEvent.setup();
    render(<App host={host} />);
    const heading = await screen.findByRole("heading", { name: "第一篇" });
    selectEditorContents(heading);

    await user.click(screen.getByRole("menuitem", { name: "格式" }));
    const bold = await screen.findByRole("menuitem", { name: "加粗" });
    expect(bold).toBeEnabled();
    await user.click(bold);

    await waitFor(() => expect(screen.getByRole("button", { name: "富文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    ));
    expect(await screen.findByRole("textbox", { name: "编辑 Markdown 文档" })).toHaveFocus();
    await waitFor(() => expect(screen.getByRole("tab", { name: /first\.md，未保存/ })).toBeInTheDocument());
    expect(host.saveDocument).not.toHaveBeenCalled();
  });

  it("opens the candidate find bar in Reading and returns focus on Escape", async () => {
    const { host } = testHost(["C:\\docs\\first.md"]);
    const user = userEvent.setup();
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "第一篇" });
    const viewport = document.querySelector<HTMLElement>(".document-viewport--reading")!;
    viewport.scrollTop = 120;
    const invoker = screen.getByRole("menuitem", { name: "编辑" });
    invoker.focus();

    await user.keyboard("{Control>}f{/Control}");
    const input = await screen.findByRole("searchbox", { name: "查找文本" }) as HTMLInputElement;
    const findBar = screen.getByTestId("find-bar");
    expect(findBar.closest(".workspace")).not.toBeNull();
    expect(findBar.parentElement).toHaveClass("workspace__find-overlay");
    expect(document.querySelector(".app-shell")).not.toHaveClass("app-shell--find-open");
    expect(viewport.scrollTop).toBe(120);
    expect(input).toHaveFocus();
    await user.type(input, "第一");
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    input.setSelectionRange(2, 2);
    screen.getByRole("button", { name: "阅读" }).focus();
    await user.keyboard("{Control>}f{/Control}");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(2);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();
    expect(invoker).toHaveFocus();
  });

  it("closes a document find session when its mode or active tab changes", async () => {
    const { host } = testHost(["C:\\docs\\first.md", "C:\\docs\\second.markdown"]);
    const user = userEvent.setup();
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "第二篇" });

    await user.keyboard("{Control>}f{/Control}");
    expect(await screen.findByTestId("find-bar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "富文本" }));
    expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "阅读" }));
    await user.keyboard("{Control>}f{/Control}");
    expect(await screen.findByTestId("find-bar")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /first\.md/ }));
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "第一篇" })).toBeInTheDocument(),
      { timeout: 3_000 },
    );
    expect(screen.queryByTestId("find-bar")).not.toBeInTheDocument();
  });

  it("opens the single LinkPanel from the Insert menu and applies a Reading selection", async () => {
    const { host } = testHost(["C:\\docs\\first.md"]);
    const user = userEvent.setup();
    render(<App host={host} />);
    const heading = await screen.findByRole("heading", { name: "第一篇" });
    selectEditorContents(heading);

    await user.click(screen.getByRole("menuitem", { name: "插入" }));
    const linkItem = await screen.findByRole("menuitem", { name: "链接" });
    expect(linkItem).toBeEnabled();
    await user.click(linkItem);
    const dialog = await screen.findByRole("dialog", { name: "链接" });
    const url = within(dialog).getByRole("textbox", { name: "链接地址" });
    await user.type(url, "https://example.com");
    await user.click(within(dialog).getByRole("button", { name: "应用" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "富文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    ));
    await waitFor(() => expect(screen.getByRole("tab", { name: /first\.md，未保存/ })).toBeInTheDocument());
    expect(await screen.findByRole("link", { name: "第一篇" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
  });

  it("keeps Protected Raw visible, guarded, and recoverable in Rich", async () => {
    const { host } = testHost(["C:\\docs\\first.md"]);
    vi.mocked(host.openDocument).mockResolvedValue(
      opened("C:\\docs\\first.md", "<custom-widget>keep</custom-widget>\n\n# 文档"),
    );
    const user = userEvent.setup();
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "文档" });
    await user.click(screen.getByRole("button", { name: "富文本" }));
    const sourceButton = await screen.findByRole("button", { name: "编辑源码" });
    await user.click(sourceButton);
    const raw = await screen.findByRole("textbox", { name: "局部 Markdown 源码" });
    fireEvent.change(raw, { target: { value: "bad\ud800" } });
    await user.click(screen.getByRole("button", { name: "保存局部源码" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("内容无法解析"))).toBe(true));
    expect(screen.getByRole("textbox", { name: "局部 Markdown 源码" })).toHaveValue("bad\ud800");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByRole("button", { name: "编辑源码" })).toBeInTheDocument();
    expect(host.saveDocument).not.toHaveBeenCalled();
  });

  it("switches the same tab Reading to real Source, edits the candidate without autosave, then saves explicitly", async () => {
    const user = userEvent.setup();
    const { host } = testHost(["C:\\docs\\first.md"]);
    const rendered = render(<App host={host} />);
    await screen.findByRole("heading", { name: "第一篇" });

    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox);
    expect(view).not.toBeNull();
    act(() => view!.dispatch({ changes: { from: view!.state.doc.length, insert: "\n\nSource edit" } }));

    expect(host.saveDocument).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "源码" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "阅读" }));
    await waitFor(() => expect(screen.getByText("Source edit")).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /first\.md，未保存/ })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "源码" }));
    const remounted = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    expect(EditorView.findFromDOM(remounted)?.state.doc.toString()).toContain("Source edit");
    await user.click(screen.getByRole("button", { name: "阅读" }));

    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(host.saveDocument).toHaveBeenCalledOnce());
    expect(rendered.container.querySelector(".cm-editor")).toBeNull();
  });

  it("undoes and redoes one continuous Source typing group in one step", async () => {
    const user = userEvent.setup();
    const { host } = testHost(["C:\\docs\\first.md"]);
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "第一篇" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    const before = view.state.doc.toString();

    for (const [index, character] of [..."hello"].entries()) {
      const from = before.length + index;
      act(() => view.dispatch({
        changes: { from, insert: character },
        selection: { anchor: from + 1 },
        annotations: [
          Transaction.userEvent.of("input.type"),
          Transaction.time.of(100 + index * 50),
        ],
      }));
    }
    expect(view.state.doc.toString()).toBe(`${before}hello`);

    textbox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "z",
    }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(before));

    textbox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "y",
    }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${before}hello`));
  });

  it("keeps selection replacement separate from the following Source typing group", async () => {
    const user = userEvent.setup();
    const { host } = testHost(["C:\\docs\\first.md"]);
    render(<App host={host} />);
    await screen.findByRole("heading", { name: "第一篇" });
    await user.click(screen.getByRole("button", { name: "源码" }));
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = EditorView.findFromDOM(textbox)!;
    const before = view.state.doc.toString();
    const from = before.length - 1;

    act(() => view.dispatch({
      selection: { anchor: from, head: before.length },
      annotations: Transaction.userEvent.of("select.pointer"),
    }));
    act(() => view.dispatch({
      changes: { from, to: before.length, insert: "X" },
      selection: { anchor: before.length },
      annotations: [
        Transaction.userEvent.of("input.type"),
        Transaction.time.of(100),
      ],
    }));
    act(() => view.dispatch({
      changes: { from: before.length, insert: "Y" },
      selection: { anchor: before.length + 1 },
      annotations: [
        Transaction.userEvent.of("input.type"),
        Transaction.time.of(150),
      ],
    }));
    expect(view.state.doc.toString()).toBe(`${before.slice(0, -1)}XY`);

    textbox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "z",
    }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${before.slice(0, -1)}X`));

    textbox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "z",
    }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(before));
  });
});

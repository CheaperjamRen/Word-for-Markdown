import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocumentController } from "../use-document-controller";
import { FormatToolbar } from "./FormatToolbar";
import {
  TOOLBAR_ACTION_IDS,
  TOOLBAR_ITEMS,
  type ToolbarActionId,
  type ToolbarStateById,
  type ToolbarToggleState,
} from "./toolbar-commands";

function controller(): DocumentController {
  return {
    tabs: [], activeTabId: null, closePrompt: null, closing: false, persistentMessage: null,
    newDocument: async () => undefined,
    openPaths: async () => undefined,
    save: async () => undefined,
    saveAs: async () => undefined,
    requestClose: () => undefined,
    requestCloseAll: () => undefined,
    resolveClose: async () => undefined,
    activate: () => undefined,
    setMode: () => "stale",
    getSourceView: () => null,
    commitRichEdit: () => ({ kind: "stale" }),
    beginProtectedRawEdit: () => false,
    updateProtectedRawBuffer: () => false,
    cancelProtectedRawEdit: () => false,
    commitProtectedRawEdit: () => ({ kind: "stale" }),
    applySourceChangeBatch: () => ({ kind: "stale" }),
    updateSourceSelection: () => undefined,
    updateSourceViewport: () => undefined,
    undo: () => false,
    redo: () => false,
  };
}

function makeStates(
  overrides: Partial<Record<ToolbarActionId, ToolbarToggleState | null>> = {},
): { states: ToolbarStateById; executes: ReadonlyMap<ToolbarActionId, ReturnType<typeof vi.fn>> } {
  const executes = new Map<ToolbarActionId, ReturnType<typeof vi.fn>>();
  const states = Object.fromEntries(TOOLBAR_ACTION_IDS.map((id) => {
    const item = TOOLBAR_ITEMS.find((candidate) => candidate.id === id);
    const toggleState = item?.kind === "command" && item.behavior === "toggle" ? "off" : null;
    const execute = vi.fn();
    executes.set(id, execute);
    return [id, {
      enabled: true,
      toggleState: overrides[id] === undefined ? toggleState : overrides[id],
      busy: false,
      title: id,
      execute,
    }];
  })) as unknown as ToolbarStateById;
  return { states, executes };
}

function installToolbarMedia(initialCompact: boolean) {
  let compact = initialCompact;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return compact; },
    media: "(max-width: 1023px)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  })));
  return {
    setCompact(next: boolean) {
      compact = next;
      act(() => listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent)));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FormatToolbar tri-state projection", () => {
  it("opens one paragraph-style menu from the live state and executes the selected choice", async () => {
    const user = userEvent.setup();
    const { states } = makeStates();
    const chooseParagraph = vi.fn();
    const richStates: ToolbarStateById = {
      ...states,
      "block-style": {
        ...states["block-style"],
        enabled: true,
        text: "标题 1",
        choices: [
          { value: "paragraph", label: "正文", selected: false, execute: chooseParagraph },
          { value: "h1", label: "标题 1", selected: true, execute: vi.fn() },
        ],
      },
    };
    render(<FormatToolbar controller={controller()} stateById={richStates} />);
    const trigger = screen.getByRole("button", { name: "段落样式" });
    expect(trigger).toHaveTextContent("标题 1");

    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "段落样式" });
    expect(within(menu).getByRole("menuitemradio", { name: "标题 1" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(within(menu).getByRole("menuitemradio", { name: "正文" }));
    expect(chooseParagraph).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "段落样式" })).toBeNull();
  });

  it("opens the single link panel and applies the entered URL through shared state", async () => {
    const user = userEvent.setup();
    const { states } = makeStates();
    const apply = vi.fn();
    const remove = vi.fn();
    const richStates = {
      ...states,
      link: {
        ...states.link,
        enabled: true,
        linkEditor: { url: null, apply, remove },
      },
    } as ToolbarStateById;
    render(<FormatToolbar controller={controller()} stateById={richStates} />);
    const trigger = screen.getByRole("button", { name: "插入链接" });

    await user.click(trigger);
    const panel = screen.getByRole("dialog", { name: "链接" });
    const input = within(panel).getByRole("textbox", { name: "链接地址" });
    expect(input).toHaveFocus();
    await user.type(input, "https://example.com");
    await user.click(within(panel).getByRole("button", { name: "应用" }));

    expect(apply).toHaveBeenCalledWith("https://example.com");
    expect(screen.queryByRole("dialog", { name: "链接" })).toBeNull();
  });

  it("projects off, on, and mixed on primary buttons while momentary actions expose no toggle state", () => {
    installToolbarMedia(false);
    const { states } = makeStates({ bold: "on", italic: "off", strike: "mixed" });
    render(<FormatToolbar controller={controller()} stateById={states} />);
    const toolbar = screen.getByRole("toolbar", { name: "文档工具" });

    expect(within(toolbar).getByRole("button", { name: "加粗" })).toHaveAttribute("aria-pressed", "true");
    expect(within(toolbar).getByRole("button", { name: "斜体" })).toHaveAttribute("aria-pressed", "false");
    expect(within(toolbar).getByRole("button", { name: "删除线" })).toHaveAttribute("aria-pressed", "mixed");
    expect(within(toolbar).getByRole("button", { name: "插入链接" })).not.toHaveAttribute("aria-pressed");
    expect(within(toolbar).getByRole("button", { name: "插入链接" })).not.toHaveAttribute("aria-checked");
  });

  it("keeps the same mixed state and execute path when strike moves into compact overflow", async () => {
    const media = installToolbarMedia(false);
    const user = userEvent.setup();
    const { states, executes } = makeStates({ strike: "mixed" });
    render(<FormatToolbar controller={controller()} stateById={states} />);
    expect(screen.getByRole("button", { name: "删除线" })).toHaveAttribute("aria-pressed", "mixed");

    media.setCompact(true);
    await user.click(screen.getByRole("button", { name: "更多" }));
    const menu = screen.getByRole("menu", { name: "更多" });
    const strike = within(menu).getByRole("menuitemcheckbox", { name: "删除线" });
    expect(strike).toHaveAttribute("aria-checked", "mixed");
    expect(strike).not.toHaveAttribute("aria-pressed");
    await waitFor(() => expect(strike).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "行内代码" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "代码块" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: "分隔线" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "代码块" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "更多" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(within(screen.getByRole("menu", { name: "更多" })).getByRole(
      "menuitemcheckbox", { name: "删除线" },
    ));
    expect(executes.get("strike")).toHaveBeenCalledOnce();

    media.setCompact(false);
    expect(screen.getByRole("button", { name: "删除线" })).toHaveAttribute("aria-pressed", "mixed");
  });

  it("uses checkbox state for disabled compact toggles and no toggle ARIA for momentary items", async () => {
    installToolbarMedia(true);
    const user = userEvent.setup();
    render(<FormatToolbar controller={controller()} />);
    await user.click(screen.getByRole("button", { name: "更多" }));
    const menu = screen.getByRole("menu", { name: "更多" });

    expect(within(menu).getByRole("menuitemcheckbox", { name: "删除线" }))
      .toHaveAttribute("aria-checked", "false");
    const horizontalRule = within(menu).getByRole("menuitem", { name: "分隔线" });
    expect(horizontalRule).not.toHaveAttribute("aria-checked");
    expect(horizontalRule).not.toHaveAttribute("aria-pressed");
  });
});

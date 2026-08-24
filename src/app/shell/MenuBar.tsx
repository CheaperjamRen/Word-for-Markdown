import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { ActiveSourceEditorRegistry, SourceEditorBridge } from "../active-source-editor";
import type { DocumentController } from "../use-document-controller";
import type { DocumentZoomMode } from "../../document/zoom";
import type { ToolbarStateById } from "./toolbar-commands";
import { createToolbarStateById } from "./toolbar-state";
import { useLocale } from "../../i18n/locale";

interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  enabled: boolean;
  action?: () => void;
}

type MenuId = "file" | "edit" | "insert" | "format" | "view" | "help";

interface MenuDefinition {
  id: MenuId;
  label: string;
  items: MenuItem[];
}

interface SavedReadingSelection {
  tabId: string;
  range: Range;
}

export function MenuBar({
  controller,
  focusReading = false,
  toolbarVisible,
  onToggleToolbar,
  onAbout,
  onSettings,
  onOpenReadingAppearance,
  onToggleFocusReading,
  onOpenFind,
  onOpenLink,
  recoveryDraftCount = 0,
  onOpenRecovery,
  registry,
  stateById: providedStateById,
  zoomMode = "canvas",
  onZoomModeChange,
  onFitWidth,
}: {
  controller: DocumentController;
  focusReading?: boolean;
  toolbarVisible: boolean;
  onToggleToolbar(): void;
  onAbout(invoker: HTMLElement): void;
  onSettings?(invoker: HTMLElement): void;
  onOpenReadingAppearance?(invoker: HTMLElement): void;
  onToggleFocusReading?(): void;
  onOpenFind?(invoker: HTMLElement): void;
  onOpenLink?(invoker: HTMLElement): void;
  recoveryDraftCount?: number;
  onOpenRecovery?(invoker: HTMLElement): void;
  registry?: ActiveSourceEditorRegistry;
  stateById?: ToolbarStateById;
  zoomMode?: DocumentZoomMode;
  onZoomModeChange?(mode: DocumentZoomMode): void;
  onFitWidth?(): void;
}) {
  const { t } = useLocale();
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [copyAvailable, setCopyAvailable] = useState(false);
  const [sourceCopyAvailable, setSourceCopyAvailable] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef(new Map<MenuId, HTMLButtonElement>());
  const readingSelectionRef = useRef<SavedReadingSelection | null>(null);
  const sourceMenuBridgeRef = useRef<SourceEditorBridge | null>(null);
  const preserveReadingSelection = useRef(false);
  const active = controller.tabs.find((tab) => tab.id === controller.activeTabId);
  const stateById = providedStateById ?? createToolbarStateById(controller);
  const activeDocument = active?.kind === "document" ? active : null;
  const canSave = stateById.save.enabled;
  const canSaveAs = Boolean(activeDocument && activeDocument.status !== "saving" && activeDocument.sourceBuffer === null);
  const hasActive = Boolean(active);
  const readingTabId = activeDocument?.mode === "reading" ? activeDocument.id : null;
  const sourceDocument = activeDocument?.mode === "source" ? activeDocument : null;
  const getReadingSurface = () => {
    if (!readingTabId) return null;
    const controlled = document.getElementById(`document-${readingTabId}`);
    if (controlled?.matches("article")) return controlled;
    return controlled?.querySelector<HTMLElement>("article.document-paper") ?? null;
  };
  const getValidReadingSelection = () => {
    const saved = readingSelectionRef.current;
    const readingSurface = getReadingSurface();
    if (
      !saved ||
      !readingTabId ||
      saved.tabId !== readingTabId ||
      !readingSurface ||
      !saved.range.startContainer.isConnected ||
      !saved.range.endContainer.isConnected ||
      !readingSurface.contains(saved.range.startContainer) ||
      !readingSurface.contains(saved.range.endContainer)
    ) return null;
    return saved.range;
  };
  const canCopy = sourceMenuBridgeRef.current
    ? sourceCopyAvailable
    : Boolean(copyAvailable && getValidReadingSelection());

  const captureReadingSelection = () => {
    const currentSelection = document.getSelection();
    const readingSurface = getReadingSurface();
    const valid = Boolean(
      readingSurface &&
      currentSelection &&
      !currentSelection.isCollapsed &&
      currentSelection.rangeCount > 0 &&
      readingSurface.contains(currentSelection.anchorNode) &&
      readingSurface.contains(currentSelection.focusNode),
    );
    if (valid && currentSelection && readingTabId) {
      readingSelectionRef.current = { tabId: readingTabId, range: currentSelection.getRangeAt(0).cloneRange() };
      setCopyAvailable(true);
    } else if (!preserveReadingSelection.current) {
      readingSelectionRef.current = null;
      setCopyAvailable(false);
    }
  };

  useEffect(() => {
    readingSelectionRef.current = null;
    setCopyAvailable(false);
    const changed = () => captureReadingSelection();
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, [readingTabId]);

  const copySelection = () => {
    const sourceBridge = sourceMenuBridgeRef.current;
    if (sourceBridge) {
      void sourceBridge.copy();
      return;
    }
    const savedRange = getValidReadingSelection();
    const currentSelection = document.getSelection();
    if (!copyAvailable || !savedRange || !currentSelection) {
      readingSelectionRef.current = null;
      setCopyAvailable(false);
      return;
    }
    currentSelection.removeAllRanges();
    currentSelection.addRange(savedRange);
    document.execCommand?.("copy");
  };

  const selectReadingSurface = () => {
    const sourceBridge = sourceMenuBridgeRef.current;
    if (sourceBridge) {
      sourceBridge.selectAll();
      return;
    }
    const readingSurface = getReadingSurface();
    if (!readingSurface) return;
    const range = document.createRange();
    range.selectNodeContents(readingSurface);
    const applySelection = () => {
      const nextSelection = document.getSelection();
      nextSelection?.removeAllRanges();
      nextSelection?.addRange(range);
    };
    applySelection();
    queueMicrotask(applySelection);
  };

  const prepareMenu = (id: MenuId) => {
    if (id !== "edit") {
      sourceMenuBridgeRef.current = null;
      setSourceCopyAvailable(false);
      return;
    }
    const bridge = sourceDocument && registry
      ? registry.get(sourceDocument.id, sourceDocument.revision)
      : null;
    sourceMenuBridgeRef.current = bridge;
    setSourceCopyAvailable(Boolean(
      bridge?.hasSelection() && typeof navigator.clipboard?.writeText === "function",
    ));
    if (!bridge) captureReadingSelection();
  };

  const openPreparedMenu = (id: MenuId) => {
    prepareMenu(id);
    setOpenMenu(id);
  };

  const definitions: MenuDefinition[] = [
    { id: "file", label: t("menu.file"), items: [
      { id: "new", label: t("menu.new"), shortcut: "Ctrl+N", enabled: !controller.closing, action: () => void controller.newDocument() },
      { id: "open", label: t("menu.open"), shortcut: "Ctrl+O", enabled: !controller.closing, action: () => void controller.openPaths() },
      { id: "save", label: t("common.save"), shortcut: "Ctrl+S", enabled: canSave, action: () => stateById.save.execute() },
      { id: "save-as", label: t("menu.saveAs"), shortcut: "Ctrl+Shift+S", enabled: canSaveAs, action: () => void controller.saveAs() },
      ...(recoveryDraftCount > 0 ? [{
        id: "recover-unsaved",
        label: t("menu.recoverUnsaved", { count: recoveryDraftCount }),
        enabled: true,
      }] : []),
      { id: "close", label: t("menu.close"), shortcut: "Ctrl+W", enabled: hasActive, action: () => active && controller.requestClose(active.id) },
      { id: "settings", label: t("menu.settings"), enabled: true },
      { id: "exit", label: t("menu.exit"), enabled: true, action: () => controller.requestCloseAll() },
    ] },
    { id: "edit", label: t("menu.edit"), items: [
      { id: "undo", label: t("menu.undo"), shortcut: "Ctrl+Z", enabled: stateById.undo.enabled, action: () => stateById.undo.execute() },
      { id: "redo", label: t("menu.redo"), shortcut: "Ctrl+Y", enabled: stateById.redo.enabled, action: () => stateById.redo.execute() },
      { id: "find", label: t("menu.find"), shortcut: "Ctrl+F", enabled: Boolean(sourceMenuBridgeRef.current || activeDocument), action: () => {
        const invoker = triggerRefs.current.get("edit");
        if (invoker) onOpenFind?.(invoker);
      } },
      { id: "cut", label: t("menu.cut"), shortcut: "Ctrl+X", enabled: false },
      { id: "copy", label: t("menu.copy"), shortcut: "Ctrl+C", enabled: canCopy, action: copySelection },
      { id: "paste", label: t("menu.paste"), shortcut: "Ctrl+V", enabled: false },
      { id: "select-all", label: t("menu.selectAll"), shortcut: "Ctrl+A", enabled: Boolean(sourceMenuBridgeRef.current || readingTabId), action: selectReadingSurface },
    ] },
    { id: "insert", label: t("menu.insert"), items: [
      { id: "link", label: t("menu.link"), enabled: stateById.link.enabled },
      { id: "image", label: t("menu.image"), enabled: stateById.image.enabled },
      { id: "table", label: t("menu.table"), enabled: stateById.table.enabled, action: stateById.table.execute },
      { id: "formula", label: t("menu.formula"), enabled: stateById.formula.enabled, action: stateById.formula.execute },
      { id: "mermaid", label: t("toolbar.mermaid"), enabled: stateById.mermaid.enabled, action: stateById.mermaid.execute },
    ] },
    { id: "format", label: t("menu.format"), items: [
      { id: "bold", label: t("menu.bold"), enabled: stateById.bold.enabled, action: stateById.bold.execute },
      { id: "italic", label: t("menu.italic"), enabled: stateById.italic.enabled, action: stateById.italic.execute },
      { id: "strike", label: t("menu.strike"), enabled: stateById.strike.enabled, action: stateById.strike.execute },
      { id: "inline-code", label: t("menu.inlineCode"), enabled: stateById["inline-code"].enabled, action: stateById["inline-code"].execute },
    ] },
    { id: "view", label: t("menu.view"), items: [
      ...(activeDocument?.mode === "reading" ? [] : [
        { id: "toolbar", label: toolbarVisible ? t("menu.hideToolbar") : t("menu.showToolbar"), enabled: true, action: onToggleToolbar },
      ]),
      { id: "reading-appearance", label: t("menu.readingAppearance"), enabled: true },
      {
        id: "focus-reading",
        label: t(focusReading ? "focus.exit" : "focus.enter"),
        shortcut: "Ctrl+Shift+F",
        enabled: Boolean(focusReading || activeDocument?.mode === "reading"),
        action: onToggleFocusReading,
      },
      {
        id: "zoom-mode",
        label: t(zoomMode === "canvas" ? "menu.zoomModeCanvas" : "menu.zoomModeText"),
        enabled: Boolean(activeDocument && activeDocument.mode !== "source" && onZoomModeChange),
        action: () => onZoomModeChange?.(zoomMode === "canvas" ? "text" : "canvas"),
      },
      {
        id: "fit-width",
        label: t("menu.fitWidth"),
        enabled: Boolean(activeDocument && activeDocument.mode !== "source" && onFitWidth),
        action: onFitWidth,
      },
    ] },
    { id: "help", label: t("menu.help"), items: [
      { id: "about", label: t("menu.about"), enabled: true },
    ] },
  ];

  const close = (restore = true) => {
    const previous = openMenu;
    setOpenMenu(null);
    preserveReadingSelection.current = false;
    if (restore && previous) queueMicrotask(() => triggerRefs.current.get(previous)?.focus());
  };

  useEffect(() => {
    if (!openMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [openMenu]);

  useEffect(() => {
    if (!openMenu) return;
    const group = triggerRefs.current.get(openMenu)?.parentElement;
    const first = group?.querySelector<HTMLButtonElement>(".menu-popover .menu-item:not(:disabled)");
    (first ?? triggerRefs.current.get(openMenu))?.focus();
  }, [openMenu]);

  useEffect(() => {
    const focusMenus = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Alt") triggerRefs.current.get("file")?.focus();
    };
    document.addEventListener("keydown", focusMenus);
    return () => document.removeEventListener("keydown", focusMenus);
  }, []);

  const triggerKey = (event: KeyboardEvent<HTMLButtonElement>, index: number, id: MenuId) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = definitions[(index + delta + definitions.length) % definitions.length]!.id;
      if (openMenu) openPreparedMenu(next);
      else triggerRefs.current.get(next)?.focus();
    } else if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPreparedMenu(id);
    } else if (event.key === "Escape") {
      close();
    }
  };

  const menuKey = (event: KeyboardEvent<HTMLDivElement>, menuIndex: number) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      items[(current + delta + items.length) % items.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = definitions[(menuIndex + delta + definitions.length) % definitions.length]!.id;
      openPreparedMenu(next);
    }
  };

  return (
    <div aria-label={t("menu.application")} className="menu-bar" data-shell-contract="menubar" ref={rootRef} role="menubar">
      {definitions.map(({ id, label, items }, index) => (
        <div className="menu-bar__group" key={id}>
          <button
            aria-expanded={openMenu === id}
            aria-haspopup="menu"
            className="menu-bar__trigger"
            data-ui-contract={index === 0 ? "ui-label" : undefined}
            onClick={() => setOpenMenu((current) => {
              if (current !== id) {
                prepareMenu(id);
                return id;
              }
              preserveReadingSelection.current = false;
              return null;
            })}
            onKeyDown={(event) => triggerKey(event, index, id)}
            onPointerDown={() => {
              preserveReadingSelection.current = true;
              prepareMenu(id);
            }}
            ref={(node) => { if (node) triggerRefs.current.set(id, node); }}
            role="menuitem"
            type="button"
          >{label}</button>
          {openMenu === id ? (
            <div aria-label={t("menu.named", { name: label })} className="menu-popover" onKeyDown={(event) => menuKey(event, index)} role="menu">
              {items.map((item) => (
                <button
                  className={`menu-item${item.enabled ? "" : " menu-item--disabled"}`}
                  disabled={!item.enabled}
                  key={item.id}
                  onClick={() => {
                    const trigger = triggerRefs.current.get(id);
                    const sourceBridge = id === "edit" ? sourceMenuBridgeRef.current : null;
                    if (sourceBridge && item.id === "find") {
                      close(false);
                      if (sourceBridge.openFind() === "stale") {
                        queueMicrotask(() => trigger?.focus());
                      }
                      return;
                    }
                    if (id === "edit" && item.id === "find" && onOpenFind && trigger) {
                      close(false);
                      onOpenFind(trigger);
                      return;
                    }
                    if (sourceBridge && item.id === "copy") {
                      close(false);
                      void sourceBridge.copy().then((result) => {
                        if (result === "stale") queueMicrotask(() => trigger?.focus());
                      });
                      return;
                    }
                    if (sourceBridge && item.id === "select-all") {
                      close(false);
                      if (sourceBridge.selectAll() === "stale") {
                        queueMicrotask(() => trigger?.focus());
                      }
                      return;
                    }
                    if (id === "insert" && item.id === "link" && onOpenLink && trigger) {
                      close(false);
                      onOpenLink(trigger);
                      return;
                    }
                    if (id === "file" && item.id === "recover-unsaved" && trigger) {
                      close(false);
                      onOpenRecovery?.(trigger);
                    } else if (id === "file" && item.id === "settings" && trigger) {
                      close(false);
                      onSettings?.(trigger);
                    } else if (id === "view" && item.id === "reading-appearance" && trigger) {
                      close(false);
                      onOpenReadingAppearance?.(trigger);
                    } else if (id === "help" && item.id === "about" && trigger) {
                      close(false);
                      onAbout(trigger);
                    } else {
                      close(true);
                      item.action?.();
                    }
                  }}
                  role="menuitem"
                  type="button"
                >
                  <span>{item.label}</span>{item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

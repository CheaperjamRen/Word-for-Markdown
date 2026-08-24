import { useEffect, useState, type KeyboardEvent } from "react";

import type { WorkspaceTab } from "../../documents/session";
import { documentHasUnsavedWork } from "../../documents/session-reducer";
import type { ActiveSourceEditorRegistry } from "../active-source-editor";
import { fileNameForDisplay, formatPathForDisplay } from "../path-display";
import type { DocumentController } from "../use-document-controller";
import { ShellIcon } from "./icons";
import { useLocale } from "../../i18n/locale";

function tabName(tab: WorkspaceTab): string {
  if (tab.kind === "preview") return tab.displayName;
  return tab.file.kind === "local"
    ? fileNameForDisplay(tab.file.canonicalPath)
    : tab.file.displayName;
}

export function DocumentTabs({
  controller,
  focusReading = false,
  onExitFocusReading,
  registry,
  onOpenStartPage,
}: {
  controller: DocumentController;
  focusReading?: boolean;
  onExitFocusReading?(): void;
  registry: ActiveSourceEditorRegistry;
  onOpenStartPage?: () => void;
}) {
  const { locale, t } = useLocale();
  const active = controller.tabs.find((tab) => tab.id === controller.activeTabId);
  const activeDocument = active?.kind === "document" ? active : null;
  const [modeFocus, setModeFocus] = useState<"reading" | "rich" | "source">("reading");

  useEffect(() => {
    if (activeDocument?.mode) setModeFocus(activeDocument.mode);
  }, [activeDocument?.id, activeDocument?.mode]);

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, tabId: string) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = controller.tabs.findIndex((tab) => tab.id === tabId);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = controller.tabs[(index + delta + controller.tabs.length) % controller.tabs.length];
    if (!next) return;
    controller.activate(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const activateMode = (mode: "reading" | "rich" | "source") => {
    if (!activeDocument) return;
    const result = controller.setMode(activeDocument.id, activeDocument.revision, mode);
    if (result === "blocked-buffer") {
      registry.get(activeDocument.id, activeDocument.revision)?.focus();
    }
  };

  const modeKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const modes = ["reading", "rich", "source"] as const;
    const current = modes.indexOf(event.currentTarget.dataset.mode as typeof modes[number]);
    const mode = event.key === "Home"
      ? modes[0]
      : event.key === "End"
        ? modes.at(-1)!
        : modes[(current + (event.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length];
    setModeFocus(mode);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`button[data-mode="${mode}"]`)
      ?.focus();
  };

  return (
    <div className="document-tabs" data-shell-contract="tabbar">
      <div aria-label={t("tabs.openDocuments")} className="document-tabs__scroll" role="tablist">
        {controller.tabs.map((tab) => {
          const isActive = tab.id === controller.activeTabId;
          const rawName = tabName(tab);
          const untitled = /^未命名 (\d+)$/.exec(rawName);
          const name = locale === "en-US" && untitled
            ? t("document.untitled", { number: untitled[1]! })
            : locale === "en-US" && rawName === "恢复的文档"
              ? t("document.recovered")
              : rawName;
          const dirty = tab.kind === "document" && documentHasUnsavedWork(tab);
          const title = tab.kind === "document" && tab.file.kind === "local"
            ? formatPathForDisplay(tab.file.canonicalPath)
            : name;
          return (
            <div
              className={`document-tab${isActive ? " document-tab--active" : ""}`}
              key={tab.id}
              title={title}
            >
              <button
                {...(isActive && tab.kind === "document" ? { "aria-controls": `document-${tab.id}` } : {})}
                aria-label={`${name}${dirty ? t("tabs.unsavedSuffix") : ""}`}
                aria-selected={isActive}
                className="document-tab__trigger"
                id={`tab-${tab.id}`}
                onClick={() => controller.activate(tab.id)}
                onKeyDown={(event) => moveFocus(event, tab.id)}
                role="tab"
                tabIndex={isActive ? 0 : -1}
                type="button"
              >
                <ShellIcon className="document-tab__icon" name="document" />
                <span className="document-tab__label">{name}</span>
                {dirty ? <span aria-hidden="true" className={`document-tab__dirty document-tab__dirty--${tab.kind === "document" ? tab.status : "dirty"}`} /> : null}
              </button>
              <button
                aria-label={t("tabs.close", { name })}
                className="document-tab__close"
                onClick={() => controller.requestClose(tab.id)}
                type="button"
              >
                <ShellIcon name="close" />
              </button>
            </div>
          );
        })}
      </div>
      <button aria-label={t("tabs.new")} className="document-tabs__new" disabled={controller.closing} onClick={() => onOpenStartPage ? onOpenStartPage() : void controller.newDocument()} title={t("tabs.newTitle")} type="button">
        <ShellIcon name="add" />
      </button>
      <span aria-hidden="true" className="document-tabs__spacer" />
      {focusReading && activeDocument?.mode === "reading" ? (
        <div className="document-tabs__focus-control">
          <button
            aria-label={t("focus.exit")}
            onClick={onExitFocusReading}
            title={`${t("focus.exit")} (Esc)`}
            type="button"
          >
            <ShellIcon className="document-tabs__mode-icon" name="close" />
            <span>{t("focus.exit")}</span>
          </button>
        </div>
      ) : <div aria-label={t("tabs.modes")} className="document-tabs__mode-control" role="group">
        {(["reading", "rich", "source"] as const).map((mode) => {
          const label = t(mode === "reading" ? "mode.reading" : mode === "rich" ? "mode.rich" : "mode.source");
          const title = t(mode === "reading" ? "mode.readingTitle" : mode === "rich" ? "mode.richTitle" : "mode.sourceTitle");
          const icon = mode === "reading" ? "reading" : mode === "rich" ? "rich" : "source";
          const enabled = Boolean(activeDocument);
          return <button
            aria-pressed={activeDocument?.mode === mode}
            aria-label={label}
            data-mode={mode}
            disabled={!enabled}
            key={mode}
            onClick={() => activateMode(mode)}
            onFocus={() => setModeFocus(mode)}
            onKeyDown={modeKey}
            title={title}
            tabIndex={enabled && modeFocus === mode ? 0 : -1}
            type="button"
          >
            <ShellIcon className="document-tabs__mode-icon" name={icon} />
            <span className="document-tabs__mode-label">{label}</span>
          </button>;
        })}
      </div>}
    </div>
  );
}

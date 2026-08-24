import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import type { HostApi } from "../../contracts/desktop";
import type { BlockViewSpan } from "../../contracts/markdown";
import type { DocumentSession } from "../../documents/session";
import { DocumentSurface } from "../../document/DocumentSurface";
import type { ActiveSourceEditorRegistry } from "../active-source-editor";
import type { ActiveEditorRegistry } from "../../editor/active-editor";
import type { RichCommand } from "../../editor/active-editor";
import {
  captureReadingSelection,
  type ReadingSelectionSnapshot,
} from "../../editor/reading-selection";
import type { DocumentController } from "../use-document-controller";
import { AboutDialog } from "./AboutDialog";
import { CloseDocumentDialog } from "./CloseDocumentDialog";
import { DocumentTabs } from "./DocumentTabs";
import { EmptyState } from "./EmptyState";
import { FormatToolbar } from "./FormatToolbar";
import { MenuBar } from "./MenuBar";
import { StatusBar } from "./StatusBar";
import { createToolbarStateById } from "./toolbar-state";
import type { ToolbarActionState } from "./toolbar-commands";
import { LinkPanel } from "../../editor/panels/LinkPanel";
import { FindBar } from "./FindBar";
import { ShellIcon } from "./icons";
import { stepDocumentZoom } from "../../document/zoom";
import { OutlinePane } from "./OutlinePane";
import { LocalResourcePreview } from "../../preview/LocalResourcePreview";
import { ConflictDialog } from "./ConflictDialog";
import { RecoveryDialog } from "./RecoveryDialog";
import { buildOutline, headingId } from "../../markdown/outline";
import type { ResolvedTarget } from "../../desktop/target-resolver";
import type { DocumentLayout } from "../../document/layout";
import type { DocumentZoomMode } from "../../document/zoom";
import {
  readDocumentPresentationPreferences,
  writeDocumentPresentationPreferences,
} from "../../document/presentation-preferences";
import { fitWidthZoom } from "../../document/zoom-geometry";
import {
  readRecentDocuments,
  recordRecentDocument,
  removeRecentDocument,
  type RecentDocument,
} from "../recent-documents";
import { fileNameForDisplay } from "../path-display";
import { useLocale } from "../../i18n/locale";
import { translateRuntimeText } from "../../i18n/messages";
import { SettingsDialog } from "./SettingsDialog";
import {
  readReadingPreferences,
  writeReadingPreferences,
  type ReadingPreferences,
  type ReadingTheme,
} from "../../reading/preferences";

type LinkEditorState = NonNullable<ToolbarActionState["linkEditor"]>;

export function AppShell({
  controller,
  host,
  registry,
  richRegistry,
  renderDocument,
}: {
  controller: DocumentController;
  host: HostApi;
  registry: ActiveSourceEditorRegistry;
  richRegistry?: ActiveEditorRegistry;
  renderDocument(tab: DocumentSession, blockViewSpans: readonly BlockViewSpan[], onOpenLink?: (href: string) => void, readingTheme?: ReadingTheme): ReactNode;
}) {
  const { locale, t } = useLocale();
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [aboutInvoker, setAboutInvoker] = useState<HTMLElement | null>(null);
  const [settingsInvoker, setSettingsInvoker] = useState<HTMLElement | null>(null);
  const [settingsPage, setSettingsPage] = useState<"general" | "reading">("general");
  const [recoveryInvoker, setRecoveryInvoker] = useState<HTMLElement | null>(null);
  const [readingPreferences, setReadingPreferences] = useState(readReadingPreferences);
  const [focusReading, setFocusReading] = useState(false);
  const [readingSelection, setReadingSelection] = useState<ReadingSelectionSnapshot | null>(null);
  const [linkPanel, setLinkPanel] = useState<{
    editor: LinkEditorState;
    invoker: HTMLElement;
  } | null>(null);
  const [findSession, setFindSession] = useState<{
    documentId: string;
    mode: "reading" | "rich";
    invoker: HTMLElement | null;
    requestId: number;
  } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [presentationPreferences, setPresentationPreferences] = useState(
    readDocumentPresentationPreferences,
  );
  const documentLayout: DocumentLayout = presentationPreferences.layout;
  const zoomMode: DocumentZoomMode = presentationPreferences.zoomMode;
  const [outlineOpen, setOutlineOpen] = useState(true);
  const outlineCollapseButtonRef = useRef<HTMLButtonElement>(null);
  const outlineRevealButtonRef = useRef<HTMLButtonElement>(null);
  const pendingOutlineFocusRef = useRef<"collapse" | "reveal" | null>(null);
  const [startPageOpen, setStartPageOpen] = useState(false);
  const [recentDocuments, setRecentDocuments] = useState(readRecentDocuments);
  const seenLocalPathsRef = useRef(new Set<string>());
  const previousActiveTabId = useRef(controller.activeTabId);
  const focusDocumentIdRef = useRef<string | null>(null);
  const focusReadingRef = useRef(false);
  focusReadingRef.current = focusReading;
  const active = controller.tabs.find((tab) => tab.id === controller.activeTabId);
  const activeDocument = active?.kind === "document" ? active : null;
  const recoveryDrafts = controller.recoveryDrafts ?? [];
  const activeExternal = activeDocument?.externalChange;
  const showOutline = Boolean(activeDocument?.mode === "reading" && buildOutline(activeDocument.candidate.text).length > 0);
  const mountFormatToolbar = toolbarVisible && !focusReading;
  const showFormatToolbar = mountFormatToolbar && (
    activeDocument?.mode !== "reading" || readingSelection !== null
  );
  useEffect(() => {
    if (!findSession) return;
    if (activeDocument?.id === findSession.documentId && activeDocument.mode === findSession.mode) return;
    setFindSession(null);
  }, [activeDocument?.id, activeDocument?.mode, findSession]);
  useEffect(() => {
    const target = pendingOutlineFocusRef.current;
    if (!target) return;
    if (outlineOpen && target === "collapse") outlineCollapseButtonRef.current?.focus();
    if (!outlineOpen && target === "reveal") outlineRevealButtonRef.current?.focus();
    pendingOutlineFocusRef.current = null;
  }, [outlineOpen]);
  useEffect(() => controller.setUiLocale?.(locale), [controller, locale]);
  useEffect(() => {
    if (!recoveryInvoker || recoveryDrafts.length > 0) return;
    const invoker = recoveryInvoker;
    setRecoveryInvoker(null);
    queueMicrotask(() => invoker.focus());
  }, [recoveryDrafts.length, recoveryInvoker]);
  useEffect(() => {
    if (previousActiveTabId.current !== controller.activeTabId) setStartPageOpen(false);
    previousActiveTabId.current = controller.activeTabId;
  }, [controller.activeTabId]);
  useEffect(() => {
    if (!focusReading) return;
    if (
      startPageOpen ||
      activeDocument?.mode !== "reading" ||
      activeDocument.id !== focusDocumentIdRef.current
    ) {
      focusDocumentIdRef.current = null;
      setFocusReading(false);
    }
  }, [activeDocument?.id, activeDocument?.mode, focusReading, startPageOpen]);
  useEffect(() => {
    const currentLocalPaths = new Set<string>();
    let openedAt = Date.now();
    for (const tab of controller.tabs) {
      if (tab.kind !== "document" || tab.file.kind !== "local") continue;
      const pathKey = tab.file.canonicalPath.toLowerCase();
      currentLocalPaths.add(pathKey);
      if (seenLocalPathsRef.current.has(pathKey)) continue;
      const next = recordRecentDocument({
        canonicalPath: tab.file.canonicalPath,
        displayName: fileNameForDisplay(tab.file.canonicalPath),
        openedAt,
      });
      openedAt += 1;
      setRecentDocuments(next);
    }
    seenLocalPathsRef.current = currentLocalPaths;
  }, [controller.tabs]);
  useSyncExternalStore(
    richRegistry?.subscribe ?? (() => () => undefined),
    richRegistry?.getSnapshot ?? (() => 0),
  );
  useEffect(() => {
    if (!activeDocument || activeDocument.mode !== "reading") {
      setReadingSelection(null);
      return;
    }
    let disposed = false;
    const readSelection = () => {
      if (disposed) return;
      const root = document.getElementById(`document-${activeDocument.id}`);
      const selection = window.getSelection();
      const next = root && selection
        ? captureReadingSelection(
            root,
            selection,
            activeDocument.id,
            activeDocument.revision,
          )
          : null;
      setReadingSelection((current) => {
        if (next) return next;
        const focused = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
        const chromeOwnsFocus = Boolean(
          focused?.closest(".menu-bar, .format-toolbar, .link-panel, .find-bar"),
        );
        return chromeOwnsFocus &&
          current?.sessionId === activeDocument.id &&
          current.candidateRevision === activeDocument.revision
          ? current
          : null;
      });
    };
    const update = () => {
      const root = document.getElementById(`document-${activeDocument.id}`);
      const selection = window.getSelection();
      const selectionIsInsideDocument = Boolean(
        root && selection && !selection.isCollapsed && selection.anchorNode && root.contains(selection.anchorNode),
      );
      if (selectionIsInsideDocument) readSelection();
      else queueMicrotask(readSelection);
    };
    document.addEventListener("selectionchange", update);
    update();
    return () => {
      disposed = true;
      document.removeEventListener("selectionchange", update);
    };
  }, [activeDocument?.id, activeDocument?.mode, activeDocument?.revision]);

  const runReadingCommand = (command: RichCommand) => {
    const selection = readingSelection;
    if (!selection || !richRegistry) return;
    const current = controller.tabs.find((tab) => tab.id === selection.sessionId);
    if (
      current?.kind !== "document" ||
      current.mode !== "reading" ||
      current.revision !== selection.candidateRevision ||
      controller.activeTabId !== current.id
    ) return;
    const token = Symbol("reading-to-rich");
    richRegistry.requestActivation(current.id, current.revision, selection.blockViewKey, token);
    const modeResult = controller.setMode(current.id, current.revision, "rich");
    if (modeResult !== "changed" && modeResult !== "unchanged") {
      richRegistry.clearActivation(token);
      return;
    }
    void richRegistry.waitFor(
      current.id,
      current.revision,
      selection.blockViewKey,
      token,
    ).then((bridge) => {
      const live = controller.tabs.find((tab) => tab.id === current.id);
      const activation = richRegistry.getActivation(current.id, current.revision);
      const exact = bridge &&
        live?.kind === "document" &&
        live.mode === "rich" &&
        live.revision === current.revision &&
        controller.activeTabId === live.id &&
        activation?.token === token;
      if (!exact || !bridge) {
        richRegistry.clearActivation(token);
        return;
      }
      const restored = bridge.restoreSelection({
        blockViewKey: selection.blockViewKey,
        anchorTextOffset: selection.anchorTextOffset,
        focusTextOffset: selection.focusTextOffset,
      });
      if (restored === "restored" && bridge.run(command) === "ran") bridge.focus();
      richRegistry.clearActivation(token);
    });
  };
  const stateById = createToolbarStateById(
    controller,
    richRegistry,
    readingSelection ? { selection: readingSelection, run: runReadingCommand } : undefined,
    t,
  );
  const stateByIdRef = useRef(stateById);
  stateByIdRef.current = stateById;
  const openLinkPanel = (invoker: HTMLElement) => {
    const editor = stateById.link.linkEditor;
    if (editor) setLinkPanel({ editor, invoker });
  };
  const openFind = (invoker: HTMLElement) => {
    if (!activeDocument || activeDocument.mode === "source") return;
    const documentId = activeDocument.id;
    const mode = activeDocument.mode;
    setFindSession((current) => current &&
      current.documentId === documentId &&
      current.mode === mode
      ? { ...current, requestId: current.requestId + 1 }
      : {
        documentId,
        mode,
        invoker,
        requestId: (current?.requestId ?? 0) + 1,
      });
  };

  const openLink = useCallback(async (href: string) => {
    const tab = controller.tabs.find((candidate) => candidate.id === controller.activeTabId);
    if (tab?.kind !== "document" || tab.file.kind !== "local") return;
    setLinkError(null);
    let target: ResolvedTarget;
    try {
      target = host.resolveTarget
        ? await host.resolveTarget(tab.file.canonicalPath, href)
        : (/^(?:https?:|mailto:)/i.test(href)
          ? { kind: "web", url: href }
          : href.startsWith("#")
            ? { kind: "anchor", headingId: href.slice(1) }
            : { kind: "blocked", reason: t("error.invalidLink") });
    } catch {
      setLinkError(t("error.linkUnreadable"));
      return;
    }
    switch (target.kind) {
      case "anchor": {
        let normalizedId = target.headingId;
        try { normalizedId = headingId(decodeURIComponent(target.headingId)); } catch { /* keep the raw fragment */ }
        const heading = document.getElementById(normalizedId);
        if (!heading) setLinkError(t("error.headingNotFound"));
        else heading.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      case "web":
        if (host.openExternalUrl) await host.openExternalUrl(target.url);
        else window.open(target.url, "_blank", "noopener,noreferrer");
        return;
      case "markdown":
        await controller.openPaths([target.canonicalPath]);
        return;
      case "preview":
        controller.openResourcePreview?.(target.canonicalPath, target.mediaType);
        return;
      case "directory":
      case "system":
        if (!host.openSystemTarget) { setLinkError(t("error.systemTargetUnavailable")); return; }
        try { await host.openSystemTarget(target.canonicalPath); } catch { setLinkError(t("error.systemOpenFailed")); }
        return;
      case "dangerous":
        const reason = translateRuntimeText(locale, target.reason);
        if (!host.openSystemTarget) { setLinkError(reason); return; }
        if (window.confirm(t("error.confirmDangerous", { reason }))) {
          try { await host.openSystemTarget(target.canonicalPath); } catch { setLinkError(t("error.systemOpenFailed")); }
        }
        return;
      case "blocked":
        setLinkError(translateRuntimeText(locale, target.reason));
    }
  }, [controller, host, locale, t]);
  const renderReading = useCallback(
    (blockViewSpans: readonly BlockViewSpan[], onOpenLink: ((href: string) => void) | undefined) =>
      activeDocument ? renderDocument(activeDocument, blockViewSpans, onOpenLink, readingPreferences.theme) : null,
    [activeDocument, readingPreferences.theme, renderDocument],
  );
  const closeFind = () => {
    const invoker = findSession?.invoker;
    setFindSession(null);
    queueMicrotask(() => {
      if (invoker?.isConnected) invoker.focus();
      else document.getElementById(`tab-${controller.activeTabId}`)?.focus();
    });
  };
  const openRecentDocument = (entry: RecentDocument) => {
    const existing = controller.tabs.find(
      (tab) => tab.kind === "document" &&
        tab.file.kind === "local" &&
        tab.file.canonicalPath.toLowerCase() === entry.canonicalPath.toLowerCase(),
    );
    if (existing) {
      controller.activate(existing.id);
      setStartPageOpen(false);
      return;
    }
    void controller.openPaths([entry.canonicalPath]);
  };
  const exitFocusReading = () => {
    focusDocumentIdRef.current = null;
    setFocusReading(false);
  };
  const enterFocusReading = () => {
    if (activeDocument?.mode !== "reading") return;
    focusDocumentIdRef.current = activeDocument.id;
    setFocusReading(true);
  };
  const toggleFocusReading = () => {
    if (focusReadingRef.current) exitFocusReading();
    else enterFocusReading();
  };

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      const stateById = stateByIdRef.current;
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && focusReadingRef.current) {
        event.preventDefault();
        exitFocusReading();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "f" && event.shiftKey) {
        const current = controller.tabs.find((tab) => tab.id === controller.activeTabId);
        if (focusReadingRef.current || (current?.kind === "document" && current.mode === "reading")) {
          event.preventDefault();
          if (focusReadingRef.current) exitFocusReading();
          else {
            focusDocumentIdRef.current = current?.kind === "document" ? current.id : null;
            setFocusReading(true);
          }
        }
      }
      else if (key === "0") {
        event.preventDefault();
        const current = controller.tabs.find((tab) => tab.id === controller.activeTabId);
        if (current?.kind === "document") controller.setDocumentZoom?.(current.id, current.revision, 100);
      }
      else if (key === "+" || key === "=") {
        event.preventDefault();
        const current = controller.tabs.find((tab) => tab.id === controller.activeTabId);
        if (current?.kind === "document") controller.setDocumentZoom?.(current.id, current.revision, stepDocumentZoom(current.zoomPercent, 1));
      }
      else if (key === "-") {
        event.preventDefault();
        const current = controller.tabs.find((tab) => tab.id === controller.activeTabId);
        if (current?.kind === "document") controller.setDocumentZoom?.(current.id, current.revision, stepDocumentZoom(current.zoomPercent, -1));
      }
      else if (key === "n") { event.preventDefault(); if (!controller.closing) void controller.newDocument(); }
      else if (key === "o") { event.preventDefault(); if (!controller.closing) void controller.openPaths(); }
      else if (key === "s" && event.shiftKey) { event.preventDefault(); void controller.saveAs(); }
      else if (key === "s") {
        event.preventDefault();
        if (stateById.save.enabled) stateById.save.execute();
      }
      else if (key === "f") {
        const current = controller.tabs.find((tab) => tab.id === controller.activeTabId);
        if (current?.kind === "document" && current.mode !== "source") {
          event.preventDefault();
          openFind(document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
        }
      }
      else if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        if (stateById.undo.enabled) stateById.undo.execute();
      }
      else if (key === "y" && !event.shiftKey) {
        event.preventDefault();
        if (stateById.redo.enabled) stateById.redo.execute();
      }
      else if (key === "w") {
        event.preventDefault();
        if (controller.activeTabId) controller.requestClose(controller.activeTabId);
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [activeDocument, controller]);

  const closeAbout = () => {
    const invoker = aboutInvoker;
    setAboutInvoker(null);
    queueMicrotask(() => invoker?.focus());
  };
  const closeSettings = () => {
    const invoker = settingsInvoker;
    setSettingsInvoker(null);
    queueMicrotask(() => invoker?.focus());
  };
  const openSettings = (invoker: HTMLElement) => {
    setSettingsPage("general");
    setSettingsInvoker(invoker);
  };
  const openReadingAppearance = (invoker: HTMLElement) => {
    setSettingsPage("reading");
    setSettingsInvoker(invoker);
  };
  const changeReadingPreferences = (value: ReadingPreferences) => {
    setReadingPreferences(value);
    writeReadingPreferences(value);
  };
  const changeDocumentLayout = (layout: DocumentLayout) => {
    setPresentationPreferences((current) => {
      const next = { ...current, layout };
      writeDocumentPresentationPreferences(next);
      return next;
    });
  };
  const changeZoomMode = (zoomMode: DocumentZoomMode) => {
    setPresentationPreferences((current) => {
      const next = { ...current, zoomMode };
      writeDocumentPresentationPreferences(next);
      return next;
    });
  };
  const fitActiveDocumentWidth = () => {
    if (!activeDocument || activeDocument.mode === "source" || !controller.setDocumentZoom) return;
    const surface = document.getElementById(`document-${activeDocument.id}`);
    const viewport = surface?.querySelector<HTMLElement>(".document-viewport");
    const stage = surface?.querySelector<HTMLElement>(".document-paper-stage");
    const baseWidth = Number(stage?.dataset.documentBaseWidth);
    const viewportWidth = viewport?.clientWidth || viewport?.getBoundingClientRect().width || 0;
    if (!Number.isFinite(baseWidth) || baseWidth <= 0 || viewportWidth <= 0) return;
    if (zoomMode !== "canvas") changeZoomMode("canvas");
    controller.setDocumentZoom(
      activeDocument.id,
      activeDocument.revision,
      fitWidthZoom(viewportWidth, baseWidth),
    );
  };

  return (
    <main
      className={`app-shell${showFormatToolbar ? "" : " app-shell--toolbar-hidden"}${focusReading ? " app-shell--focus-reading" : ""}`}
      data-reading-theme={readingPreferences.theme}
      data-theme={readingPreferences.theme === "night" ? "dark" : "light"}
    >
      <DocumentTabs
        controller={controller}
        focusReading={focusReading}
        onExitFocusReading={exitFocusReading}
        onOpenStartPage={() => setStartPageOpen(true)}
        registry={registry}
      />
      {!focusReading ? <MenuBar
        controller={controller}
        focusReading={focusReading}
        onAbout={setAboutInvoker}
        onSettings={openSettings}
        onOpenReadingAppearance={openReadingAppearance}
        onToggleFocusReading={toggleFocusReading}
        onToggleToolbar={() => setToolbarVisible((visible) => !visible)}
        registry={registry}
        stateById={stateById}
        zoomMode={zoomMode}
        onZoomModeChange={changeZoomMode}
        onFitWidth={fitActiveDocumentWidth}
        toolbarVisible={toolbarVisible}
        onOpenFind={openFind}
        onOpenLink={openLinkPanel}
        onOpenRecovery={setRecoveryInvoker}
        recoveryDraftCount={recoveryDrafts.length}
      /> : null}
      {mountFormatToolbar ? <FormatToolbar
        controller={controller}
        hidden={!showFormatToolbar}
        onOpenLink={openLinkPanel}
        stateById={stateById}
      /> : null}
      <div className="workspace-area">
        <section className="workspace">
          {linkError ? <div className="workspace__link-error" role="alert">{linkError}</div> : null}
          {findSession && activeDocument ? (
            <div className="workspace__find-overlay">
              <FindBar
                onClose={closeFind}
                requestId={findSession.requestId}
                rootId={`document-${findSession.documentId}`}
              />
            </div>
          ) : null}
          {startPageOpen ? (
            <div className="document-viewport document-viewport--start">
              <EmptyState
                controller={controller}
                onDismiss={() => setStartPageOpen(false)}
                onOpen={() => { setStartPageOpen(false); void controller.openPaths(); }}
                onNew={() => { setStartPageOpen(false); void controller.newDocument(); }}
                onOpenRecent={openRecentDocument}
                onRemoveRecent={(entry) => setRecentDocuments(removeRecentDocument(entry.canonicalPath))}
                recentDocuments={recentDocuments}
                title={t("start.title")}
              />
            </div>
          ) : active?.kind === "document" ? (
            <div className={showOutline
              ? `workspace__document-layout${outlineOpen ? " workspace__document-layout--with-outline" : ""}`
              : "workspace__document-layout"}>
              {showOutline ? <OutlinePane
                collapseButtonRef={outlineCollapseButtonRef}
                documentId={active.id}
                hidden={!outlineOpen}
                markdown={active.candidate.text}
                onCollapse={() => {
                  pendingOutlineFocusRef.current = "reveal";
                  setOutlineOpen(false);
                }}
              /> : null}
              {showOutline && !outlineOpen ? (
                <button
                  aria-expanded="false"
                  aria-label={t("outline.expand")}
                  className="outline-reveal"
                  onClick={() => {
                    pendingOutlineFocusRef.current = "collapse";
                    setOutlineOpen(true);
                  }}
                  ref={outlineRevealButtonRef}
                  title={t("outline.expand")}
                  type="button"
                >
                  <ShellIcon name="outline" />
                </button>
              ) : null}
              <DocumentSurface
                controller={controller}
                richRegistry={richRegistry}
                registry={registry}
                layout={documentLayout}
                zoomMode={zoomMode}
                onOpenLink={openLink}
                readingPreferences={readingPreferences}
                renderReading={renderReading}
                tab={active}
              />
            </div>
          ) : active?.kind === "preview" ? (
            <LocalResourcePreview
              canonicalPath={active.canonicalPath}
              displayName={active.displayName}
              mediaType={active.mediaType}
              onClose={() => controller.requestClose(active.id)}
            />
          ) : <div className="document-viewport"><EmptyState
            controller={controller}
            onOpenRecent={openRecentDocument}
            onRemoveRecent={(entry) => setRecentDocuments(removeRecentDocument(entry.canonicalPath))}
            recentDocuments={recentDocuments}
          /></div>}
        </section>
      </div>
      {!focusReading ? <StatusBar
        controller={controller}
        layout={documentLayout}
        onLayoutChange={changeDocumentLayout}
        layoutLabels={{
          a4: t("layout.a4"),
          a3: t("layout.a3"),
          canvas: t("layout.canvas"),
        }}
      /> : null}
      {linkPanel ? <LinkPanel
        initialUrl={linkPanel.editor.url}
        onApply={(url) => {
          linkPanel.editor.apply(url);
          setLinkPanel(null);
        }}
        onCancel={() => {
          const invoker = linkPanel.invoker;
          setLinkPanel(null);
          queueMicrotask(() => invoker.focus());
        }}
        onRemove={() => {
          linkPanel.editor.remove();
          setLinkPanel(null);
        }}
      /> : null}
      {controller.closePrompt ? <CloseDocumentDialog controller={controller} /> : null}
      {recoveryInvoker && recoveryDrafts.length > 0 ? <RecoveryDialog
        drafts={recoveryDrafts}
        onClose={() => {
          const invoker = recoveryInvoker;
          setRecoveryInvoker(null);
          queueMicrotask(() => invoker.focus());
        }}
        onDiscard={(id) => void controller.discardDraft?.(id)}
        onRestore={(id) => void controller.restoreDraft?.(id)}
      /> : null}
      {activeDocument && activeExternal && activeExternal.kind !== "checking" ? (
        <ConflictDialog
          kind={activeExternal.kind}
          suggestedPath={activeExternal.kind === "renamed" ? activeExternal.suggestedPath : null}
          onKeepLocal={() => controller.resolveExternalChange?.(activeDocument.id, "keep-local")}
          onUseDisk={() => controller.resolveExternalChange?.(activeDocument.id, "use-disk")}
          onSaveAs={() => void controller.saveAs(activeDocument.id)}
          onOpenSuggested={activeExternal.kind === "renamed" && activeExternal.suggestedPath
            ? () => void controller.openPaths([activeExternal.suggestedPath!])
            : undefined}
        />
      ) : null}
      {aboutInvoker ? <AboutDialog getVersion={() => host.getAppVersion()} onClose={closeAbout} /> : null}
      {settingsInvoker ? <SettingsDialog
        initialPage={settingsPage}
        onClose={closeSettings}
        onReadingPreferencesChange={changeReadingPreferences}
        readingPreferences={readingPreferences}
      /> : null}
    </main>
  );
}

import { lazy, Suspense, useEffect, useRef, useState } from "react";

import type { HostApi } from "../contracts/desktop";
import type { BlockViewSpan } from "../contracts/markdown";
import type { DocumentSession } from "../documents/session";
import { createTauriHost } from "../desktop/host";
import { loadSourceDocumentCore } from "../markdown/load-source-document";
import { FirstReadablePreview } from "../markdown/render/FirstReadablePreview";
import {
  createActiveSourceEditorRegistry,
  type ActiveSourceEditorRegistry,
} from "./active-source-editor";
import {
  createActiveEditorRegistry,
  type ActiveEditorRegistry,
} from "../editor/active-editor";
import { AppShell } from "./shell/AppShell";
import { collectComputedReadingUiContract } from "./ui-contract";
import { useDocumentController } from "./use-document-controller";
import { LocaleProvider } from "../i18n/locale";
import type { UiLocale } from "../i18n/messages";
import type { ReadingTheme } from "../reading/preferences";
import "./ui-tokens.css";
import "./app.css";

const MarkdownView = lazy(() => import("../markdown/render/MarkdownView"));
const defaultHost = createTauriHost();

export interface AppProps {
  host?: HostApi;
  loadSourceDocumentCore?: typeof loadSourceDocumentCore;
}

interface FirstReadableReceipt {
  firstFrame: number;
  phase: "scheduled" | "in-flight" | "settled";
  secondFrame: number;
}

export default function App({
  host = defaultHost,
  loadSourceDocumentCore: loadCore = loadSourceDocumentCore,
}: AppProps) {
  const controller = useDocumentController(host, loadCore);
  const [installerHint, setInstallerHint] = useState<UiLocale | null>(null);
  const sourceRegistryRef = useRef<ActiveSourceEditorRegistry | null>(null);
  if (!sourceRegistryRef.current) sourceRegistryRef.current = createActiveSourceEditorRegistry();
  const richRegistryRef = useRef<ActiveEditorRegistry | null>(null);
  if (!richRegistryRef.current) richRegistryRef.current = createActiveEditorRegistry();
  const [enhancedTabs, setEnhancedTabs] = useState<ReadonlySet<string>>(() => new Set());
  const receiptStates = useRef(new Map<string, FirstReadableReceipt>());
  const liveTabIds = useRef<ReadonlySet<string>>(new Set());
  liveTabIds.current = new Set(controller.tabs.map((tab) => tab.id));
  const active = controller.tabs.find((tab) => tab.id === controller.activeTabId);
  const activePath = active?.kind === "document" && active.file.kind === "local"
    ? active.file.canonicalPath
    : null;
  const activeEnhanced = active ? enhancedTabs.has(active.id) : false;
  const activeMode = active?.kind === "document" ? active.mode : null;

  useEffect(() => {
    let active = true;
    if (!host.getUiLanguageHint) return () => { active = false; };
    void host.getUiLanguageHint().then(
      (hint) => { if (active) setInstallerHint(hint); },
      () => undefined,
    );
    return () => { active = false; };
  }, [host]);

  useEffect(() => {
    if (
      !active ||
      active.kind !== "document" ||
      activeMode !== "reading" ||
      !activePath ||
      activeEnhanced ||
      receiptStates.current.has(active.id)
    ) return;
    const tabId = active.id;
    const receipt: FirstReadableReceipt = { firstFrame: 0, phase: "scheduled", secondFrame: 0 };
    let settleFrame = 0;
    receiptStates.current.set(tabId, receipt);
    receipt.firstFrame = requestAnimationFrame(() => {
      receipt.secondFrame = requestAnimationFrame(() => {
        if (receiptStates.current.get(tabId) !== receipt || receipt.phase !== "scheduled") return;
        receipt.phase = "in-flight";
        const snapshot = collectComputedReadingUiContract(document);
        const finish = () => {
          if (receiptStates.current.get(tabId) !== receipt || receipt.phase !== "in-flight") return;
          const surface = document.getElementById(`document-${tabId}`);
          const selection = window.getSelection();
          const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const chromeOwnsFocus = Boolean(focused?.closest(".menu-bar, .format-toolbar, .link-panel, .find-bar"));
          if (
            chromeOwnsFocus || (surface && selection && !selection.isCollapsed && selection.anchorNode &&
            surface.contains(selection.anchorNode))
          ) {
            settleFrame = requestAnimationFrame(finish);
            return;
          }
          receipt.phase = "settled";
          if (!liveTabIds.current.has(tabId)) {
            receiptStates.current.delete(tabId);
            return;
          }
          setEnhancedTabs((current) => new Set(current).add(tabId));
        };
        try {
          void host.recordFirstReadablePaint(activePath, snapshot).then(finish, finish);
        } catch {
          finish();
        }
      });
    });
    return () => {
      if (settleFrame) cancelAnimationFrame(settleFrame);
      if (receipt.phase === "scheduled") {
        cancelAnimationFrame(receipt.firstFrame);
        if (receipt.secondFrame) cancelAnimationFrame(receipt.secondFrame);
        if (receiptStates.current.get(tabId) === receipt) receiptStates.current.delete(tabId);
      }
    };
  }, [active?.id, activeEnhanced, activeMode, activePath, host]);

  const renderDocument = (
    tab: DocumentSession,
    blockViewSpans: readonly BlockViewSpan[],
    onOpenLink?: (href: string) => void,
    readingTheme: ReadingTheme = "soft-white",
  ) => {
    const preview = <FirstReadablePreview document={tab.candidate} blockViewSpans={blockViewSpans} />;
    if (!enhancedTabs.has(tab.id)) return preview;
    return (
      <Suspense fallback={preview}>
        <MarkdownView
          documentPath={tab.file.kind === "local" ? tab.file.canonicalPath : undefined}
          markdown={tab.candidate.text}
          blockViewSpans={blockViewSpans}
          onOpenLink={onOpenLink}
          readingTheme={readingTheme}
        />
      </Suspense>
    );
  };

  return (
    <LocaleProvider installerHint={installerHint}>
      <AppShell
        controller={controller}
        host={host}
        registry={sourceRegistryRef.current}
        richRegistry={richRegistryRef.current}
        renderDocument={renderDocument}
      />
    </LocaleProvider>
  );
}

import type { WorkspaceTab } from "../../documents/session";
import type { DocumentLayout } from "../../document/layout";
import type { DocumentController } from "../use-document-controller";
import { ZoomControl } from "./ZoomControl";
import { useLocale } from "../../i18n/locale";
import { translateRuntimeText } from "../../i18n/messages";

export function StatusBar({
  controller,
  layout,
  layoutLabels,
  onLayoutChange,
}: {
  controller: DocumentController;
  layout?: DocumentLayout;
  layoutLabels?: Readonly<Record<DocumentLayout, string>>;
  onLayoutChange?: (layout: DocumentLayout) => void;
}) {
  const { locale, t } = useLocale();
  const active = controller.tabs.find((tab) => tab.id === controller.activeTabId);
  const document = active?.kind === "document" ? active : null;
  const statusKey = document ? ({
    clean: "status.saved", dirty: "status.unsaved", saving: "status.saving", failed: "status.saveFailed",
    readonly: "status.readonly", conflict: "status.conflict",
  } as const)[document.status] : "status.ready";
  const saveState = t(statusKey);
  const protectedBlock = document?.protectedRawBuffer
    ? document.candidate.blocks.find(
        (block) => document.blockViewKeys.get(block.id) === document.protectedRawBuffer?.blockViewKey,
      )
    : null;
  const characterCount = document
    ? document.sourceBuffer?.bufferText.length ?? (
        document.protectedRawBuffer && protectedBlock
          ? document.candidate.text.length - protectedBlock.raw.length + document.protectedRawBuffer.bufferText.length
          : document.candidate.text.length
      )
    : 0;
  const invalidSource = document !== null && document.sourceBuffer !== null;
  const invalidProtectedRaw = document?.protectedRawBuffer?.validationError ?? null;
  const alertText = invalidSource
    ? t("status.invalidSource")
    : invalidProtectedRaw
      ? translateRuntimeText(locale, invalidProtectedRaw)
    : controller.persistentMessage?.kind === "error"
      ? translateRuntimeText(locale, controller.persistentMessage.text)
      : null;
  const informationalText = !invalidSource && controller.persistentMessage?.kind === "info"
    ? translateRuntimeText(locale, controller.persistentMessage.text)
    : null;
  const mode = t(document?.mode === "source" ? "mode.source" : document?.mode === "rich" ? "mode.rich" : "mode.reading");
  return (
    <footer
      aria-busy={document?.status === "saving"}
      className="statusbar"
      data-shell-contract="statusbar"
    >
      <div
        aria-busy={document?.status === "saving"}
        aria-live="polite"
        className="statusbar__status"
        data-ui-contract="status"
        role="status"
      >
        <span className={`statusbar__save-state statusbar__save-state--${document?.status ?? "ready"}`}>{saveState}</span>
        {informationalText ? <span className="statusbar__message">{informationalText}</span> : null}
      </div>
      <span className="statusbar__meta">{t("status.characters", { count: characterCount })}</span>
      <span className="statusbar__modes">{mode}</span>
      {document ? (
        <ZoomControl
          value={document.zoomPercent}
          onChange={(value) => controller.setDocumentZoom?.(document.id, document.revision, value)}
        />
      ) : <span className="statusbar__zoom">100%</span>}
      {document && document.mode !== "source" && layout && layoutLabels && onLayoutChange ? (
        <label className="statusbar__layout-control">
          <span>{t("status.layout")}</span>
          <select
            aria-label={t("status.documentLayout")}
            onChange={(event) => onLayoutChange(event.currentTarget.value as DocumentLayout)}
            value={layout}
          >
            {(Object.keys(layoutLabels) as DocumentLayout[]).map((value) => (
              <option key={value} value={value}>{layoutLabels[value]}</option>
            ))}
          </select>
        </label>
      ) : null}
      {alertText ? <span className="statusbar__error" role="alert">{alertText}</span> : null}
    </footer>
  );
}

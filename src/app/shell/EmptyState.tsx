import { useState } from "react";

import type { DocumentController } from "../use-document-controller";
import type { RecentDocument } from "../recent-documents";
import { fileNameForDisplay, formatPathForDisplay } from "../path-display";
import { ShellIcon } from "./icons";
import { useLocale } from "../../i18n/locale";

export interface EmptyStateProps {
  controller: DocumentController;
  onNew?: () => void | Promise<void>;
  onOpen?: () => void | Promise<void>;
  onDismiss?: () => void;
  title?: string;
  recentDocuments?: readonly RecentDocument[];
  onOpenRecent?: (entry: RecentDocument) => void | Promise<void>;
  onRemoveRecent?: (entry: RecentDocument) => void;
}

function parentPath(canonicalPath: string): string {
  const displayed = formatPathForDisplay(canonicalPath);
  const name = fileNameForDisplay(canonicalPath);
  return displayed.slice(0, Math.max(0, displayed.length - name.length)).replace(/[\\/]$/, "") || displayed;
}

function openedTime(openedAt: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(openedAt));
}

export function EmptyState({
  controller,
  onNew,
  onOpen,
  onDismiss,
  title,
  recentDocuments,
  onOpenRecent,
  onRemoveRecent,
}: EmptyStateProps) {
  const { locale, t } = useLocale();
  const [contextPath, setContextPath] = useState<string | null>(null);
  const showRecent = recentDocuments !== undefined;
  return (
    <section aria-label={t("start.region")} className={`empty-state${showRecent ? " empty-state--with-history" : ""}${onDismiss ? " empty-state--start-page" : ""}`} data-ui-contract="document">
      <div className="empty-state__intro">
        <div className="empty-state__heading">
          <ShellIcon className="empty-state__icon" name="document" />
          <div>
            <h1>{title ?? t("app.name")}</h1>
            <p>{t(onDismiss ? "start.tabDescription" : "start.localDescription")}</p>
          </div>
        </div>
        <div className="empty-state__actions">
          <button className="empty-state__primary" disabled={controller.closing} onClick={() => void (onNew ? onNew() : controller.newDocument())} type="button">{t("start.newDocument")}</button>
          <button disabled={controller.closing} onClick={() => void (onOpen ? onOpen() : controller.openPaths())} type="button">{t("start.openDocument")}</button>
          {onDismiss ? <button className="empty-state__secondary" onClick={onDismiss} type="button">{t("start.returnDocument")}</button> : null}
        </div>
      </div>
      {showRecent ? (
        <section aria-label={t("history.title")} className="empty-state__history">
          <div className="empty-state__history-heading">
            <h2>{t("history.title")}</h2>
            <span>{t("history.recent")}</span>
          </div>
          {recentDocuments.length > 0 ? (
            <div className="empty-state__recent-list">
              {recentDocuments.map((entry) => {
                const name = entry.displayName || fileNameForDisplay(entry.canonicalPath);
                const contextOpen = contextPath?.toLowerCase() === entry.canonicalPath.toLowerCase();
                return (
                  <div
                    className={`empty-state__recent-row${contextOpen ? " empty-state__recent-row--context" : ""}`}
                    key={entry.canonicalPath.toLowerCase()}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContextPath(entry.canonicalPath);
                    }}
                  >
                    <button
                      aria-label={t("history.open", { name })}
                      className="empty-state__recent-open"
                      disabled={controller.closing}
                      onClick={() => void onOpenRecent?.(entry)}
                      type="button"
                    >
                      <ShellIcon className="empty-state__recent-icon" name="document" />
                      <span className="empty-state__recent-copy">
                        <strong>{name}</strong>
                        <span>{parentPath(entry.canonicalPath)}</span>
                      </span>
                      <time dateTime={new Date(entry.openedAt).toISOString()}>{openedTime(entry.openedAt, locale)}</time>
                    </button>
                    <button
                      aria-label={t("history.remove", { name })}
                      className="empty-state__recent-remove"
                      onClick={() => {
                        setContextPath(null);
                        onRemoveRecent?.(entry);
                      }}
                      title={t("history.removeShort")}
                      type="button"
                    >
                      <ShellIcon name="close" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : <p className="empty-state__history-empty">{t("history.empty")}</p>}
        </section>
      ) : null}
    </section>
  );
}

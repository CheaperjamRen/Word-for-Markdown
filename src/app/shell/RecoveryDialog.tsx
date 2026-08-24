import { useEffect, useMemo, useRef } from "react";

import type { DraftRecord } from "../../contracts/desktop";
import { useLocale } from "../../i18n/locale";
import { fileNameForDisplay } from "../path-display";

export function RecoveryDialog({
  drafts,
  onRestore,
  onDiscard,
  onClose,
}: {
  drafts: readonly DraftRecord[];
  onRestore(id: string): void;
  onDiscard(id: string): void;
  onClose(): void;
}) {
  const { locale, t } = useLocale();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dateTime = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale],
  );

  useEffect(() => { closeRef.current?.focus(); }, []);
  if (!drafts.length) return null;

  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby="recovery-dialog-title"
        aria-modal="true"
        className="dialog recovery-dialog"
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        role="dialog"
      >
        <header className="recovery-dialog__header">
          <h2 id="recovery-dialog-title">{t("recovery.title")}</h2>
          <p>{t("recovery.originalUntouched")}</p>
        </header>
        <div className="recovery-dialog__list">
          {drafts.map((draft) => (
            <div className="recovery-dialog__item" key={draft.id}>
              <div className="recovery-dialog__details">
                <strong>{draft.canonicalPath ? fileNameForDisplay(draft.canonicalPath) : t("recovery.untitled")}</strong>
                <span className="recovery-dialog__meta">
                  <time dateTime={new Date(draft.updatedMs).toISOString()}>{dateTime.format(new Date(draft.updatedMs))}</time>
                  {draft.rejectedSourceBuffer ? <span className="recovery-dialog__tag">{t("recovery.sourceBuffer")}</span> : null}
                </span>
              </div>
              <div className="recovery-dialog__item-actions">
                <button onClick={() => onRestore(draft.id)} type="button">{t("common.restore")}</button>
                <button className="recovery-dialog__discard" onClick={() => onDiscard(draft.id)} type="button">{t("common.delete")}</button>
              </div>
            </div>
          ))}
        </div>
        <footer className="dialog__actions recovery-dialog__footer">
          <button onClick={onClose} ref={closeRef} type="button">{t("common.close")}</button>
        </footer>
      </section>
    </div>
  );
}

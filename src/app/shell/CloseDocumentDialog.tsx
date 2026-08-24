import { useEffect, useRef } from "react";

import type { DocumentController } from "../use-document-controller";
import { useLocale } from "../../i18n/locale";

export function CloseDocumentDialog({ controller }: { controller: DocumentController }) {
  const { t } = useLocale();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby="close-document-title"
        aria-modal="true"
        className="dialog close-document-dialog"
        onKeyDown={(event) => { if (event.key === "Escape") void controller.resolveClose("cancel"); }}
        role="dialog"
      >
        <h2 id="close-document-title">{t("close.title")}</h2>
        <p>{t("close.body")}</p>
        <div className="dialog__actions">
          <button className="dialog__primary" onClick={() => void controller.resolveClose("save")} type="button">{t("common.save")}</button>
          <button onClick={() => void controller.resolveClose("discard")} type="button">{t("common.discard")}</button>
          <button onClick={() => void controller.resolveClose("cancel")} ref={cancelRef} type="button">{t("common.cancel")}</button>
        </div>
      </section>
    </div>
  );
}

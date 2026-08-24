import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n/locale";

export function AboutDialog({
  getVersion,
  onClose,
}: {
  getVersion(): Promise<string>;
  onClose(): void;
}) {
  const { t } = useLocale();
  const [version, setVersion] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    void getVersion().then((value) => { if (active) setVersion(value); }, () => { if (active) setVersion(t("common.unavailable")); });
    closeRef.current?.focus();
    return () => { active = false; };
  }, [getVersion, t]);
  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby="about-dialog-title"
        aria-modal="true"
        className="dialog about-dialog"
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        role="dialog"
      >
        <h2 id="about-dialog-title">{t("about.title")}</h2>
        <p>{t("app.name")}</p>
        <p className="about-dialog__version">{t("about.version", { version: version ?? "…" })}</p>
        <div className="dialog__actions"><button onClick={onClose} ref={closeRef} type="button">{t("common.close")}</button></div>
      </section>
    </div>
  );
}

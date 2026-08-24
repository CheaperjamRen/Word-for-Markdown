import { useEffect, useRef, useState } from "react";

import { useLocale } from "../../i18n/locale";
import type { ReadingPreferences } from "../../reading/preferences";

type SettingsPage = "general" | "reading";

export function SettingsDialog({
  initialPage = "general",
  onClose,
  onReadingPreferencesChange,
  readingPreferences,
}: {
  initialPage?: SettingsPage;
  onClose(): void;
  onReadingPreferencesChange(value: ReadingPreferences): void;
  readingPreferences: ReadingPreferences;
}) {
  const { locale, setLocale, t } = useLocale();
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { closeRef.current?.focus(); }, []);

  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby="settings-dialog-title"
        aria-modal="true"
        className="dialog settings-dialog"
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        role="dialog"
      >
        <header className="settings-dialog__header">
          <h2 id="settings-dialog-title">{t("settings.title")}</h2>
        </header>
        <div className="settings-dialog__body">
          <nav aria-label={t("settings.title")} className="settings-dialog__nav">
            <button aria-current={page === "general" ? "page" : undefined} onClick={() => setPage("general")} type="button">
              {t("settings.general")}
            </button>
            <button aria-current={page === "reading" ? "page" : undefined} onClick={() => setPage("reading")} type="button">
              {t("settings.reading")}
            </button>
          </nav>
          <div className="settings-dialog__panel">
            {page === "general" ? (
              <fieldset>
                <legend>{t("settings.language")}</legend>
                <p>{t("settings.languageDescription")}</p>
                <label>
                  <input
                    checked={locale === "zh-CN"}
                    name="application-language"
                    onChange={() => setLocale("zh-CN")}
                    type="radio"
                  />
                  <span>{t("settings.zhCN")}</span>
                </label>
                <label>
                  <input
                    checked={locale === "en-US"}
                    name="application-language"
                    onChange={() => setLocale("en-US")}
                    type="radio"
                  />
                  <span>{t("settings.enUS")}</span>
                </label>
              </fieldset>
            ) : (
              <div className="settings-dialog__reading">
                <fieldset>
                  <legend>{t("settings.readingTheme")}</legend>
                  <div className="settings-dialog__options settings-dialog__options--themes">
                    {(["soft-white", "warm-paper", "night"] as const).map((theme) => (
                      <label className="settings-dialog__option" key={theme}>
                        <input
                          checked={readingPreferences.theme === theme}
                          name="reading-theme"
                          onChange={() => onReadingPreferencesChange({ ...readingPreferences, theme })}
                          type="radio"
                        />
                        <span aria-hidden="true" className={`settings-dialog__theme-swatch settings-dialog__theme-swatch--${theme}`} />
                        <span>{t(`settings.readingTheme.${theme}`)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>{t("settings.readingWidth")}</legend>
                  <div className="settings-dialog__options">
                    {(["narrow", "comfortable", "wide"] as const).map((width) => (
                      <label className="settings-dialog__option" key={width}>
                        <input
                          checked={readingPreferences.width === width}
                          name="reading-width"
                          onChange={() => onReadingPreferencesChange({ ...readingPreferences, width })}
                          type="radio"
                        />
                        <span>{t(`settings.readingWidth.${width}`)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>{t("settings.readingDensity")}</legend>
                  <div className="settings-dialog__options">
                    {(["compact", "comfortable", "spacious"] as const).map((density) => (
                      <label className="settings-dialog__option" key={density}>
                        <input
                          checked={readingPreferences.density === density}
                          name="reading-density"
                          onChange={() => onReadingPreferencesChange({ ...readingPreferences, density })}
                          type="radio"
                        />
                        <span>{t(`settings.readingDensity.${density}`)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}
          </div>
        </div>
        <footer className="dialog__actions settings-dialog__footer">
          <button onClick={onClose} ref={closeRef} type="button">{t("common.close")}</button>
        </footer>
      </section>
    </div>
  );
}

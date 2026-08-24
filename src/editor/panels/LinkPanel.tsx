import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useLocale } from "../../i18n/locale";

export function LinkPanel({
  initialUrl,
  onApply,
  onCancel,
  onRemove,
}: {
  initialUrl: string | null;
  onApply(url: string): void;
  onCancel(): void;
  onRemove(): void;
}) {
  const { t } = useLocale();
  const [url, setUrl] = useState(initialUrl ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { inputRef.current?.focus(); }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = url.trim();
    if (value) onApply(value);
  };

  return (
    <form
      aria-label={t("link.region")}
      className="link-panel"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
      onSubmit={submit}
      role="dialog"
    >
      <label className="link-panel__field">
        <span>{t("link.address")}</span>
        <input
          aria-label={t("link.address")}
          onChange={(event) => setUrl(event.currentTarget.value)}
          ref={inputRef}
          type="url"
          value={url}
        />
      </label>
      <div className="link-panel__actions">
        <button disabled={!url.trim()} type="submit">{t("common.apply")}</button>
        {initialUrl ? <button onClick={onRemove} type="button">{t("common.remove")}</button> : null}
        <button onClick={onCancel} type="button">{t("common.cancel")}</button>
      </div>
    </form>
  );
}

export default LinkPanel;

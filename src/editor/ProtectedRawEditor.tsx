import { useLayoutEffect, useRef } from "react";
import { useLocale } from "../i18n/locale";

export function ProtectedRawEditor({
  error,
  onCancel,
  onChange,
  onSave,
  value,
}: {
  error: string | null;
  onCancel(): void;
  onChange(value: string): void;
  onSave(): void;
  value: string;
}) {
  const { t } = useLocale();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { editorRef.current?.focus(); }, []);

  return (
    <section aria-label={t("raw.region")} className="protected-raw-editor">
      <textarea
        aria-label={t("raw.editor")}
        onChange={(event) => onChange(event.currentTarget.value)}
        ref={editorRef}
        spellCheck={false}
        value={value}
      />
      {error ? <div className="protected-raw-editor__error" role="alert">{error}</div> : null}
      <div className="protected-raw-editor__actions">
        <button onClick={onSave} type="button">{t("raw.save")}</button>
        <button onClick={onCancel} type="button">{t("common.cancel")}</button>
      </div>
    </section>
  );
}

export default ProtectedRawEditor;

import { convertFileSrc } from "@tauri-apps/api/core";
import "./preview.css";
import { useLocale } from "../i18n/locale";

function assetUrl(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return `file://${path.replaceAll("\\", "/")}`;
  }
}

export function LocalResourcePreview({
  displayName,
  canonicalPath,
  mediaType,
  onClose,
}: {
  displayName: string;
  canonicalPath: string;
  mediaType: "image" | "pdf";
  onClose: () => void;
}) {
  const { t } = useLocale();
  const src = assetUrl(canonicalPath);
  return (
    <section aria-label={displayName} className="resource-preview">
      <header className="resource-preview__header">
        <span className="resource-preview__name">{displayName}</span>
        <button aria-label={t("preview.close", { name: displayName })} onClick={onClose} type="button">{t("common.close")}</button>
      </header>
      <div className="resource-preview__body">
        {mediaType === "image" ? <img alt={displayName} src={src} /> : <iframe title={displayName} src={src} />}
      </div>
    </section>
  );
}

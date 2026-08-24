import { clampDocumentZoom, stepDocumentZoom } from "../../document/zoom";
import { useLocale } from "../../i18n/locale";

export function ZoomControl({ value, onChange }: { value: number; onChange(value: number): void }) {
  const { t } = useLocale();
  const zoom = clampDocumentZoom(value);
  return (
    <div aria-label={t("zoom.document")} className="statusbar__zoom statusbar__zoom-control">
      <button aria-label={t("zoom.out")} onClick={() => onChange(stepDocumentZoom(zoom, -1))} type="button">−</button>
      <input
        aria-label={t("zoom.document")}
        max={300}
        min={50}
        onChange={(event) => onChange(clampDocumentZoom(Number(event.currentTarget.value)))}
        step={10}
        type="range"
        value={zoom}
      />
      <span aria-hidden="true" className="statusbar__zoom-value">{zoom}%</span>
      <button aria-label={t("zoom.in")} onClick={() => onChange(stepDocumentZoom(zoom, 1))} type="button">＋</button>
    </div>
  );
}

import { useLocale } from "../../i18n/locale";

export function ConflictDialog({
  kind,
  suggestedPath,
  onKeepLocal,
  onUseDisk,
  onSaveAs,
  onOpenSuggested,
}: {
  kind: "conflict" | "deleted" | "renamed";
  suggestedPath?: string | null;
  onKeepLocal(): void;
  onUseDisk(): void;
  onSaveAs(): void;
  onOpenSuggested?(): void;
}) {
  const { t } = useLocale();
  const conflict = kind === "conflict";
  const title = t(conflict ? "conflict.changed" : kind === "deleted" ? "conflict.deleted" : "conflict.moved");
  return (
    <div aria-label={title} className="conflict-dialog" role="dialog">
      <div className="conflict-dialog__card">
        <h2>{title}</h2>
        <p>{t(conflict ? "conflict.changedBody" : kind === "deleted" ? "conflict.deletedBody" : "conflict.movedBody")}</p>
        {suggestedPath ? <p className="conflict-dialog__hint">{t("conflict.newLocation", { path: suggestedPath })}</p> : null}
        <div className="conflict-dialog__actions">
          {conflict ? <button onClick={onUseDisk} type="button">{t("conflict.loadDisk")}</button> : null}
          <button onClick={onKeepLocal} type="button">{t("conflict.keepMine")}</button>
          <button className="dialog__primary" onClick={onSaveAs} type="button">{t("conflict.saveAs")}</button>
          {kind === "renamed" && onOpenSuggested ? <button onClick={onOpenSuggested} type="button">{t("conflict.openNewLocation")}</button> : null}
        </div>
      </div>
    </div>
  );
}

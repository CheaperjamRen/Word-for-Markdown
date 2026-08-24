export const MIN_DOCUMENT_ZOOM = 50;
export const MAX_DOCUMENT_ZOOM = 300;
export const DOCUMENT_ZOOM_STEP = 10;

export type DocumentZoomMode = "canvas" | "text";

export function clampDocumentZoom(value: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : 100);
  return Math.min(MAX_DOCUMENT_ZOOM, Math.max(MIN_DOCUMENT_ZOOM, rounded));
}

export function stepDocumentZoom(value: number, direction: -1 | 1): number {
  return clampDocumentZoom(value + direction * DOCUMENT_ZOOM_STEP);
}

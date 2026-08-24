import type { DocumentLayout } from "./layout";
import type { DocumentZoomMode } from "./zoom";

export interface DocumentPresentationPreferences {
  layout: DocumentLayout;
  zoomMode: DocumentZoomMode;
}

export const DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES: DocumentPresentationPreferences = {
  layout: "canvas",
  zoomMode: "canvas",
};

export const DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY =
  "markdown-document-app.presentation-preferences.v1";

type PresentationPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): PresentationPreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isLayout(value: unknown): value is DocumentLayout {
  return value === "a4" || value === "a3" || value === "canvas";
}

function isZoomMode(value: unknown): value is DocumentZoomMode {
  return value === "canvas" || value === "text";
}

export function readDocumentPresentationPreferences(
  storage: PresentationPreferenceStorage | null = defaultStorage(),
): DocumentPresentationPreferences {
  if (!storage) return { ...DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES };
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY) ?? "null",
    );
    if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1) {
      return { ...DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES };
    }
    const value = parsed as Record<string, unknown>;
    return {
      layout: isLayout(value.layout) ? value.layout : DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES.layout,
      zoomMode: isZoomMode(value.zoomMode)
        ? value.zoomMode
        : DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES.zoomMode,
    };
  } catch {
    return { ...DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES };
  }
}

export function writeDocumentPresentationPreferences(
  value: DocumentPresentationPreferences,
  storage: PresentationPreferenceStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, ...value }),
    );
  } catch {
    // Presentation preferences are optional and must never block opening a document.
  }
}

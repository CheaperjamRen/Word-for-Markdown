import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES,
  DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY,
  readDocumentPresentationPreferences,
  writeDocumentPresentationPreferences,
} from "./presentation-preferences";

describe("document presentation preferences", () => {
  it("defaults first-run presentation to Canvas with whole-canvas zoom", () => {
    expect(readDocumentPresentationPreferences()).toEqual({
      layout: "canvas",
      zoomMode: "canvas",
    });
  });

  it("reads valid fields and falls back malformed fields independently", () => {
    localStorage.setItem(DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      layout: "a3",
      zoomMode: "invalid",
    }));

    expect(readDocumentPresentationPreferences()).toEqual({
      layout: "a3",
      zoomMode: "canvas",
    });
  });

  it("falls back completely for unknown versions and invalid JSON", () => {
    localStorage.setItem(DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 2,
      layout: "a4",
      zoomMode: "text",
    }));
    expect(readDocumentPresentationPreferences()).toEqual(DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES);

    localStorage.setItem(DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY, "not-json");
    expect(readDocumentPresentationPreferences()).toEqual(DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES);
  });

  it("writes the small versioned presentation shape", () => {
    writeDocumentPresentationPreferences({ layout: "a4", zoomMode: "text" });

    expect(JSON.parse(localStorage.getItem(DOCUMENT_PRESENTATION_PREFERENCES_STORAGE_KEY) ?? "null")).toEqual({
      version: 1,
      layout: "a4",
      zoomMode: "text",
    });
  });

  it("does not block startup when preference storage is unavailable", () => {
    const unavailable = {
      getItem() { throw new Error("unavailable"); },
      setItem() { throw new Error("unavailable"); },
    } as Pick<Storage, "getItem" | "setItem">;

    expect(readDocumentPresentationPreferences(unavailable)).toEqual(DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES);
    expect(() => writeDocumentPresentationPreferences(DEFAULT_DOCUMENT_PRESENTATION_PREFERENCES, unavailable)).not.toThrow();
  });
});

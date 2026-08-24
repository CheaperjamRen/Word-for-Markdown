import { describe, expect, it } from "vitest";

import {
  DEFAULT_READING_PREFERENCES,
  READING_PREFERENCES_STORAGE_KEY,
  readReadingPreferences,
  writeReadingPreferences,
} from "./preferences";

describe("reading preferences", () => {
  it("falls back field by field when stored reading preferences are malformed", () => {
    localStorage.setItem(READING_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      theme: "warm-paper",
      width: "invalid",
      density: "spacious",
    }));

    expect(readReadingPreferences()).toEqual({
      theme: "warm-paper",
      width: "comfortable",
      density: "spacious",
    });
  });

  it("falls back completely for unknown versions and invalid JSON", () => {
    localStorage.setItem(READING_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 2,
      theme: "night",
      width: "wide",
      density: "compact",
    }));
    expect(readReadingPreferences()).toEqual(DEFAULT_READING_PREFERENCES);

    localStorage.setItem(READING_PREFERENCES_STORAGE_KEY, "not-json");
    expect(readReadingPreferences()).toEqual(DEFAULT_READING_PREFERENCES);
  });

  it("writes the versioned storage shape", () => {
    writeReadingPreferences({ theme: "night", width: "wide", density: "compact" });

    expect(JSON.parse(localStorage.getItem(READING_PREFERENCES_STORAGE_KEY) ?? "null")).toEqual({
      version: 1,
      theme: "night",
      width: "wide",
      density: "compact",
    });
  });

  it("does not block startup when storage access throws", () => {
    const unavailable = {
      getItem() { throw new Error("unavailable"); },
      setItem() { throw new Error("unavailable"); },
    } as Pick<Storage, "getItem" | "setItem">;

    expect(readReadingPreferences(unavailable)).toEqual(DEFAULT_READING_PREFERENCES);
    expect(() => writeReadingPreferences(DEFAULT_READING_PREFERENCES, unavailable)).not.toThrow();
  });
});

export type ReadingTheme = "soft-white" | "warm-paper" | "night";
export type ReadingWidth = "narrow" | "comfortable" | "wide";
export type ReadingDensity = "compact" | "comfortable" | "spacious";

export interface ReadingPreferences {
  theme: ReadingTheme;
  width: ReadingWidth;
  density: ReadingDensity;
}

export const DEFAULT_READING_PREFERENCES: ReadingPreferences = {
  theme: "soft-white",
  width: "comfortable",
  density: "comfortable",
};

export const READING_PREFERENCES_STORAGE_KEY = "markdown-document-app.reading-preferences.v1";

type ReadingPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): ReadingPreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isTheme(value: unknown): value is ReadingTheme {
  return value === "soft-white" || value === "warm-paper" || value === "night";
}

function isWidth(value: unknown): value is ReadingWidth {
  return value === "narrow" || value === "comfortable" || value === "wide";
}

function isDensity(value: unknown): value is ReadingDensity {
  return value === "compact" || value === "comfortable" || value === "spacious";
}

export function readReadingPreferences(
  storage: ReadingPreferenceStorage | null = defaultStorage(),
): ReadingPreferences {
  if (!storage) return { ...DEFAULT_READING_PREFERENCES };
  try {
    const parsed: unknown = JSON.parse(storage.getItem(READING_PREFERENCES_STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1) {
      return { ...DEFAULT_READING_PREFERENCES };
    }
    const value = parsed as Record<string, unknown>;
    return {
      theme: isTheme(value.theme) ? value.theme : DEFAULT_READING_PREFERENCES.theme,
      width: isWidth(value.width) ? value.width : DEFAULT_READING_PREFERENCES.width,
      density: isDensity(value.density) ? value.density : DEFAULT_READING_PREFERENCES.density,
    };
  } catch {
    return { ...DEFAULT_READING_PREFERENCES };
  }
}

export function writeReadingPreferences(
  value: ReadingPreferences,
  storage: ReadingPreferenceStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(READING_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, ...value }));
  } catch {
    // Preferences are optional; an unavailable store must not block reading.
  }
}

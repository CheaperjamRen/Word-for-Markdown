export interface StoredReadingPosition {
  sourceOffset: number;
  updatedAt: number;
}

export const READING_POSITIONS_STORAGE_KEY = "markdown-document-app.reading-positions.v1";
export const READING_POSITION_LIMIT = 50;

type ReadingPositionStorage = Pick<Storage, "getItem" | "setItem">;

interface StoredReadingPositionEntry extends StoredReadingPosition {
  path: string;
}

interface StoredReadingPositionPayload {
  version: 1;
  entries: StoredReadingPositionEntry[];
}

function defaultStorage(): ReadingPositionStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function normalizeWindowsPath(canonicalPath: string): string {
  return canonicalPath.replaceAll("/", "\\").toLowerCase();
}

function isValidPosition(value: unknown): value is StoredReadingPosition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.sourceOffset) && Number(candidate.sourceOffset) >= 0 &&
    Number.isSafeInteger(candidate.updatedAt) && Number(candidate.updatedAt) >= 0;
}

function readPayload(storage: ReadingPositionStorage): StoredReadingPositionPayload | null {
  const parsed: unknown = JSON.parse(storage.getItem(READING_POSITIONS_STORAGE_KEY) ?? "null");
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return null;
  return { version: 1, entries: candidate.entries as StoredReadingPositionEntry[] };
}

export function readReadingPosition(
  canonicalPath: string,
  storage: ReadingPositionStorage | null = defaultStorage(),
): StoredReadingPosition | null {
  if (!storage || !canonicalPath) return null;
  try {
    const payload = readPayload(storage);
    if (!payload) return null;
    const path = normalizeWindowsPath(canonicalPath);
    const entry = payload.entries.find((candidate) =>
      typeof candidate?.path === "string" && normalizeWindowsPath(candidate.path) === path,
    );
    return isValidPosition(entry)
      ? { sourceOffset: entry.sourceOffset, updatedAt: entry.updatedAt }
      : null;
  } catch {
    return null;
  }
}

export function writeReadingPosition(
  canonicalPath: string,
  value: StoredReadingPosition,
  storage: ReadingPositionStorage | null = defaultStorage(),
): void {
  if (!storage || !canonicalPath || !isValidPosition(value)) return;
  try {
    const path = normalizeWindowsPath(canonicalPath);
    const existing = readPayload(storage)?.entries ?? [];
    const entries = existing
      .filter((entry) =>
        typeof entry?.path === "string" &&
        normalizeWindowsPath(entry.path) !== path &&
        isValidPosition(entry),
      )
      .concat({ path, sourceOffset: value.sourceOffset, updatedAt: value.updatedAt })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, READING_POSITION_LIMIT);
    storage.setItem(READING_POSITIONS_STORAGE_KEY, JSON.stringify({ version: 1, entries }));
  } catch {
    // Reading progress is optional; an unavailable store must never block a document.
  }
}

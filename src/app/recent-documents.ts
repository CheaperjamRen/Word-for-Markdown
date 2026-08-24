export const RECENT_DOCUMENTS_STORAGE_KEY = "markdown-document-app.recent-documents.v1";
export const RECENT_DOCUMENT_LIMIT = 8;

export interface RecentDocument {
  canonicalPath: string;
  displayName: string;
  openedAt: number;
}

type RecentDocumentStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): RecentDocumentStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecentDocument(value: unknown): value is RecentDocument {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<RecentDocument>;
  return typeof entry.canonicalPath === "string" && entry.canonicalPath.length > 0 &&
    typeof entry.displayName === "string" && entry.displayName.length > 0 &&
    typeof entry.openedAt === "number" && Number.isFinite(entry.openedAt) && entry.openedAt >= 0;
}

export function readRecentDocuments(storage: RecentDocumentStorage | null = defaultStorage()): readonly RecentDocument[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RECENT_DOCUMENTS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecentDocument)
      .sort((left, right) => right.openedAt - left.openedAt)
      .slice(0, RECENT_DOCUMENT_LIMIT);
  } catch {
    return [];
  }
}

export function recordRecentDocument(
  entry: RecentDocument,
  storage: RecentDocumentStorage | null = defaultStorage(),
): readonly RecentDocument[] {
  const next = [
    entry,
    ...readRecentDocuments(storage).filter(
      (current) => current.canonicalPath.toLowerCase() !== entry.canonicalPath.toLowerCase(),
    ),
  ]
    .sort((left, right) => right.openedAt - left.openedAt)
    .slice(0, RECENT_DOCUMENT_LIMIT);
  if (!storage) return next;
  try {
    storage.setItem(RECENT_DOCUMENTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Opening a document remains successful even when local metadata storage is unavailable.
  }
  return next;
}

export function removeRecentDocument(
  canonicalPath: string,
  storage: RecentDocumentStorage | null = defaultStorage(),
): readonly RecentDocument[] {
  const next = readRecentDocuments(storage).filter(
    (entry) => entry.canonicalPath.toLowerCase() !== canonicalPath.toLowerCase(),
  );
  if (!storage) return next;
  try {
    storage.setItem(RECENT_DOCUMENTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Removal is best-effort metadata cleanup and never affects the document itself.
  }
  return next;
}

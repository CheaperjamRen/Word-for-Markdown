import { beforeEach, describe, expect, it } from "vitest";

import {
  RECENT_DOCUMENTS_STORAGE_KEY,
  readRecentDocuments,
  recordRecentDocument,
  removeRecentDocument,
} from "./recent-documents";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("recent documents", () => {
  let storage: Pick<Storage, "getItem" | "setItem">;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("keeps the newest successful open for a Windows path without duplicates", () => {
    recordRecentDocument({
      canonicalPath: "C:\\Docs\\Guide.md",
      displayName: "Guide.md",
      openedAt: 10,
    }, storage);
    recordRecentDocument({
      canonicalPath: "c:\\docs\\GUIDE.md",
      displayName: "GUIDE.md",
      openedAt: 20,
    }, storage);

    expect(readRecentDocuments(storage)).toEqual([{
      canonicalPath: "c:\\docs\\GUIDE.md",
      displayName: "GUIDE.md",
      openedAt: 20,
    }]);
  });

  it("sorts newest first and retains only eight local files", () => {
    for (let index = 0; index < 10; index += 1) {
      recordRecentDocument({
        canonicalPath: `C:\\Docs\\${index}.md`,
        displayName: `${index}.md`,
        openedAt: 100 + index,
      }, storage);
    }

    const recent = readRecentDocuments(storage);
    expect(recent).toHaveLength(8);
    expect(recent.map((entry) => entry.displayName)).toEqual([
      "9.md", "8.md", "7.md", "6.md", "5.md", "4.md", "3.md", "2.md",
    ]);
  });

  it("drops malformed persisted metadata without breaking the start page", () => {
    storage.setItem(RECENT_DOCUMENTS_STORAGE_KEY, JSON.stringify([
      { canonicalPath: "C:\\Docs\\valid.md", displayName: "valid.md", openedAt: 2 },
      { canonicalPath: "C:\\Docs\\missing-time.md", displayName: "missing-time.md" },
      null,
    ]));

    expect(readRecentDocuments(storage)).toEqual([{
      canonicalPath: "C:\\Docs\\valid.md",
      displayName: "valid.md",
      openedAt: 2,
    }]);

    storage.setItem(RECENT_DOCUMENTS_STORAGE_KEY, "not-json");
    expect(readRecentDocuments(storage)).toEqual([]);
  });

  it("removes one path case-insensitively without touching the other entries", () => {
    recordRecentDocument({ canonicalPath: "C:\\Docs\\one.md", displayName: "one.md", openedAt: 1 }, storage);
    recordRecentDocument({ canonicalPath: "C:\\Docs\\two.md", displayName: "two.md", openedAt: 2 }, storage);

    expect(removeRecentDocument("c:\\docs\\ONE.md", storage)).toEqual([{
      canonicalPath: "C:\\Docs\\two.md",
      displayName: "two.md",
      openedAt: 2,
    }]);
  });
});

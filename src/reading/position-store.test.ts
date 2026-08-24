import { beforeEach, describe, expect, it } from "vitest";

import {
  READING_POSITIONS_STORAGE_KEY,
  readReadingPosition,
  writeReadingPosition,
} from "./position-store";

describe("reading position store", () => {
  beforeEach(() => localStorage.clear());

  it("matches canonical Windows paths case-insensitively across slash styles", () => {
    writeReadingPosition("\\\\?\\C:\\Docs\\Guide.md", { sourceOffset: 321, updatedAt: 1_000 });

    expect(readReadingPosition("\\\\?\\c:/docs/GUIDE.md")).toEqual({
      sourceOffset: 321,
      updatedAt: 1_000,
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [{ path: "c:\\bad.md", sourceOffset: -1, updatedAt: 1 }] }),
    JSON.stringify({ version: 1, entries: [{ path: "c:\\bad.md", sourceOffset: Number.MAX_SAFE_INTEGER + 1, updatedAt: 1 }] }),
    JSON.stringify({ version: 1, entries: [{ path: "c:\\bad.md", sourceOffset: 1, updatedAt: -1 }] }),
  ])("returns null for corrupt, unknown, negative, or unsafe stored data", (stored) => {
    localStorage.setItem(READING_POSITIONS_STORAGE_KEY, stored);

    expect(readReadingPosition("C:\\bad.md")).toBeNull();
  });

  it("keeps only the 50 most recently updated paths", () => {
    for (let index = 0; index < 55; index += 1) {
      writeReadingPosition(`C:\\docs\\${index}.md`, { sourceOffset: index, updatedAt: index });
    }

    const stored = JSON.parse(localStorage.getItem(READING_POSITIONS_STORAGE_KEY) ?? "null") as {
      entries: unknown[];
    };
    expect(stored.entries).toHaveLength(50);
    expect(readReadingPosition("C:\\docs\\0.md")).toBeNull();
    expect(readReadingPosition("C:\\docs\\54.md")).toEqual({ sourceOffset: 54, updatedAt: 54 });
  });

  it("does not block reading when browser storage is unavailable", () => {
    const unavailable = {
      getItem() { throw new Error("unavailable"); },
      setItem() { throw new Error("unavailable"); },
    } as Pick<Storage, "getItem" | "setItem">;

    expect(readReadingPosition("C:\\docs\\one.md", unavailable)).toBeNull();
    expect(() => writeReadingPosition(
      "C:\\docs\\one.md",
      { sourceOffset: 10, updatedAt: 20 },
      unavailable,
    )).not.toThrow();
  });
});

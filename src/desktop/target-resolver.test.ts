import { describe, expect, it } from "vitest";
import { classifyHref, resolveRelativeWindowsPath, splitHref } from "./target-resolver";

describe("target resolution helpers", () => {
  it("separates anchors and query fragments without treating them as paths", () => {
    expect(splitHref("./guide.md#安装" )).toEqual({ path: "./guide.md", fragment: "安装" });
    expect(splitHref("#目标")).toEqual({ path: "", fragment: "目标" });
  });

  it.each([
    ["https://example.com/a", "web"],
    ["mailto:hello@example.com", "web"],
    ["javascript:alert(1)", "blocked"],
    ["./photo.png", "preview"],
    ["./notes.md", "markdown"],
    ["./run.ps1", "dangerous"],
  ] as const)("classifies %s as %s", (href, kind) => {
    expect(classifyHref(href, { fragment: null, exists: true, directory: false, canonicalPath: href })).toMatchObject({ kind });
  });

  it("resolves relative assets against the Markdown file directory", () => {
    expect(resolveRelativeWindowsPath("C:\\docs\\notes\\readme.md", "../img/photo.png")).toBe("C:\\docs\\img\\photo.png");
  });
});

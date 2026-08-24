import { describe, expect, it } from "vitest";
import { buildOutline, headingId } from "./outline";

describe("Markdown outline", () => {
  it("creates stable nested entries and duplicate-safe heading ids", () => {
    const outline = buildOutline("# 项目计划\n\n## 目标\n\n## 目标\n\n### 交付");
    expect(outline.map((item) => [item.level, item.text, item.id])).toEqual([
      [1, "项目计划", "项目计划"],
      [2, "目标", "目标"],
      [2, "目标", "目标-1"],
      [3, "交付", "交付"],
    ]);
    expect(headingId("  Hello, world!  ")).toBe("hello-world");
  });

  it("ignores fenced headings and frontmatter", () => {
    const outline = buildOutline("---\ntitle: demo\n---\n\n# Real\n\n```md\n# Not a heading\n```");
    expect(outline.map((item) => item.text)).toEqual(["Real"]);
  });
});

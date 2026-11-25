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

  it("preserves underscores in snake_case filenames and inline code while stripping emphasis markers", () => {
    const outline = buildOutline([
      "### 3.3 隔离舱与环境嫁接 (worktree.py / worktree_env.py / git_ops.py)",
      "### 路由校验 `X-Harness_Token` 与 `*wildcard*`",
      "## **重点**与 _斜体_ 及 *强调* 和 ~~删除~~",
    ].join("\n\n"));

    expect(outline.map((item) => [item.text, item.id])).toEqual([
      [
        "3.3 隔离舱与环境嫁接 (worktree.py / worktree_env.py / git_ops.py)",
        "33-隔离舱与环境嫁接-worktreepy-worktree_envpy-git_opspy",
      ],
      [
        "路由校验 X-Harness_Token 与 *wildcard*",
        "路由校验-x-harness_token-与-wildcard",
      ],
      [
        "重点与 斜体 及 强调 和 删除",
        "重点与-斜体-及-强调-和-删除",
      ],
    ]);
  });

  it("runs Markdown stripping once, preserves code/escaped underscores, aligns indented offsets, and ignores tab code lines", () => {
    const markdown = [
      "## 构造器 `__init__` 方法",
      "## 分隔符 `_` 与 `_` 对比",
      "## 环境变量 APP__DB__HOST",
      "## 双反引号 ``foo`bar`` 示例",
      "## 参考 [Attention (ML)](https://en.wikipedia.org/wiki/Attention_(machine_learning))",
      "  ## 缩进两格标题",
      "\t# Tab 代码块不是标题",
      "## ###",
    ].join("\n\n");
    const outline = buildOutline(markdown);

    expect(outline.map((item) => [item.text, item.id])).toEqual([
      ["构造器 __init__ 方法", "构造器-__init__-方法"],
      ["分隔符 _ 与 _ 对比", "分隔符-_-与-_-对比"],
      ["环境变量 APP__DB__HOST", "环境变量-app__db__host"],
      ["双反引号 foo`bar 示例", "双反引号-foobar-示例"],
      ["参考 Attention (ML)", "参考-attention-ml"],
      ["缩进两格标题", "缩进两格标题"],
    ]);
    const indented = outline.find((item) => item.text === "缩进两格标题")!;
    expect(markdown.slice(indented.sourceOffset, indented.sourceOffset + 2)).toBe("##");
  });

  it("handles nested 4-backtick fences, inline triple backticks, badge links, and punctuation escapes", () => {
    const markdown = [
      "````md",
      "```",
      "# Inside inner fence",
      "```",
      "# Still inside 4-backtick fence",
      "````",
      "",
      "```inline``` description line",
      "",
      "## Heading After Inline Triple Backticks",
      "",
      "## [![](badge.svg)](https://ci.example.com) 构建状态",
      "",
      "## 价格 \\$100 与版本 \\~1.0",
    ].join("\n");

    const outline = buildOutline(markdown);
    expect(outline.map((item) => [item.text, item.id])).toEqual([
      ["Heading After Inline Triple Backticks", "heading-after-inline-triple-backticks"],
      ["构建状态", "构建状态"],
      ["价格 $100 与版本 ~1.0", "价格-100-与版本-10"],
    ]);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The tested Node .mjs helper intentionally has no duplicate TS declaration.
import { buildSizedMarkdown } from "../../../scripts/create-test-fixtures.mjs";
import { parseSourceDocument } from "../source-document";
import { buildBlockViewSpans, buildSourceView } from "../source-view";
import { FirstReadablePreview } from "./FirstReadablePreview";
import { MarkdownView } from "./MarkdownView";
import type { BlockViewSpan, SourceDocument } from "../../contracts/markdown";

const encoder = new TextEncoder();

function source(markdown: string) {
  return parseSourceDocument(Uint8Array.from(encoder.encode(markdown)));
}

afterEach(cleanup);

describe("FirstReadablePreview", () => {
  it("renders semantic readable blocks without inline markers or protected source", () => {
    const document = source([
      "---",
      "secret: never-preview",
      "---",
      "",
      "# **Visible** [title](https://example.com/private)",
      "",
      "Paragraph with **bold**, [link label](https://example.com), `inline code` and ~~old~~ text.",
      "",
      "> Quoted **meaning**.",
      "",
      "- first item",
      "- second `item`",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      ":::codex-private",
      "opaque: must-never-preview",
      ":::",
      "",
      '<custom-widget data-secret="never-preview"></custom-widget>',
    ].join("\n"));

    const { container } = render(<FirstReadablePreview document={document} />);

    expect(
      screen.getByRole("heading", { name: "Visible title" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Paragraph with bold, link label, inline code and old text/)).toBeInTheDocument();
    expect(screen.getByText("Quoted meaning.").closest("blockquote")).not.toBeNull();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("const value = 1;").closest("pre")).not.toBeNull();
    expect(container.textContent).not.toMatch(
      /secret:|never-preview|must-never-preview|https:\/\/|\*\*|~~|`inline code`/,
    );
  });

  it("keeps CJK-adjacent strong labels readable in the first frame", () => {
    render(<FirstReadablePreview document={source("- **容量：**上下文窗口\n")} />);
    expect(screen.getByRole("listitem")).toHaveTextContent("容量：上下文窗口");
    expect(screen.getByTestId("first-readable-preview").textContent).not.toContain("**");
  });

  it("uses parser-approved GFM deletion runs in both initial and enhanced Reading", () => {
    const document = source("Valid ~one~ and ~~two~~. Invalid ~ three ~ and ~~~four~~~.\n");
    const initial = render(<FirstReadablePreview document={document} />);
    expect(initial.container).toHaveTextContent(
      "Valid one and two. Invalid ~ three ~ and ~~~four~~~.",
    );
    initial.unmount();

    render(<MarkdownView markdown={document.text} />);
    expect(screen.getByTestId("markdown-view")).toHaveTextContent(
      "Valid one and two. Invalid ~ three ~ and ~~~four~~~.",
    );
  });

  it("enforces block, item, per-block and total character bounds", () => {
    const longParagraph = "p".repeat(1_200);
    const longCode = "c".repeat(1_200);
    const longList = Array.from(
      { length: 20 },
      (_, index) => `- item-${index + 1}-${"l".repeat(90)}`,
    ).join("\n");
    const trailing = Array.from(
      { length: 16 },
      (_, index) => `trailing-${index + 1}-${"t".repeat(500)}`,
    ).join("\n\n");
    const document = source(
      `# Bounds\n\n${longParagraph}\n\n\`\`\`text\n${longCode}\n\`\`\`\n\n${longList}\n\n${trailing}`,
    );

    render(<FirstReadablePreview document={document} />);

    const preview = screen.getByTestId("first-readable-preview");
    const blocks = Array.from(preview.children).filter(
      (element) => element.getAttribute("role") !== "status",
    );
    expect(blocks.length).toBeLessThanOrEqual(12);
    expect(screen.getAllByRole("listitem").length).toBeLessThanOrEqual(12);
    for (const block of blocks) {
      expect(block.textContent?.length ?? 0).toBeLessThanOrEqual(800);
    }
    expect(
      blocks.reduce((total, block) => total + (block.textContent?.length ?? 0), 0),
    ).toBeLessThanOrEqual(6_000);
    expect(screen.getByRole("status")).toHaveTextContent("正在完成全文排版…");
  });

  it("omits the truncation status for a complete short preview", () => {
    render(
      <FirstReadablePreview
        document={source("# Short document\n\nA complete paragraph.")}
      />,
    );

    expect(screen.getByRole("heading", { name: "Short document" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("adds stable heading ids before the enhanced renderer is ready", () => {
    const { container } = render(<FirstReadablePreview document={source("# 项目\n\n## 目标")} />);
    expect([...container.querySelectorAll("h1,h2")].map((node) => node.id)).toEqual(["项目", "目标"]);
  });

  it("shows representative content from the exact 102400-byte fixture", () => {
    const fixture = buildSizedMarkdown(102_400);

    render(<FirstReadablePreview document={source(fixture)} />);

    expect(Buffer.byteLength(fixture)).toBe(102_400);
    expect(
      screen.getByRole("heading", { name: "Large Markdown document" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Representative packaged Markdown content/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在完成全文排版…");
  });

  it("shares byte-derived top-level block hooks with enhanced Reading and owns no article landmark", () => {
    const document = source("# Heading😀\r\n\r\nParagraph 中文\r\n");
    const spans = buildBlockViewSpans(
      document,
      buildSourceView(document),
      new Map(document.blocks.map((block, index) => [block.id, `stable-${index}`])),
    );
    const Preview = FirstReadablePreview as ComponentType<{
      document: SourceDocument;
      blockViewSpans: readonly BlockViewSpan[];
    }>;
    const Enhanced = MarkdownView as ComponentType<{
      markdown: string;
      blockViewSpans: readonly BlockViewSpan[];
    }>;
    const preview = render(<Preview document={document} blockViewSpans={spans} />);
    const previewRoot = screen.getByTestId("first-readable-preview");
    const previewHooks = [...previewRoot.children].map((node) => ({
      key: node.getAttribute("data-block-view-key"),
      start: node.getAttribute("data-source-view-start"),
      end: node.getAttribute("data-source-view-end"),
    }));
    expect(previewRoot.tagName).toBe("DIV");
    preview.unmount();

    render(<Enhanced markdown={document.text} blockViewSpans={spans} />);
    const enhancedRoot = screen.getByTestId("markdown-view");
    const enhancedHooks = [...enhancedRoot.children].map((node) => ({
      key: node.getAttribute("data-block-view-key"),
      start: node.getAttribute("data-source-view-start"),
      end: node.getAttribute("data-source-view-end"),
    }));
    expect(enhancedRoot.tagName).toBe("DIV");
    expect(enhancedHooks).toEqual(previewHooks);
    expect(enhancedHooks).toEqual(spans.map((span) => ({
      key: span.blockViewKey,
      start: String(span.start),
      end: String(span.end),
    })));
  });

  it("stays bounded to 12 readable blocks and never grows yaml, math, or table placeholders", () => {
    const special = [
      "---", "title: preview", "---", "", "$$", "x^2", "$$", "",
      "| A | B |", "| - | - |", "| 1 | 2 |", "",
    ].join("\n");
    const markdown = `${special}\n${Array.from({ length: 13 }, (_, index) => `paragraph-${index}`).join("\n\n")}`;
    const document = source(markdown);
    const spans = buildBlockViewSpans(
      document,
      buildSourceView(document),
      new Map(document.blocks.map((block, index) => [block.id, `bounded-${index}`])),
    );
    const { container } = render(<FirstReadablePreview document={document} blockViewSpans={spans} />);
    const hooks = [...container.querySelectorAll<HTMLElement>("[data-block-view-key]")];

    expect(hooks).toHaveLength(12);
    for (const kind of ["yaml", "math", "table"]) {
      const span = spans.find((candidate) => candidate.kind === kind)!;
      expect(hooks.some((element) => element.dataset.blockViewKey === span.blockViewKey)).toBe(false);
    }
    expect(container.querySelector(".katex, table, details.markdown-frontmatter")).toBeNull();
  });
});

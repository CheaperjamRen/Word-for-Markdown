import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSourceDocument } from "../source-document";
import { buildBlockViewSpans, buildSourceView } from "../source-view";
import { MarkdownView } from "./MarkdownView";
import { resetMermaidSvgCacheForTests } from "./mermaid-cache";

const BASIC_FIXTURE = readFileSync(
  resolve("fixtures/markdown-showcase.md"),
  "utf8",
);

const { mermaidInitialize, mermaidRender } = vi.hoisted(() => ({
  mermaidInitialize: vi.fn(),
  mermaidRender: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: { initialize: mermaidInitialize, render: mermaidRender },
}));

describe("MarkdownView", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    resetMermaidSvgCacheForTests();
    mermaidInitialize.mockClear();
    mermaidRender.mockReset();
    mermaidRender.mockResolvedValue({ svg: "<svg></svg>" });
    delete (globalThis as { __rawHtmlExecuted?: boolean }).__rawHtmlExecuted;
  });

  it("renders GFM, frontmatter and math without exposing source markers", () => {
    render(<MarkdownView markdown={BASIC_FIXTURE} onOpenLink={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Markdown 功能示例" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByText("文档信息")).toBeInTheDocument();
    expect(document.querySelectorAll(".katex").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("| --- | --- |");
  });

  it("renders CJK-adjacent strong markers and legacy math code spans semantically", () => {
    const { container } = render(
      <MarkdownView markdown={'- **容量：**上下文窗口\n\n`QKᵀ / √d`\n\n`p_i = exp(z_i / T) / Σ exp(z_j / T)`'} />,
    );
    expect(container.querySelector("li strong")).toHaveTextContent("容量：");
    expect(container.querySelector("li")?.textContent).toBe("容量：上下文窗口");
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll("code")).toHaveLength(0);
  });

  it("initializes Mermaid with the exact strict local-only config", async () => {
    mermaidRender.mockResolvedValueOnce({ svg: "<svg></svg>" });
    render(<MarkdownView markdown={'```mermaid\ngraph TD\n A-->B\n```'} />);
    await waitFor(() =>
      expect(mermaidInitialize).toHaveBeenCalledWith({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        theme: "neutral",
      }),
    );
  });

  it("preserves Mermaid source when rendering fails", async () => {
    mermaidRender.mockRejectedValueOnce(new Error("invalid diagram"));
    render(<MarkdownView markdown={'```mermaid\ngraph TD\n A--\n```'} />);
    expect(await screen.findByText("图表没有渲染，已保留源码。")).toBeInTheDocument();
    expect(screen.getByText(/graph TD/)).toBeInTheDocument();
  });

  it("copies exact code, reports success, and restores the action label", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<MarkdownView markdown={'```ts\nconst value = "原样";\n```'} readingTheme="night" />);

    const copy = screen.getByRole("button", { name: "复制代码" });
    fireEvent.click(copy);
    await act(async () => { await Promise.resolve(); });

    expect(writeText).toHaveBeenCalledWith('const value = "原样";');
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1600));
    expect(screen.getByRole("button", { name: "复制代码" })).toBeInTheDocument();
    expect(document.querySelector(".markdown-code-block")).toHaveAttribute("data-code-theme", "dark");
  });

  it("does not show a false-success copy action without Clipboard support", () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(<MarkdownView markdown={'```text\ncontent\n```'} />);
    expect(screen.queryByRole("button", { name: "复制代码" })).not.toBeInTheDocument();
  });

  it("gives every complex reading block a stable semantic class", () => {
    const { container } = render(<MarkdownView markdown={[
      "---", "title: demo", "---", "", "> 引用", "", "![示意图](https://example.com/a.png)", "",
      "| A | B |", "| - | - |", "| 1 | 2 |", "", "$$", "\\sqrt{x}", "$$", "",
      "```text", "code", "```",
    ].join("\n")} />);

    for (const selector of [
      ".markdown-frontmatter",
      ".markdown-quote",
      ".markdown-image",
      ".markdown-table-wrap",
      ".katex-display",
      ".markdown-code-block",
    ]) expect(container.querySelector(selector), selector).not.toBeNull();
  });

  it("hands every link to the host callback instead of navigating the webview", async () => {
    const onOpenLink = vi.fn();
    render(
      <MarkdownView
        markdown={'[网页](https://example.com) [本地](./next.md)'}
        onOpenLink={onOpenLink}
      />,
    );
    await userEvent.click(screen.getByRole("link", { name: "网页" }));
    await userEvent.click(screen.getByRole("link", { name: "本地" }));
    expect(onOpenLink).toHaveBeenNthCalledWith(1, "https://example.com");
    expect(onOpenLink).toHaveBeenNthCalledWith(2, "./next.md");
  });

  it("uses neutral single-line blocks and removes GFM task-list markers", () => {
    const { container } = render(
      <MarkdownView markdown={'# 标题\n\n```js\nconst value = 1\n```\n\n```mermaid\ngraph TD\n A-->B\n```\n\n- [ ] 待办'} />,
    );
    const heading = container.querySelector("h1")!;
    const code = container.querySelector(".markdown-code-block")!;
    const mermaid = container.querySelector(".markdown-mermaid")!;
    const task = container.querySelector(".task-list-item")!;
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    expect(getComputedStyle(heading).borderTopWidth).toBe("0px");
    expect(getComputedStyle(code).borderTopWidth).toBe("1px");
    expect(getComputedStyle(mermaid).borderTopWidth).toBe("1px");
    expect(getComputedStyle(task).listStyleType).toBe("none");
    expect(getComputedStyle(checkbox).verticalAlign).toBe("-2px");
  });

  it("does not materialize raw HTML, scripts or event attributes", () => {
    const { container } = render(
      <MarkdownView
        markdown={[
          '<script>globalThis.__rawHtmlExecuted = true</script>',
          '<img src="x" onerror="globalThis.__rawHtmlExecuted = true">',
          '<custom-widget data-value="preserve-in-source"></custom-widget>',
        ].join("\n")}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("custom-widget")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect((globalThis as { __rawHtmlExecuted?: boolean }).__rawHtmlExecuted).toBeUndefined();
  });

  it("uses a non-landmark renderer root so DocumentSurface owns the sole Reading article", () => {
    render(<MarkdownView markdown="# Heading" />);
    expect(screen.getByTestId("markdown-view").tagName).toBe("DIV");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("assigns the same stable ids used by the outline, including duplicates", () => {
    const { container } = render(<MarkdownView markdown={"# 项目\n\n## 目标\n\n## 目标"} />);
    expect([...container.querySelectorAll("h1,h2")].map((node) => node.id)).toEqual(["项目", "目标", "目标-1"]);
  });

  it("keeps every rendered heading matched to its own source id under StrictMode", () => {
    render(
      <StrictMode>
        <MarkdownView markdown={"# 第一章\n\n## 第一节\n\n## 第二节\n\n### 细节"} />
      </StrictMode>,
    );

    expect(screen.getByRole("heading", { name: "第一章" })).toHaveAttribute("id", "第一章");
    expect(screen.getByRole("heading", { name: "第一节" })).toHaveAttribute("id", "第一节");
    expect(screen.getByRole("heading", { name: "第二节" })).toHaveAttribute("id", "第二节");
    expect(screen.getByRole("heading", { name: "细节" })).toHaveAttribute("id", "细节");
  });

  it("indexes 300 enhanced Reading block hooks with a linear number of span comparisons", () => {
    const markdown = Array.from({ length: 300 }, (_, index) => `paragraph-${index}`).join("\n\n");
    const document = parseSourceDocument(new Uint8Array(new TextEncoder().encode(markdown)));
    const rawSpans = [...buildBlockViewSpans(
      document,
      buildSourceView(document),
      new Map(document.blocks.map((block, index) => [block.id, `stable-${index}`])),
    )];
    let spanFieldReads = 0;
    const spans = rawSpans.map((span) => new Proxy(span, {
      get(target, property, receiver) {
        if (["start", "end", "blockViewKey", "kind", "blockId"].includes(String(property))) {
          spanFieldReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    }));

    render(<MarkdownView markdown={markdown} blockViewSpans={spans} />);

    expect(spanFieldReads).toBeLessThanOrEqual(spans.length * 8);
  });

  it("gives enhanced yaml, multiple display math, and table blocks exact unique hooks without tagging inline math", () => {
    const markdown = [
      "---", "title: hooks", "---", "", "$$", "x^2", "$$", "",
      "Inline $y$ stays in its paragraph.", "", "$$", "z^2", "$$", "",
      "| A | B |", "| - | - |", "| 1 | 2 |", "",
    ].join("\n");
    const document = parseSourceDocument(new Uint8Array(new TextEncoder().encode(markdown)));
    const spans = buildBlockViewSpans(
      document,
      buildSourceView(document),
      new Map(document.blocks.map((block, index) => [block.id, `stable-${index}`])),
    );
    const { container } = render(<MarkdownView markdown={markdown} blockViewSpans={spans} />);

    const hooked = [...container.querySelectorAll<HTMLElement>("[data-block-view-key]")];
    for (const span of spans.filter((candidate) => ["yaml", "math", "table"].includes(candidate.kind))) {
      const matches = hooked.filter((element) => element.dataset.blockViewKey === span.blockViewKey);
      expect(matches, span.kind).toHaveLength(1);
      expect(matches[0].dataset.sourceViewStart).toBe(String(span.start));
      expect(matches[0].dataset.sourceViewEnd).toBe(String(span.end));
    }
    const paragraph = spans.find((candidate) => candidate.kind === "paragraph")!;
    expect(container.querySelector(`[data-block-view-key="${paragraph.blockViewKey}"] .katex-display`)).toBeNull();
    expect(container.querySelectorAll(".katex-display")).toHaveLength(2);
  });

  it("keeps rendered Mermaid SVG intact during async theme transitions, skips neutral-to-neutral rerenders, and hits cache on remount", async () => {
    mermaidRender.mockResolvedValueOnce({ svg: '<svg data-variant="light"></svg>' });
    const diagram = "```mermaid\ngraph TD\n  A-->B\n```";
    const rendered = render(<MarkdownView markdown={diagram} readingTheme="soft-white" />);

    await waitFor(() =>
      expect(rendered.container.querySelector('.markdown-mermaid-canvas svg[data-variant="light"]')).not.toBeNull(),
    );
    expect(mermaidRender).toHaveBeenCalledTimes(1);

    rendered.rerender(<MarkdownView markdown={diagram} readingTheme="warm-paper" />);
    expect(mermaidRender).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector('.markdown-mermaid-canvas svg[data-variant="light"]')).not.toBeNull();

    let resolveDark!: (value: { svg: string }) => void;
    mermaidRender.mockImplementationOnce(
      () => new Promise<{ svg: string }>((resolve) => { resolveDark = resolve; }),
    );
    rendered.rerender(<MarkdownView markdown={diagram} readingTheme="night" />);

    // Previous SVG remains mounted both synchronously and while async dark render is in flight.
    expect(rendered.container.querySelector('.markdown-mermaid-canvas svg[data-variant="light"]')).not.toBeNull();
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(2));
    expect(rendered.container.querySelector('.markdown-mermaid-canvas svg[data-variant="light"]')).not.toBeNull();

    await act(async () => {
      resolveDark({ svg: '<svg data-variant="dark"></svg>' });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(rendered.container.querySelector('.markdown-mermaid-canvas svg[data-variant="dark"]')).not.toBeNull(),
    );

    rendered.unmount();
    mermaidRender.mockClear();
    const remounted = render(<MarkdownView markdown={diagram} readingTheme="soft-white" />);
    expect(remounted.container.querySelector('.markdown-mermaid-canvas svg[data-variant="light"]')).not.toBeNull();
    expect(mermaidRender).not.toHaveBeenCalled();
  });

  it("keeps snake_case identifiers, quoted enum unions, and method calls as inline code instead of math", () => {
    const { container } = render(
      <MarkdownView
        markdown={[
          '- TaskStatus: `"PENDING" | "RUNNING" | "WAITING_APPROVAL" | "FAILED"`',
          "- Files: `worktree_env.py` / `git_ops.py`",
          "- Call: `console.log(message)` and `PORT=8080` and `--mode=rpc`",
        ].join("\n")}
      />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(0);
    const codes = [...container.querySelectorAll("code")].map((node) => node.textContent);
    expect(codes).toEqual([
      '"PENDING" | "RUNNING" | "WAITING_APPROVAL" | "FAILED"',
      "worktree_env.py",
      "git_ops.py",
      "console.log(message)",
      "PORT=8080",
      "--mode=rpc",
    ]);
  });

  it("renders duplicate Mermaid blocks with distinct DOM ids across cold and cached mounts, cleans temp error nodes, and renders empty code blocks cleanly", async () => {
    mermaidRender.mockImplementation(async (id: string) => ({
      svg: `<svg id="${id}"><marker id="${id}-arrow"></marker></svg>`,
    }));
    const duplicate = ["```mermaid", "graph TD", "  A-->B", "```", "", "```mermaid", "graph TD", "  A-->B", "```"].join("\n");
    const rendered = render(<MarkdownView markdown={duplicate} />);

    await waitFor(() => expect(rendered.container.querySelectorAll(".markdown-mermaid-canvas svg")).toHaveLength(2));
    const coldIds = [...rendered.container.querySelectorAll(".markdown-mermaid-canvas svg")].map((el) => el.id);
    expect(coldIds[0]).toBeTruthy();
    expect(coldIds[1]).toBeTruthy();
    expect(coldIds[0]).not.toBe(coldIds[1]);

    rendered.unmount();
    mermaidRender.mockClear();
    const cachedMount = render(<MarkdownView markdown={duplicate} />);
    const cachedIds = [...cachedMount.container.querySelectorAll(".markdown-mermaid-canvas svg")].map((el) => el.id);
    expect(cachedIds).toHaveLength(2);
    expect(cachedIds[0]).toBeTruthy();
    expect(cachedIds[1]).toBeTruthy();
    expect(cachedIds[0]).not.toBe(cachedIds[1]);
    expect(mermaidRender).not.toHaveBeenCalled();
    cachedMount.unmount();

    mermaidRender.mockImplementationOnce(async (id: string) => {
      const orphan = document.createElement("div");
      orphan.id = `d${id}`;
      document.body.append(orphan);
      throw new Error("syntax error");
    });
    render(<MarkdownView markdown={"```mermaid\ngraph TD\n  broken--\n```"} />);
    expect(await screen.findByText("图表没有渲染，已保留源码。")).toBeInTheDocument();
    expect(document.querySelector('[id^="dmarkdown-mermaid-"]')).toBeNull();

    const emptyCode = render(<MarkdownView markdown={"```ts\n```\n\n```\n```"} />);
    const blocks = emptyCode.container.querySelectorAll(".markdown-code-block");
    expect(blocks).toHaveLength(2);
    expect(emptyCode.container.textContent).not.toContain("undefined");
  });

  it("assigns outline-matching DOM ids to 1-3 space indented ATX headings", () => {
    const { container } = render(<MarkdownView markdown={"  ## 缩进两格标题\n"} />);
    const heading = container.querySelector("h2");
    expect(heading).not.toBeNull();
    expect(heading?.id).toBe("缩进两格标题");
    expect(heading?.textContent).toBe("缩进两格标题");
  });
});

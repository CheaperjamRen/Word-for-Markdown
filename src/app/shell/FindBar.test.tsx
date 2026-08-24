import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FindBar } from "./FindBar";

afterEach(cleanup);

describe("FindBar", () => {
  it("finds one phrase split across inline formatting nodes", () => {
    document.body.innerHTML = '<div id="doc"><article data-document-search-content><p>alpha <strong>beta</strong></p></article></div>';
    render(<FindBar onClose={vi.fn()} rootId="doc" />);

    fireEvent.change(screen.getByRole("searchbox", { name: "查找文本" }), { target: { value: "alpha beta" } });

    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe("alpha beta");
  });

  it("searches only document content and ignores editor controls", () => {
    document.body.innerHTML = '<div id="doc"><article data-document-search-content><p>正文</p><button>editor action</button></article></div>';
    render(<FindBar onClose={vi.fn()} rootId="doc" />);

    fireEvent.change(screen.getByRole("searchbox", { name: "查找文本" }), { target: { value: "editor action" } });

    expect(screen.getByText("未找到")).toBeInTheDocument();
  });

  it("cycles matches in both directions and closes from a navigation button", () => {
    const onClose = vi.fn();
    document.body.innerHTML = '<div id="doc"><article data-document-search-content><p>中文 alpha</p><p>中文 beta</p></article></div>';
    render(<FindBar onClose={onClose} rootId="doc" />);
    const input = screen.getByRole("searchbox", { name: "查找文本" });
    fireEvent.change(input, { target: { value: "中文" } });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "下一个匹配" });
    next.focus();
    fireEvent.keyDown(next, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reselects the existing query on a repeated open request", () => {
    document.body.innerHTML = '<div id="doc"><article data-document-search-content>alpha</article></div>';
    const rendered = render(<FindBar onClose={vi.fn()} requestId={1} rootId="doc" />);
    const input = screen.getByRole("searchbox", { name: "查找文本" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alpha" } });
    input.setSelectionRange(5, 5);

    rendered.rerender(<FindBar onClose={vi.fn()} requestId={2} rootId="doc" />);

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
  });

  it("refreshes matches when the mounted document renderer replaces its text nodes", async () => {
    document.body.innerHTML = '<div id="doc"><article data-document-search-content><p>alpha one</p><p>alpha two</p></article></div>';
    render(<FindBar onClose={vi.fn()} rootId="doc" />);
    fireEvent.change(screen.getByRole("searchbox", { name: "查找文本" }), { target: { value: "alpha" } });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    const article = document.querySelector<HTMLElement>("[data-document-search-content]")!;
    article.replaceChildren(Object.assign(document.createElement("p"), { textContent: "replacement alpha" }));

    await waitFor(() => expect(screen.getByText("1 / 1")).toBeInTheDocument());
    expect(() => fireEvent.click(screen.getByRole("button", { name: "下一个匹配" }))).not.toThrow();
    expect(window.getSelection()?.toString()).toBe("alpha");
  });
});

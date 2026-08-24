import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutlinePane } from "./OutlinePane";

describe("OutlinePane", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("delegates pane collapse through one expanded disclosure control", async () => {
    const onCollapse = vi.fn();
    render(<OutlinePane markdown={"# One"} onCollapse={onCollapse} />);

    const collapse = screen.getByRole("button", { name: "收起大纲" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(collapse);

    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("scrolls the selected heading inside the active reading viewport", async () => {
    const surface = document.createElement("section");
    surface.id = "document-session-1";
    const viewport = document.createElement("div");
    viewport.className = "document-viewport document-viewport--reading";
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 80 });
    viewport.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
    surface.append(viewport);
    document.body.append(surface);
    const previous = document.createElement("h1");
    previous.id = "项目";
    previous.getBoundingClientRect = () => ({ top: 80 } as DOMRect);
    viewport.append(previous);
    const target = document.createElement("h2");
    target.id = "目标";
    let targetTop = 500;
    target.getBoundingClientRect = () => ({ top: targetTop } as DOMRect);
    viewport.append(target);
    render(<OutlinePane documentId="session-1" markdown={"# 项目\n\n## 目标"} />);
    await userEvent.click(screen.getByRole("button", { name: "目标" }));
    expect(viewport.scrollTop).toBe(456);
    targetTop = 132;
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: "目标" })).toHaveAttribute("aria-current", "location");
    surface.remove();
  });

  it("gives each heading level a visibly larger indentation step", () => {
    render(<OutlinePane markdown={"# One\n\n## Two\n\n### Three"} />);
    const items = [...document.querySelectorAll<HTMLButtonElement>(".outline-pane__item")];
    const padding = items.map((item) => Number.parseFloat(getComputedStyle(item).paddingLeft));
    expect(padding[1]! - padding[0]!).toBeGreaterThanOrEqual(20);
    expect(padding[2]! - padding[1]!).toBeGreaterThanOrEqual(20);
  });

  it("completes a selected outline jump when the full reading heading mounts later", async () => {
    const surface = document.createElement("section");
    surface.id = "document-session-1";
    const viewport = document.createElement("div");
    viewport.className = "document-viewport document-viewport--reading";
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 0 });
    viewport.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    surface.append(viewport);
    document.body.append(surface);

    render(<OutlinePane documentId="session-1" markdown={"# Intro\n\n## Later section"} />);
    await userEvent.click(screen.getByRole("button", { name: "Later section" }));

    const target = document.createElement("h2");
    target.id = "later-section";
    target.getBoundingClientRect = () => ({ top: 400 } as DOMRect);
    viewport.append(target);

    await waitFor(() => expect(viewport.scrollTop).toBe(376));
    surface.remove();
  });

  it("supports hierarchical keyboard focus, collapse, expand, and Enter jump", async () => {
    const surface = document.createElement("section");
    surface.id = "document-session-1";
    const viewport = document.createElement("div");
    viewport.className = "document-viewport document-viewport--reading";
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 0 });
    viewport.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    surface.append(viewport);
    document.body.append(surface);
    for (const [tag, id, top] of [
      ["h1", "intro", 100],
      ["h2", "goal", 300],
      ["h3", "detail", 500],
      ["h2", "next", 700],
    ] as const) {
      const heading = document.createElement(tag);
      heading.id = id;
      heading.getBoundingClientRect = () => ({ top } as DOMRect);
      viewport.append(heading);
    }

    render(<OutlinePane documentId="session-1" markdown={"# Intro\n\n## Goal\n\n### Detail\n\n## Next"} />);
    const intro = screen.getByRole("button", { name: "Intro" });
    intro.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Goal" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Detail" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "Goal" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("button", { name: "Detail" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("button", { name: "Detail" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(viewport.scrollTop).toBe(476);
    surface.remove();
  });

  it("coalesces repeated scroll events without remeasuring heading geometry", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const surface = document.createElement("section");
    surface.id = "document-session-1";
    const viewport = document.createElement("div");
    viewport.className = "document-viewport document-viewport--reading";
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 0 });
    viewport.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    surface.append(viewport);
    document.body.append(surface);
    let geometryReads = 0;
    for (const [tag, id, top] of [["h1", "intro", 0], ["h2", "later", 500]] as const) {
      const heading = document.createElement(tag);
      heading.id = id;
      heading.getBoundingClientRect = () => { geometryReads += 1; return { top } as DOMRect; };
      viewport.append(heading);
    }

    render(<OutlinePane documentId="session-1" markdown={"# Intro\n\n## Later"} />);
    geometryReads = 0;
    viewport.scrollTop = 480;
    fireEvent.scroll(viewport);
    fireEvent.scroll(viewport);
    fireEvent.scroll(viewport);

    expect(frames).toHaveLength(1);
    expect(geometryReads).toBe(0);
    act(() => frames.shift()!(0));
    expect(screen.getByRole("button", { name: "Later" })).toHaveAttribute("aria-current", "location");
    surface.remove();
  });
});

import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostApi } from "../contracts/desktop";
import type { DocumentSession } from "../documents/session";
import { sessionReducer } from "../documents/session-reducer";
import { parseSourceDocument } from "../markdown/source-document";
import { buildBlockViewSpans, buildSourceView } from "../markdown/source-view";
import { FirstReadablePreview } from "../markdown/render/FirstReadablePreview";
import { MarkdownView } from "../markdown/render/MarkdownView";
import { createActiveSourceEditorRegistry } from "../app/active-source-editor";
import { createDocumentController, type DocumentController } from "../app/use-document-controller";
import { DocumentSurface } from "./DocumentSurface";
import { anchoredScrollPosition } from "./zoom-geometry";
import { DEFAULT_READING_PREFERENCES } from "../reading/preferences";
import {
  READING_POSITIONS_STORAGE_KEY,
  readReadingPosition,
  writeReadingPosition,
} from "../reading/position-store";
import "../app/ui-tokens.css";

const encoder = new TextEncoder();

function session(mode: DocumentSession["mode"]): DocumentSession {
  const candidate = parseSourceDocument(new Uint8Array(encoder.encode("# Heading\n\nParagraph\n")));
  return {
    kind: "document",
    id: "one",
    file: { kind: "local", canonicalPath: "\\\\?\\C:\\docs\\one.md", version: { len: 1, modifiedMs: 1, sha256: "a" } },
    baseline: candidate,
    candidate,
    status: "clean",
    mode,
    revision: 0,
    zoomPercent: 100,
    draftId: null,
    externalChange: null,
    blockViewKeys: new Map(candidate.blocks.map((block, index) => [block.id, `key-${index}`])),
    sourceBuffer: null,
    protectedRawBuffer: null,
    viewState: { scrollAnchor: null, selection: null },
    history: { past: [], future: [] },
  };
}

function controller(tab: DocumentSession): DocumentController {
  return {
    tabs: [tab], activeTabId: tab.id, closePrompt: null, closing: false, persistentMessage: null,
    newDocument: async () => undefined, openPaths: async () => undefined,
    save: vi.fn(async () => undefined), saveAs: vi.fn(async () => undefined),
    requestClose: () => undefined, requestCloseAll: () => undefined,
    resolveClose: async () => undefined, activate: () => undefined,
    setMode: vi.fn(() => "changed" as const),
    getSourceView: vi.fn(() => buildSourceView(tab.candidate)),
    commitRichEdit: vi.fn(() => ({ kind: "stale" as const })),
    beginProtectedRawEdit: vi.fn(() => false), updateProtectedRawBuffer: vi.fn(() => false),
    cancelProtectedRawEdit: vi.fn(() => false), commitProtectedRawEdit: vi.fn(() => ({ kind: "stale" as const })),
    applySourceChangeBatch: vi.fn(() => ({ kind: "stale" as const })),
    updateSourceSelection: vi.fn(), updateSourceViewport: vi.fn(),
    undo: vi.fn(() => false), redo: vi.fn(() => false),
  };
}

function bufferedSession(): DocumentSession {
  const tab = session("source");
  const baseView = buildSourceView(tab.candidate);
  const bufferText = `${baseView.text}\ud800`;
  return {
    ...tab,
    sourceBuffer: {
      sessionId: tab.id,
      baseCandidateRevision: tab.revision,
      baseView,
      bufferText,
      composedChanges: [{ from: baseView.text.length, to: baseView.text.length, insert: "\ud800" }],
      validationError: "unpaired surrogate",
    },
    status: "dirty",
    viewState: {
      selection: {
        kind: "text",
        anchorBlockKey: null,
        anchorOffset: bufferText.length,
        focusBlockKey: null,
        focusOffset: bufferText.length,
      },
      scrollAnchor: { blockViewKey: null, offset: bufferText.length },
    },
  };
}

function editorFrom(container: HTMLElement): EditorView {
  const content = container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("missing real CodeMirror content");
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("missing real EditorView");
  return view;
}

function installReadingGeometry(viewportTop = 50): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("document-viewport--reading")) {
      return new DOMRect(0, viewportTop, 800, 600);
    }
    const viewport = this.closest<HTMLElement>(".document-viewport--reading");
    const contentTop = this.dataset.top !== undefined
      ? Number(this.dataset.top)
      : Number(this.dataset.index ?? 0) * 100;
    const height = Number(this.dataset.height ?? 100);
    return new DOMRect(0, viewportTop + contentTop - (viewport?.scrollTop ?? 0), 400, height);
  });
}

function hexContrast(left: string, right: string): number {
  const luminance = (value: string) => {
    const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
    if (!hex) throw new Error(`Expected a six-digit CSS hex color, received ${value}`);
    const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const [red, green, blue] = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

afterEach(() => {
  cleanup();
  localStorage.removeItem(READING_POSITIONS_STORAGE_KEY);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DocumentSurface mode ownership", () => {
  it("uses a stable base-width stage for whole-canvas zoom and typography only for text zoom", () => {
    const tab = { ...session("reading"), zoomPercent: 170 };
    const rendered = render(
      <DocumentSurface
        controller={controller(tab)}
        layout="a4"
        registry={createActiveSourceEditorRegistry()}
        tab={tab}
        zoomMode="canvas"
        renderReading={() => <div className="markdown-view">Reading</div>}
      />,
    );
    const paper = rendered.container.querySelector<HTMLElement>(".document-paper")!;
    const stage = rendered.container.querySelector<HTMLElement>(".document-paper-stage")!;
    expect(paper.style.transform).toBe("");
    expect(paper.style.zoom).toBe("1.7");
    expect(paper.style.width).toBe("794px");
    expect(stage).toHaveAttribute("data-document-base-width", "794");

    const zoomedTab = { ...tab, zoomPercent: 220 };
    rendered.rerender(
      <DocumentSurface
        controller={controller(zoomedTab)}
        layout="a4"
        registry={createActiveSourceEditorRegistry()}
        tab={zoomedTab}
        zoomMode="canvas"
        renderReading={() => <div className="markdown-view">Reading</div>}
      />,
    );
    expect(rendered.container.querySelector<HTMLElement>(".document-paper")!.style.width).toBe("794px");

    rendered.rerender(
      <DocumentSurface
        controller={controller(zoomedTab)}
        layout="a4"
        registry={createActiveSourceEditorRegistry()}
        tab={zoomedTab}
        zoomMode="text"
        renderReading={() => <div className="markdown-view">Reading</div>}
      />,
    );
    expect(rendered.container.querySelector<HTMLElement>(".document-paper")!.style.zoom).toBe("");
    expect(rendered.container.querySelector<HTMLElement>(".document-paper")!.style.width).toBe("794px");
    expect(rendered.container.querySelector<HTMLElement>(".document-surface")!.style.getPropertyValue("--document-zoom")).toBe("2.2");
  });

  it("anchors Ctrl+wheel to the pointer and other whole-canvas zoom changes to the viewport center", () => {
    const tab = session("reading");
    const setDocumentZoom = vi.fn();
    const surfaceController = { ...controller(tab), setDocumentZoom };
    const registry = createActiveSourceEditorRegistry();
    const renderReading = () => <div className="markdown-view">Reading</div>;
    const rendered = render(<DocumentSurface
      controller={surfaceController} layout="a4" registry={registry} tab={tab}
      zoomMode="canvas" renderReading={renderReading}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, writable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 400 },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(50, 40, 800, 600) },
    });

    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -100, clientX: 350, clientY: 240 });
    expect(setDocumentZoom).toHaveBeenCalledWith(tab.id, tab.revision, 110);
    const pointerAnchored = anchoredScrollPosition(
      1, 1.1, { left: 200, top: 400 }, { x: 300, y: 200 },
    );
    const zoomedTab = { ...tab, zoomPercent: 110 };
    rendered.rerender(<DocumentSurface
      controller={surfaceController} layout="a4" registry={registry} tab={zoomedTab}
      zoomMode="canvas" renderReading={renderReading}
    />);
    expect({ left: viewport.scrollLeft, top: viewport.scrollTop }).toEqual(pointerAnchored);

    const centerAnchored = anchoredScrollPosition(
      1.1, 1.5, pointerAnchored, { x: 400, y: 300 },
    );
    rendered.rerender(<DocumentSurface
      controller={surfaceController} layout="a4" registry={registry}
      tab={{ ...tab, zoomPercent: 150 }} zoomMode="canvas" renderReading={renderReading}
    />);
    expect({ left: viewport.scrollLeft, top: viewport.scrollTop }).toEqual(centerAnchored);
  });

  it("keeps the viewport center on the same paper point when a centered page starts overflowing", () => {
    const tab = session("reading");
    const registry = createActiveSourceEditorRegistry();
    const surfaceController = controller(tab);
    const renderReading = () => <div className="markdown-view">Reading</div>;
    const rendered = render(<DocumentSurface
      controller={surfaceController} layout="a4" registry={registry} tab={tab}
      zoomMode="canvas" renderReading={renderReading}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    const paper = rendered.container.querySelector<HTMLElement>(".document-paper")!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 1000, 600) },
    });
    Object.defineProperty(paper, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const scale = Number(paper.style.zoom || 1);
        const width = 794 * scale;
        const left = width <= 1000 ? (1000 - width) / 2 : 0;
        return new DOMRect(left - viewport.scrollLeft, -viewport.scrollTop, width, 1000 * scale);
      },
    });

    rendered.rerender(<DocumentSurface
      controller={surfaceController} layout="a4" registry={registry}
      tab={{ ...tab, zoomPercent: 150 }} zoomMode="canvas" renderReading={renderReading}
    />);

    expect(viewport.scrollLeft).toBe(96);
    expect(viewport.scrollTop).toBe(150);
  });

  it("pans a zoomed canvas with a middle-button drag without changing document content", () => {
    const tab = { ...session("reading"), zoomPercent: 200 };
    const rendered = render(
      <DocumentSurface
        controller={controller(tab)}
        registry={createActiveSourceEditorRegistry()}
        tab={tab}
        zoomMode="canvas"
        renderReading={() => <div className="markdown-view">Reading</div>}
      />,
    );
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    const setPointerCapture = vi.fn();
    Object.defineProperty(viewport, "setPointerCapture", { value: setPointerCapture });
    Object.defineProperty(viewport, "releasePointerCapture", { value: vi.fn() });
    Object.defineProperty(viewport, "scrollLeft", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 0 });
    const pointerEvent = (type: string, properties: Record<string, number>) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { value }])));
      return event;
    };
    expect(rendered.container.querySelector(".document-paper")).not.toHaveStyle({ cursor: "grab" });
    expect(viewport).not.toHaveClass("document-viewport--panning");
    fireEvent(viewport, pointerEvent("pointerdown", { button: 1, clientX: 200, clientY: 160, pointerId: 1 }));
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(viewport).toHaveClass("document-viewport--panning");
    fireEvent(viewport, pointerEvent("pointermove", { button: 1, clientX: 120, clientY: 100, pointerId: 1 }));
    fireEvent(viewport, pointerEvent("pointerup", { button: 1, clientX: 120, clientY: 100, pointerId: 1 }));
    expect(viewport).not.toHaveClass("document-viewport--panning");
    expect(viewport.scrollLeft).toBeGreaterThanOrEqual(80);
    expect(viewport.scrollTop).toBeGreaterThanOrEqual(60);
    expect(tab.candidate.text).toBe("# Heading\n\nParagraph\n");
  });

  it("keeps one stable tabpanel with one Reading article and non-landmark renderer content", () => {
    const tab = session("reading");
    const rendered = render(
      <DocumentSurface
        controller={controller(tab)}
        registry={createActiveSourceEditorRegistry()}
        tab={tab}
        renderReading={() => <div className="markdown-view">Reading</div>}
      />,
    );
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "document-one");
    expect(panel).toHaveAttribute("aria-labelledby", "tab-one");
    expect(withinPanel(panel, "article")).toHaveLength(1);
    expect(panel.querySelectorAll(".document-paper")).toHaveLength(1);
    expect(panel.querySelector(".markdown-view")?.tagName).toBe("DIV");
    expect(rendered.container.querySelector(".cm-editor")).toBeNull();
  });

  it("exposes exact reading preferences and complete theme token contracts", () => {
    const tab = session("reading");
    render(
      <DocumentSurface
        controller={controller(tab)}
        readingPreferences={{ theme: "warm-paper", width: "wide", density: "spacious" }}
        registry={createActiveSourceEditorRegistry()}
        tab={tab}
        renderReading={() => <div className="markdown-view">Reading</div>}
      />,
    );

    expect(screen.getByRole("article")).toHaveAttribute("data-reading-theme", "warm-paper");
    expect(screen.getByRole("article")).toHaveAttribute("data-reading-width", "wide");
    expect(screen.getByRole("article")).toHaveAttribute("data-reading-density", "spacious");

    const tokens = readFileSync(resolve(process.cwd(), "src/app/ui-tokens.css"), "utf8");
    for (const theme of ["soft-white", "warm-paper", "night"]) {
      const block = tokens.match(new RegExp(`\\[data-reading-theme=["']${theme}["']\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      for (const token of ["canvas", "paper", "ink", "muted", "link", "line", "code", "selection"]) {
        expect(block).toContain(`--reader-${token}:`);
      }
      for (const token of [
        "chrome", "chrome-raised", "app-surface", "document-gutter", "panel", "paper",
        "line-subtle", "line", "line-strong", "text-primary", "text-secondary", "text-tertiary",
        "accent", "accent-hover", "accent-pressed", "accent-subtle", "accent-selected", "focus-ring",
        "on-accent", "success", "warning", "danger",
      ]) {
        expect(block).toContain(`--${token}:`);
      }
      const token = (name: string) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1] ?? "";
      expect(hexContrast(token("on-accent"), token("accent"))).toBeGreaterThanOrEqual(4.5);
      for (const token of ["heading", "emphasis", "strong", "monospace", "link", "comment", "invalid"]) {
        expect(block).toContain(`--source-${token}:`);
      }
    }

    const appCss = readFileSync(resolve(process.cwd(), "src/app/app.css"), "utf8");
    expect(appCss).toMatch(/\.toolbar-button--save\.toolbar-button--actionable\s*\{[^}]*color:\s*var\(--on-accent\)/s);
    expect(appCss).toMatch(/\.dialog__actions \.dialog__primary\s*\{[^}]*color:\s*var\(--on-accent\)/s);
    expect(appCss).not.toMatch(/\.document-paper::(?:before|after)/);
    expect(DEFAULT_READING_PREFERENCES).toMatchObject({ theme: "soft-white", width: "comfortable" });
  });

  it.each(["first-readable", "enhanced"] as const)(
    "owns exactly one Reading article around the real %s renderer",
    (renderer) => {
      const tab = session("reading");
      const spans = buildBlockViewSpans(tab.candidate, buildSourceView(tab.candidate), tab.blockViewKeys);
      render(<DocumentSurface
        controller={controller(tab)}
        registry={createActiveSourceEditorRegistry()}
        tab={tab}
        renderReading={() => renderer === "first-readable"
          ? <FirstReadablePreview document={tab.candidate} blockViewSpans={spans} />
          : <MarkdownView markdown={tab.candidate.text} blockViewSpans={spans} />}
      />);

      expect(screen.getAllByRole("article")).toHaveLength(1);
      expect(screen.getByRole("article").querySelector("article")).toBeNull();
      expect(screen.getByRole("article").querySelector(".markdown-view")).not.toBeNull();
    },
  );

  it("uses one continuous borderless Source workspace with one scroller", async () => {
    const tab = session("source");
    const rendered = render(
      <DocumentSurface
        controller={controller(tab)}
        registry={createActiveSourceEditorRegistry()}
        tab={tab}
        renderReading={() => <div>Reading</div>}
      />,
    );
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "document-one");
    expect(panel.querySelectorAll("article, .document-paper")).toHaveLength(0);
    expect(await screen.findByRole("textbox", { name: "Markdown 源码编辑器" })).toBeInTheDocument();
    await waitFor(() => expect(rendered.container.querySelectorAll(".cm-scroller")).toHaveLength(1));
    const sourcePanel = rendered.container.querySelector<HTMLElement>(".document-surface--source")!;
    const sourceSurface = rendered.container.querySelector<HTMLElement>(".document-viewport--source")!;
    const panelStyle = getComputedStyle(sourcePanel);
    const sourceStyle = getComputedStyle(sourceSurface);
    expect(panelStyle.padding).toBe("0px");
    expect(sourceStyle.overflow).toBe("hidden");
    expect(sourceStyle.borderTopWidth).toBe("0px");
    expect(Number.parseFloat(sourceStyle.borderRadius)).toBe(0);
  });

  it.each(["readonly", "conflict"] as const)(
    "consumes real Source Save, Undo, and Redo keys while %s and leaves controller state and Host untouched",
    async (status) => {
      const saveDocument = vi.fn(() => new Promise<never>(() => undefined));
      const host = {
        openDocument: vi.fn(async (canonicalPath: string) => ({
          canonicalPath, bytes: [65, 10], version: { len: 2, modifiedMs: 1, sha256: "a" },
        })),
        saveDocument,
        watchDocument: vi.fn(async (canonicalPath: string) => ({ watchId: "watch", canonicalPath })),
        unwatchDocument: vi.fn(async () => undefined),
        setWindowTitle: vi.fn(async () => undefined),
      } as unknown as HostApi;
      const surfaceController = createDocumentController(host);
      await surfaceController.openPaths(["C:\\docs\\protected.md"]);
      const tabId = surfaceController.activeTabId!;
      surfaceController.setMode(tabId, 0, "source");
      const replace = (revision: number, text: string) => {
        const source = surfaceController.getSourceView(tabId, revision)!;
        return surfaceController.applySourceChangeBatch({
          sessionId: tabId, baseCandidateRevision: revision, baseView: source,
          changes: [{ from: 0, to: source.text.length, insert: text }],
          bufferText: text, selectionAfter: { anchor: text.length, head: text.length },
        });
      };
      expect(replace(0, "B\n")).toMatchObject({ candidateRevision: 1 });
      expect(replace(1, "C\n")).toMatchObject({ candidateRevision: 2 });
      expect(surfaceController.undo(tabId, 2)).toBe(true);
      const internals = surfaceController as unknown as { state: { tabs: readonly DocumentSession[] } };
      internals.state = {
        ...internals.state,
        tabs: internals.state.tabs.map((tab) => ({ ...tab, status })),
      };
      const tab = surfaceController.tabs[0] as DocumentSession;
      const rendered = render(<DocumentSurface
        controller={surfaceController}
        registry={createActiveSourceEditorRegistry()}
        tab={tab}
        renderReading={() => <div>Reading</div>}
      />);
      const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
      expect(editorFrom(rendered.container).state.facet(EditorState.readOnly)).toBe(true);

      for (const key of ["s", "z", "y"] as const) {
        const event = new KeyboardEvent("keydown", {
          bubbles: true, cancelable: true, ctrlKey: true, key,
        });
        textbox.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      await Promise.resolve();
      expect(saveDocument).not.toHaveBeenCalled();
      expect(surfaceController.tabs[0]).toBe(tab);
      expect(editorFrom(rendered.container).state.doc.toString()).toBe(tab.candidate.text);
    },
  );

  it("blocks real conflict typing without erasing the conflict state or metadata", async () => {
    const host = {
      openDocument: vi.fn(async (canonicalPath: string) => ({
        canonicalPath, bytes: [65, 10], version: { len: 2, modifiedMs: 1, sha256: "a" },
      })),
      saveDocument: vi.fn(),
      watchDocument: vi.fn(async (canonicalPath: string) => ({ watchId: "watch", canonicalPath })),
      unwatchDocument: vi.fn(async () => undefined),
      setWindowTitle: vi.fn(async () => undefined),
    } as unknown as HostApi;
    const surfaceController = createDocumentController(host);
    await surfaceController.openPaths(["C:\\docs\\conflict.md"]);
    const tabId = surfaceController.activeTabId!;
    surfaceController.setMode(tabId, 0, "source");
    const internals = surfaceController as unknown as { state: { tabs: readonly DocumentSession[] } };
    const external = parseSourceDocument(new Uint8Array(encoder.encode("external\n")));
    internals.state = {
      ...internals.state,
      tabs: internals.state.tabs.map((candidate) => candidate.kind !== "document" ? candidate : {
        ...candidate,
        status: "conflict" as const,
        externalChange: {
          kind: "conflict" as const,
          watchId: "watch",
          external,
          detectedVersion: { len: 9, modifiedMs: 2, sha256: "external" },
        },
      }),
    };
    const before = internals.state;
    const beforeTab = before.tabs[0] as DocumentSession;
    const tab = surfaceController.tabs[0] as DocumentSession;
    const rendered = render(<DocumentSurface
      controller={surfaceController}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={() => <div>Reading</div>}
    />);
    const textbox = await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    await userEvent.type(textbox, "D");

    expect(internals.state.tabs[0]).not.toBe(beforeTab);
    expect(surfaceController.tabs[0]).toMatchObject({
      status: "conflict",
      candidate: { text: "A\n" },
      revision: beforeTab.revision,
      history: beforeTab.history,
      externalChange: { kind: "conflict", watchId: "watch", external, detectedVersion: { len: 9, modifiedMs: 2, sha256: "external" } },
    });
    expect(editorFrom(rendered.container).state.doc.toString()).toBe("A\n");
  });

  it("round-trips a rejected buffer selection beyond accepted text as null-key absolute UTF-16 through remount", async () => {
    const tab = bufferedSession();
    const surfaceController = controller(tab);
    const mutableTabs = surfaceController.tabs as DocumentSession[];
    vi.mocked(surfaceController.updateSourceSelection).mockImplementation((sessionId, expectedRevision, selection) => {
      const next = sessionReducer({
        tabs: mutableTabs,
        activeTabId: tab.id,
        pendingOperations: new Map(),
        writeReceipts: [],
        pendingWatchCleanupIds: [],
      }, { type: "source-selection-updated", sessionId, expectedRevision, selection });
      mutableTabs.splice(0, mutableTabs.length, ...(next.tabs as DocumentSession[]));
    });
    const renderSurface = () => <DocumentSurface
      controller={surfaceController}
      registry={createActiveSourceEditorRegistry()}
      tab={mutableTabs[0]}
      renderReading={() => <div>Reading</div>}
    />;
    const rendered = render(renderSurface());
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = editorFrom(rendered.container);
    const bufferLength = tab.sourceBuffer!.bufferText.length;

    expect(view.state.doc.toString()).toBe(tab.sourceBuffer!.bufferText);
    expect(view.state.selection.main.anchor).toBe(bufferLength);
    expect(() => act(() => view.dispatch({
      selection: { anchor: bufferLength, head: bufferLength - 1 },
    }))).not.toThrow();
    expect(mutableTabs[0].viewState.selection).toEqual({
      kind: "text",
      anchorBlockKey: null,
      anchorOffset: bufferLength,
      focusBlockKey: null,
      focusOffset: bufferLength - 1,
    });

    rendered.unmount();
    const remounted = render(renderSurface());
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    expect(editorFrom(remounted.container).state.selection.main).toMatchObject({
      anchor: bufferLength,
      head: bufferLength - 1,
    });
  });

  it("round-trips a rejected buffer viewport through empty spans instead of tagging accepted blocks", async () => {
    const tab = bufferedSession();
    const surfaceController = controller(tab);
    const mutableTabs = surfaceController.tabs as DocumentSession[];
    vi.mocked(surfaceController.updateSourceViewport).mockImplementation((sessionId, expectedRevision, anchor) => {
      const next = sessionReducer({
        tabs: mutableTabs,
        activeTabId: tab.id,
        pendingOperations: new Map(),
        writeReceipts: [],
        pendingWatchCleanupIds: [],
      }, { type: "source-viewport-updated", sessionId, expectedRevision, anchor });
      mutableTabs.splice(0, mutableTabs.length, ...(next.tabs as DocumentSession[]));
    });
    const rendered = render(<DocumentSurface
      controller={surfaceController}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={() => <div>Reading</div>}
    />);
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });

    fireEvent.scroll(rendered.container.querySelector(".cm-scroller")!);

    expect(surfaceController.updateSourceViewport).toHaveBeenCalledWith(
      tab.id,
      tab.revision,
      { blockViewKey: null, offset: 0 },
    );
    expect(mutableTabs[0].viewState.scrollAnchor).toEqual({ blockViewKey: null, offset: 0 });
  });

  it("preserves an accepted block-key viewport when a rejected buffer first rerenders", async () => {
    const tab = bufferedSession();
    const acceptedView = buildSourceView(tab.candidate);
    const spans = buildBlockViewSpans(tab.candidate, acceptedView, tab.blockViewKeys);
    tab.viewState = {
      ...tab.viewState,
      scrollAnchor: { blockViewKey: spans[1].blockViewKey, offset: 1 },
    };
    const scrollIntoView = vi.spyOn(EditorView, "scrollIntoView");

    render(<DocumentSurface
      controller={controller(tab)}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={() => <div>Reading</div>}
    />);
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });

    expect(scrollIntoView).toHaveBeenCalledWith(spans[1].start + 1, { y: "start" });
  });

  it("uses zero extra source-view clones for ordinary selection and viewport callbacks", async () => {
    const tab = session("source");
    const surfaceController = controller(tab);
    const rendered = render(<DocumentSurface
      controller={surfaceController}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={() => <div>Reading</div>}
    />);
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = editorFrom(rendered.container);
    vi.mocked(surfaceController.getSourceView).mockClear();

    act(() => view.dispatch({ selection: { anchor: 1, head: 1 } }));
    fireEvent.scroll(view.scrollDOM);

    expect(surfaceController.updateSourceSelection).toHaveBeenCalledOnce();
    expect(surfaceController.updateSourceViewport).toHaveBeenCalledOnce();
    expect(surfaceController.getSourceView).not.toHaveBeenCalled();
  });

  it("falls back to one current view per rapid accepted selection or viewport before parent rerender", async () => {
    const tab = session("source");
    const surfaceController = controller(tab);
    const mutableTabs = surfaceController.tabs as DocumentSession[];
    vi.mocked(surfaceController.getSourceView).mockImplementation((sessionId, revision) => {
      const current = mutableTabs.find((candidate) => candidate.id === sessionId);
      return current && current.revision === revision ? buildSourceView(current.candidate) : null;
    });
    vi.mocked(surfaceController.applySourceChangeBatch).mockImplementation((batch) => {
      const candidate = parseSourceDocument(new Uint8Array(encoder.encode(batch.bufferText)));
      mutableTabs[0] = {
        ...mutableTabs[0],
        candidate,
        revision: 1,
        status: "dirty",
        blockViewKeys: new Map(candidate.blocks.map((block, index) => [block.id, `next-${index}`])),
      };
      return { kind: "accepted", candidateRevision: 1, view: buildSourceView(candidate) };
    });
    const rendered = render(<DocumentSurface
      controller={surfaceController}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={() => <div>Reading</div>}
    />);
    await screen.findByRole("textbox", { name: "Markdown 源码编辑器" });
    const view = editorFrom(rendered.container);
    vi.mocked(surfaceController.getSourceView).mockClear();

    act(() => view.dispatch({ changes: { from: 0, to: 1, insert: "!" } }));
    act(() => view.dispatch({ selection: { anchor: 2, head: 2 } }));
    fireEvent.scroll(view.scrollDOM);

    expect(surfaceController.updateSourceSelection).toHaveBeenCalledWith(
      tab.id,
      1,
      expect.objectContaining({ kind: "text" }),
    );
    expect(surfaceController.updateSourceViewport).toHaveBeenCalledWith(
      tab.id,
      1,
      expect.objectContaining({ offset: expect.any(Number) }),
    );
    expect(surfaceController.getSourceView).toHaveBeenCalledTimes(2);
  });

  it("round-trips a bounded intra-block Reading offset instead of collapsing a tall block to its start", async () => {
    const candidate = parseSourceDocument(new Uint8Array(encoder.encode(`${"x".repeat(100)}\n`)));
    const base = session("reading");
    const tab: DocumentSession = {
      ...base,
      candidate,
      baseline: candidate,
      blockViewKeys: new Map(candidate.blocks.map((block) => [block.id, "tall"])),
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: "tall", offset: 50 } },
    };
    installReadingGeometry();
    const surfaceController = controller(tab);
    const rendered = render(<DocumentSurface
      controller={surfaceController}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={(spans) => <div
        data-block-view-key={spans[0].blockViewKey}
        data-height="200"
        data-top="100"
      >Tall block</div>}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;

    expect(viewport.scrollTop).toBe(200);
    await Promise.resolve();
    viewport.scrollTop = 150;
    fireEvent.scroll(viewport);
    expect(surfaceController.updateSourceViewport).toHaveBeenLastCalledWith(
      tab.id,
      tab.revision,
      { blockViewKey: "tall", offset: 25 },
    );
  });

  it("uses the nearest rendered predecessor for a protected anchor with no Reading node", () => {
    const candidate = parseSourceDocument(new Uint8Array(encoder.encode(
      "# Before\n\n<custom-widget>opaque</custom-widget>\n\n# After\n",
    )));
    const base = session("reading");
    const keys = new Map(candidate.blocks.map((block, index) => [block.id, `protected-${index}`]));
    const tab: DocumentSession = {
      ...base,
      candidate,
      baseline: candidate,
      blockViewKeys: keys,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: "protected-1", offset: 0 } },
    };
    installReadingGeometry();
    const rendered = render(<DocumentSurface
      controller={controller(tab)}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={(spans) => <>
        <div data-block-view-key={spans[0].blockViewKey} data-top="100">Before</div>
        <div data-block-view-key={spans[2].blockViewKey} data-top="300">After</div>
      </>}
    />);

    expect(rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!.scrollTop).toBe(200);
  });

  it("falls back at preview truncation then retries the exact 13th block when enhanced Reading commits", async () => {
    const markdown = Array.from({ length: 13 }, (_, index) => `paragraph-${index}`).join("\n\n");
    const candidate = parseSourceDocument(new Uint8Array(encoder.encode(markdown)));
    const base = session("reading");
    const keys = new Map(candidate.blocks.map((block, index) => [block.id, `block-${index}`]));
    const tab: DocumentSession = {
      ...base,
      candidate,
      baseline: candidate,
      blockViewKeys: keys,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: "block-12", offset: 0 } },
    };
    installReadingGeometry();
    const PreviewThenEnhanced = ({ spans }: { spans: ReturnType<typeof buildBlockViewSpans> }) => {
      const [limit, setLimit] = useState(12);
      return <div data-reading-render-ready={limit === 13 ? "true" : "false"}>
        <button onClick={() => setLimit(13)} type="button">renderer ready</button>
        {spans.slice(0, limit).map((span, index) => (
          <div data-block-view-key={span.blockViewKey} data-index={index} key={span.blockViewKey} />
        ))}
      </div>;
    };
    const renderReading = (spans: ReturnType<typeof buildBlockViewSpans>) => <PreviewThenEnhanced spans={spans} />;
    const surfaceController = controller(tab);
    const rendered = render(<DocumentSurface
      controller={surfaceController}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={renderReading}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    expect(viewport.scrollTop).toBe(1_200);

    fireEvent.click(screen.getByRole("button", { name: "renderer ready" }));

    await waitFor(() => expect(viewport.scrollTop).toBe(1_200));
  });

  it("uses the nearest rendered successor when the first canonical block has no hook", () => {
    const candidate = parseSourceDocument(new Uint8Array(encoder.encode("<x>hidden</x>\n\n# Visible\n")));
    const base = session("reading");
    const tab: DocumentSession = {
      ...base,
      candidate,
      baseline: candidate,
      blockViewKeys: new Map(candidate.blocks.map((block, index) => [block.id, `successor-${index}`])),
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: "successor-0", offset: 0 } },
    };
    installReadingGeometry();
    const rendered = render(<DocumentSurface
      controller={controller(tab)} registry={createActiveSourceEditorRegistry()} tab={tab}
      renderReading={(spans) => <div data-block-view-key={spans[1].blockViewKey} data-top="250" />}
    />);
    expect(rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!.scrollTop).toBe(250);
  });

  it("leaves scroll untouched for foreign/no hooks and disconnects a pending observer on unmount", () => {
    const base = session("reading");
    const targetKey = [...base.blockViewKeys.values()][0];
    const tab = {
      ...base,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: targetKey, offset: 0 } },
    };
    const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    class FakeMutationObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(_callback: MutationCallback) { observers.push(this); }
    }
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const rendered = render(<DocumentSurface
      controller={controller(tab)} registry={createActiveSourceEditorRegistry()} tab={tab}
      renderReading={() => <div data-block-view-key="foreign" />}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    expect(viewport.scrollTop).toBe(0);
    expect(observers).toHaveLength(1);
    rendered.unmount();
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
  });

  it("does not retain an observer after renderer-ready settles without an exact hook", () => {
    const base = session("reading");
    const targetKey = [...base.blockViewKeys.values()][0];
    const tab = {
      ...base,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: targetKey, offset: 0 } },
    };
    const constructed = vi.fn();
    class FakeMutationObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(_callback: MutationCallback) { constructed(); }
    }
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    render(<DocumentSurface
      controller={controller(tab)} registry={createActiveSourceEditorRegistry()} tab={tab}
      renderReading={() => <div data-reading-render-ready="true"><div data-block-view-key="foreign" /></div>}
    />);
    expect(constructed).not.toHaveBeenCalled();
  });

  it("disconnects the pending restore observer when the exact hook appears", () => {
    const base = session("reading");
    const targetKey = [...base.blockViewKeys.values()][0];
    const tab = {
      ...base,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: targetKey, offset: 0 } },
    };
    let callback!: MutationCallback;
    const disconnect = vi.fn();
    class FakeMutationObserver {
      disconnect = disconnect;
      observe = vi.fn();
      constructor(next: MutationCallback) { callback = next; }
    }
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const rendered = render(<DocumentSurface
      controller={controller(tab)} registry={createActiveSourceEditorRegistry()} tab={tab}
      renderReading={() => <div data-reading-render-ready="false"><div data-block-view-key="foreign" /></div>}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    const exact = document.createElement("div");
    exact.dataset.blockViewKey = targetKey;
    viewport.append(exact);

    callback([], {} as MutationObserver);

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects a pending restore observer when renderer-ready settles without the exact hook", () => {
    const base = session("reading");
    const targetKey = [...base.blockViewKeys.values()][0];
    const tab = {
      ...base,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: targetKey, offset: 0 } },
    };
    let callback!: MutationCallback;
    const disconnect = vi.fn();
    class FakeMutationObserver {
      disconnect = disconnect;
      observe = vi.fn();
      constructor(next: MutationCallback) { callback = next; }
    }
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const ReadyWithoutHook = () => {
      const [ready, setReady] = useState(false);
      return <div data-reading-render-ready={String(ready)}>
        <button onClick={() => setReady(true)} type="button">settle renderer</button>
        <div data-block-view-key="foreign" />
      </div>;
    };
    render(<DocumentSurface
      controller={controller(tab)} registry={createActiveSourceEditorRegistry()} tab={tab}
      renderReading={() => <ReadyWithoutHook />}
    />);
    fireEvent.click(screen.getByRole("button", { name: "settle renderer" }));

    callback([], {} as MutationObserver);

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it.each(["mode", "tab"] as const)("disconnects a pending restore observer on %s replacement", (route) => {
    const base = session("reading");
    const targetKey = [...base.blockViewKeys.values()][0];
    const tab = {
      ...base,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: targetKey, offset: 0 } },
    };
    const disconnect = vi.fn();
    class FakeMutationObserver {
      disconnect = disconnect;
      observe = vi.fn();
      constructor(_next: MutationCallback) {}
    }
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const surfaceController = controller(tab);
    const sharedView = buildSourceView(tab.candidate);
    surfaceController.getSourceView = vi.fn(() => sharedView);
    const registry = createActiveSourceEditorRegistry();
    const renderReading = () => <div data-reading-render-ready="false"><div data-block-view-key="foreign" /></div>;
    const rendered = render(<DocumentSurface
      controller={surfaceController} registry={registry} tab={tab} renderReading={renderReading}
    />);
    const replacement = route === "mode"
      ? { ...tab, mode: "rich" as const }
      : { ...tab, id: "replacement" };

    rendered.rerender(<DocumentSurface
      controller={surfaceController} registry={registry} tab={replacement} renderReading={renderReading}
    />);

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("does not let an old queued restore callback clear a newer restoration guard", () => {
    const base = session("reading");
    const targetKey = [...base.blockViewKeys.values()][0];
    const first = {
      ...base,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: targetKey, offset: 0 } },
    };
    const second = {
      ...first,
      viewState: { ...first.viewState, scrollAnchor: { blockViewKey: targetKey, offset: 1 } },
    };
    const queued: Array<() => void> = [];
    vi.stubGlobal("queueMicrotask", (callback: () => void) => { queued.push(callback); });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    const surfaceController = controller(first);
    const renderReading = (spans: ReturnType<typeof buildBlockViewSpans>) => <div
      data-block-view-key={spans[0].blockViewKey}
    />;
    const rendered = render(<DocumentSurface
      controller={surfaceController}
      registry={createActiveSourceEditorRegistry()}
      tab={first}
      renderReading={renderReading}
    />);
    rendered.rerender(<DocumentSurface
      controller={surfaceController}
      registry={createActiveSourceEditorRegistry()}
      tab={second}
      renderReading={renderReading}
    />);
    expect(queued).toHaveLength(2);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;

    queued[0]();
    viewport.scrollTop = 150;
    fireEvent.scroll(viewport);
    expect(surfaceController.updateSourceViewport).not.toHaveBeenCalled();

    queued[1]();
    fireEvent.scroll(viewport);
    expect(surfaceController.updateSourceViewport).toHaveBeenCalledOnce();
  });

  it("ignores a MutationObserver callback delivered after cleanup and a new effect", () => {
    const base = session("reading");
    const targetKey = [...base.blockViewKeys.values()][0];
    const first = {
      ...base,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: targetKey, offset: 0 } },
    };
    const second = {
      ...first,
      id: "two",
      viewState: { ...first.viewState, scrollAnchor: null },
    };
    let oldCallback!: MutationCallback;
    const disconnect = vi.fn();
    class FakeMutationObserver {
      disconnect = disconnect;
      observe = vi.fn();
      constructor(callback: MutationCallback) { oldCallback = callback; }
    }
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    const surfaceController = controller(first);
    const registry = createActiveSourceEditorRegistry();
    const renderReading = (spans: ReturnType<typeof buildBlockViewSpans>) => <div
      data-block-view-key={spans[0].blockViewKey}
    />;
    const rendered = render(<DocumentSurface
      controller={surfaceController} registry={registry} tab={first} renderReading={() => <div data-block-view-key="foreign" />}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    expect(oldCallback).toBeTypeOf("function");

    rendered.rerender(<DocumentSurface
      controller={surfaceController} registry={registry} tab={second} renderReading={renderReading}
    />);
    viewport.scrollTop = 150;
    oldCallback([], {} as MutationObserver);
    expect(viewport.scrollTop).toBe(150);
    fireEvent.scroll(viewport);
    expect(surfaceController.updateSourceViewport).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("biases a Reading pixel ratio away from a split emoji surrogate boundary", async () => {
    const candidate = parseSourceDocument(new Uint8Array(encoder.encode("A😀B\n")));
    const base = session("reading");
    const tab: DocumentSession = {
      ...base,
      candidate,
      baseline: candidate,
      blockViewKeys: new Map([[candidate.blocks[0].id, "emoji"]]),
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: "emoji", offset: 0 } },
    };
    installReadingGeometry();
    const surfaceController = controller(tab);
    const rendered = render(<DocumentSurface
      controller={surfaceController} registry={createActiveSourceEditorRegistry()} tab={tab}
      renderReading={(spans) => <div
        data-block-view-key={spans[0].blockViewKey} data-height="4" data-top="100"
      />}
    />);
    await Promise.resolve();
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    viewport.scrollTop = 102;
    fireEvent.scroll(viewport);
    expect(surfaceController.updateSourceViewport).toHaveBeenLastCalledWith(
      tab.id, tab.revision, { blockViewKey: "emoji", offset: 1 },
    );
  });

  it("restores a clean local document from its stored absolute source offset", () => {
    const tab = session("reading");
    const view = buildSourceView(tab.candidate);
    const spans = buildBlockViewSpans(tab.candidate, view, tab.blockViewKeys);
    writeReadingPosition(tab.file.kind === "local" ? tab.file.canonicalPath : "", {
      sourceOffset: spans[1].start,
      updatedAt: 100,
    });
    installReadingGeometry();

    const rendered = render(<DocumentSurface
      controller={controller(tab)}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={(renderedSpans) => <>
        <div data-block-view-key={renderedSpans[0].blockViewKey} data-top="100" />
        <div data-block-view-key={renderedSpans[1].blockViewKey} data-top="300" />
      </>}
    />);

    expect(rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!.scrollTop).toBe(300);
  });

  it("keeps the current session viewport ahead of a stored reading position", () => {
    const base = session("reading");
    const view = buildSourceView(base.candidate);
    const spans = buildBlockViewSpans(base.candidate, view, base.blockViewKeys);
    const tab = {
      ...base,
      viewState: { ...base.viewState, scrollAnchor: { blockViewKey: spans[0].blockViewKey, offset: 0 } },
    };
    writeReadingPosition(base.file.kind === "local" ? base.file.canonicalPath : "", {
      sourceOffset: spans[1].start,
      updatedAt: 100,
    });
    installReadingGeometry();

    const rendered = render(<DocumentSurface
      controller={controller(tab)}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={(renderedSpans) => <>
        <div data-block-view-key={renderedSpans[0].blockViewKey} data-top="100" />
        <div data-block-view-key={renderedSpans[1].blockViewKey} data-top="300" />
      </>}
    />);

    expect(rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!.scrollTop).toBe(100);
  });

  it("coalesces Reading scroll writes and flushes the latest source offset after 250ms", () => {
    vi.useFakeTimers();
    const tab = session("reading");
    installReadingGeometry();
    const rendered = render(<DocumentSurface
      controller={controller(tab)}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={(spans) => <div data-block-view-key={spans[0].blockViewKey} data-top="100" />}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    const path = tab.file.kind === "local" ? tab.file.canonicalPath : "";

    viewport.scrollTop = 125;
    fireEvent.scroll(viewport);
    viewport.scrollTop = 175;
    fireEvent.scroll(viewport);
    expect(readReadingPosition(path)).toBeNull();

    act(() => vi.advanceTimersByTime(250));

    expect(readReadingPosition(path)?.sourceOffset).toBeGreaterThan(0);
  });

  it("flushes a pending local Reading position before the surface unmounts", () => {
    vi.useFakeTimers();
    const tab = session("reading");
    installReadingGeometry();
    const rendered = render(<DocumentSurface
      controller={controller(tab)}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={(spans) => <div data-block-view-key={spans[0].blockViewKey} />}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    const path = tab.file.kind === "local" ? tab.file.canonicalPath : "";
    viewport.scrollTop = 50;
    fireEvent.scroll(viewport);

    rendered.unmount();

    expect(readReadingPosition(path)?.sourceOffset).toBeGreaterThan(0);
  });

  it("never persists a Reading position for an untitled document", () => {
    vi.useFakeTimers();
    const base = session("reading");
    const tab: DocumentSession = { ...base, file: { kind: "untitled", displayName: "Untitled.md" } };
    installReadingGeometry();
    const rendered = render(<DocumentSurface
      controller={controller(tab)}
      registry={createActiveSourceEditorRegistry()}
      tab={tab}
      renderReading={(spans) => <div data-block-view-key={spans[0].blockViewKey} />}
    />);
    const viewport = rendered.container.querySelector<HTMLElement>(".document-viewport--reading")!;
    viewport.scrollTop = 50;
    fireEvent.scroll(viewport);
    act(() => vi.advanceTimersByTime(250));

    expect(localStorage.getItem(READING_POSITIONS_STORAGE_KEY)).toBeNull();
  });
});

function withinPanel(panel: HTMLElement, selector: string): Element[] {
  return [...panel.querySelectorAll(selector)];
}

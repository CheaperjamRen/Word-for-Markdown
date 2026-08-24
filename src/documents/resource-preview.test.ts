import { describe, expect, it } from "vitest";
import type { SourceDocument } from "../contracts/markdown";
import type { ResourcePreviewSession, WorkspaceState } from "./session";
import { sessionReducer } from "./session-reducer";

const source = { bytes: new Uint8Array(), text: "", bomLength: 0, newline: "lf", blocks: [] } as SourceDocument;
const state: WorkspaceState = {
  tabs: [], activeTabId: null, pendingOperations: new Map(), writeReceipts: [], pendingWatchCleanupIds: [],
};
const preview: ResourcePreviewSession = {
  kind: "preview", id: "preview-1", canonicalPath: "C:\\docs\\photo.png", displayName: "photo.png", mediaType: "image", zoomPercent: 100,
};

describe("resource preview sessions", () => {
  it("opens one independent preview tab and reuses it for the same canonical path", () => {
    const first = sessionReducer(state, { type: "open-preview", preview });
    expect(first.tabs).toEqual([preview]);
    const second = sessionReducer(first, { type: "open-preview", preview: { ...preview, id: "preview-2" } });
    expect(second.tabs).toHaveLength(1);
    expect(second.activeTabId).toBe("preview-1");
  });

  it("changes only the active document zoom without touching candidate history", () => {
    const document = {
      kind: "document" as const, id: "doc", file: { kind: "untitled" as const, displayName: "未命名" },
      baseline: source, candidate: source, status: "dirty" as const, mode: "reading" as const,
      revision: 3, zoomPercent: 100, draftId: null, externalChange: null, blockViewKeys: new Map(),
      sourceBuffer: null, protectedRawBuffer: null, viewState: { scrollAnchor: null, selection: null }, history: { past: [], future: [] },
    };
    const next = sessionReducer({ ...state, tabs: [document], activeTabId: document.id }, { type: "document-zoom-updated", sessionId: document.id, expectedRevision: 3, zoomPercent: 150 });
    expect((next.tabs[0] as typeof document).zoomPercent).toBe(150);
    expect((next.tabs[0] as typeof document).revision).toBe(3);
  });
});

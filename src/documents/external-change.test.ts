import { describe, expect, it } from "vitest";
import type { FileVersion } from "../contracts/desktop";
import type { SourceDocument } from "../contracts/markdown";
import type { DocumentSession, WorkspaceState } from "./session";
import { documentHasUnsavedWork, sessionReducer } from "./session-reducer";

const version: FileVersion = { len: 3, modifiedMs: 2, sha256: "external" };
const source = (text: string): SourceDocument => ({ bytes: new TextEncoder().encode(text), text, bomLength: 0, newline: "lf", blocks: [] });
const session = (candidate: SourceDocument, status: DocumentSession["status"] = "clean"): DocumentSession => ({
  kind: "document", id: "doc", file: { kind: "local", canonicalPath: "C:\\docs\\doc.md", version }, baseline: source("base"), candidate, status, mode: "reading", revision: 2,
  zoomPercent: 100, draftId: null, externalChange: { kind: "checking", watchId: "watch" }, blockViewKeys: new Map(), sourceBuffer: null, protectedRawBuffer: null,
  viewState: { scrollAnchor: null, selection: null }, history: { past: [], future: [] },
});
const state = (tab: DocumentSession): WorkspaceState => ({ tabs: [tab], activeTabId: tab.id, pendingOperations: new Map(), writeReceipts: [], pendingWatchCleanupIds: [] });

describe("external document changes", () => {
  it("reloads a clean tab without changing its mode or creating history", () => {
    const external = source("external");
    const next = sessionReducer(state(session(source("base"))), { type: "external-reloaded", sessionId: "doc", expectedRevision: 2, watchId: "watch", document: external, version });
    const tab = next.tabs[0] as DocumentSession;
    expect(tab.candidate.text).toBe("external");
    expect(tab.baseline.text).toBe("external");
    expect(tab.status).toBe("clean");
    expect(tab.history).toEqual({ past: [], future: [] });
  });

  it("marks a dirty tab as conflict and preserves the local candidate", () => {
    const local = source("local");
    const next = sessionReducer(state(session(local, "dirty")), { type: "external-conflict", sessionId: "doc", expectedRevision: 2, watchId: "watch", document: source("external"), version });
    const tab = next.tabs[0] as DocumentSession;
    expect(tab.status).toBe("conflict");
    expect(tab.candidate.text).toBe("local");
    expect(tab.externalChange).toMatchObject({ kind: "conflict", watchId: "watch", detectedVersion: version });
    expect(documentHasUnsavedWork(tab)).toBe(true);
  });
});

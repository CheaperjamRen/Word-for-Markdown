import { describe, expect, it } from "vitest";
import * as desktopContract from "./desktop";
import wire from "../../fixtures/contracts/desktop-wire.json";
import {
  DESKTOP_COMMANDS,
  DESKTOP_EVENTS,
  type HostOpenDocument,
  type DeleteDraftInvoke,
  type DraftRecord,
  type FileChangedEvent,
  type ListDraftsInvoke,
  type OpenDocumentEventPayload,
  type OpenDocumentInvoke,
  type ReadDraftInvoke,
  type RecordFirstReadablePaintInvoke,
  type SaveDocumentAsInvoke,
  type SaveDocumentAsResult,
  type SaveDocumentInvoke,
  type TakeOpenRequestsInvoke,
  type TakeOpenRequestsResult,
  type UnwatchDocumentInvoke,
  type WatchDocumentInvoke,
  type WatchDocumentResult,
  type WriteDraftInvoke,
} from "./desktop";
import type { SelectionSnapshot, SourceViewModel } from "./markdown";
import type {
  DocumentMode,
  DocumentStatus,
  ResourcePreviewSession,
  WorkspaceTab,
} from "../documents/session";

function expectExactKeys(value: object, keys: string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

describe("desktop wire contract", () => {
  it("exposes typed desktop failures without importing the Tauri adapter", () => {
    const contract = desktopContract as unknown as {
      DesktopFailureError?: new (failure: typeof wire.desktopFailure) => Error;
      DesktopWireError?: new () => Error;
      getDesktopFailure?: (error: unknown) => typeof wire.desktopFailure | null;
    };
    expect(contract.DesktopFailureError).toBeTypeOf("function");
    expect(contract.DesktopWireError).toBeTypeOf("function");
    expect(contract.getDesktopFailure).toBeTypeOf("function");
    const typed = new contract.DesktopFailureError!(wire.desktopFailure);
    expect(contract.getDesktopFailure!(typed)).toEqual(wire.desktopFailure);
    expect(contract.getDesktopFailure!(new contract.DesktopWireError!())).toBeNull();
    expect(contract.getDesktopFailure!(new Error("raw framework failure"))).toBeNull();
  });
  it("locks command and event names used by every frontend adapter", () => {
    expect(DESKTOP_COMMANDS).toEqual(wire.commands);
    expect(DESKTOP_EVENTS).toEqual(wire.events);
    const eventPayload: OpenDocumentEventPayload = wire.openEventPayload;
    const queued: TakeOpenRequestsResult = wire.takeOpenRequestsResult;
    expect(eventPayload).toBeNull();
    expect(queued).toEqual(["C:\\docs\\契约.md"]);
  });

  it("locks every lifecycle payload including nested draft and selection keys", () => {
    const saveAs: SaveDocumentAsInvoke = wire.saveAsInvoke;
    const savedAs: SaveDocumentAsResult = wire.saveAsResult;
    const writeDraft: WriteDraftInvoke = wire.writeDraftInvoke;
    const listed: ListDraftsInvoke = wire.listDraftsInvoke;
    const read: ReadDraftInvoke = wire.readDraftInvoke;
    const deleted: DeleteDraftInvoke = wire.deleteDraftInvoke;
    const record = wire.draftRecord as unknown as DraftRecord;
    const watch: WatchDocumentInvoke = wire.watchDocumentInvoke;
    const watched: WatchDocumentResult = wire.watchDocumentResult;
    const unwatch: UnwatchDocumentInvoke = wire.unwatchDocumentInvoke;
    const event: FileChangedEvent = { ...wire.fileChangedEvent, kind: "renamed" };

    expectExactKeys(saveAs, ["request"]);
    expectExactKeys(saveAs.request, ["targetPath", "bytes", "expectedTargetVersion"]);
    expectExactKeys(savedAs, ["canonicalPath", "version"]);
    expectExactKeys(writeDraft.request, ["draft"]);
    expectExactKeys(writeDraft.request.draft, [
      "id", "sessionId", "canonicalPath", "baselineVersion", "bytes",
      "candidateRevision", "rejectedSourceBuffer",
    ]);
    expectExactKeys(listed.request, []);
    expectExactKeys(read.request, ["id"]);
    expectExactKeys(deleted.request, ["id"]);
    expectExactKeys(record, [
      "id", "sessionId", "canonicalPath", "baselineVersion", "bytes",
      "candidateRevision", "rejectedSourceBuffer", "updatedMs",
    ]);
    expectExactKeys(record.rejectedSourceBuffer!, [
      "baseCandidateRevision", "baseCandidateSha256", "utf16CodeUnitsBase64", "selection",
    ]);
    expectExactKeys(record.rejectedSourceBuffer!.selection!, [
      "kind", "anchorBlockKey", "anchorOffset", "focusBlockKey", "focusOffset",
    ]);
    expectExactKeys(watch.request, ["canonicalPath"]);
    expectExactKeys(watched, ["watchId", "canonicalPath"]);
    expectExactKeys(unwatch.request, ["watchId"]);
    expectExactKeys(event, ["watchId", "canonicalPath", "kind", "newCanonicalPath"]);
    expect(event.newCanonicalPath).toBe("C:\\docs\\契约-新.md");
  });

  it("rejects drift in every camelCase invoke and response payload", () => {
    const takeInvoke: TakeOpenRequestsInvoke = wire.takeOpenRequestsInvoke;
    const openInvoke: OpenDocumentInvoke = wire.openInvoke;
    const opened: HostOpenDocument = wire.openDocument;
    const saveInvoke: SaveDocumentInvoke = wire.saveInvoke;
    const paintInvoke: RecordFirstReadablePaintInvoke = wire.paintInvoke;

    expectExactKeys(takeInvoke, ["request"]);
    expectExactKeys(takeInvoke.request, []);
    expectExactKeys(openInvoke, ["request"]);
    expectExactKeys(openInvoke.request, ["path"]);
    expectExactKeys(opened, ["canonicalPath", "bytes", "version"]);
    expectExactKeys(opened.version, ["len", "modifiedMs", "sha256"]);
    expectExactKeys(saveInvoke, ["request"]);
    expectExactKeys(saveInvoke.request, ["canonicalPath", "bytes", "expectedVersion"]);
    expectExactKeys(saveInvoke.request.expectedVersion, ["len", "modifiedMs", "sha256"]);
    expectExactKeys(paintInvoke, ["request"]);
    expectExactKeys(paintInvoke.request, ["path", "applicationNetworkRequests", "uiContract"]);
    expectExactKeys(paintInvoke.request.uiContract, [
      "uiFontSize", "statusFontSize", "documentFontSize", "documentLineHeight",
      "toolbarIconWidth", "iconButtonHeight",
    ]);
    expect(opened.version.sha256).toBe("contract-sha256");
    expect(saveInvoke.request.expectedVersion).toEqual(opened.version);
  });
});

describe("frontend-only document contracts", () => {
  it.each([
    ["text", wire.selectionText],
    ["table", wire.selectionTable],
  ])("owns the tagged %s SelectionSnapshot in the canonical markdown contract", (_kind, fixture) => {
    const selection = fixture as unknown as SelectionSnapshot;

    expect(selection).toEqual(fixture);
  });
  it("keeps the source offset map typed and represented as Uint32Array", () => {
    const view: SourceViewModel = {
      text: "A\n",
      byteOffsetAtViewOffset: Uint32Array.of(0, 1, 2),
    };

    expect(view.byteOffsetAtViewOffset).toBeInstanceOf(Uint32Array);
    expect([...view.byteOffsetAtViewOffset]).toEqual([0, 1, 2]);
  });

  it("keeps document modes, statuses, and resource previews discriminated in WorkspaceTab", () => {
    const modes: DocumentMode[] = ["reading", "rich", "source"];
    const statuses: DocumentStatus[] = [
      "clean", "dirty", "saving", "failed", "readonly", "conflict",
    ];
    const preview: ResourcePreviewSession = {
      kind: "preview",
      id: "preview-1",
      canonicalPath: "C:\\docs\\diagram.pdf",
      displayName: "diagram.pdf",
      mediaType: "pdf",
      zoomPercent: 100,
    };
    const tab: WorkspaceTab = preview;

    expect(modes).toHaveLength(3);
    expect(statuses).toHaveLength(6);
    expect(tab.kind).toBe("preview");
  });
});

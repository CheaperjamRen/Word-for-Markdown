import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileVersion, HostApi, HostOpenDocument } from "../contracts/desktop";
import App from "./App";

const rendererControl = vi.hoisted(() => ({
  promise: null as Promise<void> | null,
  suspended: false,
}));

vi.mock("../markdown/render/MarkdownView", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ markdown }: { markdown: string }) => {
      if (rendererControl.suspended && rendererControl.promise) throw rendererControl.promise;
      return createElement("div", { "data-testid": "markdown-view" }, markdown);
    },
  };
});

const VERSION: FileVersion = { len: 1, modifiedMs: 10, sha256: "v1" };
const encoder = new TextEncoder();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function frames() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextId;
    pending.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    pending.delete(id);
  });
  const runNext = () => {
    const entry = [...pending.entries()].sort(([left], [right]) => left - right)[0];
    if (!entry) throw new Error("no animation frame is pending");
    pending.delete(entry[0]);
    act(() => entry[1](performance.now()));
  };
  return { count: () => pending.size, runNext, runTwo: () => { runNext(); runNext(); } };
}

function fixture(initialPath = "C:\\docs\\first.md") {
  let openListener: ((paths: string[]) => void) | undefined;
  const files = new Map<string, HostOpenDocument>([
    ["C:\\docs\\first.md", { canonicalPath: "C:\\docs\\first.md", bytes: [...encoder.encode("# First")], version: VERSION }],
    ["C:\\docs\\second.md", { canonicalPath: "C:\\docs\\second.md", bytes: [...encoder.encode("# Second")], version: VERSION }],
  ]);
  const host: HostApi = {
    onOpenRequests: vi.fn(async (listener) => { openListener = listener; listener([initialPath]); return () => undefined; }),
    onFileDrop: vi.fn(async () => () => undefined),
    onWindowCloseRequested: vi.fn(async () => () => undefined),
    closeWindow: vi.fn(async () => undefined),
    getAppVersion: vi.fn(async () => "0.1.0"),
    onFileChanged: vi.fn(async () => () => undefined),
    pickMarkdownFiles: vi.fn(async () => null),
    pickMarkdownSavePath: vi.fn(async () => null),
    openDocument: vi.fn(async (path) => files.get(path)!),
    saveDocument: vi.fn(async () => VERSION),
    saveDocumentAs: vi.fn(async (request) => ({ canonicalPath: request.targetPath, version: VERSION })),
    writeDraft: vi.fn(async () => { throw new Error("unused"); }),
    listDrafts: vi.fn(async () => []),
    readDraft: vi.fn(async () => { throw new Error("unused"); }),
    deleteDraft: vi.fn(async () => undefined),
    watchDocument: vi.fn(async (canonicalPath) => ({ watchId: "watch", canonicalPath })),
    unwatchDocument: vi.fn(async () => undefined),
    setWindowTitle: vi.fn(async () => undefined),
    recordFirstReadablePaint: vi.fn(async () => 100),
  };
  return { host, open: (path: string) => act(() => openListener?.([path])) };
}

function findInitialReadablePreview() {
  return screen.findByTestId("first-readable-preview", {}, { timeout: 3_000 });
}

afterEach(() => {
  cleanup();
  rendererControl.promise = null;
  rendererControl.suspended = false;
  vi.restoreAllMocks();
});

describe("per-tab first-readable receipts", () => {
  it("records after two frames and does not reissue an in-flight receipt after switching tabs", async () => {
    const controlledFrames = frames();
    const receipt = deferred<number>();
    const { host, open } = fixture();
    vi.mocked(host.recordFirstReadablePaint).mockImplementation(() => receipt.promise);
    render(<App host={host} />);

    await findInitialReadablePreview();
    await waitFor(() => expect(controlledFrames.count()).toBe(1));
    controlledFrames.runNext();
    expect(host.recordFirstReadablePaint).not.toHaveBeenCalled();
    controlledFrames.runNext();
    expect(host.recordFirstReadablePaint).toHaveBeenCalledOnce();

    open("C:\\docs\\second.md");
    expect(await screen.findByRole("heading", { name: "Second" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /first\.md/ }));
    expect(screen.getByRole("heading", { name: "First" })).toBeInTheDocument();
    expect(host.recordFirstReadablePaint).toHaveBeenCalledOnce();

    await act(async () => { receipt.resolve(100); await receipt.promise; });
    expect(await screen.findByTestId("markdown-view")).toHaveTextContent("# First");
    expect(host.recordFirstReadablePaint).toHaveBeenCalledOnce();
  });

  it("ignores a stale receipt for a closed tab and records the reopened session once", async () => {
    const controlledFrames = frames();
    const firstReceipt = deferred<number>();
    const { host, open } = fixture();
    vi.mocked(host.recordFirstReadablePaint)
      .mockImplementationOnce(() => firstReceipt.promise)
      .mockResolvedValue(100);
    render(<App host={host} />);

    await findInitialReadablePreview();
    controlledFrames.runTwo();
    await userEvent.keyboard("{Control>}w{/Control}");
    expect(screen.queryByRole("tab", { name: /first\.md/ })).not.toBeInTheDocument();
    await act(async () => { firstReceipt.resolve(100); await firstReceipt.promise; });

    open("C:\\docs\\first.md");
    await screen.findByTestId("first-readable-preview");
    await waitFor(() => expect(controlledFrames.count()).toBe(1));
    controlledFrames.runTwo();
    await waitFor(() => expect(host.recordFirstReadablePaint).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("markdown-view")).toHaveTextContent("# First");
  });

  it("keeps the readable preview while the enhanced renderer suspends", async () => {
    const controlledFrames = frames();
    const renderer = deferred<void>();
    rendererControl.suspended = true;
    rendererControl.promise = renderer.promise;
    const { host } = fixture();
    render(<App host={host} />);

    expect(await findInitialReadablePreview()).toHaveTextContent("First");
    controlledFrames.runTwo();
    await waitFor(() => expect(host.recordFirstReadablePaint).toHaveBeenCalledOnce());
    expect(screen.getByTestId("first-readable-preview")).toHaveTextContent("First");
    expect(screen.queryByTestId("markdown-view")).not.toBeInTheDocument();

    rendererControl.suspended = false;
    await act(async () => { renderer.resolve(); await renderer.promise; });
    expect(await screen.findByTestId("markdown-view")).toHaveTextContent("# First");
  });
});

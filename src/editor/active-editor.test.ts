// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { ActiveEditorBridge } from "./active-editor";
import { createActiveEditorRegistry } from "./active-editor";

function bridge(
  revision: number,
  blockViewKey = "block-a",
  mountToken = Symbol("mount"),
): ActiveEditorBridge {
  return {
    sessionId: "one",
    candidateRevision: revision,
    blockViewKey,
    mountToken,
    getInsertionBlockViewKey: vi.fn(() => blockViewKey),
    getState: vi.fn(() => ({
      canUndo: false,
      canRedo: false,
      canLink: true,
      block: "paragraph" as const,
      formats: {
        bold: "off" as const,
        italic: "off" as const,
        strikethrough: "off" as const,
        code: "off" as const,
      },
      list: "none" as const,
      linkUrl: null,
    })),
    restoreSelection: vi.fn(() => "restored" as const),
    run: vi.fn(() => "ran" as const),
    focus: vi.fn(() => "focused" as const),
  };
}

describe("active Rich editor registry", () => {
  it("returns only the exact session, revision and stable block bridge", () => {
    const registry = createActiveEditorRegistry();
    const current = bridge(3);
    const unregister = registry.register(current);

    expect(registry.get("one", 3, "block-a")).toBe(current);
    expect(registry.get("one", 2, "block-a")).toBeNull();
    expect(registry.get("one", 3, "block-b")).toBeNull();
    unregister();
    expect(registry.get("one", 3, "block-a")).toBeNull();
  });

  it("waits for one exact bridge and cancels stale pending requests", async () => {
    const registry = createActiveEditorRegistry();
    const waitToken = Symbol("wait");
    const waiting = registry.waitFor("one", 4, "block-a", waitToken);
    registry.register(bridge(3));
    expect(registry.get("one", 4, "block-a")).toBeNull();
    const current = bridge(4);
    registry.register(current);
    await expect(waiting).resolves.toBe(current);

    const cancelledToken = Symbol("cancelled");
    const cancelled = registry.waitFor("one", 5, "block-a", cancelledToken);
    registry.cancel(cancelledToken);
    await expect(cancelled).resolves.toBeNull();
  });

  it("does not let cleanup for an old mount remove its replacement", () => {
    const registry = createActiveEditorRegistry();
    const changed = vi.fn();
    registry.subscribe(changed);
    const old = bridge(1);
    const removeOld = registry.register(old);
    const replacement = bridge(1, "block-a", Symbol("replacement"));
    registry.register(replacement);
    removeOld();

    expect(registry.get("one", 1, "block-a")).toBe(replacement);
    expect(registry.getSnapshot()).toBeGreaterThanOrEqual(2);
    expect(changed).toHaveBeenCalled();
  });

  it("publishes and clears one exact block activation request", () => {
    const registry = createActiveEditorRegistry();
    const token = Symbol("activation");
    registry.requestActivation("one", 7, "block-c", token);
    expect(registry.getActivation("one", 7)).toEqual({ blockViewKey: "block-c", token });
    expect(registry.getActivation("one", 6)).toBeNull();
    registry.clearActivation(token);
    expect(registry.getActivation("one", 7)).toBeNull();
  });
});

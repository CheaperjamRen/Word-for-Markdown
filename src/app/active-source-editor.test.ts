// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { SourceEditorBridge } from "./active-source-editor";
import { createActiveSourceEditorRegistry } from "./active-source-editor";

function bridge(sessionId: string, candidateRevision: number): SourceEditorBridge {
  return {
    sessionId,
    candidateRevision,
    mountToken: Symbol(`${sessionId}:${candidateRevision}`),
    hasSelection: vi.fn(() => false),
    copy: vi.fn(async () => "copied" as const),
    selectAll: vi.fn(() => "selected" as const),
    openFind: vi.fn(() => "opened" as const),
    focus: vi.fn(() => "focused" as const),
  };
}

describe("active Source editor registry", () => {
  it("returns only the exact current session/revision bridge and ignores stale cleanup", () => {
    const registry = createActiveSourceEditorRegistry();
    const first = bridge("one", 0);
    const unregisterFirst = registry.register(first);
    expect(registry.get("one", 0)).toBe(first);
    expect(registry.get("one", 1)).toBeNull();

    const second = bridge("one", 1);
    const unregisterSecond = registry.register(second);
    unregisterFirst();
    expect(registry.get("one", 1)).toBe(second);
    unregisterSecond();
    expect(registry.get("one", 1)).toBeNull();
  });

  it("clears every live bridge without invoking editor operations", () => {
    const registry = createActiveSourceEditorRegistry();
    const current = bridge("one", 0);
    registry.register(current);
    registry.clear();
    expect(registry.get("one", 0)).toBeNull();
    expect(current.focus).not.toHaveBeenCalled();
  });

  it("keeps a same-session same-revision replacement when stale StrictMode cleanup runs", () => {
    const registry = createActiveSourceEditorRegistry();
    const first = bridge("one", 0);
    const unregisterFirst = registry.register(first);
    const replacement = bridge("one", 0);
    const unregisterReplacement = registry.register(replacement);

    unregisterFirst();
    expect(registry.get("one", 0)).toBe(replacement);
    unregisterReplacement();
    expect(registry.get("one", 0)).toBeNull();
  });
});

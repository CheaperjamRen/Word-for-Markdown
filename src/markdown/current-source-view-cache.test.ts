// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { parseSourceDocument } from "./source-document";
import { buildSourceView } from "./source-view";
import { CurrentSourceViewCache } from "./current-source-view-cache";

const encoder = new TextEncoder();

describe("CurrentSourceViewCache", () => {
  it("builds once for the exact session/revision/candidate identity and replaces old candidates", () => {
    const build = vi.fn(buildSourceView);
    const cache = new CurrentSourceViewCache(build);
    const a = parseSourceDocument(encoder.encode("A\n"));
    const b = parseSourceDocument(encoder.encode("B\n"));

    const first = cache.getOrBuild("one", 0, a);
    expect(cache.getOrBuild("one", 0, a)).toBe(first);
    expect(build).toHaveBeenCalledOnce();
    const second = cache.getOrBuild("one", 1, b);
    expect(second).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
    cache.getOrBuild("one", 0, a);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("evicts closed sessions, retains only live sessions, and clears on dispose", () => {
    const build = vi.fn(buildSourceView);
    const cache = new CurrentSourceViewCache(build);
    const source = parseSourceDocument(encoder.encode("A\n"));
    cache.getOrBuild("one", 0, source);
    cache.getOrBuild("two", 0, source);
    cache.retainSessions(new Set(["two"]));
    cache.getOrBuild("one", 0, source);
    expect(build).toHaveBeenCalledTimes(3);
    cache.evictSession("two");
    cache.getOrBuild("two", 0, source);
    expect(build).toHaveBeenCalledTimes(4);
    cache.clear();
    cache.getOrBuild("two", 0, source);
    expect(build).toHaveBeenCalledTimes(5);
  });
});

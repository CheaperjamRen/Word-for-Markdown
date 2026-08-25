// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { SourceHistoryKind } from "../contracts/markdown";
import {
  continueSourceHistoryGroup,
  type SourceHistoryEdit,
} from "./source-history-group";

function edit(overrides: Partial<SourceHistoryEdit> = {}): SourceHistoryEdit {
  return {
    kind: "typing",
    at: 100,
    from: 0,
    to: 0,
    beforeHead: 0,
    afterHead: 1,
    hasLineBreak: false,
    deleteDirection: null,
    ...overrides,
  };
}

function ids() {
  let sequence = 0;
  return () => `g${++sequence}`;
}

describe("Source history grouping", () => {
  it("joins adjacent typing inside 500ms and splits at 500ms", () => {
    const nextId = ids();
    const first = continueSourceHistoryGroup(null, edit(), nextId);
    const joined = continueSourceHistoryGroup(first, edit({
      at: 599,
      from: 1,
      to: 1,
      beforeHead: 1,
      afterHead: 2,
    }), nextId);
    const split = continueSourceHistoryGroup(joined, edit({
      at: 1099,
      from: 2,
      to: 2,
      beforeHead: 2,
      afterHead: 3,
    }), nextId);

    expect(first.group.id).toBe("g1");
    expect(joined.group.id).toBe("g1");
    expect(split.group.id).toBe("g2");
  });

  it("splits typing when the caret or changed range is no longer adjacent", () => {
    const nextId = ids();
    const first = continueSourceHistoryGroup(null, edit(), nextId);
    const moved = continueSourceHistoryGroup(first, edit({
      at: 200,
      from: 5,
      to: 5,
      beforeHead: 5,
      afterHead: 6,
    }), nextId);

    expect(moved.group.id).toBe("g2");
  });

  it("keeps consecutive backward and forward deletes in their own groups", () => {
    const nextId = ids();
    const backward = continueSourceHistoryGroup(null, edit({
      kind: "delete",
      from: 4,
      to: 5,
      beforeHead: 5,
      afterHead: 4,
      deleteDirection: "backward",
    }), nextId);
    const backwardAgain = continueSourceHistoryGroup(backward, edit({
      kind: "delete",
      at: 200,
      from: 3,
      to: 4,
      beforeHead: 4,
      afterHead: 3,
      deleteDirection: "backward",
    }), nextId);
    const forward = continueSourceHistoryGroup(backwardAgain, edit({
      kind: "delete",
      at: 250,
      from: 3,
      to: 4,
      beforeHead: 3,
      afterHead: 3,
      deleteDirection: "forward",
    }), nextId);
    const forwardAgain = continueSourceHistoryGroup(forward, edit({
      kind: "delete",
      at: 300,
      from: 3,
      to: 4,
      beforeHead: 3,
      afterHead: 3,
      deleteDirection: "forward",
    }), nextId);

    expect(backwardAgain.group.id).toBe(backward.group.id);
    expect(forward.group.id).not.toBe(backward.group.id);
    expect(forwardAgain.group.id).toBe(forward.group.id);
  });

  it.each([
    ["line break", edit({ hasLineBreak: true, afterHead: 1 })],
    ["composition", edit({ kind: "composition" })],
    ["paste or replacement", edit({ kind: "atomic" })],
  ] satisfies ReadonlyArray<readonly [string, SourceHistoryEdit]>) (
    "always starts a new group for %s",
    (_label, nextEdit) => {
      const nextId = ids();
      const first = continueSourceHistoryGroup(null, edit(), nextId);
      const special = continueSourceHistoryGroup(first, nextEdit, nextId);
      const after = continueSourceHistoryGroup(special, edit({
        at: 200,
        from: nextEdit.afterHead,
        to: nextEdit.afterHead,
        beforeHead: nextEdit.afterHead,
        afterHead: nextEdit.afterHead + 1,
      }), nextId);

      expect(special.group.id).not.toBe(first.group.id);
      expect(after.group.id).not.toBe(special.group.id);
    },
  );

  it("exposes only the four generic history kinds", () => {
    const kinds: SourceHistoryKind[] = ["typing", "delete", "composition", "atomic"];
    expect(kinds).toHaveLength(4);
  });
});

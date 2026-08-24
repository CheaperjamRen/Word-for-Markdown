// @vitest-environment node
import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { applySourceTextEditsToView } from "../markdown/source-view";
import { composePendingChanges, sourceTextEditsFromChangeSet } from "./source-change-set";

describe("Source ChangeSet composition", () => {
  it("composes A to B to C and exports ordered original-base edits", () => {
    const a = "alpha";
    const first = ChangeSet.of({ from: 0, to: 1, insert: "A" }, a.length);
    const b = first.apply(Text.of([a])).toString();
    let pending = ChangeSet.empty(a.length);
    pending = composePendingChanges(pending, first);
    const afterFirst = pending.apply(Text.of([a]));
    expect(afterFirst.toString()).toBe("Alpha");
    const second = ChangeSet.of({ from: 5, insert: "!" }, 5);
    pending = composePendingChanges(pending, second);
    const edits = sourceTextEditsFromChangeSet(pending);

    expect(edits).toEqual([
      { from: 0, to: 1, insert: "A" },
      { from: 5, to: 5, insert: "!" },
    ]);
    expect(applySourceTextEditsToView(a, edits)).toBe("Alpha!");
    expect(b).toBe("Alpha");
  });

  it("retains exact surrogate code units across invalid two-sided edits and empty repair", () => {
    const a = "AB";
    let pending = ChangeSet.empty(a.length);
    pending = composePendingChanges(pending, ChangeSet.of({ from: 1, insert: "\ud800" }, 2));
    pending = composePendingChanges(pending, ChangeSet.of([
      { from: 0, insert: "X" },
      { from: 3, insert: "Y" },
    ], 3));
    const edits = sourceTextEditsFromChangeSet(pending);
    const projected = applySourceTextEditsToView(a, edits);

    expect(projected).toBe("XA\ud800BY");
    expect(projected.charCodeAt(2)).toBe(0xd800);
    expect(sourceTextEditsFromChangeSet(ChangeSet.empty(a.length))).toEqual([]);
    expect(() => composePendingChanges(pending, ChangeSet.empty(999))).toThrow();

    const repaired = composePendingChanges(pending, ChangeSet.of([
      { from: 0, to: 1, insert: "" },
      { from: 2, to: 3, insert: "" },
      { from: 4, to: 5, insert: "" },
    ], projected.length));
    const repairEdits = sourceTextEditsFromChangeSet(repaired);
    expect(repairEdits).toEqual([]);
    expect(applySourceTextEditsToView(a, repairEdits)).toBe(a);
  });
});

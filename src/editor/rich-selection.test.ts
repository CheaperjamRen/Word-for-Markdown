import { describe, expect, it } from "vitest";
import { normalizeRichSelectionBookmark } from "./rich-selection";

describe("rich selection bookmark", () => {
  it("clamps offsets and biases an astral split to the preceding code point", () => {
    expect(normalizeRichSelectionBookmark({
      blockViewKey: "stable",
      anchorTextOffset: 2,
      focusTextOffset: 99,
    }, "A😀B")).toMatchObject({ anchorTextOffset: 1, focusTextOffset: 4 });
  });
});

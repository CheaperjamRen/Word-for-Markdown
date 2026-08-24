import { describe, expect, it } from "vitest";
import { clampDocumentZoom, stepDocumentZoom } from "./zoom";

describe("document zoom", () => {
  it("moves in ten-point steps and clamps to the document limits", () => {
    expect(stepDocumentZoom(100, 1)).toBe(110);
    expect(stepDocumentZoom(100, -1)).toBe(90);
    expect(clampDocumentZoom(42)).toBe(50);
    expect(clampDocumentZoom(318)).toBe(300);
  });
});

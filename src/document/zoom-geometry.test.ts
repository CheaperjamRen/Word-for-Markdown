import { describe, expect, it } from "vitest";

import {
  anchoredScrollPosition,
  documentBaseWidth,
  fitWidthZoom,
} from "./zoom-geometry";

describe("document zoom geometry", () => {
  it("uses fixed paper widths and a clamped Canvas base width", () => {
    expect(documentBaseWidth("a4", 400)).toBe(794);
    expect(documentBaseWidth("a3", 400)).toBe(1120);
    expect(documentBaseWidth("canvas", 400)).toBe(640);
    expect(documentBaseWidth("canvas", 900)).toBe(844);
    expect(documentBaseWidth("canvas", 1600)).toBe(1120);
  });

  it("fits the base width with a reserved margin and document zoom limits", () => {
    expect(fitWidthZoom(834, 794)).toBe(100);
    expect(fitWidthZoom(1200, 794)).toBe(146);
    expect(fitWidthZoom(300, 794)).toBe(50);
    expect(fitWidthZoom(5000, 794)).toBe(300);
    expect(fitWidthZoom(Number.NaN, 794)).toBe(100);
    expect(fitWidthZoom(900, 0)).toBe(100);
  });

  it("keeps the same viewport point anchored while zooming in and back out", () => {
    expect(anchoredScrollPosition(
      1,
      1.5,
      { left: 200, top: 400 },
      { x: 300, y: 200 },
    )).toEqual({ left: 450, top: 700 });
    expect(anchoredScrollPosition(
      1.5,
      1,
      { left: 450, top: 700 },
      { x: 300, y: 200 },
    )).toEqual({ left: 200, top: 400 });
  });

  it("sanitizes non-finite geometry and never produces negative scroll", () => {
    expect(anchoredScrollPosition(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { left: Number.NaN, top: -20 },
      { x: Number.POSITIVE_INFINITY, y: 20 },
    )).toEqual({ left: 0, top: 0 });
    expect(anchoredScrollPosition(
      1,
      0.5,
      { left: 0, top: 0 },
      { x: 100, y: 100 },
    )).toEqual({ left: 0, top: 0 });
  });
});

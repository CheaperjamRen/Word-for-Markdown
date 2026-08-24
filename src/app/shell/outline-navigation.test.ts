import { describe, expect, it } from "vitest";

import type { OutlineItem } from "../../markdown/outline";
import {
  activeOutlineId,
  parentOutlineId,
  visibleOutlineIds,
} from "./outline-navigation";

const items: OutlineItem[] = [
  { id: "intro", text: "Intro", level: 1, sourceLine: 0, sourceOffset: 0 },
  { id: "goal", text: "Goal", level: 2, sourceLine: 2, sourceOffset: 9 },
  { id: "detail", text: "Detail", level: 3, sourceLine: 4, sourceOffset: 18 },
  { id: "next", text: "Next", level: 2, sourceLine: 6, sourceOffset: 29 },
  { id: "appendix", text: "Appendix", level: 1, sourceLine: 8, sourceOffset: 39 },
];

describe("outline navigation", () => {
  it("finds the active heading with a 500-heading binary search", () => {
    const positions = Array.from({ length: 500 }, (_, index) => ({ id: `h-${index}`, top: index * 120 }));
    expect(activeOutlineId(positions, -1)).toBeNull();
    expect(activeOutlineId(positions, 0)).toBe("h-0");
    expect(activeOutlineId(positions, 59_879)).toBe("h-498");
    expect(activeOutlineId(positions, 59_880)).toBe("h-499");
  });

  it("finds the nearest parent across H1, H2, and H3 levels", () => {
    expect(parentOutlineId(items, "detail")).toBe("goal");
    expect(parentOutlineId(items, "next")).toBe("intro");
    expect(parentOutlineId(items, "appendix")).toBeNull();
  });

  it("hides descendants of collapsed headings without losing later siblings", () => {
    expect(visibleOutlineIds(items, new Set(["goal"]))).toEqual(["intro", "goal", "next", "appendix"]);
    expect(visibleOutlineIds(items, new Set(["intro"]))).toEqual(["intro", "appendix"]);
    expect(visibleOutlineIds(items, new Set())).toEqual(items.map((item) => item.id));
  });
});

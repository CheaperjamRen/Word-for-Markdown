import type { OutlineItem } from "../../markdown/outline";

export interface OutlinePosition {
  id: string;
  top: number;
}

export function activeOutlineId(
  positions: readonly OutlinePosition[],
  scrollTop: number,
): string | null {
  let low = 0;
  let high = positions.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (positions[middle]!.top <= scrollTop) {
      active = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return active < 0 ? null : positions[active]!.id;
}

export function parentOutlineId(
  items: readonly OutlineItem[],
  id: string,
): string | null {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const level = items[index]!.level;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    if (items[candidate]!.level < level) return items[candidate]!.id;
  }
  return null;
}

export function visibleOutlineIds(
  items: readonly OutlineItem[],
  collapsed: ReadonlySet<string>,
): string[] {
  const visible: string[] = [];
  let hiddenBelowLevel: number | null = null;
  for (const item of items) {
    if (hiddenBelowLevel !== null && item.level > hiddenBelowLevel) continue;
    hiddenBelowLevel = null;
    visible.push(item.id);
    if (collapsed.has(item.id)) hiddenBelowLevel = item.level;
  }
  return visible;
}

import type { DocumentLayout } from "./layout";
import { clampDocumentZoom } from "./zoom";

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface ScrollPosition {
  left: number;
  top: number;
}

const A4_BASE_WIDTH = 794;
const A3_BASE_WIDTH = 1120;
const CANVAS_MIN_BASE_WIDTH = 640;
const CANVAS_MAX_BASE_WIDTH = 1120;
const CANVAS_GUTTER = 56;
const DEFAULT_FIT_MARGIN = 40;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function documentBaseWidth(layout: DocumentLayout, viewportWidth: number): number {
  if (layout === "a4") return A4_BASE_WIDTH;
  if (layout === "a3") return A3_BASE_WIDTH;
  const available = finiteOr(viewportWidth, CANVAS_MIN_BASE_WIDTH + CANVAS_GUTTER) - CANVAS_GUTTER;
  return Math.round(Math.min(CANVAS_MAX_BASE_WIDTH, Math.max(CANVAS_MIN_BASE_WIDTH, available)));
}

export function fitWidthZoom(
  viewportWidth: number,
  baseWidth: number,
  margin = DEFAULT_FIT_MARGIN,
): number {
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(baseWidth) || baseWidth <= 0) return 100;
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : DEFAULT_FIT_MARGIN;
  return clampDocumentZoom(((viewportWidth - safeMargin) / baseWidth) * 100);
}

export function anchoredScrollPosition(
  previousZoom: number,
  nextZoom: number,
  scroll: ScrollPosition,
  anchor: ViewportPoint,
): ScrollPosition {
  const previous = Number.isFinite(previousZoom) && previousZoom > 0 ? previousZoom : 1;
  const next = Number.isFinite(nextZoom) && nextZoom > 0 ? nextZoom : 1;
  const ratio = next / previous;
  const axis = (offset: number, point: number) => Math.max(0, Math.round(
    (finiteOr(offset, 0) + finiteOr(point, 0)) * ratio - finiteOr(point, 0),
  ));
  return {
    left: axis(scroll.left, anchor.x),
    top: axis(scroll.top, anchor.y),
  };
}

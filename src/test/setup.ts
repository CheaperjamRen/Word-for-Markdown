import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";

Object.defineProperty(navigator, "language", {
  configurable: true,
  value: "zh-CN",
});

beforeEach(() => { if (typeof localStorage !== "undefined") localStorage.clear(); });
afterEach(() => { if (typeof localStorage !== "undefined") localStorage.clear(); });

if (typeof Range !== "undefined") {
  const zeroRect = () => new DOMRect(0, 0, 0, 0);
  if (typeof Range.prototype.getClientRects !== "function") {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: zeroRect,
    });
  }
}

if (
  typeof document !== "undefined" &&
  typeof HTMLInputElement !== "undefined" &&
  typeof HTMLInputElement.prototype.select === "function"
) {
  const nativeSelect = HTMLInputElement.prototype.select;
  const probe = document.createElement("input");
  document.body.append(probe);
  nativeSelect.call(probe);
  const selectFocuses = document.activeElement === probe;
  probe.remove();
  if (!selectFocuses) {
    Object.defineProperty(HTMLInputElement.prototype, "select", {
      configurable: true,
      value(this: HTMLInputElement) {
        this.focus();
        nativeSelect.call(this);
      },
    });
  }
}

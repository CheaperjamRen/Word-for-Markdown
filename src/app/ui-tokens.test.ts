// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("confirmed UI density contract", () => {
  it.each([
    ["--ui-font-size", "12px"],
    ["--ui-caption-size", "11px"],
    ["--document-font-size", "16px"],
    ["--document-line-height", "28px"],
    ["--toolbar-icon-size", "20px"],
    ["--menu-icon-size", "16px"],
    ["--icon-button-size", "32px"],
  ])("keeps %s at %s", (token, value) => {
    const css = readFileSync(new URL("./ui-tokens.css", import.meta.url), "utf8");
    expect(css).toMatch(new RegExp(`${token}:\\s*${value.replace(".", "\\.")}`));
  });

  it.each([
    ["rest", ".toolbar-button"],
    ["hover", ":hover"],
    ["pressed", ":active"],
    ["selected", ".document-tab--active"],
    ["focus-visible", ":focus-visible"],
    ["disabled", ":disabled"],
    ["busy", '.statusbar[aria-busy="true"]'],
    ["error", ".statusbar__error"],
  ])("defines the %s interaction selector", (_state, selector) => {
    expect(readFileSync(new URL("./app.css", import.meta.url), "utf8")).toContain(
      selector,
    );
  });
});

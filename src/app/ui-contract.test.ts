import { afterEach, describe, expect, it } from "vitest";
import * as uiContract from "./ui-contract";
import { collectComputedReadingUiContract, collectComputedUiContract } from "./ui-contract";

function mountVisibleContractElements(): void {
  document.body.innerHTML = `
    <span data-ui-contract="ui-label" style="font-size: 12px">Markdown 文档</span>
    <span data-ui-contract="status" style="font-size: 11px">已打开</span>
    <article data-ui-contract="document" style="font-size: 16px; line-height: 28px">正文</article>
    <svg data-ui-contract="toolbar-icon" style="display: block; width: 20px"></svg>
    <button data-ui-contract="icon-button" style="display: block; height: 32px">保存</button>
  `;
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--toolbar-icon-size");
  document.documentElement.style.removeProperty("--icon-button-size");
});

describe("runtime UI contract collector", () => {
  it("measures the rendered desktop shell rows and both icon dimensions", () => {
    document.body.innerHTML = `
      <div data-shell-contract="tabbar" style="height: 36px"></div>
      <div data-shell-contract="menubar" style="height: 28px"></div>
      <div data-shell-contract="toolbar" style="height: 44px"></div>
      <div data-shell-contract="statusbar" style="height: 28px"></div>
      <span data-ui-contract="ui-label" style="font-size: 12px"></span>
      <span data-ui-contract="status" style="font-size: 11px"></span>
      <article data-ui-contract="document" style="font-size: 16px; line-height: 28px"></article>
      <svg data-ui-contract="toolbar-icon" style="display:block; width:20px; height:20px"></svg>
      <button data-ui-contract="icon-button" style="display:block; width:32px; height:32px"></button>
    `;
    const collector = (uiContract as unknown as {
      collectComputedShellContract?: (root: ParentNode) => Record<string, string>;
    }).collectComputedShellContract;

    expect(collector).toBeTypeOf("function");
    expect(collector!(document)).toEqual({
      tabbarHeight: "36px", menubarHeight: "28px", toolbarHeight: "44px", statusbarHeight: "28px",
      uiFontSize: "12px", statusFontSize: "11px", documentFontSize: "16px", documentLineHeight: "28px",
      toolbarIconWidth: "20px", toolbarIconHeight: "20px", iconButtonWidth: "32px", iconButtonHeight: "32px",
    });
  });

  it("reads all six values from visible computed styles", () => {
    mountVisibleContractElements();

    expect(collectComputedUiContract(document)).toEqual({
      uiFontSize: "12px",
      statusFontSize: "11px",
      documentFontSize: "16px",
      documentLineHeight: "28px",
      toolbarIconWidth: "20px",
      iconButtonHeight: "32px",
    });
  });

  it("uses shell tokens for toolbar geometry when Reading intentionally hides editing tools", () => {
    document.documentElement.style.setProperty("--toolbar-icon-size", "20px");
    document.documentElement.style.setProperty("--icon-button-size", "32px");
    document.body.innerHTML = `
      <span data-ui-contract="ui-label" style="font-size: 12px">Markdown 文档</span>
      <span data-ui-contract="status" style="font-size: 11px">已打开</span>
      <article data-ui-contract="document" style="font-size: 17px; line-height: 29px">正文</article>
    `;

    expect(collectComputedReadingUiContract(document)).toEqual({
      uiFontSize: "12px",
      statusFontSize: "11px",
      documentFontSize: "17px",
      documentLineHeight: "29px",
      toolbarIconWidth: "20px",
      iconButtonHeight: "32px",
    });
  });

  it.each([
    [
      "missing",
      "status",
      () => document.querySelector('[data-ui-contract="status"]')?.remove(),
    ],
    [
      "display none",
      "document",
      () => {
        const element = document.querySelector<HTMLElement>(
          '[data-ui-contract="document"]',
        );
        if (element) element.style.display = "none";
      },
    ],
    [
      "visibility hidden",
      "toolbar-icon",
      () => {
        const element = document.querySelector<HTMLElement>(
          '[data-ui-contract="toolbar-icon"]',
        );
        if (element) element.style.visibility = "hidden";
      },
    ],
  ])("rejects a %s runtime marker", (_caseName, role, hide) => {
    mountVisibleContractElements();
    hide();

    expect(() => collectComputedUiContract(document)).toThrow(
      `ui contract element ${role} is missing or hidden`,
    );
  });
});

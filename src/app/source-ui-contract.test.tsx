import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceViewModel } from "../contracts/markdown";
import { SourceEditor } from "../source/SourceEditor";
import { collectComputedSourceContract, collectComputedSourceStateColor } from "./source-ui-contract";
import "./ui-tokens.css";

function view(text: string): SourceViewModel {
  return { text, byteOffsetAtViewOffset: Uint32Array.from({ length: text.length + 1 }, (_, index) => index) };
}

function contrastRatio(foreground: string, background: string): number {
  const channels = (value: string) => (value.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number);
  const luminance = (value: string) => {
    const [red, green, blue] = channels(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const left = luminance(foreground);
  const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

afterEach(cleanup);

describe("computed Source UI contract", () => {
  it("rejects fabricated cm-like fixtures", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="source-editor"><div class="cm-editor"><div class="cm-content"></div></div></div>';
    expect(() => collectComputedSourceContract(root)).toThrow("real mounted Source editor");
  });

  it("reads direct typography, focus, gutter, scroller, and muted token values from a real editor", async () => {
    const rendered = render(<div data-reading-theme="soft-white"><SourceEditor
      sessionId="one"
      candidateRevision={0}
      view={view("# Heading\n\n*emphasis* **strong** `code` [link](https://example.com) ~~old~~\n\n<!-- comment -->\n\n()\n\n[invalid](")}
      buffer={null}
      readOnly={false}
      zoomPercent={100}
      initialSelection={null}
      initialViewportOffset={null}
      onChangeBatch={() => ({ kind: "stale" })}
      onSelectionChange={vi.fn()}
      onViewportOffsetChange={vi.fn()}
      onUndo={() => false}
      onRedo={() => false}
      onSave={vi.fn()}
      registerBridge={() => () => undefined}
    /></div>);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    expect(EditorView.findFromDOM(content)).not.toBeNull();
    const editor = EditorView.findFromDOM(content)!;
    expect(getComputedStyle(editor.dom).outline).toMatch(/^0(?:px)?\b/);
    const bracket = editor.state.doc.toString().indexOf("(", editor.state.doc.toString().indexOf("<!--"));
    editor.dispatch({ selection: { anchor: bracket + 1 } });
    editor.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "f",
    }));
    const find = await screen.findByRole("textbox", { name: "查找" });
    fireEvent.change(find, { target: { value: "Heading" } });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "查找" })).toHaveValue("Heading"));
    editor.dispatch({ selection: { anchor: 0, head: bracket + 1 } });
    editor.focus();
    await waitFor(() => expect(rendered.container.querySelector(".cm-searchMatch")).not.toBeNull());
    await waitFor(() => expect(rendered.container.querySelector(".cm-selectionBackground")).not.toBeNull());
    await waitFor(() => {
      const renderedText = [...content.querySelectorAll("span")].map((element) => element.textContent).join(" ");
      for (const marker of ["Heading", "emphasis", "strong", "code", "link", "old", "comment"]) {
        expect(renderedText).toContain(marker);
      }
    });
    const contract = collectComputedSourceContract(rendered.container);
    const selectionBackgroundColor = collectComputedSourceStateColor(rendered.container, "selection");
    const searchMatchBackgroundColor = collectComputedSourceStateColor(rendered.container, "search-match");
    editor.dispatch({ selection: { anchor: bracket + 1 } });
    await waitFor(() => expect(rendered.container.querySelector(".cm-matchingBracket")).not.toBeNull());
    const matchingBracketBackgroundColor = collectComputedSourceStateColor(rendered.container, "matching-bracket");

    expect(contract.fontSize).toBe("14px");
    expect(contract.lineHeight).toBe("22px");
    expect(contract.searchFontSize).toBe("12px");
    expect(contract.searchLineHeight).toBe("16px");
    expect(contract.scrollerCount).toBe(1);
    expect(contract.sourceBackgroundColor).toBe("rgb(251, 252, 252)");
    expect(contract.gutterBackgroundColor).toBe("rgb(245, 247, 248)");
    expect(contract.gutterBorderRightWidth).toBe("1px");
    expect(contract.focusOutlineWidth).toBe("2px");
    expect(new Set(contract.tokenColors)).toEqual(new Set([
      "rgb(49, 95, 140)", "rgb(100, 116, 133)", "rgb(51, 65, 78)",
      "rgb(71, 107, 112)", "rgb(98, 107, 115)", "rgb(107, 117, 126)",
    ]));
    expect(contract.tokenColorBySemantic).toEqual({
      heading: "rgb(49, 95, 140)",
      emphasis: "rgb(100, 116, 133)",
      strong: "rgb(51, 65, 78)",
      monospace: "rgb(71, 107, 112)",
      link: "rgb(49, 95, 140)",
      strikethrough: "rgb(98, 107, 115)",
      comment: "rgb(107, 117, 126)",
    });
    const extended = contract as typeof contract & {
      gutterTextColor?: string;
      activeGutterTextColor?: string;
    };
    expect(extended.gutterTextColor).toEqual(expect.any(String));
    expect(extended.activeGutterTextColor).toEqual(expect.any(String));
    for (const [foreground, background] of [
      [contract.tokenColorBySemantic.strikethrough, contract.sourceBackgroundColor],
      [contract.tokenColorBySemantic.comment, contract.sourceBackgroundColor],
      [extended.gutterTextColor!, contract.gutterBackgroundColor],
      [extended.activeGutterTextColor!, contract.activeGutterBackgroundColor],
    ]) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(new Set([
      selectionBackgroundColor,
      searchMatchBackgroundColor,
      matchingBracketBackgroundColor,
    ]).size).toBe(3);
    for (const color of [
      selectionBackgroundColor,
      searchMatchBackgroundColor,
      matchingBracketBackgroundColor,
    ]) expect(color).toMatch(/^rgb\((?:2[0-5][0-9]|1[5-9][0-9])/);
  });

  it("keeps every mounted Find control at 12/16 with usable CSS targets and compact checkboxes", async () => {
    const rendered = render(<div><SourceEditor
      sessionId="search"
      candidateRevision={0}
      view={view("# Heading\n\nHeading again")}
      buffer={null}
      readOnly={false}
      zoomPercent={100}
      initialSelection={null}
      initialViewportOffset={null}
      onChangeBatch={() => ({ kind: "stale" })}
      onSelectionChange={vi.fn()}
      onViewportOffsetChange={vi.fn()}
      onUndo={() => false}
      onRedo={() => false}
      onSave={vi.fn()}
      registerBridge={() => () => undefined}
    /></div>);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    content.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, ctrlKey: true, key: "f",
    }));
    await screen.findByRole("textbox", { name: "查找" });
    const panel = rendered.container.querySelector<HTMLElement>(".cm-panel.cm-search")!;
    const labels = [...panel.querySelectorAll<HTMLElement>("label")];
    const textFields = [...panel.querySelectorAll<HTMLInputElement>("input.cm-textfield")];
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>("button")];
    const checkboxes = [...panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

    expect(labels).toHaveLength(3);
    expect(textFields).toHaveLength(2);
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    expect(checkboxes).toHaveLength(3);
    expect(getComputedStyle(panel)).toMatchObject({
      maxWidth: "100%",
      overflowX: "auto",
      overflowY: "hidden",
    });
    for (const element of [...labels, ...textFields, ...buttons]) {
      expect(getComputedStyle(element).fontSize).toBe("12px");
      expect(getComputedStyle(element).lineHeight).toBe("16px");
    }
    for (const element of [...textFields, ...buttons, ...labels]) {
      expect(Number.parseFloat(getComputedStyle(element).minHeight)).toBeGreaterThanOrEqual(28);
    }
    for (const checkbox of checkboxes) {
      expect(Number.parseFloat(getComputedStyle(checkbox).minWidth)).toBeLessThanOrEqual(16);
      expect(Number.parseFloat(getComputedStyle(checkbox).minHeight)).toBeLessThanOrEqual(16);
    }
    expect(Number.parseFloat(getComputedStyle(panel.querySelector<HTMLButtonElement>('button[name="close"]')!).minWidth))
      .toBeGreaterThanOrEqual(28);
  });

  it("maps forced-colors tokens to selected/disabled modes, focus targets, and Source caret semantics", () => {
    const css = readFileSync(resolve(process.cwd(), "src/source/source-editor.css"), "utf8");
    const appCss = readFileSync(resolve(process.cwd(), "src/app/app.css"), "utf8");
    const source = readFileSync(resolve(process.cwd(), "src/source/SourceEditor.tsx"), "utf8");
    expect(source).toMatch(/tag:\s*tags\.invalid,\s*color:\s*"var\(--source-invalid\)"/);
    const forced = css.match(/@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*)\}\s*$/i)?.[1] ?? "";
    expect(forced).toContain(".source-editor");
    for (const token of ["Canvas", "CanvasText", "Highlight", "HighlightText", "GrayText"]) {
      expect(forced).toContain(token);
    }
    const appForced = appCss.match(/@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*)\}\s*$/i)?.[1] ?? "";
    expect(appForced).toMatch(/button\[aria-pressed="true"\]\s*\{[^}]*color:\s*HighlightText;[^}]*background:\s*Highlight;[^}]*border-color:\s*Highlight;/s);
    expect(appForced).toMatch(/button:disabled\s*\{[^}]*color:\s*GrayText;[^}]*border-color:\s*GrayText;/s);
    expect(appForced).toMatch(/button:focus-visible\s*\{[^}]*outline-color:\s*Highlight;/s);
    expect(forced).toMatch(/\.source-editor \.cm-content\s*\{[^}]*caret-color:\s*CanvasText;/s);
    expect(forced).toMatch(/\.source-editor \.cm-editor\.cm-focused\s*\{[^}]*outline-color:\s*Highlight;/s);
    expect(forced).toMatch(/\.cm-panel\.cm-search (?:input|button):focus-visible[^{]*\{[^}]*outline-color:\s*Highlight;/s);
    expect(css).not.toMatch(/(?:^|,)\s*(?:\*|html|body)[^{]*\{[^}]*forced-color-adjust\s*:\s*none/is);
    expect(appCss).not.toMatch(/forced-color-adjust\s*:\s*none/i);
  });
});

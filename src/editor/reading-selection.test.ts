import { expect, it } from "vitest";

import { captureReadingSelection } from "./reading-selection";

it("captures one block visible selection with mixed semantic formatting and direction", () => {
  const root = document.createElement("section");
  root.innerHTML = '<p data-block-view-key="stable">same <strong>same</strong> <del>删😀</del></p>';
  document.body.append(root);
  const paragraph = root.querySelector("p")!;
  const plain = paragraph.firstChild!;
  const bold = paragraph.querySelector("strong")!.firstChild!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.setStart(plain, 0);
  range.setEnd(bold, bold.textContent!.length);
  selection.removeAllRanges();
  selection.addRange(range);

  const captured = captureReadingSelection(root, selection, "one", 3);
  expect(captured).toMatchObject({
    sessionId: "one",
    candidateRevision: 3,
    blockViewKey: "stable",
    anchorTextOffset: 0,
    focusTextOffset: 9,
    state: { formats: { bold: "mixed" } },
  });
  root.remove();
});

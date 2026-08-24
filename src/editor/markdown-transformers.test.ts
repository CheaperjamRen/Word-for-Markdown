// @vitest-environment node
import { expect, it } from "vitest";

import { normalizeGfmDeletionForLexical } from "./markdown-transformers";

it("normalizes only parser-approved single-tilde deletion markers for Lexical hydration", () => {
  expect(normalizeGfmDeletionForLexical("before ~one~ after")).toBe("before ~~one~~ after");
  expect(normalizeGfmDeletionForLexical("before ~~two~~ after")).toBe("before ~~two~~ after");
  expect(normalizeGfmDeletionForLexical("before ~a **b** c~ after")).toBe(
    "before ~~a **b** c~~ after",
  );
  expect(normalizeGfmDeletionForLexical("before ~ one ~ after")).toBe("before ~ one ~ after");
  expect(normalizeGfmDeletionForLexical("before ~~~three~~~ after")).toBe(
    "before ~~~three~~~ after",
  );
});

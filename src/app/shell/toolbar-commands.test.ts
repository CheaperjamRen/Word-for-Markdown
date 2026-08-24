// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  TOOLBAR_ACTION_IDS,
  TOOLBAR_ITEMS,
  createToolbarLayout,
} from "./toolbar-commands";

describe("canonical toolbar command registry", () => {
  it("keeps wide and compact placement disjoint without duplicating command ids", () => {
    const wide = createToolbarLayout(false);
    const compact = createToolbarLayout(true);
    const ids = (layout: ReturnType<typeof createToolbarLayout>) => [
      ...layout.primary.map((item) => item.id),
      ...layout.overflowGroups.flatMap((group) => group.commands.map((command) => command.id)),
    ].filter((id) => id !== "history-spacer" && id !== "more");

    expect(new Set(ids(wide))).toEqual(new Set(TOOLBAR_ACTION_IDS));
    expect(new Set(ids(compact))).toEqual(new Set(TOOLBAR_ACTION_IDS));
    expect(new Set(ids(wide)).size).toBe(TOOLBAR_ACTION_IDS.length);
    expect(new Set(ids(compact)).size).toBe(TOOLBAR_ACTION_IDS.length);
    expect(wide.primary.map((item) => item.id)).toEqual([
      "save", "block-style", "bold", "italic", "strike", "inline-code", "link",
      "bullet-list", "number-list", "task-list", "quote", "code-block", "table",
      "image", "formula", "history-spacer", "undo", "redo", "more",
    ]);
    expect(compact.primary.map((item) => item.id)).toEqual([
      "save", "block-style", "bold", "italic", "link", "bullet-list", "number-list",
      "task-list", "quote", "table", "history-spacer", "undo", "redo", "more",
    ]);
  });

  it("keeps toggle versus momentary semantics in the one layout registry", () => {
    const behaviorById = new Map(
      TOOLBAR_ITEMS.flatMap((item) =>
        item.kind === "command" ? [[item.id, item.behavior] as const] : [],
      ),
    );

    expect([...behaviorById.entries()].filter(([, behavior]) => behavior === "toggle").map(([id]) => id))
      .toEqual([
        "bold", "italic", "strike", "inline-code", "bullet-list", "number-list",
        "task-list", "quote", "code-block",
      ]);
    expect([...behaviorById.entries()].filter(([, behavior]) => behavior === "momentary").map(([id]) => id))
      .toEqual(["link", "table", "image", "formula", "horizontal-rule", "mermaid", "undo", "redo"]);
  });
});

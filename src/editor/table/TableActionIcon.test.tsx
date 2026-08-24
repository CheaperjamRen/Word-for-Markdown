import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TableActionIcon, type TableAction } from "./TableActionIcon";

describe("TableActionIcon", () => {
  it("keeps one centered 24px grid while encoding axis and operation separately", () => {
    const actions: TableAction[] = ["insert-row", "delete-row", "insert-column", "delete-column"];
    const { container } = render(<div>{actions.map((action) => <TableActionIcon action={action} key={action} />)}</div>);
    const icons = [...container.querySelectorAll("svg")];
    expect(icons).toHaveLength(4);
    for (const [index, icon] of icons.entries()) {
      expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
      expect(icon).toHaveAttribute("data-axis", index < 2 ? "row" : "column");
      expect(icon).toHaveAttribute("data-operation", index % 2 === 0 ? "insert" : "delete");
      const mark = icon.querySelector("[data-action-mark]");
      expect(mark).not.toBeNull();
      expect(mark).toHaveAttribute("data-mark-shape", index % 2 === 0 ? "arrow" : "minus");
    }
  });
});

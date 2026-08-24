import { describe, expect, it } from "vitest";
import { parseGfmTable, replaceTableCellContents, serializeTableMatrix, tableMatrix, toggleCellFormat } from "./gfm-table";

describe("GFM table adapter", () => {
  it("parses escaped pipes and code-span pipes without splitting them", () => {
    const model = parseGfmTable("| Name | Value |\n| --- | ---: |\n| a\\|b | `x|y` |\n")!;
    expect(tableMatrix(model)).toEqual([["Name", "Value"], ["a\\|b", "`x|y`"]]);
    expect(model.delimiter[1]?.raw).toBe("---:");
  });

  it("splices changed cell content while preserving delimiters and newline policy", () => {
    const raw = "| A | B |\r\n| --- | --- |\r\n| old | keep |";
    const model = parseGfmTable(raw)!;
    expect(replaceTableCellContents(model, [["A", "B"], ["new", "keep"]])).toBe(
      "| A | B |\r\n| --- | --- |\r\n| new | keep |",
    );
  });

  it("serializes structural changes and applies explicit batch format targets", () => {
    const model = parseGfmTable("| A | B |\n| --- | --- |\n| one | two |")!;
    const expanded = serializeTableMatrix(model, [["A", "B", "C"], ["one", "two", "three"]]);
    expect(expanded).toContain("| A | B | C |");
    expect(expanded).toContain("three");
    expect(toggleCellFormat("one", "bold", "on")).toBe("**one**");
    expect(toggleCellFormat("**one**", "bold", "off")).toBe("one");
  });

  it("keeps a table's pipe style and trailing newline during structural edits", () => {
    const model = parseGfmTable("A | B\n--- | ---\none | two\n")!;
    const expanded = serializeTableMatrix(model, [["A", "B", "C"], ["one", "two", "three"]]);
    expect(expanded).toBe("A | B | C\n--- | --- | ---\none | two | three\n");
  });

  it("fails closed for mixed line endings instead of risking a wrong cell splice", () => {
    expect(parseGfmTable("| A | B |\r\n| --- | --- |\n| one | two |")).toBeNull();
  });
});

// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { fileNameForDisplay, formatPathForDisplay } from "./path-display";

describe("user-facing Windows paths", () => {
  it.each([
    ["\\\\?\\C:\\docs\\a.md", "C:\\docs\\a.md"],
    ["\\\\?\\UNC\\server\\share\\a.md", "\\\\server\\share\\a.md"],
    ["C:\\docs\\a.md", "C:\\docs\\a.md"],
    ["\\\\server\\share\\a.md", "\\\\server\\share\\a.md"],
  ])("formats %s without changing the user-readable path", (canonical, displayed) => {
    expect(formatPathForDisplay(canonical)).toBe(displayed);
    expect(fileNameForDisplay(canonical)).toBe("a.md");
  });

  it("fails an unknown device namespace closed to a safe basename", () => {
    expect(formatPathForDisplay("\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\secret.md"))
      .toBe("secret.md");
    expect(formatPathForDisplay("\\\\.\\GLOBALROOT\\Device\\HarddiskVolume1\\device.md"))
      .toBe("device.md");
    expect(formatPathForDisplay("\\??\\C:\\hidden\\kernel.md"))
      .toBe("kernel.md");
  });

  it("keeps one filename presentation owner for controller titles, receipts, and Save As suggestions", () => {
    const controllerSource = readFileSync(resolve(process.cwd(), "src/app/use-document-controller.ts"), "utf8");
    expect(controllerSource).not.toMatch(/function\s+fileName\s*\(/);
    expect(controllerSource.match(/fileNameForDisplay\s*\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { after, test } from "node:test";

import { createSourceEditorQaFixtures } from "./create-source-editor-qa-fixtures.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "markdown-source-qa-"));

after(() => {
  const resolvedRoot = resolve(temporaryRoot);
  const resolvedTemporaryDirectory = `${resolve(tmpdir())}${sep}`;
  assert.ok(resolvedRoot.startsWith(resolvedTemporaryDirectory));
  rmSync(resolvedRoot, { recursive: true, force: true });
});

test("creates deterministic representative and extreme Source QA fixtures", () => {
  const output = join(temporaryRoot, "fixtures");
  const files = createSourceEditorQaFixtures(output);

  assert.equal(statSync(files.representative100Kb).size, 102_400);
  assert.equal(statSync(files.representative1Mb).size, 1_048_576);
  assert.equal(statSync(files.singleLine100Kb).size, 102_400);

  const representative = readFileSync(files.representative100Kb, "utf8");
  for (const marker of [
    "# Source editor QA",
    "中文段落",
    "🧭",
    "- list item",
    "| Capability | Status |",
    "[local Markdown link](./linked-document.md)",
    "```typescript",
    "$$",
  ]) {
    assert.ok(representative.includes(marker), `missing representative marker: ${marker}`);
  }

  const singleLine = readFileSync(files.singleLine100Kb, "utf8");
  assert.equal(singleLine.includes("\n"), false);
  assert.equal(singleLine.includes("\r"), false);
});

test("refuses to overwrite an existing output directory", () => {
  const output = join(temporaryRoot, "existing");
  createSourceEditorQaFixtures(output);
  assert.equal(existsSync(output), true);
  assert.throws(() => createSourceEditorQaFixtures(output), /already exists/i);
});

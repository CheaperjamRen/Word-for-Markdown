import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

function icoSizes(relativePath) {
  const bytes = readFileSync(resolve(root, relativePath));
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    return [bytes[offset] || 256, bytes[offset + 1] || 256];
  }).sort((left, right) => left[0] - right[0]);
}

test("icon commands are part of the local verification contract", () => {
  assert.equal(packageJson.scripts["icons:generate"], "node scripts/generate-icons.mjs");
  assert.equal(packageJson.scripts["icons:contact-sheet"], "node scripts/write-icon-contact-sheet.mjs");
  assert.equal(packageJson.scripts["icons:test"], "node --test scripts/icon-assets.node-test.mjs");
  assert.match(packageJson.scripts.verify, /npm run icons:test/);
});

test("application and Markdown file ICOs contain the required Windows sizes", () => {
  const expected = [[16, 16], [24, 24], [32, 32], [48, 48], [64, 64], [256, 256]];
  assert.deepEqual(icoSizes("src-tauri/icons/icon.ico"), expected);
  assert.deepEqual(icoSizes("src-tauri/icons/markdown-file.ico"), expected);
});

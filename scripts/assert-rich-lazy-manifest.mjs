import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceLazyManifest } from "./assert-source-lazy-manifest.mjs";

export function assertRichLazyManifest(manifest) {
  return assertSourceLazyManifest(manifest);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: node scripts/assert-rich-lazy-manifest.mjs <manifest.json>");
  assertRichLazyManifest(JSON.parse(readFileSync(path, "utf8")));
  process.stdout.write("rich lazy manifest passed\n");
}

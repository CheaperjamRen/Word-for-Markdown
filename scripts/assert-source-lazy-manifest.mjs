import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_DYNAMIC_SOURCES = [
  "src/source/SourceEditor.tsx",
  "src/markdown/source-document.ts",
  "src/markdown/render/MarkdownView.tsx",
  "src/editor/RichDocumentSurface.tsx",
];

function normalizedSource(value) {
  return typeof value === "string"
    ? value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "")
    : null;
}

function fail(message) {
  throw new Error(`invalid Source lazy manifest: ${message}`);
}

export function assertSourceLazyManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("root must be an object");
  }
  const chunks = new Map(Object.entries(manifest));
  if (chunks.size === 0) fail("manifest is empty");

  for (const [key, chunk] of chunks) {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) fail(`${key} is not a chunk`);
    for (const edge of ["imports", "dynamicImports"]) {
      const references = chunk[edge] ?? [];
      if (!Array.isArray(references) || references.some((value) => typeof value !== "string")) {
        fail(`${key}.${edge} must be a string array`);
      }
      for (const reference of references) {
        if (!chunks.has(reference)) fail(`${key}.${edge} references missing chunk ${reference}`);
      }
    }
  }

  const entryKeys = [...chunks]
    .filter(([, chunk]) => chunk.isEntry === true)
    .map(([key]) => key);
  if (entryKeys.length === 0) fail("no entry chunk");
  const appEntryKeys = entryKeys.filter(
    (key) => normalizedSource(chunks.get(key).src) === "index.html",
  );
  if (appEntryKeys.length !== 1) fail("index.html must have exactly one entry chunk");

  const keyBySource = new Map();
  for (const [key, chunk] of chunks) {
    const source = normalizedSource(chunk.src);
    if (source === null) continue;
    if (keyBySource.has(source)) fail(`${source} is declared by duplicate chunks`);
    keyBySource.set(source, key);
  }

  const keyByRequiredSource = new Map();
  for (const source of REQUIRED_DYNAMIC_SOURCES) {
    const key = keyBySource.get(source);
    if (!key) fail(`${source} must have exactly one manifest chunk`);
    if (chunks.get(key).isDynamicEntry !== true) fail(`${source} must be a dynamic entry`);
    keyByRequiredSource.set(source, key);
  }

  const staticReachable = new Set();
  const staticStack = [...entryKeys];
  while (staticStack.length) {
    const key = staticStack.pop();
    if (staticReachable.has(key)) continue;
    staticReachable.add(key);
    staticStack.push(...(chunks.get(key).imports ?? []));
  }

  const dynamicallyReachable = new Set();
  const visited = new Set();
  const stack = appEntryKeys.map((key) => ({ key, crossedDynamicEdge: false }));
  while (stack.length) {
    const state = stack.pop();
    const visitKey = `${state.crossedDynamicEdge ? "dynamic" : "static"}:${state.key}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    if (state.crossedDynamicEdge) dynamicallyReachable.add(state.key);
    const chunk = chunks.get(state.key);
    for (const key of chunk.imports ?? []) {
      stack.push({ key, crossedDynamicEdge: state.crossedDynamicEdge });
    }
    for (const key of chunk.dynamicImports ?? []) {
      stack.push({ key, crossedDynamicEdge: true });
    }
  }

  for (const [source, key] of keyByRequiredSource) {
    if (staticReachable.has(key)) fail(`${source} is statically reachable from an entry`);
    if (!dynamicallyReachable.has(key)) fail(`${source} is orphaned from entry dynamic imports`);
  }

  return {
    entries: entryKeys.length,
    dynamicSources: Object.fromEntries(keyByRequiredSource),
  };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: node scripts/assert-source-lazy-manifest.mjs <manifest.json>");
  assertSourceLazyManifest(JSON.parse(readFileSync(path, "utf8")));
}

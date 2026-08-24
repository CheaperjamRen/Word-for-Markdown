import assert from "node:assert/strict";

import { assertSourceLazyManifest } from "./assert-source-lazy-manifest.mjs";

function validManifest(shared = false) {
  const manifest = {
    "index.html": {
      file: "assets/index-A.js", src: "index.html", isEntry: true,
      imports: [],
      dynamicImports: [
        "src/source/SourceEditor.tsx",
        "src/markdown/source-document.ts",
        "src/markdown/render/MarkdownView.tsx",
        "src/editor/RichDocumentSurface.tsx",
      ],
    },
    "src/source/SourceEditor.tsx": {
      file: "assets/SourceEditor-B.js", src: "src/source/SourceEditor.tsx", isDynamicEntry: true,
      imports: shared ? ["_codemirror-shared"] : [], dynamicImports: [],
    },
    "src/markdown/source-document.ts": {
      file: "assets/source-document-C.js", src: "src/markdown/source-document.ts", isDynamicEntry: true,
      imports: [], dynamicImports: [],
    },
    "src/markdown/render/MarkdownView.tsx": {
      file: "assets/MarkdownView-D.js", src: "src/markdown/render/MarkdownView.tsx", isDynamicEntry: true,
      imports: [], dynamicImports: [],
    },
    "src/editor/RichDocumentSurface.tsx": {
      file: "assets/RichDocumentSurface-E.js", src: "src/editor/RichDocumentSurface.tsx", isDynamicEntry: true,
      imports: [], dynamicImports: [],
    },
  };
  if (shared) manifest["_codemirror-shared"] = { file: "assets/vendor-E.js", imports: [], dynamicImports: [] };
  return manifest;
}

export function runSyntheticManifestCases() {
  assert.doesNotThrow(() => assertSourceLazyManifest(validManifest(false)));
  assert.doesNotThrow(() => assertSourceLazyManifest(validManifest(true)));

  for (const [name, mutate] of [
    ["static SourceEditor", (manifest) => { manifest["index.html"].imports.push("src/source/SourceEditor.tsx"); }],
    ["orphan SourceEditor", (manifest) => { manifest["index.html"].dynamicImports = manifest["index.html"].dynamicImports.filter((key) => !key.includes("SourceEditor")); }],
    ["missing Core", (manifest) => { delete manifest["src/markdown/source-document.ts"]; }],
    ["missing MarkdownView", (manifest) => { delete manifest["src/markdown/render/MarkdownView.tsx"]; }],
    ["duplicate SourceEditor src", (manifest) => { manifest.duplicate = { ...manifest["src/source/SourceEditor.tsx"] }; }],
    ["missing index entry", (manifest) => { manifest["index.html"].isEntry = false; }],
    ["wrong index entry", (manifest) => { manifest["index.html"].src = "app.html"; }],
    ["duplicate index entry", (manifest) => { manifest["other-index"] = { ...manifest["index.html"] }; }],
    ["SourceEditor missing dynamic flag", (manifest) => { delete manifest["src/source/SourceEditor.tsx"].isDynamicEntry; }],
    ["SourceEditor false dynamic flag", (manifest) => { manifest["src/source/SourceEditor.tsx"].isDynamicEntry = false; }],
    ["arbitrary duplicate src", (manifest) => {
      manifest.sharedA = { file: "assets/a.js", src: "src/shared.ts", imports: [], dynamicImports: [] };
      manifest.sharedB = { file: "assets/b.js", src: "src/shared.ts", imports: [], dynamicImports: [] };
    }],
  ]) {
    const manifest = validManifest(false);
    mutate(manifest);
    assert.throws(() => assertSourceLazyManifest(manifest), undefined, name);
  }
}

if (process.env.VITEST === "true") {
  const { describe, it } = await import("vitest");
  describe("Source lazy manifest synthetic graph", () => {
    it("accepts legal folded/shared graphs and rejects every mutated boundary", () => {
      runSyntheticManifestCases();
    });
  });
} else {
  runSyntheticManifestCases();
  process.stdout.write("source lazy manifest synthetic cases passed\n");
}

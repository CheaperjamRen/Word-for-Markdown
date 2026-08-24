import assert from "node:assert/strict";
import { assertRichLazyManifest } from "./assert-rich-lazy-manifest.mjs";

if (process.env.VITEST !== "true") {
  const manifest = {
    "index.html": {
      src: "index.html", isEntry: true, imports: [],
      dynamicImports: ["rich", "source", "core", "markdown"],
    },
    rich: { src: "src/editor/RichDocumentSurface.tsx", isDynamicEntry: true, imports: [], dynamicImports: [] },
    source: { src: "src/source/SourceEditor.tsx", isDynamicEntry: true, imports: [], dynamicImports: [] },
    core: { src: "src/markdown/source-document.ts", isDynamicEntry: true, imports: [], dynamicImports: [] },
    markdown: { src: "src/markdown/render/MarkdownView.tsx", isDynamicEntry: true, imports: [], dynamicImports: [] },
  };
  assert.doesNotThrow(() => assertRichLazyManifest(manifest));
  process.stdout.write("rich lazy manifest synthetic case passed\n");
}

if (process.env.VITEST === "true") {
  const { describe, it } = await import("vitest");
  describe("Rich lazy manifest", () => {
    it("exports the shared strict lazy graph gate", () => {
      const manifest = {
        "index.html": {
          src: "index.html", isEntry: true, imports: [],
          dynamicImports: ["rich", "source", "core", "markdown"],
        },
        rich: { src: "src/editor/RichDocumentSurface.tsx", isDynamicEntry: true, imports: [], dynamicImports: [] },
        source: { src: "src/source/SourceEditor.tsx", isDynamicEntry: true, imports: [], dynamicImports: [] },
        core: { src: "src/markdown/source-document.ts", isDynamicEntry: true, imports: [], dynamicImports: [] },
        markdown: { src: "src/markdown/render/MarkdownView.tsx", isDynamicEntry: true, imports: [], dynamicImports: [] },
      };
      assert.doesNotThrow(() => assertRichLazyManifest(manifest));
    });
  });
}

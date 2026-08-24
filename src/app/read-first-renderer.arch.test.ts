// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd());
const sourceRoot = resolve(repositoryRoot, "src");
const appPath = resolve(sourceRoot, "app/App.tsx");
const mainPath = resolve(sourceRoot, "main.tsx");
const sourceDocumentPath = resolve(sourceRoot, "markdown/source-document.ts");
const sourceDocumentLoaderPath = resolve(
  sourceRoot,
  "markdown/load-source-document.ts",
);
const previewPath = resolve(
  sourceRoot,
  "markdown/render/FirstReadablePreview.tsx",
);
const fullRendererPath = resolve(sourceRoot, "markdown/render/MarkdownView.tsx");
const richRendererPath = resolve(sourceRoot, "editor/RichDocumentSurface.tsx");

function productionSourceFiles(): string[] {
  const config = ts.readConfigFile(
    resolve(repositoryRoot, "tsconfig.json"),
    ts.sys.readFile,
  );
  return ts
    .parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot)
    .fileNames.map((path) => resolve(path))
    .filter(
      (path) => path.startsWith(sourceRoot) && !path.includes(".test."),
    );
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function resolveLocalImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe("read-first renderer architecture", () => {
  it("loads Markdown Core through one dynamic edge with no static startup path", () => {
    const coreReferences: Array<{
      dynamic: boolean;
      file: string;
      specifier: string;
    }> = [];

    for (const path of productionSourceFiles()) {
      const sourceFile = parse(path);
      const visit = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          resolveLocalImport(path, node.moduleSpecifier.text) === sourceDocumentPath
        ) {
          coreReferences.push({
            dynamic: false,
            file: path,
            specifier: node.moduleSpecifier.text,
          });
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]) &&
          resolveLocalImport(path, node.arguments[0].text) === sourceDocumentPath
        ) {
          coreReferences.push({
            dynamic: true,
            file: path,
            specifier: node.arguments[0].text,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(coreReferences).toEqual([
      {
        dynamic: true,
        file: sourceDocumentLoaderPath,
        specifier: "./source-document",
      },
    ]);

    for (const entryPath of [mainPath, appPath, previewPath]) {
      const visited = new Set<string>();
      const stack = [entryPath];
      while (stack.length > 0) {
        const path = stack.pop()!;
        if (visited.has(path)) continue;
        visited.add(path);
        expect(path).not.toBe(sourceDocumentPath);
        const sourceFile = parse(path);
        sourceFile.forEachChild((node) => {
          if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier)
          ) {
            const dependency = resolveLocalImport(path, node.moduleSpecifier.text);
            if (dependency) stack.push(dependency);
          }
        });
      }
    }
  });

  it("keeps the full MarkdownView lazy and uses a lightweight GFM passive Rich view", () => {
    const rendererReferences: Array<{
      dynamic: boolean;
      file: string;
      node: ts.Node;
      specifier: string;
    }> = [];

    for (const path of productionSourceFiles()) {
      const sourceFile = parse(path);
      const visit = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text.endsWith("/MarkdownView")
        ) {
          rendererReferences.push({
            dynamic: false,
            file: path,
            node,
            specifier: node.moduleSpecifier.text,
          });
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text.endsWith("/MarkdownView")
        ) {
          rendererReferences.push({
            dynamic: true,
            file: path,
            node,
            specifier: node.arguments[0].text,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(rendererReferences).toHaveLength(1);
    const reference = rendererReferences.find((candidate) => candidate.file === appPath)!;
    expect(reference.dynamic).toBe(true);
    expect(reference.file).toBe(appPath);
    expect(reference.specifier).toBe("../markdown/render/MarkdownView");
    const callback = reference.node.parent;
    expect(ts.isArrowFunction(callback) && callback.body === reference.node).toBe(true);
    const lazyCall = callback.parent;
    expect(
      ts.isCallExpression(lazyCall) &&
        ts.isIdentifier(lazyCall.expression) &&
        lazyCall.expression.text === "lazy" &&
        lazyCall.arguments.length === 1 &&
        lazyCall.arguments[0] === callback,
    ).toBe(true);
    expect(rendererReferences.some((candidate) => candidate.file === richRendererPath)).toBe(false);

    const visited = new Set<string>();
    const stack = [previewPath];
    while (stack.length > 0) {
      const path = stack.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      expect(path).not.toBe(fullRendererPath);
      const sourceFile = parse(path);
      sourceFile.forEachChild((node) => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const dependency = resolveLocalImport(path, node.moduleSpecifier.text);
          if (dependency) stack.push(dependency);
        }
      });
    }
  });

  it("keeps RichDocumentSurface and Lexical out of the static Reading closure", () => {
    const references: Array<{ dynamic: boolean; file: string; specifier: string }> = [];
    for (const path of productionSourceFiles()) {
      const sourceFile = parse(path);
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
            resolveLocalImport(path, node.moduleSpecifier.text) === richRendererPath) {
          references.push({ dynamic: false, file: path, specifier: node.moduleSpecifier.text });
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
            resolveLocalImport(path, node.arguments[0].text) === richRendererPath) {
          references.push({ dynamic: true, file: path, specifier: node.arguments[0].text });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(references).toEqual([{
      dynamic: true,
      file: resolve(sourceRoot, "document/DocumentSurface.tsx"),
      specifier: "../editor/RichDocumentSurface",
    }]);
    const documentSurfaceSource = readFileSync(
      resolve(sourceRoot, "document/DocumentSurface.tsx"),
      "utf8",
    );
    expect(documentSurfaceSource).toContain(
      'const richDocumentSurfaceModule = import("../editor/RichDocumentSurface")',
    );
    expect(documentSurfaceSource).toContain(
      "const RichDocumentSurface = lazy(() => richDocumentSurfaceModule)",
    );
    const visited = new Set<string>();
    const stack = [appPath, previewPath, mainPath];
    while (stack.length) {
      const path = stack.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      expect(path).not.toBe(richRendererPath);
      const sourceFile = parse(path);
      sourceFile.forEachChild((node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const dependency = resolveLocalImport(path, node.moduleSpecifier.text);
          if (dependency) stack.push(dependency);
        }
      });
    }
  });
});

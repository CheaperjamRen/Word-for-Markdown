// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "src");
const richPath = resolve(root, "editor/RichDocumentSurface.tsx");
const lexicalPath = resolve(root, "editor/LexicalBlockEditor.tsx");

function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

describe("Rich editor lazy boundary", () => {
  it("keeps Lexical reachable only through the Rich lazy surface", () => {
    const richImports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveLocal(richPath, node.moduleSpecifier.text);
        if (resolved === lexicalPath) richImports.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source(richPath));
    expect(richImports).toEqual(["./LexicalBlockEditor"]);

    const appSource = readFileSync(resolve(root, "app/App.tsx"), "utf8");
    expect(appSource).not.toMatch(/@lexical\//);
  });
});

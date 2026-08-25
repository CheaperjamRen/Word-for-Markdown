// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd());
const sourceRoot = resolve(repositoryRoot, "src");
const sourceEditorPath = resolve(sourceRoot, "source/SourceEditor.tsx");
const documentSurfacePath = resolve(sourceRoot, "document/DocumentSurface.tsx");
const mainPath = resolve(sourceRoot, "main.tsx");
const appPath = resolve(sourceRoot, "app/App.tsx");
const sourceChangeSetPath = resolve(sourceRoot, "source/source-change-set.ts");
const appShellPath = resolve(sourceRoot, "app/shell/AppShell.tsx");
const menuBarPath = resolve(sourceRoot, "app/shell/MenuBar.tsx");
const expectedDependencies = {
  "@codemirror/commands": "6.11.0",
  "@codemirror/lang-markdown": "6.5.2",
  "@codemirror/language": "6.12.4",
  "@codemirror/search": "6.7.1",
  "@codemirror/state": "6.7.1",
  "@codemirror/view": "6.43.9",
  "@lezer/highlight": "1.2.3",
} as const;

function productionSourceFiles(): string[] {
  const config = ts.readConfigFile(resolve(repositoryRoot, "tsconfig.json"), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot).fileNames
    .map((path) => resolve(path))
    .filter((path) => path.startsWith(sourceRoot) && !path.includes(".test.") && !path.startsWith(resolve(sourceRoot, "test")));
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
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe("Source editor dependency and lazy architecture", () => {
  it("declares the seven exact direct runtime dependencies and no Source wrapper", () => {
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const declared = Object.fromEntries(
      Object.keys(expectedDependencies).map((name) => [name, manifest.dependencies?.[name]]),
    );

    expect(declared).toEqual(expectedDependencies);
    expect(manifest.dependencies).not.toHaveProperty("codemirror");
    expect(manifest.dependencies).not.toHaveProperty("@uiw/react-codemirror");
    expect(manifest.dependencies).not.toHaveProperty("@codemirror/basic-setup");
    const lock = JSON.parse(readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    expect(Object.fromEntries(Object.keys(expectedDependencies).map((name) => [
      name,
      lock.packages[""].dependencies?.[name],
    ]))).toEqual(expectedDependencies);
    for (const [name, version] of Object.entries(expectedDependencies)) {
      const suffix = `node_modules/${name}`;
      const copies = Object.entries(lock.packages).filter(([path]) => path.replaceAll("\\", "/").endsWith(suffix));
      expect(copies).toHaveLength(1);
      expect(copies[0][1].version).toBe(version);
    }
  });

  it("keeps every CodeMirror value import inside one Source subtree reached by the sole lazy editor edge", () => {
    const packageImports: Array<{ file: string; specifier: string }> = [];
    const editorReferences: Array<{ dynamic: boolean; file: string; specifier: string }> = [];

    for (const path of productionSourceFiles()) {
      const sourceFile = parse(path);
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.startsWith("@codemirror/") || specifier === "@lezer/highlight") {
            if (!node.importClause?.isTypeOnly) {
              packageImports.push({ file: relative(repositoryRoot, path), specifier });
            }
          }
          if (resolveLocalImport(path, specifier) === sourceEditorPath) {
            editorReferences.push({ dynamic: false, file: path, specifier });
          }
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]) &&
          resolveLocalImport(path, node.arguments[0].text) === sourceEditorPath
        ) {
          editorReferences.push({ dynamic: true, file: path, specifier: node.arguments[0].text });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(packageImports.every(({ file }) => file.replaceAll("\\", "/").startsWith("src/source/"))).toBe(true);
    expect(editorReferences).toEqual([{
      dynamic: true,
      file: documentSurfacePath,
      specifier: "../source/SourceEditor",
    }]);
  });

  it("rejects every entry-static transitive CodeMirror path, including a static Source helper counterexample", () => {
    const files = productionSourceFiles();
    const graph = new Map<string, string[]>();
    const dynamicGraph = new Map<string, string[]>();
    const packageOwners = new Set<string>();
    for (const path of files) {
      const dependencies: string[] = [];
      const dynamicDependencies: string[] = [];
      const sourceFile = parse(path);
      const visit = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          !node.importClause?.isTypeOnly
        ) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.startsWith("@codemirror/") || specifier === "@lezer/highlight") {
            packageOwners.add(path);
          }
          const dependency = resolveLocalImport(path, specifier);
          if (dependency) dependencies.push(dependency);
        }
        if (
          ts.isExportDeclaration(node) &&
          !node.isTypeOnly &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const dependency = resolveLocalImport(path, node.moduleSpecifier.text);
          if (dependency) dependencies.push(dependency);
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const dependency = resolveLocalImport(path, node.arguments[0].text);
          if (dependency) dynamicDependencies.push(dependency);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      graph.set(path, dependencies);
      dynamicGraph.set(path, dynamicDependencies);
    }

    const packagePathsFrom = (entry: string, candidateGraph = graph): string[] => {
      const visited = new Set<string>();
      const stack = [entry];
      const violations: string[] = [];
      while (stack.length) {
        const path = stack.pop()!;
        if (visited.has(path)) continue;
        visited.add(path);
        if (packageOwners.has(path)) violations.push(path);
        stack.push(...(candidateGraph.get(path) ?? []));
      }
      return violations;
    };

    expect(packagePathsFrom(mainPath)).toEqual([]);
    const entryStatic = new Set<string>();
    const staticStack = [mainPath];
    while (staticStack.length) {
      const path = staticStack.pop()!;
      if (entryStatic.has(path)) continue;
      entryStatic.add(path);
      staticStack.push(...(graph.get(path) ?? []));
    }
    const cmBearingDynamicRoots = [...entryStatic]
      .flatMap((path) => dynamicGraph.get(path) ?? [])
      .filter((root) => packagePathsFrom(root).length > 0);
    expect(cmBearingDynamicRoots).toEqual([sourceEditorPath]);
    const mutated = new Map([...graph].map(([path, dependencies]) => [path, [...dependencies]]));
    mutated.set(appPath, [...(mutated.get(appPath) ?? []), sourceChangeSetPath]);
    expect(packagePathsFrom(mainPath, mutated)).toContain(sourceChangeSetPath);
  });

  it("keeps one CodeMirror-free Source batch contract, one mode location, and no Task 4 zoom/debug seam", () => {
    const declarations = new Map<string, string[]>();
    const sourceViewDefinitions: string[] = [];
    const forbiddenPressed: string[] = [];
    const forbiddenZoomMutators: string[] = [];
    const forbiddenDebugOrZoomRoutes: string[] = [];
    const recentDocumentsPath = resolve(sourceRoot, "app/recent-documents.ts");
    const localePath = resolve(sourceRoot, "i18n/locale.tsx");
    const readingPreferencesPath = resolve(sourceRoot, "reading/preferences.ts");
    const readingPositionPath = resolve(sourceRoot, "reading/position-store.ts");
    const presentationPreferencesPath = resolve(sourceRoot, "document/presentation-preferences.ts");
    for (const path of productionSourceFiles()) {
      const sourceFile = parse(path);
      const visit = (node: ts.Node): void => {
        if (
          (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
          ["SourceSelectionRange", "SourceChangeBatch", "SourceChangeAck"].includes(node.name.text)
        ) {
          declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), path]);
        }
        if (ts.isFunctionDeclaration(node) && node.name?.text === "buildSourceView") {
          sourceViewDefinitions.push(path);
        }
        if (ts.isIdentifier(node) && node.text === "pressed") forbiddenPressed.push(path);
        if (
          (ts.isMethodDeclaration(node) || ts.isPropertySignature(node)) &&
          node.name.getText().toLowerCase().includes("zoom") &&
          /set|update|change/.test(node.name.getText().toLowerCase()) &&
          !(path === resolve(sourceRoot, "app/use-document-controller.ts") && node.name.getText() === "setDocumentZoom")
        ) {
          forbiddenZoomMutators.push(path);
        }
        if (
          (ts.isStringLiteralLike(node) && /(?:debug|test-route|zoom-(?:set|change)|set-zoom)/i.test(node.text)) ||
          (ts.isIdentifier(node) && node.text === "localStorage" && ![
            recentDocumentsPath,
            localePath,
            readingPreferencesPath,
            readingPositionPath,
            presentationPreferencesPath,
          ].includes(path)) ||
          (ts.isIdentifier(node) && node.text === "URLSearchParams") ||
          (ts.isPropertyAccessExpression(node) && node.name.text.startsWith("__"))
        ) forbiddenDebugOrZoomRoutes.push(path);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    for (const name of ["SourceSelectionRange", "SourceChangeBatch", "SourceChangeAck"]) {
      expect(declarations.get(name)).toEqual([resolve(sourceRoot, "contracts/markdown.ts")]);
    }
    const contractPath = resolve(sourceRoot, "contracts/markdown.ts");
    const contractSource = parse(contractPath);
    const batch = contractSource.statements.find((statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "SourceChangeBatch",
    );
    expect(batch?.members.map((member) => member.name?.getText()).sort()).toEqual([
      "baseCandidateRevision",
      "changes",
      "historyGroup",
      "selectionAfter",
      "sessionId",
    ]);
    const contractText = readFileSync(contractPath, "utf8");
    expect(contractText).not.toMatch(/@codemirror|@lezer/);
    expect(contractText.match(/export interface SourceHistoryGroup\b/g)).toHaveLength(1);
    expect(contractText).toMatch(/kind:\s*SourceHistoryKind/);
    expect(sourceViewDefinitions).toEqual([resolve(sourceRoot, "markdown/source-view.ts")]);
    expect(forbiddenPressed).toEqual([]);
    expect(forbiddenZoomMutators).toEqual([]);
    expect(forbiddenDebugOrZoomRoutes).toEqual([]);
    expect(readFileSync(resolve(sourceRoot, "app/shell/toolbar-commands.ts"), "utf8")).not.toMatch(/reading|rich|source/);
  });

  it("constructs one shared toolbar state object and passes that exact identity to toolbar, menu, and shortcuts", () => {
    const source = readFileSync(appShellPath, "utf8");
    const menuSource = readFileSync(menuBarPath, "utf8");
    expect(source.match(/createToolbarStateById\(\s*controller\s*,/g)).toHaveLength(1);
    expect(source.match(/stateById=\{stateById\}/g)).toHaveLength(2);
    expect(source).toMatch(/stateById\.save\.execute\(\)/);
    expect(source).toMatch(/stateById\.undo\.execute\(\)/);
    expect(source).toMatch(/stateById\.redo\.execute\(\)/);
    expect(menuSource).toMatch(/stateById\.undo\.execute\(\)/);
    expect(menuSource).toMatch(/stateById\.redo\.execute\(\)/);
    expect(menuSource).not.toMatch(/controller\.undo\s*\(/);
    expect(menuSource).not.toMatch(/controller\.redo\s*\(/);
  });
});

// @vitest-environment node
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd());
const hostPath = resolve(repositoryRoot, "src/desktop/host.ts");
const contractPath = resolve(repositoryRoot, "src/contracts/desktop.ts");
const allowedNumberArrayFiles = new Set([hostPath, contractPath]);

function isProductionSource(sourceFile: ts.SourceFile): boolean {
  const path = resolve(sourceFile.fileName);
  return (
    path.startsWith(resolve(repositoryRoot, "src")) &&
    !sourceFile.fileName.includes(".test.")
  );
}

function isExplicitNumberArray(node: ts.Node): boolean {
  if (
    ts.isArrayTypeNode(node) &&
    node.elementType.kind === ts.SyntaxKind.NumberKeyword
  ) {
    return true;
  }

  return (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === "Array" &&
    node.typeArguments?.length === 1 &&
    node.typeArguments[0].kind === ts.SyntaxKind.NumberKeyword
  );
}

function isResolvedNumberArray(
  checker: ts.TypeChecker,
  node: ts.Expression,
): boolean {
  const type = checker.getTypeAtLocation(node);
  if (!checker.isArrayType(type)) return false;
  const [element] = checker.getTypeArguments(type as ts.TypeReference);
  return Boolean(element && element.flags & ts.TypeFlags.NumberLike);
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText();
    }
    current = current.parent;
  }
  return undefined;
}

describe("wire byte architecture", () => {
  it("allows exactly one inbound number[] to Uint8Array conversion", () => {
    const config = ts.readConfigFile(
      resolve(repositoryRoot, "tsconfig.json"),
      ts.sys.readFile,
    );
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      repositoryRoot,
    );
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
    const explicitNumberArrayViolations: string[] = [];
    const hostOpenDocumentViolations: string[] = [];
    const conversions: Array<{ file: string; functionName?: string }> = [];

    for (const sourceFile of program.getSourceFiles().filter(isProductionSource)) {
      const absolutePath = resolve(sourceFile.fileName);
      const visit = (node: ts.Node): void => {
        if (
          isExplicitNumberArray(node) &&
          !allowedNumberArrayFiles.has(absolutePath)
        ) {
          explicitNumberArrayViolations.push(absolutePath);
        }

        if (
          ts.isIdentifier(node) &&
          node.text === "HostOpenDocument" &&
          !allowedNumberArrayFiles.has(absolutePath)
        ) {
          hostOpenDocumentViolations.push(absolutePath);
        }

        let argument: ts.Expression | undefined;
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Uint8Array" &&
          node.expression.name.text === "from"
        ) {
          argument = node.arguments[0];
        } else if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "Uint8Array"
        ) {
          argument = node.arguments?.[0];
        }

        if (argument && isResolvedNumberArray(checker, argument)) {
          conversions.push({
            file: absolutePath,
            functionName: enclosingFunctionName(node),
          });
        }

        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(explicitNumberArrayViolations).toEqual([]);
    expect(hostOpenDocumentViolations).toEqual([]);
    expect(conversions).toEqual([
      { file: hostPath, functionName: "wireBytesToSourceInput" },
    ]);
  }, 15_000);
});

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

function exactRepresentativeMarkdown(targetBytes, newline) {
  const base = [
    "# Source editor QA",
    "",
    "中文段落用于验证输入法、软换行与选区；emoji 🧭 不得破坏 UTF-16 偏移。",
    "",
    "- list item one",
    "- list item two",
    "",
    "| Capability | Status |",
    "| --- | --- |",
    "| Soft wrapping | Enabled |",
    "| Logical line numbers | Preserved |",
    "",
    "[local Markdown link](./linked-document.md)",
    "",
    "```typescript",
    "const message = \"long document\";",
    "```",
    "",
    "Inline math $E = mc^2$ and display math:",
    "",
    "$$",
    "\\sqrt{x^2 + y^2}",
    "$$",
    "",
  ].join(newline);
  const repeatedParagraph = [
    "Long-form Markdown should remain readable and editable without changing its source bytes.",
    "",
  ].join(newline);
  const baseBytes = Buffer.byteLength(base);
  const paragraphBytes = Buffer.byteLength(repeatedParagraph);
  if (baseBytes > targetBytes) {
    throw new Error("Fixture target is smaller than the representative content.");
  }
  const repeatCount = Math.floor((targetBytes - baseBytes) / paragraphBytes);
  const remainder = targetBytes - baseBytes - repeatCount * paragraphBytes;
  const value = `${base}${repeatedParagraph.repeat(repeatCount)}${"x".repeat(remainder)}`;
  if (Buffer.byteLength(value) !== targetBytes) {
    throw new Error("Fixture generator failed to reach the exact byte target.");
  }
  return value;
}

function exactSingleLineMarkdown(targetBytes) {
  const prefix = "# One logical line — 中文 🧭 | soft wrapping must preserve line number 1 | ";
  const remaining = targetBytes - Buffer.byteLength(prefix);
  if (remaining < 0) throw new Error("Fixture target is smaller than its prefix.");
  return `${prefix}${"x".repeat(remaining)}`;
}

export function createSourceEditorQaFixtures(outputDirectory) {
  if (!isAbsolute(outputDirectory)) {
    throw new Error("Source QA output directory must be absolute.");
  }
  const output = resolve(outputDirectory);
  if (output === repositoryRoot) {
    throw new Error("Source QA output directory cannot be the repository root.");
  }
  if (existsSync(output)) {
    throw new Error(`Source QA output directory already exists: ${output}`);
  }

  mkdirSync(output);
  const files = {
    representative100Kb: join(output, "source-100kb.md"),
    representative1Mb: join(output, "source-1mb.md"),
    singleLine100Kb: join(output, "source-single-line-100kb.md"),
  };
  writeFileSync(files.representative100Kb, exactRepresentativeMarkdown(102_400, "\n"), "utf8");
  writeFileSync(files.representative1Mb, exactRepresentativeMarkdown(1_048_576, "\r\n"), "utf8");
  writeFileSync(files.singleLine100Kb, exactSingleLineMarkdown(102_400), "utf8");
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    throw new Error("Usage: npm run source:qa-fixtures -- <absolute-output-directory>");
  }
  console.log(JSON.stringify(createSourceEditorQaFixtures(outputDirectory), null, 2));
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const EDITABLE_PARAGRAPH = "这是唯一允许修改的段落。";

export function buildSizedMarkdown(targetBytes) {
  if (!Number.isInteger(targetBytes) || targetBytes < 1024) {
    throw new Error("Fixture target must be an integer of at least 1024 bytes.");
  }
  const paddedParagraphs = [
    "Representative packaged Markdown content is visible before full formatting. payload-00-",
    ...Array.from(
      { length: 80 },
      (_, index) =>
        `Regular document paragraph ${String(index + 1).padStart(2, "0")} keeps structure bounded. payload-${String(index + 1).padStart(2, "0")}-`,
    ),
  ];
  const fixedBlocks = [
    "# Large Markdown document",
    paddedParagraphs[0],
    [
      "- representative list item one",
      "- representative list item two",
      "- representative list item three",
      "- representative list item four",
      "- representative list item five",
      "- representative list item six",
      "- representative list item seven",
      "- representative list item eight",
    ].join("\n"),
    "> A representative quotation remains a bounded semantic block.",
    "```text\nbounded code sample\n```",
    ...paddedParagraphs.slice(1),
  ];
  const base = `${fixedBlocks.join("\n\n")}\n`;
  let remaining = targetBytes - Buffer.byteLength(base);
  if (remaining < 0) {
    throw new Error("Fixture target is smaller than the representative structure.");
  }
  const share = Math.floor(remaining / paddedParagraphs.length);
  let extra = remaining % paddedParagraphs.length;
  const padded = paddedParagraphs.map((paragraph) => {
    const size = share + (extra-- > 0 ? 1 : 0);
    return paragraph + "x".repeat(size);
  });
  const value = [
    fixedBlocks[0],
    padded[0],
    fixedBlocks[2],
    fixedBlocks[3],
    fixedBlocks[4],
    ...padded.slice(1),
  ].join("\n\n") + "\n";
  if (Buffer.byteLength(value) !== targetBytes) {
    throw new Error("Fixture generator failed to reach the exact byte target.");
  }
  return value;
}

function exactSingleReplacement(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected exactly one protected fixture paragraph: ${before}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function crlfBomBuffer(value) {
  const logical = value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\s+$/u, "")
    .concat("\n")
    .replace(/\n/g, "\r\n");
  return Buffer.concat([BOM, Buffer.from(logical, "utf8")]);
}

export function buildProtectedFixtureSet(logicalSource) {
  const baseline = crlfBomBuffer(logicalSource);
  const normalized = baseline.subarray(BOM.length).toString("utf8");
  const expected = exactSingleReplacement(
    normalized,
    EDITABLE_PARAGRAPH,
    `**${EDITABLE_PARAGRAPH}**`,
  );
  const external = exactSingleReplacement(
    normalized,
    EDITABLE_PARAGRAPH,
    "external winner",
  );
  return {
    baseline,
    expected: Buffer.concat([BOM, Buffer.from(expected, "utf8")]),
    external: Buffer.concat([BOM, Buffer.from(external, "utf8")]),
    localCandidate: Buffer.concat([BOM, Buffer.from(expected, "utf8")]),
  };
}

export function createTestFixtures(repositoryRoot) {
  const outputRoot = join(repositoryRoot, "fixtures", "generated");
  mkdirSync(outputRoot, { recursive: true });
  const protectedSource = readFileSync(
    join(repositoryRoot, "fixtures", "protected-syntax.md"),
    "utf8",
  );
  const protectedSet = buildProtectedFixtureSet(protectedSource);
  const outputs = {
    basic: join(outputRoot, "markdown-showcase.md"),
    startup100Kb: join(outputRoot, "large-100kb.md"),
    size1Mb: join(outputRoot, "large-1mb.md"),
    protected: join(outputRoot, "protected-crlf.md"),
    protectedExpected: join(outputRoot, "protected-crlf-expected.md"),
    restart: join(outputRoot, "restart.md"),
    restartExpected: join(outputRoot, "restart-expected.md"),
    conflict: join(outputRoot, "conflict.md"),
    conflictExternal: join(outputRoot, "conflict-external.md"),
    conflictLocalCandidate: join(outputRoot, "conflict-local-candidate.md"),
  };

  writeFileSync(
    outputs.basic,
    readFileSync(join(repositoryRoot, "fixtures", "markdown-showcase.md")),
  );
  writeFileSync(outputs.startup100Kb, buildSizedMarkdown(100 * 1024), "utf8");
  writeFileSync(outputs.size1Mb, buildSizedMarkdown(1024 * 1024), "utf8");
  writeFileSync(outputs.protected, protectedSet.baseline);
  writeFileSync(outputs.protectedExpected, protectedSet.expected);
  writeFileSync(outputs.restart, protectedSet.baseline);
  writeFileSync(outputs.restartExpected, protectedSet.expected);
  writeFileSync(outputs.conflict, protectedSet.baseline);
  writeFileSync(outputs.conflictExternal, protectedSet.external);
  writeFileSync(outputs.conflictLocalCandidate, protectedSet.localCandidate);
  return outputs;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const repositoryRoot = resolve(dirname(scriptPath), "..");
  const outputs = createTestFixtures(repositoryRoot);
  console.log(JSON.stringify(outputs, null, 2));
}

export interface OutlineItem {
  id: string;
  text: string;
  level: number;
  sourceLine: number;
  sourceOffset: number;
}

function readableHeadingText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\\([\\`*_[\]{}()#+.!>-])/g, "$1")
    .trim();
}

export function headingId(value: string): string {
  const text = readableHeadingText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return text || "heading";
}

export function buildOutline(markdown: string): OutlineItem[] {
  const source = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const lineOffsets = [0];
  for (let index = 1; index < lines.length; index += 1) {
    lineOffsets.push(lineOffsets[index - 1] + lines[index - 1].length + 1);
  }
  const result: OutlineItem[] = [];
  const used = new Map<string, number>();
  const hasFrontmatter = lines[0]?.trim() === "---" && lines.slice(1).some((line) => line.trim() === "---");
  let inFrontmatter = hasFrontmatter;
  let frontmatterClosed = !hasFrontmatter;
  let fence: string | null = null;

  for (const [sourceLine, line] of lines.entries()) {
    if (!frontmatterClosed && sourceLine === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") {
        inFrontmatter = false;
        frontmatterClosed = true;
      }
      continue;
    }
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1][0] : null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const text = readableHeadingText(match[2].replace(/\s+#+\s*$/, ""));
    if (!text) continue;
    const base = headingId(text);
    const occurrence = used.get(base) ?? 0;
    used.set(base, occurrence + 1);
    result.push({
      id: occurrence === 0 ? base : `${base}-${occurrence}`,
      text,
      level: match[1].length,
      sourceLine,
      sourceOffset: lineOffsets[sourceLine]!,
    });
  }
  return result;
}

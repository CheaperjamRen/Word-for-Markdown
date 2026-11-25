export interface OutlineItem {
  id: string;
  text: string;
  level: number;
  sourceLine: number;
  sourceOffset: number;
}

function readableHeadingText(value: string): string {
  const codeSpans: string[] = [];
  const escapedChars: string[] = [];
  const withPlaceholders = value
    .replace(/(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g, (_match, _ticks: string, rawCode: string) => {
      const code = rawCode.length >= 2 && rawCode.startsWith(" ") && rawCode.endsWith(" ") && /[^ ]/.test(rawCode)
        ? rawCode.slice(1, -1)
        : rawCode;
      const index = codeSpans.push(code) - 1;
      return `\u0000CODE${index}\u0000`;
    })
    .replace(/\\([!"#$%&'()*+,-./:;<=>?@[\\\]^_`{|}~])/g, (_match, char: string) => {
      const index = escapedChars.push(char) - 1;
      return `\u0000ESC${index}\u0000`;
    })
    .replace(/!\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, "$1")
    .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, "$1");
  const stripped = withPlaceholders
    .replace(/(\*\*|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?=[^\p{L}\p{N}_]|$)/gu, "$1$2")
    .replace(/\*([^\s*](?:[^*]*?[^\s*])?)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])_([^\s_](?:[^_]*?[^\s_])?)_(?=[^\p{L}\p{N}_]|$)/gu, "$1$2");
  return stripped
    .replace(/\u0000ESC(\d+)\u0000/g, (_match, index: string) => escapedChars[Number(index)] ?? "")
    .replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "")
    .trim();
}

function slugifyHeadingText(readableText: string): string {
  const slug = readableText
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return slug || "heading";
}

export function headingId(value: string): string {
  return slugifyHeadingText(readableHeadingText(value));
}

// Outline parsing is a full scan of the document; several views (outline pane,
// reading view, first preview, shell) ask for the same text in one frame.
// Cache the last few results so they share a single parse. Callers treat the
// result as read-only.
const OUTLINE_CACHE_LIMIT = 4;
const outlineCache = new Map<string, OutlineItem[]>();

export function buildOutline(markdown: string): OutlineItem[] {
  const cached = outlineCache.get(markdown);
  if (cached) {
    outlineCache.delete(markdown);
    outlineCache.set(markdown, cached);
    return cached;
  }
  const result = parseOutline(markdown);
  outlineCache.set(markdown, result);
  if (outlineCache.size > OUTLINE_CACHE_LIMIT) {
    const oldest = outlineCache.keys().next().value;
    if (oldest !== undefined) outlineCache.delete(oldest);
  }
  return result;
}

/** Cheap check used by chrome that only needs to know whether any heading exists. */
export function hasOutline(markdown: string): boolean {
  return buildOutline(markdown).length > 0;
}

function parseOutline(markdown: string): OutlineItem[] {
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
  let fence: { char: "`" | "~"; length: number } | null = null;

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
    if (fence === null) {
      const openFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (openFence && !(openFence[1][0] === "`" && openFence[2].includes("`"))) {
        fence = { char: openFence[1][0] as "`" | "~", length: openFence[1].length };
        continue;
      }
    } else {
      const closeFence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closeFence && closeFence[1][0] === fence.char && closeFence[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const match = /^( {0,3})(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line);
    if (!match) continue;
    const rawHeading = match[3].replace(/(?:^|[ \t]+)#+[ \t]*$/, "");
    const text = readableHeadingText(rawHeading);
    if (!text) continue;
    const base = slugifyHeadingText(text);
    const occurrence = used.get(base) ?? 0;
    used.set(base, occurrence + 1);
    result.push({
      id: occurrence === 0 ? base : `${base}-${occurrence}`,
      text,
      level: match[2].length,
      sourceLine,
      sourceOffset: lineOffsets[sourceLine]! + match[1].length,
    });
  }
  return result;
}

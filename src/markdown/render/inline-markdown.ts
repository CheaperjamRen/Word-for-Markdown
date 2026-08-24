interface MdastNode {
  type?: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}

function strongChildren(value: string): MdastNode[] | null {
  const pattern = /(\*\*|__)([\s\S]*?)\1(?=[\p{L}\p{N}])/gu;
  const result: MdastNode[] = [];
  let cursor = 0;
  let matched = false;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    const marker = match[1];
    const content = match[2];
    if (!marker || !content || index < cursor) continue;
    if (index > cursor) result.push({ type: "text", value: value.slice(cursor, index) });
    result.push({
      type: "strong",
      children: [{ type: "text", value: content }],
    });
    cursor = index + match[0].length;
    matched = true;
  }
  if (!matched) return null;
  if (cursor < value.length) result.push({ type: "text", value: value.slice(cursor) });
  return result;
}

function legacyMath(value: string): string | null {
  if (
    !/[√∑Σ≤≥≈≠^_=]/u.test(value) &&
    !/\b(?:exp|log|sin|cos|softmax)\s*\(/iu.test(value)
  ) return null;
  if (!/[A-Za-zα-ωΑ-Ω]/u.test(value)) return null;

  const superscripts: Record<string, string> = {
    "ᵀ": "^T", "²": "^2", "³": "^3",
  };
  let latex = value.trim();
  for (const [from, to] of Object.entries(superscripts)) latex = latex.split(from).join(to);
  latex = latex
    .replace(/√\s*([A-Za-z0-9]+)/gu, "\\sqrt{$1}")
    .replace(/[Σ∑]/gu, "\\sum")
    .replace(/≤/gu, "\\leq")
    .replace(/≥/gu, "\\geq")
    .replace(/≠/gu, "\\neq")
    .replace(/≈/gu, "\\approx");
  return latex;
}

function transformChildren(node: MdastNode): void {
  if (!node.children) return;
  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...(strongChildren(child.value) ?? [child]));
      continue;
    }
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const value = legacyMath(child.value);
      if (value) {
        next.push({
          type: "inlineMath",
          value,
          data: {
            hName: "code",
            hProperties: { className: ["language-math", "math-inline"] },
            hChildren: [{ type: "text", value }],
          },
        });
        continue;
      }
    }
    transformChildren(child);
    next.push(child);
  }
  node.children = next;
}

/** Adds only the narrow compatibility syntax used by existing local handbooks. */
export function remarkLenientInlineMarkdown() {
  return (tree: unknown) => transformChildren(tree as MdastNode);
}

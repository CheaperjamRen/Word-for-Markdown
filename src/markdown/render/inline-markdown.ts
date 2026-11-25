import katex from "katex";

interface MdastNode {
  type?: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}

function strongChildren(value: string): MdastNode[] | null {
  const pattern = /(\*\*|(?<![\p{L}\p{N}_])__)([\s\S]*?)\1(?=[\p{L}\p{N}])/gu;
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

const CODE_SYNTAX_DISQUALIFIER = /(?:["'`$%&#\\]|(?<![_^])\{|:\/\/|^\/.+\/[gimsuy]*$|\b0x[0-9a-fA-F]+|\bv?\d+(?:\.\d+)+\^|^[A-Za-z][A-Za-z0-9+#.-]+\s*[≤≥]+\s*v?\d|\p{Script=Han}|==|!=|<=|>=|=>|->|::|&&|\|\||;|(?:^|\s)--[A-Za-z0-9]|^_|_$|__|[A-Za-z0-9]{2,}_[A-Za-z0-9]{2,}|[A-Za-z0-9]_[A-Za-z0-9]+_|[A-Za-z0-9_]\.[A-Za-z_]|(?<!\b(?:sin|cos|tan|log|exp))[A-Za-z_]{3,}\^|\^[A-Za-z]{2,})/u;
const UNIT_BADGE_DISQUALIFIER = /\b\d+(?:\.\d+)?\s*(?:ms|ns|us|µs|px|rem|vh|vw|fps|hz|khz|mhz|ghz|kb|mb|gb|tb|kib|mib|gib)\b/iu;
const UNICODE_MATH_SIGNAL = /[√∑Σ≤≥≈≠ᵀ²³⁴⁻¹±×·∈∉⊆∂∇∞ℝα-ωΑ-Ωϵϕ]/u;
const NON_LOG_MATH_FN_SIGNAL = /(?<![A-Za-z0-9_.$])\b(?:exp|sin|cos|softmax)\s*\(/iu;
const LOG_MATH_FN_SIGNAL = /(?<![A-Za-z0-9_.$])\blog\s*\(\s*(?:[-+]?\d+(?:\.\d+)?|[A-Za-zα-ωΑ-Ωϵϕ](?:_(?:\{[^}]+\}|[A-Za-z0-9]+))?)\s*\)/iu;
const CONTEXTUAL_LOG_SIGNAL = /(?:[=+\-*/∑Σ]\s*|-)(?<![A-Za-z0-9_.$])\blog\s*\([^)]+\)/iu;
const MATH_SUPERSCRIPT_SIGNAL = /(?<![A-Za-z]{3})[A-Za-zα-ωΑ-Ωϵϕ0-9)\]}]\^(?:\{[^}]+\}|[-+]?\d+|[A-Za-zα-ωΑ-Ωϵϕ])(?![A-Za-z0-9_])/u;
const MATH_BRACED_SUBSCRIPT_SIGNAL = /[A-Za-zα-ωΑ-Ωϵϕ0-9)\]}]_\{[^}]+\}/u;

function hasBalancedBraces(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function legacyMath(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    CODE_SYNTAX_DISQUALIFIER.test(trimmed) ||
    UNIT_BADGE_DISQUALIFIER.test(trimmed) ||
    !hasBalancedBraces(trimmed)
  ) return null;
  if (
    !UNICODE_MATH_SIGNAL.test(trimmed) &&
    !NON_LOG_MATH_FN_SIGNAL.test(trimmed) &&
    !LOG_MATH_FN_SIGNAL.test(trimmed) &&
    !CONTEXTUAL_LOG_SIGNAL.test(trimmed) &&
    !MATH_SUPERSCRIPT_SIGNAL.test(trimmed) &&
    !MATH_BRACED_SUBSCRIPT_SIGNAL.test(trimmed)
  ) return null;
  if (!/[A-Za-zα-ωΑ-Ωϵϕ]/u.test(trimmed)) return null;

  const replacements: ReadonlyArray<readonly [string, string]> = [
    ["⁻¹", "^{-1}"],
    ["ᵀ", "^T"],
    ["²", "^2"],
    ["³", "^3"],
    ["⁴", "^4"],
  ];
  let latex = trimmed;
  for (const [from, to] of replacements) latex = latex.split(from).join(to);
  latex = latex
    .replace(/√\s*([A-Za-zα-ωΑ-Ωϵϕ0-9]+(?:_(?:\{[^}]+\}|[A-Za-z0-9]+))?)/gu, "\\sqrt{$1}")
    .replace(/[Σ∑]/gu, "\\sum")
    .replace(/≤/gu, "\\leq")
    .replace(/≥/gu, "\\geq")
    .replace(/≠/gu, "\\neq")
    .replace(/≈/gu, "\\approx")
    .replace(/±/gu, "\\pm")
    .replace(/×/gu, "\\times")
    .replace(/·/gu, "\\cdot")
    .replace(/∈/gu, "\\in")
    .replace(/∉/gu, "\\notin")
    .replace(/⊆/gu, "\\subseteq")
    .replace(/∂/gu, "\\partial")
    .replace(/∇/gu, "\\nabla")
    .replace(/∞/gu, "\\infty")
    .replace(/ℝ/gu, "\\mathbb{R}")
    .replace(/→/gu, "\\to")
    .replace(/\^([-+]?\d{2,}|[-+][A-Za-z0-9]+)(?![A-Za-z0-9}])/g, "^{$1}")
    .replace(/_([A-Za-z0-9]{2,})\b/g, "_{$1}");
  if (/\^(?:\{[^}]*\}|[A-Za-z0-9+-]+)\s*\^/.test(latex)) return null;
  try {
    katex.renderToString(latex, { throwOnError: true, strict: "ignore" });
  } catch {
    return null;
  }
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

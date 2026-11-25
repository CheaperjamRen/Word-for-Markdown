import katex from "katex";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { describe, expect, it } from "vitest";

import { remarkLenientInlineMarkdown } from "./inline-markdown";

interface TestNode {
  type?: string;
  value?: string;
  children?: TestNode[];
}

function parseInlineChildren(markdown: string): TestNode[] {
  const processor = unified().use(remarkParse).use(remarkLenientInlineMarkdown);
  const tree = processor.runSync(processor.parse(markdown)) as TestNode;
  return tree.children?.[0]?.children ?? [];
}

describe("remarkLenientInlineMarkdown", () => {
  it.each([
    ["QKᵀ / √d", "QK^T / \\sqrt{d}"],
    ["p_i = exp(z_i / T) / Σ exp(z_j / T)", "p_i = exp(z_i / T) / \\sum exp(z_j / T)"],
    ["softmax(QK^T / √d_k)", "softmax(QK^T / \\sqrt{d_k})"],
    ["a_i ≤ b_i", "a_i \\leq b_i"],
    ["d_{model}", "d_{model}"],
    ["W_{query} K_{key}^T / √d_{model}", "W_{query} K_{key}^T / \\sqrt{d_{model}}"],
    ["Emb_{query} K_{key}^T", "Emb_{query} K_{key}^T"],
    ["loss_i = -log(p_i)", "loss_i = -log(p_i)"],
    ["L = -log(1 - p_i)", "L = -log(1 - p_i)"],
    ["L_ce = -∑ y_i log(p_i)", "L_{ce} = -\\sum y_i log(p_i)"],
    ["A⁻¹", "A^{-1}"],
    ["ε = 10^-8", "ε = 10^{-8}"],
    ["N = 2^32", "N = 2^{32}"],
    ["x → ∞", "x \\to \\infty"],
  ])("converts handbook legacy math %s to valid KaTeX inlineMath", (source, expectedLatex) => {
    const children = parseInlineChildren(`\`${source}\``);
    expect(children).toHaveLength(1);
    expect(children[0]?.type).toBe("inlineMath");
    expect(children[0]?.value).toBe(expectedLatex);
    expect(() => katex.renderToString(expectedLatex, { throwOnError: true, strict: "ignore" })).not.toThrow();
  });

  it.each([
    '"PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED"',
    '"SAFE" | "REQUIRES_APPROVAL" | "BLOCKED"',
    "worktree_env.py",
    "git_ops.py",
    "source_offset",
    "console.log(value)",
    "log(err)",
    "log('err')",
    "log($err)",
    "exp({ x })",
    "p ≥ 95%",
    "x^2 & mask",
    "C# ≥ 12",
    "HEAD^1",
    "HEAD^{commit}",
    "v0.1.1^0",
    "0xff^mask",
    "延迟 ≤ 50ms",
    "latency ≤ 50ms",
    "Python ≥ 3.11",
    "node ≥ 20",
    "a_b_c ≤ 1",
    "Aᵀ^2",
    "\\alpha_1",
    "PENDING → RUNNING",
    "PORT=8080",
    "x = 1",
    "--mode=rpc",
    "^0.1.1",
  ])("preserves technical or KaTeX-unsafe code span %s as inlineCode", (source) => {
    const children = parseInlineChildren(`\`${source}\``);
    expect(children).toHaveLength(1);
    expect(children[0]?.type).toBe("inlineCode");
    expect(children[0]?.value).toBe(source);
  });

  it("keeps intraword double underscores intact while converting CJK-adjacent bold markers", () => {
    const children = parseInlineChildren("环境变量 APP__DB__HOST 与 **容量：**说明");
    expect(children.map((node) => [node.type, node.value ?? node.children?.[0]?.value])).toEqual([
      ["text", "环境变量 APP__DB__HOST 与 "],
      ["strong", "容量："],
      ["text", "说明"],
    ]);
  });
});

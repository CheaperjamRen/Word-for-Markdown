import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** The one Markdown grammar profile shared by Core and editable views. */
export function createMarkdownParser() {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm, { singleTilde: true })
    .use(remarkMath);
}

export function parseMarkdown(text: string) {
  return createMarkdownParser().parse(text);
}

export function isDeletionNode(node: unknown): node is {
  type: "delete";
  children?: unknown[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
} {
  return typeof node === "object" && node !== null && (node as { type?: unknown }).type === "delete";
}

export default createMarkdownParser;

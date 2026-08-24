import { isDeletionNode, parseMarkdown } from "../markdown/markdown-profile";
import {
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CHECK_LIST,
  CODE,
  HEADING,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  UNORDERED_LIST,
  type Transformer,
} from "@lexical/markdown";

export const RICH_MARKDOWN_TRANSFORMERS: readonly Transformer[] = [
  HEADING,
  QUOTE,
  CODE,
  UNORDERED_LIST,
  ORDERED_LIST,
  CHECK_LIST,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  LINK,
];

export function normalizeGfmDeletionForLexical(markdown: string): string {
  const replacements: Array<{ from: number; to: number; value: string }> = [];
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const node = value as {
      children?: unknown[];
      position?: { start?: { offset?: number }; end?: { offset?: number } };
    };
    if (isDeletionNode(node) && node.children?.length) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      const first = node.children[0] as { position?: { start?: { offset?: number } } };
      const last = node.children.at(-1) as { position?: { end?: { offset?: number } } };
      const contentStart = first.position?.start?.offset;
      const contentEnd = last.position?.end?.offset;
      if (
        start !== undefined && end !== undefined &&
        contentStart !== undefined && contentEnd !== undefined &&
        markdown.slice(start, contentStart) === "~" &&
        markdown.slice(contentEnd, end) === "~"
      ) {
        replacements.push(
          { from: contentEnd, to: end, value: "~~" },
          { from: start, to: contentStart, value: "~~" },
        );
      }
    }
    node.children?.forEach(visit);
  };
  visit(parseMarkdown(markdown));
  let result = markdown;
  for (const replacement of replacements.sort((left, right) => right.from - left.from)) {
    result = result.slice(0, replacement.from) + replacement.value + result.slice(replacement.to);
  }
  return result;
}

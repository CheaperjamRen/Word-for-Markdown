// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isDeletionNode, parseMarkdown } from "./markdown-profile";

function inlineChildren(text: string): readonly unknown[] {
  const root = parseMarkdown(text);
  const paragraph = root.children[0];
  return paragraph && "children" in paragraph && Array.isArray(paragraph.children)
    ? paragraph.children
    : [];
}

describe("shared Markdown profile", () => {
  it.each(["~one~", "~~two~~"])("recognizes legal GFM deletion %s", (text) => {
    expect(inlineChildren(text).some(isDeletionNode)).toBe(true);
  });

  it.each(["~ one ~", "a ~~~three~~~ b"])(
    "keeps invalid or triple tilde text literal: %s",
    (text) => expect(inlineChildren(text).some(isDeletionNode)).toBe(false),
  );

  it("keeps nested inline positions available for mapping", () => {
    const children = inlineChildren("重复 ~中文😀 **词**~ 词");
    const deletion = children.find(isDeletionNode) as { position?: unknown; children?: unknown[] } | undefined;
    expect(deletion?.position).toBeDefined();
    expect(deletion?.children?.length).toBeGreaterThan(0);
  });
});

import { createElement, type ReactElement } from "react";

import type { BlockViewSpan, SourceBlock, SourceDocument } from "../../contracts/markdown";
import { deletionSourceRunsForBlock } from "../inline-profile";
import { buildOutline } from "../outline";
import { useLocale } from "../../i18n/locale";
import "./markdown.css";

const MAX_BLOCKS = 12;
const MAX_LIST_ITEMS = 12;
const MAX_BLOCK_CHARACTERS = 800;
const MAX_TOTAL_CHARACTERS = 6_000;

interface PreviewBlock {
  id: string;
  kind: "heading" | "paragraph" | "list" | "blockquote" | "code";
  text?: string;
  depth?: number;
  items?: string[];
  ordered?: boolean;
}

function readableInlineText(markdown: string, deletionRuns: readonly string[] = []): string {
  let readable = markdown;
  for (const run of deletionRuns) {
    const markerLength = run.startsWith("~~") ? 2 : 1;
    if (run.length <= markerLength * 2) continue;
    readable = readable.split(run).join(run.slice(markerLength, -markerLength));
  }
  return readable
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,!?;:]|$)/g, "$1$2")
    .replace(/\\([\\`*_[\]{}()#+.!>-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function codeText(raw: string): string {
  const fenced = /^(?:```|~~~)[^\r\n]*\r?\n([\s\S]*?)\r?\n(?:```|~~~)\s*$/.exec(
    raw,
  );
  return (fenced?.[1] ?? raw.replace(/^(?: {4}|\t)/gm, "")).trim();
}

function previewBlock(
  document: SourceDocument,
  block: SourceBlock,
  remainingCharacters: number,
  remainingListItems: number,
): { block: PreviewBlock | null; characters: number; items: number; truncated: boolean } {
  const blockLimit = Math.min(MAX_BLOCK_CHARACTERS, remainingCharacters);
  const deletionRuns = deletionSourceRunsForBlock(document, block.id);
  if (blockLimit <= 0) {
    return { block: null, characters: 0, items: 0, truncated: true };
  }

  if (block.kind === "list") {
    const rawItems = block.raw
      .split(/\r?\n/)
      .map((line) => /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);
    const items: string[] = [];
    let characters = 0;
    let truncated = rawItems.length > remainingListItems;
    for (const match of rawItems.slice(0, remainingListItems)) {
      const readable = readableInlineText(match[3], deletionRuns);
      const available = blockLimit - characters;
      if (available <= 0) {
        truncated = true;
        break;
      }
      const text = readable.slice(0, available);
      if (text.length < readable.length) truncated = true;
      if (text.length > 0) {
        items.push(text);
        characters += text.length;
      }
    }
    return {
      block:
        items.length > 0
          ? {
              id: block.id,
              kind: "list",
              items,
              ordered: /^\s*\d+[.)]\s+/.test(block.raw),
            }
          : null,
      characters,
      items: items.length,
      truncated,
    };
  }

  let kind: PreviewBlock["kind"];
  let depth: number | undefined;
  let readable: string;
  if (block.kind === "heading") {
    const match = /^(#{1,6})\s+([\s\S]*)$/.exec(block.raw);
    kind = "heading";
    depth = match?.[1].length ?? 1;
    readable = readableInlineText(match?.[2] ?? block.raw, deletionRuns);
  } else if (block.kind === "paragraph") {
    kind = "paragraph";
    readable = readableInlineText(block.raw, deletionRuns);
  } else if (block.kind === "blockquote") {
    kind = "blockquote";
    readable = readableInlineText(
      block.raw.replace(/^\s*>\s?/gm, ""),
      deletionRuns,
    );
  } else if (block.kind === "code") {
    kind = "code";
    readable = codeText(block.raw);
  } else {
    return { block: null, characters: 0, items: 0, truncated: true };
  }

  const text = readable.slice(0, blockLimit);
  return {
    block: text ? { id: block.id, kind, text, depth } : null,
    characters: text.length,
    items: 0,
    truncated: text.length < readable.length,
  };
}

function renderBlock(block: PreviewBlock, span: BlockViewSpan | undefined, headingId?: string): ReactElement {
  const sourceProps = span ? {
    "data-block-view-key": span.blockViewKey,
    "data-source-view-start": span.start,
    "data-source-view-end": span.end,
  } : {};
  if (block.kind === "heading") {
    return createElement(
      `h${Math.min(6, Math.max(1, block.depth ?? 1))}`,
      { key: block.id, id: headingId, ...sourceProps },
      block.text,
    );
  }
  if (block.kind === "list") {
    return createElement(
      block.ordered ? "ol" : "ul",
      { key: block.id, ...sourceProps },
      block.items?.map((item, index) => (
        <li key={`${block.id}-${index}`}>{item}</li>
      )),
    );
  }
  if (block.kind === "blockquote") {
    return <blockquote key={block.id} {...sourceProps}>{block.text}</blockquote>;
  }
  if (block.kind === "code") {
    return (
      <pre className="markdown-code-source markdown-preview__code" key={block.id} {...sourceProps}>
        <code>{block.text}</code>
      </pre>
    );
  }
  return <p key={block.id} {...sourceProps}>{block.text}</p>;
}

export function FirstReadablePreview({
  document,
  blockViewSpans = [],
}: {
  document: SourceDocument;
  blockViewSpans?: readonly BlockViewSpan[];
}) {
  const { t } = useLocale();
  const rendered: PreviewBlock[] = [];
  const headingIds = buildOutline(document.text);
  let headingIndex = 0;
  let characters = 0;
  let listItems = 0;
  let truncated = false;

  for (const sourceBlock of document.blocks) {
    if (sourceBlock.protected) continue;
    if (rendered.length >= MAX_BLOCKS) {
      truncated = true;
      break;
    }
    const result = previewBlock(
      document,
      sourceBlock,
      MAX_TOTAL_CHARACTERS - characters,
      MAX_LIST_ITEMS - listItems,
    );
    truncated ||= result.truncated;
    characters += result.characters;
    listItems += result.items;
    if (result.block) rendered.push(result.block);
  }

  return (
    <div
      className="markdown-view markdown-preview"
      data-reading-render-ready="false"
      data-testid="first-readable-preview"
    >
      {rendered.map((block) => {
        const id = block.kind === "heading" ? headingIds[headingIndex++]?.id : undefined;
        return renderBlock(block, blockViewSpans.find((span) => span.blockId === block.id), id);
      })}
      {truncated ? (
        <p aria-live="polite" className="markdown-preview__status" role="status">
          {t("preview.layoutPending")}
        </p>
      ) : null}
    </div>
  );
}

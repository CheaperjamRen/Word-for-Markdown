import {
  createContext,
  createElement,
  memo,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Highlight, themes, type Language } from "prism-react-renderer";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "./markdown.css";
import { remarkLenientInlineMarkdown } from "./inline-markdown";
import type { BlockViewSpan } from "../../contracts/markdown";
import { buildOutline } from "../outline";
import { resolveRelativeWindowsPath } from "../../desktop/target-resolver";
import { useLocale } from "../../i18n/locale";
import type { ReadingTheme } from "../../reading/preferences";
import {
  materializeMermaidSvg,
  nextMermaidRenderSequence,
  readCachedMermaidSvg,
  writeCachedMermaidSvg,
} from "./mermaid-cache";

export interface MarkdownViewProps {
  markdown: string;
  onOpenLink?: (href: string) => void;
  documentPath?: string;
  blockViewSpans?: readonly BlockViewSpan[];
  readingTheme?: ReadingTheme;
}

function splitFrontmatter(source: string): {
  frontmatter: string | null;
  body: string;
  bodyOffset: number;
} {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!match) {
    return { frontmatter: null, body: normalized, bodyOffset: 0 };
  }

  return {
    frontmatter: match[1],
    body: normalized.slice(match[0].length),
    bodyOffset: match[0].length,
  };
}

function CodeBlock({
  code,
  language,
  readingTheme,
  sourceProps,
}: {
  code: string;
  language: string;
  readingTheme: ReadingTheme;
  sourceProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const { t } = useLocale();
  const normalizedCode = code.replace(/\n$/, "");
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const canCopy = typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);
  const copyCode = async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(normalizedCode);
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        setCopied(false);
      }, 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="markdown-code-block" data-code-theme={readingTheme === "night" ? "dark" : "light"} {...sourceProps}>
      {language || canCopy ? <div className="markdown-code-header">
        <span className="markdown-code-language">{language || t("code.label")}</span>
        {canCopy ? <button className="markdown-code-copy" onClick={() => void copyCode()} type="button">
          {t(copied ? "code.copied" : "code.copy")}
        </button> : null}
      </div> : null}
      <Highlight
        theme={readingTheme === "night" ? themes.vsDark : themes.github}
        code={normalizedCode}
        language={(language || "text") as Language}
      >
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${className} markdown-code-source`}
            style={{ ...style, background: "transparent" }}
          >
            {tokens.map((line, lineIndex) => (
              <div key={lineIndex} {...getLineProps({ line })}>
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

function MermaidBlock({
  readingTheme,
  source,
  sourceProps,
}: {
  readingTheme: ReadingTheme;
  source: string;
  sourceProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const { t } = useLocale();
  const reactId = useId();
  const sanitizedReactId = useMemo(() => reactId.replace(/[^a-z0-9_-]/gi, ""), [reactId]);
  const instanceDiagramId = `markdown-mermaid-${sanitizedReactId}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const appliedCacheKeyRef = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const mermaidTheme = readingTheme === "night" ? "dark" : "neutral";
  const cacheKey = `${mermaidTheme}\0${source}`;
  const cachedEntry = readCachedMermaidSvg(cacheKey);

  useLayoutEffect(() => {
    if (cachedEntry === undefined || !hostRef.current) return;
    setFailed(false);
    if (appliedCacheKeyRef.current !== cacheKey || hostRef.current.childElementCount === 0) {
      hostRef.current.innerHTML = materializeMermaidSvg(cachedEntry, instanceDiagramId);
      appliedCacheKeyRef.current = cacheKey;
    }
  }, [cacheKey, cachedEntry, instanceDiagramId]);

  useEffect(() => {
    const latestCached = readCachedMermaidSvg(cacheKey);
    if (latestCached !== undefined) {
      if (hostRef.current && (appliedCacheKeyRef.current !== cacheKey || hostRef.current.childElementCount === 0)) {
        hostRef.current.innerHTML = materializeMermaidSvg(latestCached, instanceDiagramId);
        appliedCacheKeyRef.current = cacheKey;
      }
      setFailed(false);
      return;
    }
    let cancelled = false;
    let diagramId: string | null = null;
    setFailed(false);

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          theme: mermaidTheme,
        });
        diagramId = `${instanceDiagramId}-${nextMermaidRenderSequence()}`;
        const { svg } = await mermaid.render(diagramId, source);
        if (cancelled || !hostRef.current) return;
        const entry = { diagramId, svg };
        writeCachedMermaidSvg(cacheKey, entry);
        hostRef.current.innerHTML = materializeMermaidSvg(entry, instanceDiagramId);
        appliedCacheKeyRef.current = cacheKey;
      })
      .catch(() => {
        if (diagramId) {
          document.getElementById(`d${diagramId}`)?.remove();
          document.getElementById(diagramId)?.remove();
        }
        if (cancelled) return;
        appliedCacheKeyRef.current = null;
        hostRef.current?.replaceChildren();
        setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, instanceDiagramId, mermaidTheme, source]);

  return (
    <div className="markdown-mermaid" data-testid="mermaid-diagram" {...sourceProps}>
      <div ref={hostRef} className="markdown-mermaid-canvas" />
      {failed ? (
        <div className="markdown-mermaid-fallback" role="status">
          <p>{t("preview.diagramFallback")}</p>
          <pre>{source}</pre>
        </div>
      ) : null}
    </div>
  );
}

const NO_SPANS: readonly BlockViewSpan[] = [];
const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkLenientInlineMarkdown];

export const MarkdownView = memo(function MarkdownView({
  markdown,
  onOpenLink,
  documentPath,
  blockViewSpans = NO_SPANS,
  readingTheme = "soft-white",
}: MarkdownViewProps) {
  const { t } = useLocale();
  const { frontmatter, body, bodyOffset } = useMemo(() => splitFrontmatter(markdown), [markdown]);
  const outline = useMemo(() => buildOutline(markdown), [markdown]);
  const headingIdsByOffset = useMemo(
    () => new Map(outline.map((item) => [item.sourceOffset, item.id])),
    [outline],
  );
  const blockViewSpansByRange = useMemo(() => {
    const indexed = new Map<string, BlockViewSpan>();
    for (const span of blockViewSpans) {
      const key = `${span.start}:${span.end}`;
      if (indexed.has(key)) throw new Error(`duplicate Reading block span ${key}`);
      indexed.set(key, span);
    }
    return indexed;
  }, [blockViewSpans]);
  const mathLocationHooks = useMemo(() => {
    const mathSpans = blockViewSpans.filter((span) => span.kind === "math");
    return function sourceMathLocationPlugin() {
      return (tree: unknown) => {
        let mathIndex = 0;
        const visit = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          const node = value as {
            properties?: Record<string, unknown>;
            children?: unknown[];
          };
          const classes = node.properties?.className;
          const classNames = Array.isArray(classes) ? classes : typeof classes === "string" ? classes.split(/\s+/) : [];
          if (classNames.includes("katex-display")) {
            const span = mathSpans[mathIndex++];
            if (span) {
              node.properties = {
                ...node.properties,
                "data-block-view-key": span.blockViewKey,
                "data-source-view-start": span.start,
                "data-source-view-end": span.end,
              };
            }
          }
          node.children?.forEach(visit);
        };
        visit(tree);
      };
    };
  }, [blockViewSpans]);
  const rehypePlugins = useMemo(() => [rehypeKatex, mathLocationHooks], [mathLocationHooks]);
  const renderContext = useMemo<MarkdownRenderContextValue>(() => ({
    blockViewSpansByRange,
    bodyOffset,
    documentPath,
    headingIdsByOffset,
    onOpenLink,
    readingTheme,
  }), [blockViewSpansByRange, bodyOffset, documentPath, headingIdsByOffset, onOpenLink, readingTheme]);

  return (
    <div className="markdown-view" data-reading-render-ready="true" data-testid="markdown-view">
      {frontmatter !== null ? (
        <details className="markdown-frontmatter" {...(blockViewSpans[0]?.kind === "yaml" ? {
          "data-block-view-key": blockViewSpans[0].blockViewKey,
          "data-source-view-start": blockViewSpans[0].start,
          "data-source-view-end": blockViewSpans[0].end,
        } : {})}>
          <summary>{t("preview.documentInfo")}</summary>
          <pre>{frontmatter}</pre>
        </details>
      ) : null}

      <MarkdownRenderContext.Provider value={renderContext}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={rehypePlugins}
          components={MARKDOWN_COMPONENTS}
        >
          {body}
        </ReactMarkdown>
      </MarkdownRenderContext.Provider>
    </div>
  );
});

interface AstNode {
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

interface MarkdownRenderContextValue {
  blockViewSpansByRange: ReadonlyMap<string, BlockViewSpan>;
  bodyOffset: number;
  documentPath?: string;
  headingIdsByOffset: ReadonlyMap<number, string>;
  onOpenLink?: (href: string) => void;
  readingTheme: ReadingTheme;
}

const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({
  blockViewSpansByRange: new Map(),
  bodyOffset: 0,
  headingIdsByOffset: new Map(),
  readingTheme: "soft-white",
});

function nodeSourceProps(
  ctx: MarkdownRenderContextValue,
  node: AstNode | undefined,
): HTMLAttributes<HTMLElement> {
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  if (start === undefined || end === undefined) return {};
  const absoluteStart = ctx.bodyOffset + start;
  const absoluteEnd = ctx.bodyOffset + end;
  const span = ctx.blockViewSpansByRange.get(`${absoluteStart}:${absoluteEnd}`);
  return span ? {
    "data-block-view-key": span.blockViewKey,
    "data-source-view-start": span.start,
    "data-source-view-end": span.end,
  } as HTMLAttributes<HTMLElement> : {};
}

function makeHeadingComponent(level: 1 | 2 | 3 | 4 | 5 | 6) {
  return function MarkdownHeading({ node, ...rest }: HTMLAttributes<HTMLHeadingElement> & ExtraProps) {
    const ctx = useContext(MarkdownRenderContext);
    const start = node?.position?.start?.offset;
    const id = start === undefined ? undefined : ctx.headingIdsByOffset.get(ctx.bodyOffset + start);
    return createElement(`h${level}`, { ...nodeSourceProps(ctx, node), ...rest, id });
  };
}

const PreBlockContext = createContext(false);

// Module-constant renderer map: component identities never change across theme, link,
// path, or span updates, so react-markdown updates blocks in place without remounting.
const MARKDOWN_COMPONENTS: Components = {
  h1: makeHeadingComponent(1),
  h2: makeHeadingComponent(2),
  h3: makeHeadingComponent(3),
  h4: makeHeadingComponent(4),
  h5: makeHeadingComponent(5),
  h6: makeHeadingComponent(6),
  p: function MarkdownParagraph({ node, ...rest }) {
    const ctx = useContext(MarkdownRenderContext);
    return <p {...nodeSourceProps(ctx, node)} {...rest} />;
  },
  blockquote: function MarkdownBlockquote({ node, ...rest }) {
    const ctx = useContext(MarkdownRenderContext);
    return <blockquote className="markdown-quote" {...nodeSourceProps(ctx, node)} {...rest} />;
  },
  ul: function MarkdownUnorderedList({ node, ...rest }) {
    const ctx = useContext(MarkdownRenderContext);
    return <ul {...nodeSourceProps(ctx, node)} {...rest} />;
  },
  ol: function MarkdownOrderedList({ node, ...rest }) {
    const ctx = useContext(MarkdownRenderContext);
    return <ol {...nodeSourceProps(ctx, node)} {...rest} />;
  },
  hr: function MarkdownRule({ node, ...rest }) {
    const ctx = useContext(MarkdownRenderContext);
    return <hr {...nodeSourceProps(ctx, node)} {...rest} />;
  },
  a: function MarkdownLink({ href, children }) {
    const { onOpenLink } = useContext(MarkdownRenderContext);
    return (
      <a
        aria-disabled={onOpenLink ? undefined : true}
        className={onOpenLink ? undefined : "markdown-link--disabled"}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          if (href) onOpenLink?.(href);
        }}
        tabIndex={onOpenLink ? undefined : -1}
      >
        {children}
      </a>
    );
  },
  code: function MarkdownCode({ children, className, node }) {
    const ctx = useContext(MarkdownRenderContext);
    const inPre = useContext(PreBlockContext);
    const code = children == null ? "" : String(children);
    const language = /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
    const fenced = inPre || Boolean(language) || code.endsWith("\n");
    if (!fenced) return <code>{children}</code>;
    if (language.toLowerCase() === "mermaid") {
      return <MermaidBlock
        readingTheme={ctx.readingTheme}
        source={code.replace(/\n$/, "")}
        sourceProps={nodeSourceProps(ctx, node) as HTMLAttributes<HTMLDivElement>}
      />;
    }
    return <CodeBlock
      code={code}
      language={language}
      readingTheme={ctx.readingTheme}
      sourceProps={nodeSourceProps(ctx, node) as HTMLAttributes<HTMLDivElement>}
    />;
  },
  pre: function MarkdownPre({ children }) {
    return <PreBlockContext.Provider value={true}>{children}</PreBlockContext.Provider>;
  },
  img: function MarkdownImage({ src, alt }) {
    const { documentPath } = useContext(MarkdownRenderContext);
    const localPath = documentPath && src ? resolveRelativeWindowsPath(documentPath, src) : null;
    let resolvedSrc = src;
    if (localPath) {
      try { resolvedSrc = convertFileSrc(localPath); } catch { resolvedSrc = src; }
    }
    return <img className="markdown-image" src={resolvedSrc} alt={alt ?? ""} loading="lazy" decoding="async" />;
  },
  table: function MarkdownTable({ children, node }) {
    const ctx = useContext(MarkdownRenderContext);
    return (
      <div className="markdown-table-wrap" {...nodeSourceProps(ctx, node)}>
        <table>{children}</table>
      </div>
    );
  },
  input: function MarkdownInput({ node: _node, ...props }) {
    return <input {...props} />;
  },
};

export default MarkdownView;

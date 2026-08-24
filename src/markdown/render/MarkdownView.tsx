import {
  createElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Highlight, themes, type Language } from "prism-react-renderer";
import ReactMarkdown from "react-markdown";
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
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    hostRef.current?.replaceChildren();

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          theme: readingTheme === "night" ? "dark" : "neutral",
        });
        const diagramId = `markdown-mermaid-${reactId.replace(/[^a-z0-9_-]/gi, "")}`;
        const { svg } = await mermaid.render(diagramId, source);
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = svg;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [reactId, readingTheme, source]);

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

export function MarkdownView({ markdown, onOpenLink, documentPath, blockViewSpans = [], readingTheme = "soft-white" }: MarkdownViewProps) {
  const { t } = useLocale();
  const { frontmatter, body, bodyOffset } = splitFrontmatter(markdown);
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
  const sourceProps = (node: {
    position?: { start?: { offset?: number }; end?: { offset?: number } };
  } | undefined): HTMLAttributes<HTMLElement> => {
    const start = node?.position?.start?.offset;
    const end = node?.position?.end?.offset;
    if (start === undefined || end === undefined) return {};
    const absoluteStart = bodyOffset + start;
    const absoluteEnd = bodyOffset + end;
    const span = blockViewSpansByRange.get(`${absoluteStart}:${absoluteEnd}`);
    return span ? {
      "data-block-view-key": span.blockViewKey,
      "data-source-view-start": span.start,
      "data-source-view-end": span.end,
    } as HTMLAttributes<HTMLElement> : {};
  };
  const heading = (
    level: number,
    node: { position?: { start?: { offset?: number }; end?: { offset?: number } } } | undefined,
    rest: Record<string, unknown>,
  ) => {
    const start = node?.position?.start?.offset;
    const id = start === undefined ? undefined : headingIdsByOffset.get(bodyOffset + start);
    return createElement(`h${level}`, { ...sourceProps(node), ...rest, id });
  };

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

      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkLenientInlineMarkdown]}
        rehypePlugins={[rehypeKatex, mathLocationHooks]}
        components={{
          h1: ({ node, ...rest }) => heading(1, node, rest),
          h2: ({ node, ...rest }) => heading(2, node, rest),
          h3: ({ node, ...rest }) => heading(3, node, rest),
          h4: ({ node, ...rest }) => heading(4, node, rest),
          h5: ({ node, ...rest }) => heading(5, node, rest),
          h6: ({ node, ...rest }) => heading(6, node, rest),
          p: ({ node, ...rest }) => <p {...sourceProps(node)} {...rest} />,
          blockquote: ({ node, ...rest }) => <blockquote className="markdown-quote" {...sourceProps(node)} {...rest} />,
          ul: ({ node, ...rest }) => <ul {...sourceProps(node)} {...rest} />,
          ol: ({ node, ...rest }) => <ol {...sourceProps(node)} {...rest} />,
          hr: ({ node, ...rest }) => <hr {...sourceProps(node)} {...rest} />,
          a: ({ href, children }) => (
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
          ),
          code: ({ children, className, node }) => {
            const code = String(children);
            const language = /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
            const fenced = Boolean(language) || code.endsWith("\n");
            if (!fenced) return <code>{children}</code>;
            if (language.toLowerCase() === "mermaid") {
              return <MermaidBlock
                readingTheme={readingTheme}
                source={code.replace(/\n$/, "")}
                sourceProps={sourceProps(node) as HTMLAttributes<HTMLDivElement>}
              />;
            }
            return <CodeBlock
              code={code}
              language={language}
              readingTheme={readingTheme}
              sourceProps={sourceProps(node) as HTMLAttributes<HTMLDivElement>}
            />;
          },
          pre: ({ children }) => <>{children}</>,
          img: ({ src, alt }) => {
            const localPath = documentPath && src ? resolveRelativeWindowsPath(documentPath, src) : null;
            let resolvedSrc = src;
            if (localPath) {
              try { resolvedSrc = convertFileSrc(localPath); } catch { resolvedSrc = src; }
            }
            return <img className="markdown-image" src={resolvedSrc} alt={alt ?? ""} loading="lazy" decoding="async" />;
          },
          table: ({ children, node }) => (
            <div className="markdown-table-wrap" {...sourceProps(node)}>
              <table>{children}</table>
            </div>
          ),
          input: ({ node: _node, ...props }) => <input {...props} />,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownView;

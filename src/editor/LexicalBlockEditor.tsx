import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  HeadingNode,
  QuoteNode,
} from "@lexical/rich-text";
import { $createCodeNode, $isCodeNode, CodeNode } from "@lexical/code-core";
import { $isLinkNode, $toggleLink, LinkNode } from "@lexical/link";
import {
  $insertList,
  $isListNode,
  $removeList,
  ListItemNode,
  ListNode,
} from "@lexical/list";
import { $setBlocksType } from "@lexical/selection";
import {
  $createParagraphNode,
  $createRangeSelection,
  $getSelection,
  $getRoot,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type EditorState,
} from "lexical";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { BlockPatch, SourceBlock } from "../contracts/markdown";
import type {
  ActiveEditorBridge,
  RichFormat,
  RichToolbarState,
} from "./active-editor";
import {
  normalizeGfmDeletionForLexical,
  RICH_MARKDOWN_TRANSFORMERS,
} from "./markdown-transformers";
import "./editor.css";
import { useLocale } from "../i18n/locale";

export interface LexicalBlockEditorProps {
  autoFocus?: boolean;
  block: SourceBlock;
  blockViewKey?: string;
  candidateRevision?: number;
  onPatch(patch: BlockPatch): void;
  registerBridge?(bridge: ActiveEditorBridge): () => void;
  sessionId?: string;
}

interface MarkdownBridgePluginProps {
  markdown: string;
  onMarkdown(markdown: string): void;
}

const EXTERNAL_MARKDOWN_SYNC_TAG = "external-markdown-sync";

function comparableMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/^\u200b+|\u200b+$/g, "")
    .replace(/\n+$/, "");
}

function serializedMarkdown(editorState: EditorState): string {
  return editorState.read(() => comparableMarkdown(
    $convertToMarkdownString([...RICH_MARKDOWN_TRANSFORMERS]),
  ));
}

function MarkdownBridgePlugin({
  markdown,
  onMarkdown,
}: MarkdownBridgePluginProps) {
  const [editor] = useLexicalComposerContext();
  const hydratingRef = useRef(true);
  const composingRef = useRef(false);
  const pendingCompositionRef = useRef(false);
  const lastMarkdownRef = useRef(comparableMarkdown(markdown));
  const lastLocalEmissionRef = useRef<string | null>(null);
  const lastIncomingRef = useRef(comparableMarkdown(markdown));

  useLayoutEffect(() => {
    hydratingRef.current = false;
  }, []);

  const emitMarkdown = useCallback((editorState: EditorState) => {
    const nextMarkdown = serializedMarkdown(editorState);
    if (nextMarkdown === lastMarkdownRef.current) return;
    lastMarkdownRef.current = nextMarkdown;
    lastLocalEmissionRef.current = nextMarkdown;
    onMarkdown(nextMarkdown);
  }, [onMarkdown]);

  useEffect(() => {
    const incoming = comparableMarkdown(markdown);
    if (incoming === lastIncomingRef.current) return;
    lastIncomingRef.current = incoming;
    if (incoming === lastLocalEmissionRef.current) {
      lastLocalEmissionRef.current = null;
      lastMarkdownRef.current = incoming;
      return;
    }
    const current = serializedMarkdown(editor.getEditorState());
    if (current === incoming) {
      lastMarkdownRef.current = incoming;
      return;
    }
    editor.update(() => {
      $convertFromMarkdownString(
        normalizeGfmDeletionForLexical(markdown),
        [...RICH_MARKDOWN_TRANSFORMERS],
      );
    }, { tag: EXTERNAL_MARKDOWN_SYNC_TAG });
  }, [editor, markdown]);

  useEffect(() => {
    const started = () => { composingRef.current = true; };
    const ended = () => {
      composingRef.current = false;
      queueMicrotask(() => {
        if (!pendingCompositionRef.current) return;
        pendingCompositionRef.current = false;
        emitMarkdown(editor.getEditorState());
      });
    };
    let currentRoot: HTMLElement | null = null;
    const unregister = editor.registerRootListener((root, previousRoot) => {
      previousRoot?.removeEventListener("compositionstart", started);
      previousRoot?.removeEventListener("compositionend", ended);
      root?.addEventListener("compositionstart", started);
      root?.addEventListener("compositionend", ended);
      currentRoot = root;
    });
    return () => {
      unregister();
      currentRoot?.removeEventListener("compositionstart", started);
      currentRoot?.removeEventListener("compositionend", ended);
    };
  }, [editor, emitMarkdown]);

  const handleChange = useCallback(
    (editorState: EditorState, _editor: unknown, tags: Set<string>) => {
      if (hydratingRef.current) {
        return;
      }
      if (tags.has(EXTERNAL_MARKDOWN_SYNC_TAG)) {
        lastMarkdownRef.current = serializedMarkdown(editorState);
        lastLocalEmissionRef.current = null;
        return;
      }
      if (composingRef.current || editor.isComposing()) {
        pendingCompositionRef.current = true;
        return;
      }
      pendingCompositionRef.current = false;
      emitMarkdown(editorState);
    },
    [editor, emitMarkdown],
  );

  return (
    <OnChangePlugin
      ignoreHistoryMergeTagChange={false}
      ignoreSelectionChange
      onChange={handleChange}
    />
  );
}

const EMPTY_RICH_STATE: RichToolbarState = {
  canUndo: false,
  canRedo: false,
  canLink: false,
  block: "paragraph",
  formats: { bold: "off", italic: "off", strikethrough: "off", code: "off" },
  list: "none",
  linkUrl: null,
};

function ActiveEditorBridgePlugin({
  blockViewKey,
  blockViewKeys,
  candidateRevision,
  registerBridge,
  sessionId,
}: {
  blockViewKey: string;
  blockViewKeys?: readonly string[];
  candidateRevision: number;
  registerBridge(bridge: ActiveEditorBridge): () => void;
  sessionId: string;
}) {
  const [editor] = useLexicalComposerContext();
  const mountedRef = useRef(true);
  const mountTokenRef = useRef(Symbol("rich-editor-mount"));

  useLayoutEffect(() => {
    mountedRef.current = true;
    const readState = (): RichToolbarState => editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return EMPTY_RICH_STATE;
      const textNodes = selection.getNodes().filter($isTextNode);
      const linkUrls = new Set<string>();
      for (const node of selection.getNodes()) {
        let current = node;
        while (current.getParent() && !$isLinkNode(current)) current = current.getParentOrThrow();
        if ($isLinkNode(current)) linkUrls.add(current.getURL());
      }
      const top = selection.anchor.getNode().getTopLevelElementOrThrow();
      const block: RichToolbarState["block"] = $isHeadingNode(top)
        ? top.getTag()
        : $isQuoteNode(top)
          ? "quote"
          : $isCodeNode(top)
            ? "code"
            : "paragraph";
      const listType = $isListNode(top) ? top.getListType() : null;
      const list: RichToolbarState["list"] = listType === "check"
        ? "task"
        : listType === "bullet" || listType === "number"
          ? listType
          : "none";
      const formats = Object.fromEntries(
        (["bold", "italic", "strikethrough", "code"] as const).map((format) => {
          const enabled = textNodes.filter((node) => node.hasFormat(format)).length;
          return [format, enabled === 0 ? "off" : enabled === textNodes.length ? "on" : "mixed"];
        }),
      ) as RichToolbarState["formats"];
      return {
        ...EMPTY_RICH_STATE,
        block,
        canLink: !selection.isCollapsed() && selection.getTextContent().length > 0,
        formats,
        list,
        linkUrl: linkUrls.size === 1 ? [...linkUrls][0] : null,
      };
    });
    const bridge: ActiveEditorBridge = {
      sessionId,
      candidateRevision,
      blockViewKey,
      mountToken: mountTokenRef.current,
      getState: readState,
      getInsertionBlockViewKey() {
        if (!mountedRef.current) return null;
        return editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return null;
          const children = $getRoot().getChildren();
          const stableKeys = blockViewKeys ?? [blockViewKey];
          if (children.length !== stableKeys.length) return null;
          const top = selection.anchor.getNode().getTopLevelElementOrThrow();
          const index = children.findIndex((child) => child.getKey() === top.getKey());
          return index >= 0 ? stableKeys[index] ?? null : null;
        });
      },
      restoreSelection(bookmark) {
        if (!mountedRef.current) return "stale";
        if (bookmark.blockViewKey !== blockViewKey) return "unsupported";
        let restored = false;
        editor.update(() => {
          const textNodes = $getRoot().getAllTextNodes();
          const pointAt = (requested: number) => {
            const offset = Math.max(0, Math.trunc(requested));
            let consumed = 0;
            for (const node of textNodes) {
              const length = node.getTextContentSize();
              if (offset <= consumed + length) {
                return { node, offset: offset - consumed };
              }
              consumed += length;
            }
            const last = textNodes.at(-1);
            return last ? { node: last, offset: last.getTextContentSize() } : null;
          };
          const anchor = pointAt(bookmark.anchorTextOffset);
          const focus = pointAt(bookmark.focusTextOffset);
          if (!anchor || !focus) return;
          const selection = $createRangeSelection();
          selection.anchor.set(anchor.node.getKey(), anchor.offset, "text");
          selection.focus.set(focus.node.getKey(), focus.offset, "text");
          $setSelection(selection);
          restored = true;
        }, { discrete: true });
        return restored ? "restored" : "unsupported";
      },
      run(command) {
        if (!mountedRef.current) return "stale";
        if (
          command.kind !== "format" &&
          command.kind !== "block" &&
          command.kind !== "list" &&
          command.kind !== "link"
        ) {
          return "rejected";
        }
        let changed = false;
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          if (command.kind === "link") {
            if (command.url !== null && selection.isCollapsed()) return;
            $toggleLink(command.url);
            changed = true;
            return;
          }
          if (command.kind === "list") {
            const current = readState().list;
            if (current === command.value) $removeList();
            else $insertList(command.value === "task" ? "check" : command.value);
            changed = true;
            return;
          }
          if (command.kind === "block") {
            if (readState().list !== "none") $removeList();
            $setBlocksType(selection, () => {
              if (command.value === "paragraph") return $createParagraphNode();
              if (command.value === "quote") return $createQuoteNode();
              if (command.value === "code") return $createCodeNode();
              return $createHeadingNode(command.value);
            });
            changed = true;
            return;
          }
          const format = command.value as RichFormat;
          if (selection.isCollapsed()) {
            const enabled = selection.hasFormat(format);
            if ((command.desired === "on") !== enabled) {
              selection.formatText(format);
              changed = true;
            }
            return;
          }
          for (const node of selection.extract()) {
            if (!$isTextNode(node)) continue;
            const enabled = node.hasFormat(format);
            if ((command.desired === "on") !== enabled) {
              node.toggleFormat(format);
              changed = true;
            }
          }
        });
        if (!changed) return "rejected";
        // A controller commit can synchronously rerender the shell and move
        // focus to the command surface. Restore the document caret after that
        // transaction so toolbar/menu formatting remains keyboard-continuous.
        queueMicrotask(() => {
          if (mountedRef.current) editor.focus();
        });
        return "ran";
      },
      focus() {
        if (!mountedRef.current) return "stale";
        editor.focus();
        return "focused";
      },
      subscribe(listener) {
        return editor.registerUpdateListener(() => listener());
      },
    };
    const unregister = registerBridge(bridge);
    return () => {
      mountedRef.current = false;
      unregister();
    };
  }, [blockViewKey, blockViewKeys, candidateRevision, editor, registerBridge, sessionId]);

  return null;
}

function FocusRequestPlugin({ token }: { token: symbol | null | undefined }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (token) editor.focus();
  }, [editor, token]);
  return null;
}

function ReliableAutoFocusPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let disposed = false;
    const focus = (force: boolean) => {
      if (disposed) return;
      const root = editor.getRootElement();
      const active = document.activeElement;
      if (
        !force &&
        active !== null &&
        active !== document.body &&
        active !== document.documentElement &&
        active !== root
      ) return;
      editor.focus(undefined, { defaultSelection: "rootStart" });
    };
    focus(true);
    const restorePageFocus = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== document.documentElement) return;
      queueMicrotask(() => focus(false));
    };
    document.addEventListener("focusin", restorePageFocus);
    const retry = window.setInterval(() => focus(false), 80);
    const stopRetry = window.setTimeout(() => window.clearInterval(retry), 640);
    return () => {
      disposed = true;
      document.removeEventListener("focusin", restorePageFocus);
      window.clearInterval(retry);
      window.clearTimeout(stopRetry);
    };
  }, [editor]);
  return null;
}

function BlockViewKeyDomPlugin({ blockViewKeys }: { blockViewKeys: readonly string[] }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      const root = editor.getRootElement();
      if (!root) return;
      const children = [...root.children] as HTMLElement[];
      for (const child of children) child.removeAttribute("data-rich-drop-block-key");
      if (children.length !== blockViewKeys.length) return;
      children.forEach((child, index) => {
        child.dataset.richDropBlockKey = blockViewKeys[index]!;
      });
    };
    const unregisterRoot = editor.registerRootListener(() => queueMicrotask(sync));
    const unregisterUpdate = editor.registerUpdateListener(() => queueMicrotask(sync));
    queueMicrotask(sync);
    return () => {
      disposed = true;
      unregisterRoot();
      unregisterUpdate();
    };
  }, [blockViewKeys, editor]);
  return null;
}

export function LexicalBlockEditor({
  autoFocus = false,
  block,
  blockViewKey = block.id,
  candidateRevision = 0,
  onPatch,
  registerBridge,
  sessionId = "standalone",
}: LexicalBlockEditorProps) {
  const { t } = useLocale();
  if (block.protected) {
    throw new Error("protected block");
  }

  if (!["paragraph", "heading", "blockquote", "code", "list"].includes(block.kind)) {
    throw new Error("unsupported block kind");
  }

  return <LexicalMarkdownEditor
    ariaLabel={t("rich.blockEditor")}
    autoFocus={autoFocus}
    blockViewKey={blockViewKey}
    candidateRevision={candidateRevision}
    editorKey={blockViewKey}
    markdown={block.raw}
    onMarkdownChange={(markdown) => onPatch({ blockId: block.id, markdown })}
    registerBridge={registerBridge}
    sessionId={sessionId}
  />;
}

export interface LexicalMarkdownEditorProps {
  ariaLabel: string;
  autoFocus?: boolean;
  blockViewKey: string;
  blockViewKeys?: readonly string[];
  candidateRevision: number;
  editorKey: string;
  focusToken?: symbol | null;
  markdown: string;
  onMarkdownChange(markdown: string): void;
  onFocus?(): void;
  registerBridge?(bridge: ActiveEditorBridge): () => void;
  sessionId: string;
}

export function LexicalMarkdownEditor({
  ariaLabel,
  autoFocus = false,
  blockViewKey,
  blockViewKeys,
  candidateRevision,
  editorKey,
  focusToken,
  markdown,
  onMarkdownChange,
  onFocus,
  registerBridge,
  sessionId,
}: LexicalMarkdownEditorProps) {
  return (
    <LexicalComposer
      key={editorKey}
      initialConfig={{
        namespace: `markdown-rich-${editorKey}`,
        nodes: [HeadingNode, QuoteNode, CodeNode, ListNode, ListItemNode, LinkNode],
        editorState: () => {
          $convertFromMarkdownString(
            normalizeGfmDeletionForLexical(markdown),
            [...RICH_MARKDOWN_TRANSFORMERS],
          );
        },
        onError: (error) => {
          throw error;
        },
      }}
    >
      <section className="lexical-block-editor lexical-document-editor">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              aria-label={ariaLabel}
              className="lexical-block-editor__content lexical-document-editor__content"
              onFocus={onFocus}
              spellCheck
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </section>
      <HistoryPlugin />
      {autoFocus ? <ReliableAutoFocusPlugin /> : null}
      {focusToken ? <FocusRequestPlugin token={focusToken} /> : null}
      {blockViewKeys ? <BlockViewKeyDomPlugin blockViewKeys={blockViewKeys} /> : null}
      {registerBridge ? <ActiveEditorBridgePlugin
        blockViewKey={blockViewKey}
        blockViewKeys={blockViewKeys}
        candidateRevision={candidateRevision}
        registerBridge={registerBridge}
        sessionId={sessionId}
      /> : null}
      <MarkdownShortcutPlugin transformers={[...RICH_MARKDOWN_TRANSFORMERS]} />
      <MarkdownBridgePlugin markdown={markdown} onMarkdown={onMarkdownChange} />
    </LexicalComposer>
  );
}

export default LexicalBlockEditor;

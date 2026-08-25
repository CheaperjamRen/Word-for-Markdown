import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
  redo,
  undo,
} from "@codemirror/commands";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type KeyBinding,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useLayoutEffect, useRef, useState } from "react";

import type { SourceEditorBridge } from "../app/active-source-editor";
import type {
  SourceBufferState,
  SourceChangeAck,
  SourceChangeBatch,
  SourceSelectionRange,
  SourceViewModel,
} from "../contracts/markdown";
import { composePendingChanges, sourceTextEditsFromChangeSet } from "./source-change-set";
import { markSourceEditorContent } from "./source-editor-instance";
import "./source-editor.css";
import { useLocale } from "../i18n/locale";
import type { MessageKey } from "../i18n/messages";

export interface SourceEditorProps {
  sessionId: string;
  candidateRevision: number;
  view: SourceViewModel;
  buffer: SourceBufferState | null;
  readOnly: boolean;
  zoomPercent: number;
  initialSelection: SourceSelectionRange | null;
  initialViewportOffset: number | null;
  onChangeBatch(batch: SourceChangeBatch): SourceChangeAck;
  onSelectionChange(expectedRevision: number, selection: SourceSelectionRange): void;
  onViewportOffsetChange(expectedRevision: number, absoluteOffset: number): void;
  onUndo(expectedRevision: number): boolean;
  onRedo(expectedRevision: number): boolean;
  onSave(): void;
  registerBridge(bridge: SourceEditorBridge): () => void;
}

interface SourceRuntime {
  sessionId: string;
  baseRevision: number;
  pending: ChangeSet;
  historyGroupSequence: number;
  rejected: boolean;
  suppress: boolean;
  destroyed: boolean;
  propRevision: number;
  propView: SourceViewModel;
  propBuffer: SourceBufferState | null;
  pendingSubmission: boolean;
  composing: boolean;
  pendingHistoryIsolation: boolean;
}

const sourceHighlightStyle = HighlightStyle.define([
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: "var(--source-heading)", fontWeight: "650" },
  { tag: tags.emphasis, color: "var(--source-emphasis)", fontStyle: "italic" },
  { tag: tags.strong, color: "var(--source-strong)", fontWeight: "650" },
  { tag: tags.monospace, color: "var(--source-monospace)" },
  { tag: [tags.link, tags.url], color: "var(--source-link)", textDecoration: "underline" },
  { tag: tags.strikethrough, color: "var(--text-secondary)", textDecoration: "line-through" },
  { tag: tags.comment, color: "var(--source-comment)" },
  { tag: tags.invalid, color: "var(--source-invalid)" },
]);

type SourceTranslator = (key: MessageKey) => string;

const SOURCE_TAB_FOCUS_HINT_ID = "source-editor-tab-focus-hint";
const SOURCE_INVALID_NOTE_ID = "source-editor-invalid-note";
const unsupportedMultipleSelectionKeys = new Set([
  "Mod-d",
  "Mod-Shift-l",
  "Mod-Alt-ArrowUp",
  "Mod-Alt-ArrowDown",
]);

export function singleSelectionKeymap(bindings: readonly KeyBinding[]): readonly KeyBinding[] {
  return bindings.filter((binding) =>
    binding.key === undefined || !unsupportedMultipleSelectionKeys.has(binding.key),
  );
}

function sourceDescribedBy(invalid: boolean): string {
  return invalid
    ? `${SOURCE_TAB_FOCUS_HINT_ID} ${SOURCE_INVALID_NOTE_ID}`
    : SOURCE_TAB_FOCUS_HINT_ID;
}

function sourceLocaleExtensions(t: SourceTranslator, editorLabel: string): Extension[] {
  return [
    EditorState.phrases.of({
      Find: t("source.find"),
      Replace: t("source.replace"),
      next: t("source.next"),
      previous: t("source.previous"),
      all: t("source.all"),
      "match case": t("source.matchCase"),
      regexp: t("source.regexp"),
      "by word": t("source.wholeWord"),
      replace: t("source.replace"),
      "replace all": t("source.replaceAll"),
      close: t("source.closeFind"),
      "current match": t("source.currentMatch"),
      "on line": t("source.onLine"),
      "replaced match on line $": t("source.replacedLine"),
      "replaced $ matches": t("source.replacedCount"),
    }),
    EditorView.contentAttributes.of({
      "aria-label": editorLabel,
      "aria-describedby": SOURCE_TAB_FOCUS_HINT_ID,
      "aria-keyshortcuts": "Control+M",
      spellcheck: "false",
    }),
  ];
}

export function sourceTypographyForZoom(zoomPercent: number): {
  fontSize: string;
  lineHeight: string;
} {
  const scale = Number.isFinite(zoomPercent) && zoomPercent > 0 ? zoomPercent / 100 : 1;
  return {
    fontSize: `${14 * scale}px`,
    lineHeight: `${22 * scale}px`,
  };
}

function sourceTheme(zoomPercent: number): Extension {
  const typography = sourceTypographyForZoom(zoomPercent);
  return EditorView.theme({
    "&": {
      height: "100%",
      minWidth: "0",
      minHeight: "0",
      color: "var(--text-primary)",
      backgroundColor: "var(--paper)",
      outline: "0 solid transparent",
    },
    "&.cm-focused": {
      outline: "2px solid var(--focus-ring)",
      outlineOffset: "-2px",
    },
    ".cm-scroller": {
      overflow: "auto",
      minWidth: "0",
      minHeight: "0",
      fontFamily: '"Cascadia Mono", "Segoe UI Mono", Consolas, monospace',
    },
    ".cm-content": {
      minHeight: "100%",
      padding: "14px 20px 24px",
      caretColor: "var(--accent-pressed)",
      fontSize: typography.fontSize,
      lineHeight: typography.lineHeight,
    },
    ".cm-line": { padding: "0 8px" },
    ".cm-gutters": {
      backgroundColor: "var(--chrome)",
      color: "var(--text-secondary)",
      borderRightWidth: "1px",
      borderRightStyle: "solid",
      borderRightColor: "var(--line)",
    },
    ".cm-activeLineGutter": { color: "var(--text-primary)", backgroundColor: "var(--accent-subtle)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--reader-selection)",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--accent-subtle)",
      outline: "1px solid var(--line)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-selected)" },
    ".cm-matchingBracket": {
      backgroundColor: "var(--accent-selected)",
      outline: "1px solid var(--line-strong)",
    },
    ".cm-specialChar": {
      color: "var(--danger)",
      backgroundColor: "color-mix(in srgb, var(--danger) 8%, transparent)",
      borderRadius: "2px",
    },
    ".cm-panels": {
      backgroundColor: "var(--chrome)",
      color: "var(--text-primary)",
      fontFamily: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif',
      fontSize: "12px",
      lineHeight: "16px",
    },
    ".cm-panel.cm-search": {
      display: "flex",
      flexWrap: "wrap",
      gap: "4px 6px",
      alignItems: "center",
      padding: "6px 8px",
      borderBottom: "1px solid var(--line)",
    },
    ".cm-textfield, .cm-button": {
      font: '12px/16px "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    },
  });
}

function safeSelection(selection: SourceSelectionRange | null, length: number): EditorSelection | undefined {
  if (!selection) return undefined;
  const anchor = Math.min(length, Math.max(0, selection.anchor));
  const head = Math.min(length, Math.max(0, selection.head));
  return EditorSelection.single(anchor, head);
}

function initialPending(buffer: SourceBufferState | null, baseLength: number): ChangeSet {
  return buffer
    ? ChangeSet.of(buffer.composedChanges.map((change) => ({ ...change })), baseLength)
    : ChangeSet.empty(baseLength);
}

function resetCodeMirrorHistory(view: EditorView, compartment: Compartment): void {
  view.dispatch({
    effects: compartment.reconfigure([]),
    annotations: Transaction.addToHistory.of(false),
  });
  view.dispatch({
    effects: compartment.reconfigure(history()),
    annotations: Transaction.addToHistory.of(false),
  });
  view.dispatch({
    annotations: [Transaction.addToHistory.of(false), isolateHistory.of("after")],
  });
}

function currentViewportOffset(view: EditorView): number {
  const top = view.scrollDOM.getBoundingClientRect().top;
  const relativeHeight = Math.max(0, (top - view.documentTop) / Math.max(view.scaleY, 0.0001));
  return view.lineBlockAtHeight(relativeHeight).from;
}

export function SourceEditor(props: SourceEditorProps) {
  const { locale, t } = useLocale();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const runtimeRef = useRef<SourceRuntime | null>(null);
  const propsRef = useRef(props);
  const bridgeCleanupRef = useRef<(() => void) | null>(null);
  const liveMountTokenRef = useRef<symbol | null>(null);
  const historyCompartmentRef = useRef(new Compartment());
  const zoomCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const localeCompartmentRef = useRef(new Compartment());
  const appliedZoomRef = useRef(props.zoomPercent);
  const appliedReadOnlyRef = useRef(props.readOnly);
  const appliedLocaleRef = useRef(locale);
  const [invalid, setInvalid] = useState(props.buffer !== null);
  propsRef.current = props;

  useLayoutEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const baseLength = props.buffer?.baseView.text.length ?? props.view.text.length;
    const initialText = props.buffer?.bufferText ?? props.view.text;
    const runtime: SourceRuntime = {
      sessionId: props.sessionId,
      baseRevision: props.buffer?.baseCandidateRevision ?? props.candidateRevision,
      pending: initialPending(props.buffer, baseLength),
      historyGroupSequence: 0,
      rejected: props.buffer !== null,
      suppress: false,
      destroyed: false,
      propRevision: props.candidateRevision,
      propView: props.view,
      propBuffer: props.buffer,
      pendingSubmission: false,
      composing: false,
      pendingHistoryIsolation: false,
    };
    runtimeRef.current = runtime;
    appliedZoomRef.current = props.zoomPercent;
    appliedReadOnlyRef.current = props.readOnly;
    appliedLocaleRef.current = locale;

    const historyCompartment = historyCompartmentRef.current;
    const zoomCompartment = zoomCompartmentRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;
    let view!: EditorView;

    const applicationKeymap = [
      {
        scope: "editor search-panel",
        any: (_view: EditorView, event: KeyboardEvent) => {
          if (
            !(event.ctrlKey || event.metaKey) ||
            event.altKey ||
            event.shiftKey ||
            event.key.toLowerCase() !== "s"
          ) return false;
          event.preventDefault();
          propsRef.current.onSave();
          return true;
        },
      },
      {
        key: "Mod-z",
        scope: "editor search-panel",
        preventDefault: true,
        run: () => {
          if (runtime.rejected) undo(view);
          else propsRef.current.onUndo(runtime.baseRevision);
          return true;
        },
      },
      {
        key: "Mod-y",
        scope: "editor search-panel",
        preventDefault: true,
        run: () => {
          if (runtime.rejected) redo(view);
          else propsRef.current.onRedo(runtime.baseRevision);
          return true;
        },
      },
    ];

    const submitPending = () => {
      if (!runtime.pendingSubmission || runtime.destroyed) return;
      runtime.pendingSubmission = false;
      const main = view.state.selection.main;
      const batch: SourceChangeBatch = {
        sessionId: runtime.sessionId,
        baseCandidateRevision: runtime.baseRevision,
        changes: sourceTextEditsFromChangeSet(runtime.pending).map((change) => ({ ...change })),
        selectionAfter: { anchor: main.anchor, head: main.head },
        historyGroup: {
          id: `${runtime.sessionId}:source:${runtime.historyGroupSequence++}`,
          kind: "atomic",
        },
      };
      const ack = propsRef.current.onChangeBatch(batch);
      if (ack.kind === "accepted") {
        runtime.baseRevision = ack.candidateRevision;
        runtime.pending = ChangeSet.empty(view.state.doc.length);
        runtime.rejected = false;
        view.contentDOM.setAttribute("aria-invalid", "false");
        view.contentDOM.setAttribute("aria-describedby", sourceDescribedBy(false));
        setInvalid(false);
        queueMicrotask(() => {
          if (runtime.destroyed || editorRef.current !== view) return;
          runtime.suppress = true;
          resetCodeMirrorHistory(view, historyCompartment);
          runtime.suppress = false;
        });
      } else if (ack.kind === "rejected") {
        const firstRejectedChange = !runtime.rejected;
        runtime.rejected = true;
        view.contentDOM.setAttribute("aria-invalid", "true");
        view.contentDOM.setAttribute("aria-describedby", sourceDescribedBy(true));
        setInvalid(true);
        if (firstRejectedChange) {
          runtime.pendingHistoryIsolation = true;
          queueMicrotask(() => {
            if (
              runtime.destroyed ||
              editorRef.current !== view ||
              !runtime.pendingHistoryIsolation
            ) return;
            runtime.pendingHistoryIsolation = false;
            runtime.suppress = true;
            view.dispatch({ annotations: isolateHistory.of("after") });
            runtime.suppress = false;
          });
        }
      }
    };

    const state = EditorState.create({
      doc: initialText,
      selection: safeSelection(props.initialSelection, initialText.length),
      extensions: [
        EditorView.lineWrapping,
        lineNumbers(),
        highlightActiveLineGutter(),
        drawSelection(),
        highlightSpecialChars(),
        dropCursor(),
        bracketMatching(),
        markdown({ base: markdownLanguage, pasteURLAsLink: false }),
        syntaxHighlighting(sourceHighlightStyle),
        search({ top: true }),
        highlightSelectionMatches(),
        localeCompartmentRef.current.of(sourceLocaleExtensions(t, t("source.editor"))),
        historyCompartment.of(history()),
        zoomCompartment.of(sourceTheme(props.zoomPercent)),
        readOnlyCompartment.of([
          EditorState.readOnly.of(props.readOnly),
          EditorView.editable.of(!props.readOnly),
        ]),
        EditorView.domEventHandlers({
          compositionstart() {
            runtime.composing = true;
            return false;
          },
          compositionupdate() {
            runtime.composing = true;
            return false;
          },
          compositionend() {
            runtime.composing = false;
            queueMicrotask(() => submitPending());
            return false;
          },
        }),
        EditorState.transactionExtender.of((transaction) => {
          if (
            !transaction.docChanged ||
            transaction.annotation(Transaction.addToHistory) === false
          ) return null;
          if (runtime.pendingHistoryIsolation) {
            return { annotations: isolateHistory.of("before") };
          }
          if (!runtime.rejected && !runtime.pendingSubmission) {
            return { annotations: isolateHistory.of("before") };
          }
          return null;
        }),
        keymap.of([
          ...applicationKeymap,
          indentWithTab,
          ...singleSelectionKeymap(searchKeymap),
          ...singleSelectionKeymap(defaultKeymap),
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (runtime.suppress || runtime.destroyed) return;
          if (update.docChanged) {
            runtime.pending = composePendingChanges(runtime.pending, update.changes);
            runtime.pendingSubmission = true;
            if (!runtime.composing && !view.compositionStarted && !view.composing) submitPending();
          } else if (update.selectionSet) {
            const main = update.state.selection.main;
            propsRef.current.onSelectionChange(runtime.baseRevision, {
              anchor: main.anchor,
              head: main.head,
            });
          }
        }),
      ],
    });

    view = new EditorView({ state, parent });
    const unmarkSourceEditorContent = markSourceEditorContent(
      view.contentDOM,
      () => EditorView.findFromDOM(view.contentDOM),
    );
    editorRef.current = view;
    view.contentDOM.setAttribute("aria-invalid", runtime.rejected ? "true" : "false");
    view.contentDOM.setAttribute("aria-describedby", sourceDescribedBy(runtime.rejected));

    const reportViewport = () => {
      if (runtime.suppress || runtime.destroyed) return;
      propsRef.current.onViewportOffsetChange(runtime.baseRevision, currentViewportOffset(view));
    };
    view.scrollDOM.addEventListener("scroll", reportViewport, { passive: true });
    if (props.initialViewportOffset !== null) {
      view.dispatch({
        effects: EditorView.scrollIntoView(
          Math.min(initialText.length, Math.max(0, props.initialViewportOffset)),
          { y: "start" },
        ),
        annotations: Transaction.addToHistory.of(false),
      });
    }

    return () => {
      runtime.destroyed = true;
      view.scrollDOM.removeEventListener("scroll", reportViewport);
      bridgeCleanupRef.current?.();
      bridgeCleanupRef.current = null;
      liveMountTokenRef.current = null;
      if (editorRef.current === view) editorRef.current = null;
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      unmarkSourceEditorContent();
      view.destroy();
    };
  }, [props.sessionId]);

  useLayoutEffect(() => {
    const view = editorRef.current;
    const runtime = runtimeRef.current;
    if (!view || !runtime || runtime.destroyed) return;
    const targetText = props.buffer?.bufferText ?? props.view.text;
    const targetBaseLength = props.buffer?.baseView.text.length ?? props.view.text.length;
    const targetRevision = props.buffer?.baseCandidateRevision ?? props.candidateRevision;
    const targetRejected = props.buffer !== null;
    const externalDocumentChanged =
      props.candidateRevision !== runtime.propRevision ||
      props.view !== runtime.propView ||
      props.buffer !== runtime.propBuffer;
    const selection = safeSelection(props.initialSelection, targetText.length);
    const currentSelection = view.state.selection.main;
    const selectionChanged = Boolean(selection && (
      currentSelection.anchor !== selection.main.anchor ||
      currentSelection.head !== selection.main.head
    ));
    const docChanged = externalDocumentChanged && view.state.doc.toString() !== targetText;

    runtime.suppress = true;
    try {
      if (docChanged || selectionChanged) {
        view.dispatch({
          changes: docChanged ? { from: 0, to: view.state.doc.length, insert: targetText } : undefined,
          selection,
          annotations: [Transaction.addToHistory.of(false), isolateHistory.of("before")],
        });
      }
      if (
        externalDocumentChanged && (
          runtime.baseRevision !== targetRevision ||
          runtime.rejected !== targetRejected ||
          docChanged
        )
      ) {
        runtime.baseRevision = targetRevision;
        runtime.pending = initialPending(props.buffer, targetBaseLength);
        runtime.pendingSubmission = false;
        runtime.pendingHistoryIsolation = false;
        runtime.rejected = targetRejected;
        resetCodeMirrorHistory(view, historyCompartmentRef.current);
      }
      if (externalDocumentChanged) {
        runtime.propRevision = props.candidateRevision;
        runtime.propView = props.view;
        runtime.propBuffer = props.buffer;
      }
      if (docChanged && props.initialViewportOffset !== null) {
        view.dispatch({
          effects: EditorView.scrollIntoView(
            Math.min(targetText.length, Math.max(0, props.initialViewportOffset)),
            { y: "start" },
          ),
          annotations: Transaction.addToHistory.of(false),
        });
      }
    } finally {
      runtime.suppress = false;
    }
    view.contentDOM.setAttribute("aria-invalid", targetRejected ? "true" : "false");
    view.contentDOM.setAttribute("aria-describedby", sourceDescribedBy(targetRejected));
    if (invalid !== targetRejected) setInvalid(targetRejected);

  }, [
    props.candidateRevision,
    props.view,
    props.buffer,
    props.initialSelection,
  ]);

  useLayoutEffect(() => {
    const view = editorRef.current;
    const runtime = runtimeRef.current;
    if (
      !view ||
      !runtime ||
      runtime.destroyed ||
      appliedZoomRef.current === props.zoomPercent
    ) return;
    appliedZoomRef.current = props.zoomPercent;
    runtime.suppress = true;
    view.dispatch({
      effects: zoomCompartmentRef.current.reconfigure(sourceTheme(props.zoomPercent)),
      annotations: Transaction.addToHistory.of(false),
    });
    runtime.suppress = false;
    view.requestMeasure();
  }, [props.zoomPercent]);

  useLayoutEffect(() => {
    const view = editorRef.current;
    const runtime = runtimeRef.current;
    if (
      !view ||
      !runtime ||
      runtime.destroyed ||
      appliedReadOnlyRef.current === props.readOnly
    ) return;
    appliedReadOnlyRef.current = props.readOnly;
    runtime.suppress = true;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(props.readOnly),
        EditorView.editable.of(!props.readOnly),
      ]),
      annotations: Transaction.addToHistory.of(false),
    });
    runtime.suppress = false;
  }, [props.readOnly]);

  useLayoutEffect(() => {
    const view = editorRef.current;
    const runtime = runtimeRef.current;
    if (!view || !runtime || runtime.destroyed || appliedLocaleRef.current === locale) return;
    appliedLocaleRef.current = locale;
    view.dispatch({
      effects: localeCompartmentRef.current.reconfigure(sourceLocaleExtensions(t, t("source.editor"))),
      annotations: Transaction.addToHistory.of(false),
    });
  }, [locale, t]);

  useLayoutEffect(() => {
    const view = editorRef.current;
    const runtime = runtimeRef.current;
    if (!view || !runtime || runtime.destroyed) return;
    const mountToken = Symbol(`${props.sessionId}:${props.candidateRevision}`);
    liveMountTokenRef.current = mountToken;
    const isCurrent = () =>
      editorRef.current === view &&
      runtimeRef.current === runtime &&
      !runtime.destroyed &&
      liveMountTokenRef.current === mountToken &&
      runtime.baseRevision === props.candidateRevision;
    const bridge: SourceEditorBridge = {
      sessionId: props.sessionId,
      candidateRevision: props.candidateRevision,
      mountToken,
      hasSelection: () => isCurrent() && !view.state.selection.main.empty,
      copy: async () => {
        if (!isCurrent()) return "stale";
        const selection = view.state.selection.main;
        const writeText = navigator.clipboard?.writeText;
        if (selection.empty || typeof writeText !== "function") {
          view.focus();
          return "failed";
        }
        const text = view.state.sliceDoc(selection.from, selection.to);
        try {
          if (document.execCommand?.("copy")) {
            if (!isCurrent()) return "stale";
            view.focus();
            return "copied";
          }
        } catch {
          // Fall through to the Clipboard API when the synchronous browser copy is unavailable.
        }
        try {
          await writeText.call(navigator.clipboard, text);
        } catch {
          if (!isCurrent()) return "stale";
          view.focus();
          return "failed";
        }
        if (!isCurrent()) return "stale";
        view.focus();
        return "copied";
      },
      selectAll: () => {
        if (!isCurrent()) return "stale";
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        view.focus();
        return "selected";
      },
      openFind: () => {
        if (!isCurrent()) return "stale";
        openSearchPanel(view);
        return "opened";
      },
      focus: () => {
        if (!isCurrent()) return "stale";
        view.focus();
        return "focused";
      },
    };
    const unregister = props.registerBridge(bridge);
    let active = true;
    bridgeCleanupRef.current = () => {
      if (!active) return;
      active = false;
      unregister();
      if (liveMountTokenRef.current === mountToken) liveMountTokenRef.current = null;
    };
    return () => bridgeCleanupRef.current?.();
  }, [
    props.sessionId,
    props.candidateRevision,
    props.registerBridge,
  ]);

  return <div className="source-editor">
    <div className="source-editor__mount" ref={hostRef} />
    <span className="source-editor__sr-hint" id={SOURCE_TAB_FOCUS_HINT_ID}>{t("source.tabFocusHint")}</span>
    {invalid ? <div className="source-editor__invalid-note" id={SOURCE_INVALID_NOTE_ID} role="note">
      {t("source.invalid")}
    </div> : null}
  </div>;
}

export default SourceEditor;

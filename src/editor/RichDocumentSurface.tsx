import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { DocumentSession } from "../documents/session";
import { LexicalBlockEditor, LexicalMarkdownEditor } from "./LexicalBlockEditor";
import type { DocumentController } from "../app/use-document-controller";
import { ShellIcon } from "../app/shell/icons";
import type { ActiveEditorRegistry } from "./active-editor";
import { documentEditsAreEnabled } from "../documents/session";
import { ProtectedRawEditor } from "./ProtectedRawEditor";
import { TableEditor } from "./table/TableEditor";
import "./editor.css";
import { useLocale } from "../i18n/locale";
import type { MessageKey } from "../i18n/messages";

export interface RichDocumentSurfaceProps {
  controller: DocumentController;
  registry: ActiveEditorRegistry;
  tab: DocumentSession;
}

function blockLabelKey(kind: string): MessageKey {
  if (kind === "heading") return "block.heading";
  if (kind === "paragraph") return "block.paragraphObject";
  if (kind === "blockquote") return "block.blockquote";
  if (kind === "list") return "block.list";
  if (kind === "code") return "block.code";
  if (kind === "table") return "block.table";
  return "block.protected";
}

function isMermaidBlock(block: DocumentSession["candidate"]["blocks"][number]): boolean {
  return block.kind === "code" && /^(?:```|~~~)\s*mermaid\b/i.test(block.raw);
}

function objectLabelKey(block: DocumentSession["candidate"]["blocks"][number]): MessageKey {
  if (block.kind === "table") return "block.table";
  if (block.kind === "math") return "block.math";
  if (block.kind === "code") return "block.code";
  if (block.kind === "yaml") return "block.yaml";
  if (block.protected) return "block.protected";
  return blockLabelKey(block.kind);
}

function richRunEditable(block: DocumentSession["candidate"]["blocks"][number]): boolean {
  if (block.protected) return false;
  return ["paragraph", "heading", "blockquote", "list"].includes(block.kind);
}

type RichSegment =
  | {
      kind: "editor";
      index: number;
      blockViewKeys: readonly string[];
      firstBlockViewKey: string;
      lastBlockViewKey: string;
      markdown: string;
      runKey: string;
    }
  | {
      kind: "island";
      index: number;
      block: DocumentSession["candidate"]["blocks"][number];
      blockViewKey: string | null;
    };

function richSegments(tab: DocumentSession): RichSegment[] {
  const segments: RichSegment[] = [];
  let run: DocumentSession["candidate"]["blocks"] = [];
  let previousIslandKey: string | null = null;
  const flush = (nextIslandKey: string | null) => {
    if (run.length === 0) return;
    const first = run[0]!;
    const last = run.at(-1)!;
    const blockViewKeys = run.map((block) => tab.blockViewKeys.get(block.id)).filter(
      (value): value is string => value !== undefined,
    );
    if (blockViewKeys.length === run.length) {
      segments.push({
        kind: "editor",
        index: segments.length,
        blockViewKeys,
        firstBlockViewKey: blockViewKeys[0]!,
        lastBlockViewKey: blockViewKeys.at(-1)!,
        markdown: tab.candidate.text.slice(first.start, last.end),
        runKey: `${previousIslandKey ?? "START"}:${nextIslandKey ?? "END"}`,
      });
    } else {
      for (const block of run) {
        segments.push({
          kind: "island",
          index: segments.length,
          block,
          blockViewKey: tab.blockViewKeys.get(block.id) ?? null,
        });
      }
    }
    run = [];
  };

  for (const block of tab.candidate.blocks) {
    if (richRunEditable(block)) {
      run = [...run, block];
      continue;
    }
    const blockViewKey = tab.blockViewKeys.get(block.id) ?? null;
    flush(blockViewKey);
    segments.push({
      kind: "island",
      index: segments.length,
      block,
      blockViewKey,
    });
    previousIslandKey = blockViewKey;
  }
  flush(null);
  if (segments.length === 0) {
    const emptyBlockViewKey = `${tab.id}:empty`;
    segments.push({
      kind: "editor",
      index: 0,
      blockViewKeys: [],
      firstBlockViewKey: emptyBlockViewKey,
      lastBlockViewKey: emptyBlockViewKey,
      markdown: "",
      runKey: "START:END",
    });
  }
  return segments;
}

function markdownForCandidateNewline(markdown: string, tab: DocumentSession): string {
  return tab.candidate.newline === "crlf" ? markdown.replace(/\r?\n/g, "\r\n") : markdown;
}

export function RichDocumentSurface({ controller, registry, tab }: RichDocumentSurfaceProps) {
  const { locale, t } = useLocale();
  const [activeBlockKey, setActiveBlockKey] = useState<string | null>(null);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number | null>(null);
  const [selectedObjectKey, setSelectedObjectKey] = useState<string | null>(null);
  const [draggedObjectKey, setDraggedObjectKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ beforeBlockViewKey: string | null; top: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{
    blockViewKey: string;
    dragging: boolean;
    handle: HTMLButtonElement;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const segments = useMemo(() => richSegments(tab), [tab]);
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const activation = registry.getActivation(tab.id, tab.revision);
  useEffect(() => {
    if (!activation?.blockViewKey) return;
    const activeSegment = segments.find((segment) => segment.kind === "editor"
      ? segment.blockViewKeys.includes(activation.blockViewKey)
      : segment.blockViewKey === activation.blockViewKey);
    if (activeSegment) {
      setActiveBlockKey(activation.blockViewKey);
      setActiveSegmentIndex(activeSegment.index);
    }
  }, [activation?.blockViewKey, activation?.token, segments]);
  const registerBridge = useCallback(
    (bridge: Parameters<ActiveEditorRegistry["register"]>[0]) => registry.register(bridge),
    [registry],
  );
  const blockOrder = useMemo(() => tab.candidate.blocks.flatMap((block) => {
    const key = tab.blockViewKeys.get(block.id);
    return key ? [key] : [];
  }), [tab]);
  const canMoveObjects = tab.status !== "saving" && tab.sourceBuffer === null && documentEditsAreEnabled(tab);
  const clearDrag = () => {
    const pointerDrag = pointerDragRef.current;
    if (pointerDrag) {
      try {
        pointerDrag.handle.releasePointerCapture(pointerDrag.pointerId);
      } catch {
        // The browser may have already released capture after pointercancel.
      }
    }
    pointerDragRef.current = null;
    setDraggedObjectKey(null);
    setDropTarget(null);
  };
  const moveObject = (blockViewKey: string, beforeBlockViewKey: string | null) => {
    const currentIndex = blockOrder.indexOf(blockViewKey);
    if (
      currentIndex < 0 ||
      beforeBlockViewKey === blockViewKey ||
      beforeBlockViewKey === (blockOrder[currentIndex + 1] ?? null)
    ) return;
    controller.commitRichEdit({
      sessionId: tab.id,
      baseCandidateRevision: tab.revision,
      mutations: [{ kind: "move-block", blockViewKey, beforeBlockViewKey }],
      selectionAfter: null,
    });
  };
  const keyboardMove = (blockViewKey: string, direction: -1 | 1) => {
    const index = blockOrder.indexOf(blockViewKey);
    if (index < 0) return;
    if (direction < 0) {
      if (index === 0) return;
      moveObject(blockViewKey, blockOrder[index - 1]!);
      return;
    }
    if (index === blockOrder.length - 1) return;
    moveObject(blockViewKey, blockOrder[index + 2] ?? null);
  };
  const targetAt = (clientY: number) => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const entries = [...surface.querySelectorAll<HTMLElement>("[data-rich-drop-block-key]")]
      .map((element) => ({
        beforeBlockViewKey: element.dataset.richDropBlockKey ?? null,
        rect: element.getBoundingClientRect(),
      }))
      .filter((entry): entry is { beforeBlockViewKey: string; rect: DOMRect } => entry.beforeBlockViewKey !== null)
      .sort((left, right) => left.rect.top - right.rect.top);
    if (entries.length === 0) return null;
    const next = entries.find((entry) => clientY < entry.rect.top + entry.rect.height / 2);
    const boundaryTop = next?.rect.top ?? entries.at(-1)!.rect.bottom;
    return {
      beforeBlockViewKey: next?.beforeBlockViewKey ?? null,
      top: Math.max(0, boundaryTop - surface.getBoundingClientRect().top),
    };
  };

  return (
    <div
      aria-label={t("rich.editor")}
      className="rich-document-surface"
      data-document-search-content
      data-testid="rich-document-surface"
      data-ui-contract="document"
      onPointerCancelCapture={(event) => {
        if (pointerDragRef.current?.pointerId !== event.pointerId) return;
        clearDrag();
      }}
      onPointerMoveCapture={(event) => {
        const pointerDrag = pointerDragRef.current;
        if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
        if (!pointerDrag.dragging) {
          const distance = Math.hypot(
            event.clientX - pointerDrag.startX,
            event.clientY - pointerDrag.startY,
          );
          if (distance < 4) return;
          pointerDrag.dragging = true;
          setDraggedObjectKey(pointerDrag.blockViewKey);
        }
        event.preventDefault();
        event.stopPropagation();
        const next = targetAt(event.clientY);
        if (next) setDropTarget((current) =>
          current?.beforeBlockViewKey === next.beforeBlockViewKey && current.top === next.top ? current : next,
        );
      }}
      onPointerUpCapture={(event) => {
        const pointerDrag = pointerDragRef.current;
        if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const target = pointerDrag.dragging ? (targetAt(event.clientY) ?? dropTarget) : null;
        if (target) moveObject(pointerDrag.blockViewKey, target.beforeBlockViewKey);
        clearDrag();
      }}
      ref={surfaceRef}
    >
      {draggedObjectKey && dropTarget ? (
        <div
          aria-hidden="true"
          className="rich-document-surface__drop-indicator"
          data-rich-drop-indicator="true"
          style={{ top: dropTarget.top }}
        />
      ) : null}
      {segments.map((segment) => {
        if (segment.kind === "editor") {
          const active = activeSegmentIndex === segment.index;
          const bridgeBlockViewKey = activeBlockKey !== null && segment.blockViewKeys.includes(activeBlockKey)
            ? activeBlockKey
            : segment.firstBlockViewKey;
          return (
            <div
              className={`rich-document-surface__run${active ? " rich-document-surface__run--active" : ""}`}
              data-rich-editor-run="true"
              key={`editor-run:${tab.id}:${segment.runKey}`}
            >
              <LexicalMarkdownEditor
                ariaLabel={t("rich.documentEditor")}
                autoFocus={segment.blockViewKeys.length === 0}
                blockViewKey={bridgeBlockViewKey}
                blockViewKeys={segment.blockViewKeys}
                candidateRevision={tab.revision}
                editorKey={`${tab.id}:run:${segment.runKey}`}
                focusToken={active ? activation?.token : undefined}
                markdown={segment.markdown}
                onFocus={() => {
                  setActiveBlockKey(segment.firstBlockViewKey);
                  setActiveSegmentIndex(segment.index);
                }}
                onMarkdownChange={(markdown) => {
                  const live = controller.tabs.find((candidate) => candidate.id === tab.id);
                  if (live?.kind !== "document" || live.mode !== "rich") return;
                  const liveSegment = richSegments(live)[segment.index];
                  if (liveSegment?.kind !== "editor") return;
                  if (liveSegment.blockViewKeys.length === 0) {
                    controller.commitRichEdit({
                      sessionId: live.id,
                      baseCandidateRevision: live.revision,
                      mutations: [{
                        kind: "insert-after",
                        blockViewKey: null,
                        markdown: markdownForCandidateNewline(markdown, live),
                      }],
                      selectionAfter: null,
                    });
                    return;
                  }
                  controller.commitRichEdit({
                    sessionId: live.id,
                    baseCandidateRevision: live.revision,
                    mutations: [{
                      kind: "replace-range",
                      firstBlockViewKey: liveSegment.firstBlockViewKey,
                      lastBlockViewKey: liveSegment.lastBlockViewKey,
                      markdown: markdownForCandidateNewline(markdown, live),
                    }],
                    selectionAfter: null,
                  });
                }}
                registerBridge={active ? registerBridge : undefined}
                sessionId={tab.id}
              />
            </div>
          );
        }
        const { block, blockViewKey } = segment;
        const active = blockViewKey !== null && activeSegmentIndex === segment.index;
        const editable = block.kind === "table" || (block.kind === "code" && !isMermaidBlock(block));
        const label = isMermaidBlock(block) ? "Mermaid" : t(objectLabelKey(block));
        const moveLabel = locale === "zh-CN" && /^[A-Za-z]/.test(label)
          ? `移动 ${label}`
          : t("block.move", { name: label });
        return (
          <div
            className={`rich-object-shell${selectedObjectKey === blockViewKey ? " rich-object-shell--selected" : ""}${draggedObjectKey === blockViewKey ? " rich-object-shell--dragging" : ""}`}
            data-rich-drop-block-key={blockViewKey ?? undefined}
            key={`island:${blockViewKey ?? block.id}`}
          >
            <button
              aria-label={moveLabel}
              className="rich-object-shell__handle"
              disabled={!canMoveObjects || !blockViewKey}
              onClick={(event) => {
                event.stopPropagation();
                if (blockViewKey) setSelectedObjectKey(blockViewKey);
              }}
              onPointerDown={(event) => {
                if (!blockViewKey || !canMoveObjects || event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                setSelectedObjectKey(blockViewKey);
                event.currentTarget.setPointerCapture?.(event.pointerId);
                pointerDragRef.current = {
                  blockViewKey,
                  dragging: false,
                  handle: event.currentTarget,
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                };
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  clearDrag();
                  return;
                }
                if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || !blockViewKey) return;
                event.preventDefault();
                keyboardMove(blockViewKey, event.key === "ArrowUp" ? -1 : 1);
              }}
              title={moveLabel}
              type="button"
            >
              <ShellIcon name="grip" />
            </button>
            <div
              className={`rich-document-surface__block${active ? " rich-document-surface__block--active" : ""}`}
              data-block-view-key={blockViewKey ?? undefined}
              data-rich-block-kind={block.kind}
              onClick={() => {
                if (!editable || !blockViewKey) return;
                setActiveBlockKey(blockViewKey);
                setActiveSegmentIndex(segment.index);
              }}
            >
              {active && blockViewKey && block.kind === "table" ? (
                <TableEditor
                  block={block}
                  blockViewKey={blockViewKey}
                  candidateRevision={tab.revision}
                  controller={controller}
                  registerBridge={registerBridge}
                  sessionId={tab.id}
                  tab={tab}
                />
              ) : active && blockViewKey && block.kind === "code" && !isMermaidBlock(block) ? (
                <LexicalBlockEditor
                  autoFocus
                  block={block}
                  blockViewKey={blockViewKey}
                  candidateRevision={tab.revision}
                  onPatch={(patch) => {
                    controller.commitRichEdit({
                      sessionId: tab.id,
                      baseCandidateRevision: tab.revision,
                      mutations: [{ kind: "replace-block", blockViewKey, markdown: patch.markdown }],
                      selectionAfter: null,
                    });
                  }}
                  registerBridge={registerBridge}
                  sessionId={tab.id}
                />
              ) : (
                <div
                  aria-label={`${t(blockLabelKey(block.kind))}${block.protected ? ` (${t("block.sourceEntry")})` : ""}`}
                  className="rich-document-surface__passive"
                  data-rich-passive="true"
                >
                  {block.protected && blockViewKey ? (
                    tab.protectedRawBuffer?.blockViewKey === blockViewKey ? (
                      <ProtectedRawEditor
                        error={tab.protectedRawBuffer.validationError}
                        onCancel={() => {
                          controller.cancelProtectedRawEdit(tab.id, tab.revision, blockViewKey);
                        }}
                        onChange={(value) => {
                          controller.updateProtectedRawBuffer(tab.id, tab.revision, blockViewKey, value);
                        }}
                        onSave={() => {
                          controller.commitProtectedRawEdit(tab.id, tab.revision, blockViewKey);
                        }}
                        value={tab.protectedRawBuffer.bufferText}
                      />
                    ) : (
                      <div className="rich-document-surface__protected-card">
                        <div className="rich-document-surface__protected-heading">
                          <span>{block.kind === "yaml" ? t("raw.documentInfoSource") : t("block.protected")}</span>
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              controller.beginProtectedRawEdit(tab.id, tab.revision, blockViewKey);
                            }}
                            type="button"
                          >{t("raw.edit")}</button>
                        </div>
                        <pre className="rich-document-surface__protected-raw">{block.raw}</pre>
                      </div>
                    )
                  ) : (
                    <ReactMarkdown
                      components={{
                        table: ({ node: _node, ...props }) => (
                          <div className="rich-document-surface__passive-table-wrap">
                            <table {...props} />
                          </div>
                        ),
                      }}
                      remarkPlugins={[remarkGfm]}
                    >{block.raw}</ReactMarkdown>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default RichDocumentSurface;

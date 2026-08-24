import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
  type UIEvent,
} from "react";

import type { ActiveSourceEditorRegistry, SourceEditorBridge } from "../app/active-source-editor";
import { fileNameForDisplay } from "../app/path-display";
import type { DocumentController } from "../app/use-document-controller";
import { createActiveEditorRegistry, type ActiveEditorRegistry } from "../editor/active-editor";
import type { DocumentSession } from "../documents/session";
import { documentEditsAreEnabled } from "../documents/session";
import { buildBlockViewSpans } from "../markdown/source-view";
import {
  sourceOffsetForViewportAnchor,
  sourceRangeForSelection,
  textSelectionForSourceRange,
  viewportAnchorForSourceOffset,
} from "../source/source-selection";
import "../app/app.css";
import { stepDocumentZoom, clampDocumentZoom, type DocumentZoomMode } from "./zoom";
import type { DocumentLayout } from "./layout";
import { useLocale } from "../i18n/locale";
import {
  DEFAULT_READING_PREFERENCES,
  type ReadingPreferences,
} from "../reading/preferences";
import { readReadingPosition, writeReadingPosition } from "../reading/position-store";
import {
  anchoredScrollPosition,
  documentBaseWidth,
  type ViewportPoint,
} from "./zoom-geometry";

const SourceEditor = lazy(() => import("../source/SourceEditor"));
const richDocumentSurfaceModule = import("../editor/RichDocumentSurface");
const RichDocumentSurface = lazy(() => richDocumentSurfaceModule);

export interface DocumentSurfaceProps {
  controller: DocumentController;
  richRegistry?: ActiveEditorRegistry;
  registry: ActiveSourceEditorRegistry;
  tab: DocumentSession;
  layout?: DocumentLayout;
  zoomMode?: DocumentZoomMode;
  renderReading(blockViewSpans: ReturnType<typeof buildBlockViewSpans>, onOpenLink?: (href: string) => void): ReactNode;
  onOpenLink?: (href: string) => void;
  readingPreferences?: ReadingPreferences;
}

export const DocumentSurface = memo(function DocumentSurface({
  controller,
  richRegistry,
  registry,
  tab,
  layout = "a4",
  zoomMode = "canvas",
  renderReading,
  onOpenLink,
  readingPreferences = DEFAULT_READING_PREFERENCES,
}: DocumentSurfaceProps) {
  const { t } = useLocale();
  const documentViewportRef = useRef<HTMLDivElement>(null);
  const documentPaperRef = useRef<HTMLElement>(null);
  const assignDocumentPaper = useCallback((node: HTMLElement | null) => {
    documentPaperRef.current = node;
  }, []);
  const [viewportWidth, setViewportWidth] = useState(0);
  const restoringReadingRef = useRef(false);
  const readingRestoreTokenRef = useRef(0);
  const pendingReadingPositionRef = useRef<{
    canonicalPath: string;
    sourceOffset: number;
    updatedAt: number;
  } | null>(null);
  const readingPositionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackRichRegistryRef = useRef<ActiveEditorRegistry | null>(null);
  if (!fallbackRichRegistryRef.current) fallbackRichRegistryRef.current = createActiveEditorRegistry();
  const resolvedRichRegistry = richRegistry ?? fallbackRichRegistryRef.current;
  const sourceView = useMemo(
    () => controller.getSourceView(tab.id, tab.revision),
    [controller, tab.id, tab.revision, tab.candidate],
  );
  const blockViewSpans = useMemo(
    () => sourceView
      ? buildBlockViewSpans(tab.candidate, sourceView, tab.blockViewKeys)
      : [],
    [sourceView, tab.candidate, tab.blockViewKeys],
  );
  const sourceProjectionText = tab.sourceBuffer?.bufferText ?? sourceView?.text ?? "";
  const sourceProjectionSpans = tab.sourceBuffer ? [] : blockViewSpans;
  const persistentReadingPath = tab.file.kind === "local" && tab.status === "clean"
    ? tab.file.canonicalPath
    : null;
  const storedReadingOffset = useMemo(() => {
    if (
      tab.mode !== "reading" ||
      tab.viewState.scrollAnchor !== null ||
      persistentReadingPath === null
    ) return null;
    return readReadingPosition(persistentReadingPath)?.sourceOffset ?? null;
  }, [tab.id, tab.mode, tab.viewState.scrollAnchor, persistentReadingPath]);
  const initialSelection = useMemo(
    () => sourceView
      ? sourceRangeForSelection(
          tab.viewState.selection,
          sourceProjectionSpans,
          sourceProjectionText,
        )
      : null,
    [sourceView, sourceProjectionSpans, sourceProjectionText, tab.viewState.selection],
  );
  const initialViewportOffset = useMemo(
    () => {
      if (!sourceView) return null;
      if (tab.sourceBuffer && tab.viewState.scrollAnchor?.blockViewKey !== null) {
        const acceptedOffset = sourceOffsetForViewportAnchor(
          tab.viewState.scrollAnchor,
          blockViewSpans,
          sourceView.text,
        );
        return acceptedOffset === null
          ? null
          : Math.min(sourceProjectionText.length, acceptedOffset);
      }
      const sessionOffset = sourceOffsetForViewportAnchor(
        tab.viewState.scrollAnchor,
        sourceProjectionSpans,
        sourceProjectionText,
      );
      if (sessionOffset !== null) return sessionOffset;
      return storedReadingOffset === null
        ? null
        : Math.min(sourceProjectionText.length, storedReadingOffset);
    },
    [
      sourceView,
      sourceProjectionSpans,
      sourceProjectionText,
      blockViewSpans,
      tab.sourceBuffer,
      tab.viewState.scrollAnchor,
      storedReadingOffset,
    ],
  );
  const flushReadingPosition = useCallback(() => {
    if (readingPositionTimerRef.current !== null) {
      clearTimeout(readingPositionTimerRef.current);
      readingPositionTimerRef.current = null;
    }
    const pending = pendingReadingPositionRef.current;
    pendingReadingPositionRef.current = null;
    if (pending) writeReadingPosition(pending.canonicalPath, pending);
  }, []);
  const scheduleReadingPosition = useCallback((canonicalPath: string, sourceOffset: number) => {
    pendingReadingPositionRef.current = { canonicalPath, sourceOffset, updatedAt: Date.now() };
    if (readingPositionTimerRef.current !== null) return;
    readingPositionTimerRef.current = setTimeout(flushReadingPosition, 250);
  }, [flushReadingPosition]);

  useEffect(() => () => flushReadingPosition(), [
    tab.id,
    tab.mode,
    persistentReadingPath,
    flushReadingPosition,
  ]);
  const registerBridge = useCallback(
    (bridge: SourceEditorBridge) => registry.register(bridge),
    [registry],
  );

  useLayoutEffect(() => {
    if (tab.mode === "source") return;
    const viewport = documentViewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const measured = viewport.clientWidth || viewport.getBoundingClientRect().width;
      if (!Number.isFinite(measured) || measured <= 0) return;
      setViewportWidth((current) => current === measured ? current : measured);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tab.id, tab.mode]);

  useLayoutEffect(() => {
    const restoreToken = ++readingRestoreTokenRef.current;
    restoringReadingRef.current = false;
    if (tab.mode !== "reading" || !sourceView || initialViewportOffset === null) return;
    const viewport = documentViewportRef.current;
    if (!viewport) return;
    const requestedKey = tab.viewState.scrollAnchor?.blockViewKey;
    const targetSpan = (requestedKey
      ? blockViewSpans.find((candidate) => candidate.blockViewKey === requestedKey)
      : blockViewSpans.find(
          (candidate) => initialViewportOffset >= candidate.start && initialViewportOffset <= candidate.end,
        ));
    if (!targetSpan) return;

    let observer: MutationObserver | null = null;
    const restore = (): boolean => {
      const elementsByKey = new Map(
        [...viewport.querySelectorAll<HTMLElement>("[data-block-view-key]")]
          .map((element) => [element.dataset.blockViewKey, element] as const)
          .filter((entry): entry is readonly [string, HTMLElement] => Boolean(entry[0])),
      );
      let restoredSpan = targetSpan;
      let block = elementsByKey.get(targetSpan.blockViewKey);
      const exact = Boolean(block);
      if (!block) {
        const targetIndex = blockViewSpans.indexOf(targetSpan);
        for (let distance = 1; distance < blockViewSpans.length; distance += 1) {
          const predecessor = blockViewSpans[targetIndex - distance];
          const successor = blockViewSpans[targetIndex + distance];
          const predecessorBlock = predecessor && elementsByKey.get(predecessor.blockViewKey);
          const successorBlock = successor && elementsByKey.get(successor.blockViewKey);
          if (predecessorBlock) {
            restoredSpan = predecessor;
            block = predecessorBlock;
            break;
          }
          if (successorBlock) {
            restoredSpan = successor;
            block = successorBlock;
            break;
          }
        }
      }
      if (!block) return false;
      const sourceLength = Math.max(1, restoredSpan.end - restoredSpan.start);
      const sourceOffset = exact
        ? Math.min(sourceLength, Math.max(0, initialViewportOffset - restoredSpan.start))
        : restoredSpan.start < targetSpan.start ? sourceLength : 0;
      const viewportRect = viewport.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      const blockScrollTop = viewport.scrollTop + blockRect.top - viewportRect.top;
      const pixelOffset = blockRect.height > 0
        ? Math.round((sourceOffset / sourceLength) * blockRect.height)
        : 0;
      restoringReadingRef.current = true;
      viewport.scrollTop = blockScrollTop + pixelOffset;
      queueMicrotask(() => {
        if (readingRestoreTokenRef.current === restoreToken) {
          restoringReadingRef.current = false;
        }
      });
      return exact;
    };

    const rendererReady = () => Boolean(
      viewport.querySelector('[data-reading-render-ready="true"]'),
    );
    if (!restore() && !rendererReady() && typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        if (readingRestoreTokenRef.current !== restoreToken) return;
        if (restore() || rendererReady()) observer?.disconnect();
      });
      observer.observe(viewport, { childList: true, subtree: true });
    }
    return () => {
      readingRestoreTokenRef.current += 1;
      restoringReadingRef.current = false;
      observer?.disconnect();
    };
  }, [
    tab.id,
    tab.mode,
    tab.viewState.scrollAnchor?.blockViewKey,
    sourceView,
    blockViewSpans,
    initialViewportOffset,
  ]);

  const updateReadingViewport = (event: UIEvent<HTMLDivElement>) => {
    if (restoringReadingRef.current || !sourceView) return;
    const viewport = event.currentTarget;
    const viewportRect = viewport.getBoundingClientRect();
    const blocks = [...viewport.querySelectorAll<HTMLElement>("[data-block-view-key]")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }));
    const visibleEntry = blocks.filter(({ rect }) => rect.top <= viewportRect.top + 1).at(-1) ?? blocks[0];
    if (!visibleEntry) return;
    const { element: visible, rect: visibleRect } = visibleEntry;
    const key = visible.dataset.blockViewKey;
    const span = key ? blockViewSpans.find((candidate) => candidate.blockViewKey === key) : undefined;
    if (!span) return;
    const visibleScrollTop = viewport.scrollTop + visibleRect.top - viewportRect.top;
    const pixelOffset = Math.min(
      visibleRect.height,
      Math.max(0, viewport.scrollTop - visibleScrollTop),
    );
    let offset = visibleRect.height > 0
      ? Math.round((pixelOffset / visibleRect.height) * (span.end - span.start))
      : 0;
    const absoluteOffset = span.start + offset;
    if (
      absoluteOffset > 0 &&
      absoluteOffset < sourceView.text.length &&
      /[\uD800-\uDBFF]/.test(sourceView.text[absoluteOffset - 1]) &&
      /[\uDC00-\uDFFF]/.test(sourceView.text[absoluteOffset])
    ) {
      offset -= 1;
    }
    controller.updateSourceViewport(tab.id, tab.revision, {
      blockViewKey: span.blockViewKey,
      offset,
    });
    if (persistentReadingPath) {
      scheduleReadingPosition(persistentReadingPath, span.start + offset);
    }
  };

  const panelProps = {
    id: `document-${tab.id}`,
    "aria-labelledby": `tab-${tab.id}`,
  };
  const zoom = clampDocumentZoom(tab.zoomPercent) / 100;
  const textZoom = zoomMode === "text" ? zoom : 1;
  const canvasZoom = zoomMode === "canvas" ? zoom : 1;
  const zoomStyle = {
    "--document-zoom": String(textZoom),
    "--document-canvas-zoom": String(canvasZoom),
    "--document-font-size-zoom": `${16 * textZoom}px`,
    "--document-line-height-zoom": `${28 * textZoom}px`,
    "--code-font-size-zoom": `${14 * textZoom}px`,
    "--code-line-height-zoom": `${22 * textZoom}px`,
  } as CSSProperties;
  const baseWidth = documentBaseWidth(layout, viewportWidth);
  const paperZoomStyle = {
    width: `${baseWidth}px`,
    zoom: zoomMode === "canvas" ? canvasZoom : undefined,
  } satisfies CSSProperties;
  const pendingZoomAnchorRef = useRef<ViewportPoint | null>(null);
  const zoomGeometrySnapshotRef = useRef<{
    anchor: ViewportPoint;
    baseWidth: number;
    nextBaseWidth: number;
    nextValue: number;
    paperRect: DOMRect;
    scrollLeft: number;
    scrollTop: number;
    tabId: string;
    value: number;
    viewportRect: DOMRect;
  } | null>(null);
  const previousZoomRenderRef = useRef({
    baseWidth,
    mode: tab.mode,
    tabId: tab.id,
    value: canvasZoom,
  });
  const previousRender = previousZoomRenderRef.current;
  if (
    previousRender.tabId === tab.id &&
    previousRender.mode !== "source" &&
    tab.mode !== "source" &&
    (previousRender.value !== canvasZoom || previousRender.baseWidth !== baseWidth)
  ) {
    const viewport = documentViewportRef.current;
    const paper = documentPaperRef.current;
    if (viewport && paper) {
      zoomGeometrySnapshotRef.current = {
        anchor: pendingZoomAnchorRef.current ?? {
          x: viewport.clientWidth / 2,
          y: viewport.clientHeight / 2,
        },
        baseWidth: previousRender.baseWidth,
        nextBaseWidth: baseWidth,
        nextValue: canvasZoom,
        paperRect: paper.getBoundingClientRect(),
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        tabId: tab.id,
        value: previousRender.value,
        viewportRect: viewport.getBoundingClientRect(),
      };
    }
  }
  previousZoomRenderRef.current = {
    baseWidth,
    mode: tab.mode,
    tabId: tab.id,
    value: canvasZoom,
  };
  useLayoutEffect(() => {
    const viewport = documentViewportRef.current;
    const paper = documentPaperRef.current;
    const previous = zoomGeometrySnapshotRef.current;
    zoomGeometrySnapshotRef.current = null;
    pendingZoomAnchorRef.current = null;
    if (
      viewport &&
      paper &&
      previous &&
      previous.tabId === tab.id &&
      previous.nextValue === canvasZoom &&
      previous.nextBaseWidth === baseWidth &&
      tab.mode !== "source" &&
      (previous.value !== canvasZoom || previous.baseWidth !== baseWidth)
    ) {
      const viewportRect = viewport.getBoundingClientRect();
      const paperRect = paper.getBoundingClientRect();
      if (
        previous.paperRect.width > 0 &&
        previous.paperRect.height > 0 &&
        paperRect.width > 0 &&
        paperRect.height > 0
      ) {
        const desiredX = previous.viewportRect.left + previous.anchor.x;
        const desiredY = previous.viewportRect.top + previous.anchor.y;
        const paperX = (desiredX - previous.paperRect.left) / previous.paperRect.width;
        const paperY = (desiredY - previous.paperRect.top) / previous.paperRect.height;
        const nextX = paperRect.left + paperX * paperRect.width;
        const nextY = paperRect.top + paperY * paperRect.height;
        viewport.scrollLeft = Math.max(0, Math.round(
          viewport.scrollLeft + nextX - (viewportRect.left + previous.anchor.x),
        ));
        viewport.scrollTop = Math.max(0, Math.round(
          viewport.scrollTop + nextY - (viewportRect.top + previous.anchor.y),
        ));
      } else {
        const next = anchoredScrollPosition(
          previous.value,
          canvasZoom,
          { left: previous.scrollLeft, top: previous.scrollTop },
          previous.anchor,
        );
        viewport.scrollLeft = next.left;
        viewport.scrollTop = next.top;
      }
    }
  }, [baseWidth, canvasZoom, tab.id, tab.mode]);
  const canvasDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const [canvasPanning, setCanvasPanning] = useState(false);
  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (zoomMode !== "canvas" || event.button !== 1) return;
    const viewport = event.currentTarget;
    canvasDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture?.(event.pointerId);
    setCanvasPanning(true);
    event.preventDefault();
  };
  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = canvasDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const viewport = event.currentTarget;
    viewport.scrollLeft = drag.scrollLeft + drag.startX - event.clientX;
    viewport.scrollTop = drag.scrollTop + drag.startY - event.clientY;
  };
  const handleCanvasPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (canvasDragRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      canvasDragRef.current = null;
      setCanvasPanning(false);
    }
  };
  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    if (!event.ctrlKey || !controller.setDocumentZoom) return;
    event.preventDefault();
    const nextZoom = stepDocumentZoom(tab.zoomPercent, event.deltaY < 0 ? 1 : -1);
    if (nextZoom === tab.zoomPercent) return;
    if (zoomMode === "canvas" && tab.mode !== "source") {
      const viewport = documentViewportRef.current;
      if (viewport) {
        const rect = viewport.getBoundingClientRect();
        pendingZoomAnchorRef.current = {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        };
      }
    }
    controller.setDocumentZoom(tab.id, tab.revision, nextZoom);
  };
  const displayName = tab.file.kind === "local"
    ? fileNameForDisplay(tab.file.canonicalPath)
    : tab.file.displayName;

  const currentSourceProjection = (expectedRevision: number) => {
    const current = controller.tabs.find((candidate) => candidate.id === tab.id);
    if (current?.kind !== "document" || current.revision !== expectedRevision || !sourceView) {
      return null;
    }
    if (current.sourceBuffer) {
      return { current, spans: [], text: current.sourceBuffer.bufferText };
    }
    if (current.candidate === tab.candidate) {
      return { current, spans: blockViewSpans, text: sourceView.text };
    }
    const currentView = controller.getSourceView(current.id, current.revision);
    if (!currentView) return null;
    return {
      current,
      spans: buildBlockViewSpans(current.candidate, currentView, current.blockViewKeys),
      text: currentView.text,
    };
  };

  if (tab.mode === "rich") {
    return <section {...panelProps} className="document-surface document-surface--rich" onWheel={handleWheel} role="tabpanel" style={zoomStyle}>
      <div className={`document-viewport document-viewport--rich${canvasPanning ? " document-viewport--panning" : ""}`} onPointerDown={handleCanvasPointerDown} onPointerMove={handleCanvasPointerMove} onPointerUp={handleCanvasPointerUp} onPointerCancel={handleCanvasPointerUp} ref={documentViewportRef}>
        <div className={`document-paper-wrap document-paper-wrap--${layout}`}>
          <div className="document-paper-stage" data-document-base-width={baseWidth}>
            <div aria-label={displayName} className={`document-paper document-paper--rich document-paper--${layout}`} ref={assignDocumentPaper} style={paperZoomStyle}>
              <Suspense fallback={<div aria-busy="true" className="rich-surface__loading">{t("rich.loading")}</div>}>
                <RichDocumentSurface controller={controller} registry={resolvedRichRegistry} tab={tab} />
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </section>;
  }

  if (tab.mode !== "source") {
    return <section
      {...panelProps}
      className="document-surface"
      data-reading-density={readingPreferences.density}
      data-reading-theme={readingPreferences.theme}
      data-reading-width={readingPreferences.width}
      onWheel={handleWheel}
      role="tabpanel"
      style={zoomStyle}
    >
      <div
        className={`document-viewport document-viewport--reading${canvasPanning ? " document-viewport--panning" : ""}`}
        onScroll={updateReadingViewport}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerUp}
        ref={documentViewportRef}
      >
        <div className={`document-paper-wrap document-paper-wrap--${layout}`}>
          <div className="document-paper-stage" data-document-base-width={baseWidth}>
            <article
              aria-label={displayName}
              className={`document-paper document-paper--${layout}`}
              data-reading-density={readingPreferences.density}
              data-reading-theme={readingPreferences.theme}
              data-reading-width={readingPreferences.width}
              data-document-search-content
              data-ui-contract="document"
              ref={assignDocumentPaper}
              style={paperZoomStyle}
            >
              {renderReading(blockViewSpans, onOpenLink)}
            </article>
          </div>
        </div>
      </div>
    </section>;
  }

  return <section
    {...panelProps}
    className="document-surface document-surface--source"
    onWheel={handleWheel}
    role="tabpanel"
    style={zoomStyle}
  >
    <div className="document-viewport document-viewport--source source-surface">
      {sourceView ? <Suspense fallback={<div aria-busy="true" className="source-surface__loading">{t("source.loading")}</div>}>
        <SourceEditor
          sessionId={tab.id}
          candidateRevision={tab.revision}
          view={sourceView}
          buffer={tab.sourceBuffer}
          readOnly={!documentEditsAreEnabled(tab)}
          zoomPercent={tab.zoomPercent}
          initialSelection={initialSelection}
          initialViewportOffset={initialViewportOffset}
          onChangeBatch={(batch) => controller.applySourceChangeBatch(batch)}
          onSelectionChange={(expectedRevision, selection) => {
            const projection = currentSourceProjection(expectedRevision);
            if (!projection) return;
            controller.updateSourceSelection(
              projection.current.id,
              projection.current.revision,
              textSelectionForSourceRange(selection, projection.spans, projection.text),
            );
          }}
          onViewportOffsetChange={(expectedRevision, offset) => {
            const projection = currentSourceProjection(expectedRevision);
            if (!projection) return;
            controller.updateSourceViewport(
              projection.current.id,
              projection.current.revision,
              viewportAnchorForSourceOffset(offset, projection.spans, projection.text),
            );
          }}
          onUndo={(expectedRevision) => controller.undo(tab.id, expectedRevision)}
          onRedo={(expectedRevision) => controller.redo(tab.id, expectedRevision)}
          onSave={() => { void controller.save(tab.id); }}
          registerBridge={registerBridge}
        />
      </Suspense> : <div aria-busy="true" className="source-surface__loading">{t("source.loading")}</div>}
    </div>
  </section>;
}, (previous, next) => (
  previous.controller === next.controller &&
  previous.richRegistry === next.richRegistry &&
  previous.registry === next.registry &&
  previous.tab === next.tab &&
  previous.layout === next.layout &&
  previous.zoomMode === next.zoomMode &&
  previous.readingPreferences === next.readingPreferences &&
  previous.renderReading === next.renderReading &&
  previous.onOpenLink === next.onOpenLink
));

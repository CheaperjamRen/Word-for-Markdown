import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";

import { buildOutline } from "../../markdown/outline";
import { useLocale } from "../../i18n/locale";
import {
  activeOutlineId,
  parentOutlineId,
  visibleOutlineIds,
  type OutlinePosition,
} from "./outline-navigation";
import { ShellIcon } from "./icons";

export function OutlinePane({
  markdown,
  documentId,
  hidden = false,
  onCollapse,
  collapseButtonRef,
}: {
  markdown: string;
  documentId?: string;
  hidden?: boolean;
  onCollapse?(): void;
  collapseButtonRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useLocale();
  const items = useMemo(() => buildOutline(markdown), [markdown]);
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const pendingJumpRef = useRef<MutationObserver | null>(null);
  const positionsRef = useRef<readonly OutlinePosition[]>([]);
  const activeFrameRef = useRef<number | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const visibleIds = useMemo(() => visibleOutlineIds(items, collapsedIds), [collapsedIds, items]);
  const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds]);

  useEffect(() => {
    setActiveId(items[0]?.id ?? null);
    setCollapsedIds(new Set());
  }, [items]);

  useEffect(() => () => {
    pendingJumpRef.current?.disconnect();
    pendingJumpRef.current = null;
    if (activeFrameRef.current !== null) cancelAnimationFrame(activeFrameRef.current);
    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
  }, [documentId, items]);

  useEffect(() => {
    if (!documentId || items.length === 0) return;
    const surface = document.getElementById(`document-${documentId}`);
    const viewport = surface?.querySelector<HTMLElement>(".document-viewport--reading");
    if (!surface || !viewport) return;
    const currentSurface = surface;

    const measure = () => {
      const viewportTop = viewport.getBoundingClientRect().top;
      positionsRef.current = items
        .map((item) => ({ item, node: document.getElementById(item.id) }))
        .filter((entry): entry is { item: (typeof items)[number]; node: HTMLElement } => Boolean(entry.node))
        .filter((entry) => currentSurface.contains(entry.node))
        .map(({ item, node }) => ({
          id: item.id,
          top: viewport.scrollTop + node.getBoundingClientRect().top - viewportTop,
        }))
        .sort((left, right) => left.top - right.top);
      const active = activeOutlineId(positionsRef.current, viewport.scrollTop + 48);
      if (active) setActiveId(active);
    };
    const scheduleMeasure = () => {
      if (measureFrameRef.current !== null) return;
      measureFrameRef.current = requestAnimationFrame(() => {
        measureFrameRef.current = null;
        measure();
      });
    };
    const updateActive = () => {
      if (activeFrameRef.current !== null) return;
      activeFrameRef.current = requestAnimationFrame(() => {
        activeFrameRef.current = null;
        const active = activeOutlineId(positionsRef.current, viewport.scrollTop + 48);
        if (active) setActiveId(active);
      });
    };

    viewport.addEventListener("scroll", updateActive, { passive: true });
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(currentSurface, { childList: true, subtree: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(viewport);
    const paper = viewport.querySelector<HTMLElement>(".document-paper");
    if (paper) resizeObserver?.observe(paper);
    measure();

    return () => {
      viewport.removeEventListener("scroll", updateActive);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      if (activeFrameRef.current !== null) cancelAnimationFrame(activeFrameRef.current);
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
      activeFrameRef.current = null;
      measureFrameRef.current = null;
    };
  }, [documentId, items]);

  useEffect(() => {
    if (!activeId || !visibleIdSet.has(activeId)) return;
    buttonRefs.current.get(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, visibleIdSet]);

  if (items.length === 0) return null;
  const select = (id: string) => {
    pendingJumpRef.current?.disconnect();
    pendingJumpRef.current = null;
    setActiveId(id);
    const surface = documentId ? document.getElementById(`document-${documentId}`) : document.body;
    if (!surface) return;
    const jump = () => {
      const target = document.getElementById(id);
      if (!target || !surface.contains(target)) return false;
      const viewport = surface.querySelector<HTMLElement>(".document-viewport--reading");
      if (!viewport) return false;
      const top = Math.max(
        0,
        viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24,
      );
      viewport.scrollTop = top;
      return true;
    };
    if (jump()) return;
    const observer = new MutationObserver(() => {
      if (!jump()) return;
      observer.disconnect();
      if (pendingJumpRef.current === observer) pendingJumpRef.current = null;
    });
    observer.observe(surface, { childList: true, subtree: true });
    pendingJumpRef.current = observer;
  };

  const itemIndex = new Map(items.map((item, index) => [item.id, index]));
  const hasChildren = (id: string) => {
    const index = itemIndex.get(id);
    return index !== undefined && Boolean(items[index + 1] && items[index + 1]!.level > items[index]!.level);
  };
  const firstChildId = (id: string) => {
    const index = itemIndex.get(id);
    return index === undefined || !items[index + 1] || items[index + 1]!.level <= items[index]!.level
      ? null
      : items[index + 1]!.id;
  };
  const focusItem = (id: string | null) => {
    if (id) buttonRefs.current.get(id)?.focus();
  };
  const setBranchCollapsed = (id: string, collapsed: boolean) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (collapsed) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const onItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const visibleIndex = visibleIds.indexOf(id);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      focusItem(visibleIds[Math.min(visibleIds.length - 1, Math.max(0, visibleIndex + delta))] ?? null);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusItem(event.key === "Home" ? visibleIds[0] ?? null : visibleIds.at(-1) ?? null);
    } else if (event.key === "ArrowRight" && hasChildren(id)) {
      event.preventDefault();
      if (collapsedIds.has(id)) setBranchCollapsed(id, false);
      else focusItem(firstChildId(id));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (hasChildren(id) && !collapsedIds.has(id)) setBranchCollapsed(id, true);
      else focusItem(parentOutlineId(items, id));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(id);
    }
  };

  return (
    <aside aria-label={t("outline.document")} className="outline-pane" data-document-id={documentId} hidden={hidden}>
      <div className="outline-pane__header">
        <span>{t("outline.title")}</span>
        <button
          aria-expanded="true"
          aria-label={t("outline.collapse")}
          onClick={onCollapse}
          ref={collapseButtonRef}
          title={t("outline.collapse")}
          type="button"
        >
          <ShellIcon className="outline-pane__pane-toggle" name="chevron" />
        </button>
      </div>
      <nav className="outline-pane__list">
        {items.filter((item) => visibleIdSet.has(item.id)).map((item) => {
          const branch = hasChildren(item.id);
          const collapsed = collapsedIds.has(item.id);
          return (
            <button
              aria-current={activeId === item.id ? "location" : undefined}
              aria-expanded={branch ? !collapsed : undefined}
              className={activeId === item.id ? "outline-pane__item outline-pane__item--active" : "outline-pane__item"}
              key={item.id}
              onClick={() => select(item.id)}
              onKeyDown={(event) => onItemKeyDown(event, item.id)}
              data-outline-level={item.level}
              ref={(node) => {
                if (node) buttonRefs.current.set(item.id, node);
                else buttonRefs.current.delete(item.id);
              }}
              style={{ paddingLeft: `${10 + (item.level - 1) * 20}px` }}
              title={item.text}
              type="button"
            >
              {branch ? <ShellIcon className={`outline-pane__branch${collapsed ? " outline-pane__branch--collapsed" : ""}`} name="chevron" /> : <span aria-hidden="true" className="outline-pane__branch-spacer" />}
              <span className="outline-pane__label">{item.text}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

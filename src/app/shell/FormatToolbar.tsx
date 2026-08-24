import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import type { DocumentController } from "../use-document-controller";
import { ShellIcon } from "./icons";
import {
  createToolbarLayout,
  toolbarGroupLabelKey,
  toolbarLabelKey,
  type ToolbarActionId,
  type ToolbarActionState,
  type ToolbarItem,
  type ToolbarStateById,
} from "./toolbar-commands";
import { createToolbarStateById } from "./toolbar-state";
import { LinkPanel } from "../../editor/panels/LinkPanel";
import { useLocale } from "../../i18n/locale";

const COMPACT_QUERY = "(max-width: 1023px)";
const OVERFLOW_ITEM_SELECTOR = "[data-toolbar-placement='overflow']";

function initialCompact(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(COMPACT_QUERY).matches;
}

function groupOf(item: ToolbarItem): string | null {
  return item.kind === "save" || item.kind === "block-style" || item.kind === "command"
    ? item.group
    : null;
}

function separates(previous: ToolbarItem | undefined, current: ToolbarItem): boolean {
  if (!previous) return false;
  const previousGroup = groupOf(previous);
  const currentGroup = groupOf(current);
  return Boolean(previousGroup && currentGroup && previousGroup !== currentGroup);
}

function toggleAriaValue(state: ToolbarActionState): boolean | "mixed" | undefined {
  if (state.toggleState === null) return undefined;
  if (state.toggleState === "mixed") return "mixed";
  return state.toggleState === "on";
}

export function FormatToolbar({
  controller,
  hidden = false,
  onOpenLink,
  stateById: providedStateById,
}: {
  controller: DocumentController;
  hidden?: boolean;
  onOpenLink?(invoker: HTMLElement): void;
  stateById?: ToolbarStateById;
}) {
  const { t } = useLocale();
  const [compact, setCompact] = useState(initialCompact);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [blockStyleOpen, setBlockStyleOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const controlRefs = useRef(new Map<string, HTMLButtonElement>());
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const blockStyleMenuRef = useRef<HTMLDivElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const pendingResponsiveFocus = useRef<string | null>(null);
  const layout = createToolbarLayout(compact);
  const stateById = providedStateById ?? createToolbarStateById(controller, undefined, undefined, t);

  const rememberControl = (id: string, node: HTMLButtonElement | null) => {
    if (node) controlRefs.current.set(id, node);
    else controlRefs.current.delete(id);
  };

  const enabledPrimaryIds: string[] = layout.primary.flatMap((item) => {
    if (item.kind === "overflow-trigger") return [item.id];
    if (item.kind === "save" || item.kind === "block-style" || item.kind === "command") {
      return stateById[item.id].enabled ? [item.id] : [];
    }
    return [];
  });
  const [rovingId, setRovingId] = useState<string | null>(() => enabledPrimaryIds[0] ?? null);

  useLayoutEffect(() => {
    const toolbarOwnsFocus = Boolean(
      document.activeElement instanceof HTMLElement && toolbarRef.current?.contains(document.activeElement),
    );
    const currentIsEnabled = enabledPrimaryIds.includes(rovingId ?? "");
    const nextId = toolbarOwnsFocus && currentIsEnabled ? rovingId : (enabledPrimaryIds[0] ?? null);
    if (nextId !== rovingId) setRovingId(nextId);
    if (toolbarOwnsFocus && !currentIsEnabled && nextId) controlRefs.current.get(nextId)?.focus();
  }, [enabledPrimaryIds.join("|"), rovingId]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COMPACT_QUERY);
    const changed = (event: MediaQueryListEvent) => {
      const focused = document.activeElement instanceof HTMLElement && toolbarRef.current?.contains(document.activeElement)
        ? document.activeElement.closest<HTMLElement>("[data-toolbar-id]")
        : null;
      pendingResponsiveFocus.current = focused?.dataset.toolbarId ?? null;
      setCompact(event.matches);
    };
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const requestedId = pendingResponsiveFocus.current;
    pendingResponsiveFocus.current = null;
    if (overflowOpen) setOverflowOpen(false);
    if (!requestedId) return;
    const destination = controlRefs.current.get(requestedId);
    if (
      destination?.dataset.toolbarPlacement === "primary" &&
      enabledPrimaryIds.includes(requestedId) &&
      !destination.disabled
    ) destination.focus();
    else overflowTriggerRef.current?.focus();
  }, [compact]);

  useEffect(() => {
    if (!overflowOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!overflowMenuRef.current?.contains(target) && !overflowTriggerRef.current?.contains(target)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [overflowOpen]);

  useEffect(() => {
    if (!blockStyleOpen) return;
    blockStyleMenuRef.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"], [role="menuitemradio"]')
      ?.focus();
  }, [blockStyleOpen]);

  useEffect(() => {
    if (!blockStyleOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !blockStyleMenuRef.current?.contains(target) &&
        !controlRefs.current.get("block-style")?.contains(target)
      ) setBlockStyleOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [blockStyleOpen]);

  useEffect(() => {
    if (!overflowOpen) return;
    overflowMenuRef.current?.querySelector<HTMLButtonElement>(OVERFLOW_ITEM_SELECTOR)?.focus();
  }, [overflowOpen]);

  const closeOverflow = (restore = true) => {
    setOverflowOpen(false);
    if (restore) queueMicrotask(() => overflowTriggerRef.current?.focus());
  };

  const rove = (event: KeyboardEvent<HTMLButtonElement>, currentId: string): boolean => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return false;
    event.preventDefault();
    let nextId: string | undefined;
    if (event.key === "Home") nextId = enabledPrimaryIds[0];
    else if (event.key === "End") nextId = enabledPrimaryIds.at(-1);
    else {
      const current = Math.max(0, enabledPrimaryIds.indexOf(currentId));
      const delta = event.key === "ArrowRight" ? 1 : -1;
      nextId = enabledPrimaryIds[(current + delta + enabledPrimaryIds.length) % enabledPrimaryIds.length];
    }
    if (!nextId) return true;
    setRovingId(nextId);
    controlRefs.current.get(nextId)?.focus();
    return true;
  };

  const overflowKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(OVERFLOW_ITEM_SELECTOR)];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Tab") {
      event.preventDefault();
      const sequential = [...document.querySelectorAll<HTMLElement>(
        "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]",
      )].filter((element) => element.tabIndex >= 0 && !element.closest(".toolbar-overflow__menu"));
      const triggerIndex = sequential.indexOf(overflowTriggerRef.current!);
      const delta = event.shiftKey ? -1 : 1;
      const destination = sequential[(triggerIndex + delta + sequential.length) % sequential.length];
      setOverflowOpen(false);
      queueMicrotask(() => destination?.focus());
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      items[(current + delta + items.length) % items.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeOverflow();
    }
  };

  const sharedButtonProps = (id: ToolbarActionId, state: ToolbarActionState) => ({
    "aria-busy": state.busy,
    "data-busy": String(state.busy),
    "data-toolbar-id": id,
    "data-toolbar-placement": "primary",
    disabled: !state.enabled,
    onClick: state.execute,
    onMouseDown: (event: MouseEvent<HTMLButtonElement>) => {
      if (state.enabled) event.preventDefault();
    },
    onFocus: () => setRovingId(id),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => { rove(event, id); },
    ref: (node: HTMLButtonElement | null) => rememberControl(id, node),
    tabIndex: state.enabled && rovingId === id ? 0 : -1,
    title: state.title,
    type: "button" as const,
  });

  const renderPrimaryItem = (item: ToolbarItem): ReactNode => {
    switch (item.kind) {
      case "save": {
        const state = stateById[item.id];
        return (
          <button
            {...sharedButtonProps(item.id, state)}
            aria-label={t(toolbarLabelKey(item.id))}
            className={`toolbar-button toolbar-button--save${state.enabled ? " toolbar-button--actionable" : ""}`}
            data-toolbar-group={item.group}
            data-ui-contract="icon-button"
          ><ShellIcon className="toolbar-icon" data-ui-contract="toolbar-icon" name={item.icon} /></button>
        );
      }
      case "block-style": {
        const state = stateById[item.id];
        return (
          <button
            {...sharedButtonProps(item.id, state)}
            aria-expanded={blockStyleOpen}
            aria-haspopup="menu"
            aria-label={t(toolbarLabelKey(item.id))}
            className="toolbar-button toolbar-button--style"
            data-toolbar-group={item.group}
            onClick={() => {
              if (!state.enabled || !state.choices?.length) return;
              setOverflowOpen(false);
              setBlockStyleOpen((open) => !open);
            }}
          ><span>{state.text ?? t("block.paragraph")}</span><ShellIcon className="toolbar-chevron" name="chevron" /></button>
        );
      }
      case "command": {
        const state = stateById[item.id];
        return (
          <button
            {...sharedButtonProps(item.id, state)}
            {...(item.behavior === "toggle" ? { "aria-pressed": toggleAriaValue(state) } : {})}
            aria-label={t(toolbarLabelKey(item.id))}
            className="toolbar-button"
            data-toolbar-group={item.group}
            onClick={(event) => {
              if (!state.enabled) return;
              if (item.id === "link" && state.linkEditor) {
                setBlockStyleOpen(false);
                setOverflowOpen(false);
                if (onOpenLink) onOpenLink(event.currentTarget);
                else setLinkOpen(true);
                return;
              }
              state.execute();
            }}
          ><ShellIcon className="toolbar-icon" name={item.icon} /></button>
        );
      }
      case "spacer":
        return <span aria-hidden="true" className="toolbar-spacer" data-toolbar-id={item.id} data-toolbar-placement="primary" />;
      case "overflow-trigger":
        return (
          <button
            aria-expanded={overflowOpen}
            aria-haspopup="menu"
            aria-label={t(toolbarLabelKey(item.id))}
            className="toolbar-button toolbar-button--more"
            data-toolbar-id={item.id}
            data-toolbar-placement="primary"
            onClick={() => setOverflowOpen((open) => !open)}
            onFocus={() => setRovingId(item.id)}
            onKeyDown={(event) => {
              if (rove(event, item.id)) return;
              if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOverflowOpen(true);
              } else if (event.key === "Escape") closeOverflow();
            }}
            ref={(node) => {
              overflowTriggerRef.current = node;
              rememberControl(item.id, node);
            }}
            tabIndex={rovingId === item.id ? 0 : -1}
            type="button"
          ><span>{t(toolbarLabelKey(item.id))}</span><ShellIcon className="toolbar-chevron" name="chevron" /></button>
        );
      default: {
        const exhaustive: never = item;
        return exhaustive;
      }
    }
  };

  return (
    <div aria-label={t("toolbar.document")} className="format-toolbar" data-shell-contract="toolbar" hidden={hidden} ref={toolbarRef} role="toolbar">
      {layout.primary.map((item, index) => (
        <Fragment key={item.id}>
          {separates(layout.primary[index - 1], item) ? <span aria-hidden="true" className="toolbar-separator" /> : null}
          {renderPrimaryItem(item)}
        </Fragment>
      ))}
      {blockStyleOpen && stateById["block-style"].choices?.length ? (
        <div
          aria-label={t("toolbar.blockStyle")}
          className="menu-popover toolbar-style__menu"
          onKeyDown={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              items[(current + delta + items.length) % items.length]?.focus();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setBlockStyleOpen(false);
              queueMicrotask(() => controlRefs.current.get("block-style")?.focus());
            }
          }}
          ref={blockStyleMenuRef}
          role="menu"
        >
          {stateById["block-style"].choices.map((choice) => (
            <button
              aria-checked={choice.selected}
              className="menu-item"
              key={choice.value}
              onClick={() => {
                choice.execute();
                setBlockStyleOpen(false);
              }}
              role="menuitemradio"
              tabIndex={-1}
              type="button"
            >{choice.label}</button>
          ))}
        </div>
      ) : null}
      {linkOpen && stateById.link.linkEditor ? (
        <LinkPanel
          initialUrl={stateById.link.linkEditor.url}
          onApply={(url) => {
            stateById.link.linkEditor?.apply(url);
            setLinkOpen(false);
          }}
          onCancel={() => {
            setLinkOpen(false);
            queueMicrotask(() => controlRefs.current.get("link")?.focus());
          }}
          onRemove={() => {
            stateById.link.linkEditor?.remove();
            setLinkOpen(false);
          }}
        />
      ) : null}
      {overflowOpen ? (
        <div aria-label={t("toolbar.more")} className="menu-popover toolbar-overflow__menu" onKeyDown={overflowKey} ref={overflowMenuRef} role="menu">
          {layout.overflowGroups.map((group, index) => (
            <div className="toolbar-overflow__group" key={group.id} role="presentation">
              {index > 0 ? <div aria-hidden="true" className="menu-separator" role="separator" /> : null}
              <div className="menu-group-label">{toolbarGroupLabelKey(group.id) ? t(toolbarGroupLabelKey(group.id)!) : group.label}</div>
              {group.commands.map((command) => {
                const state = stateById[command.id];
                return (
                  <button
                    aria-busy={state.busy}
                    aria-disabled={!state.enabled}
                    {...(command.behavior === "toggle" ? { "aria-checked": toggleAriaValue(state) } : {})}
                    className={`menu-item${state.enabled ? "" : " menu-item--disabled"}`}
                    data-busy={String(state.busy)}
                    data-toolbar-group={command.group}
                    data-toolbar-id={command.id}
                    data-toolbar-placement="overflow"
                    key={command.id}
                    onClick={() => {
                      if (!state.enabled) return;
                      state.execute();
                      closeOverflow();
                    }}
                    ref={(node) => rememberControl(command.id, node)}
                    role={command.behavior === "toggle" ? "menuitemcheckbox" : "menuitem"}
                    tabIndex={-1}
                    title={state.title}
                    type="button"
                  >{t(toolbarLabelKey(command.id))}</button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

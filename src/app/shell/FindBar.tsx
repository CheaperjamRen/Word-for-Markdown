import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "../../i18n/locale";
import { ShellIcon } from "./icons";

interface FindMatch {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
}

interface SearchTextSegment {
  node: Text;
  start: number;
  end: number;
  block: Element;
}

const SEARCHABLE_SELECTOR = "[data-document-search-content]";
const BLOCK_SELECTOR = "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th";
const EXCLUDED_SELECTOR = "button,input,textarea,select,option,[aria-hidden='true'],[data-find-exclude]";

function collectMatches(root: HTMLElement | null, query: string): FindMatch[] {
  if (!root || !query) return [];
  const contentRoot = root.matches(SEARCHABLE_SELECTOR)
    ? root
    : root.querySelector<HTMLElement>(SEARCHABLE_SELECTOR);
  if (!contentRoot) return [];
  const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      return !parent || !node.textContent || parent.closest(EXCLUDED_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const segments: SearchTextSegment[] = [];
  let logicalText = "";
  let previousBlock: Element | null = null;
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? contentRoot;
    if (logicalText && previousBlock && previousBlock !== block) logicalText += "\n";
    const start = logicalText.length;
    logicalText += text;
    segments.push({ node: node as Text, start, end: logicalText.length, block });
    previousBlock = block;
    node = walker.nextNode();
  }
  const matches: FindMatch[] = [];
  const haystack = logicalText.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let from = 0;
  let startSegmentIndex = 0;
  let endSegmentIndex = 0;
  while (from < haystack.length) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) break;
    const matchEnd = found + query.length;
    while (startSegmentIndex < segments.length && found >= segments[startSegmentIndex]!.end) startSegmentIndex += 1;
    endSegmentIndex = Math.max(endSegmentIndex, startSegmentIndex);
    while (endSegmentIndex < segments.length && matchEnd > segments[endSegmentIndex]!.end) endSegmentIndex += 1;
    const startSegment = segments[startSegmentIndex];
    const endSegment = segments[endSegmentIndex];
    if (startSegment && endSegment && found >= startSegment.start && matchEnd > endSegment.start) {
      matches.push({
        startNode: startSegment.node,
        startOffset: found - startSegment.start,
        endNode: endSegment.node,
        endOffset: matchEnd - endSegment.start,
      });
    }
    from = found + Math.max(1, query.length);
  }
  return matches;
}

export function FindBar({
  onClose,
  requestId = 0,
  rootId,
}: {
  onClose(): void;
  requestId?: number;
  rootId: string;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [contentRevision, setContentRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(
    () => collectMatches(document.getElementById(rootId), query),
    [contentRevision, query, rootId],
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [requestId]);

  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;
    const observationRoot = root.parentElement ?? root;
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setContentRevision((value) => value + 1);
      });
    });
    observer.observe(observationRoot, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [rootId]);

  useEffect(() => {
    setCurrent((value) => matches.length === 0 ? 0 : Math.min(value, matches.length - 1));
  }, [matches.length]);

  useEffect(() => {
    const match = matches[current];
    if (!match) return;
    if (
      !match.startNode.isConnected ||
      !match.endNode.isConnected ||
      match.startOffset > match.startNode.length ||
      match.endOffset > match.endNode.length
    ) {
      setContentRevision((value) => value + 1);
      return;
    }
    const range = document.createRange();
    try {
      range.setStart(match.startNode, match.startOffset);
      range.setEnd(match.endNode, match.endOffset);
    } catch {
      setContentRevision((value) => value + 1);
      return;
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    match.startNode.parentElement?.scrollIntoView?.({ block: "center" });
  }, [current, matches]);

  const move = (delta: number) => {
    if (matches.length === 0) return;
    setCurrent((value) => (value + delta + matches.length) % matches.length);
  };

  return (
    <div
      aria-label={t("find.region")}
      className="find-bar"
      data-testid="find-bar"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      role="search"
    >
      <label className="find-bar__label" htmlFor="document-find-input">{t("find.label")}</label>
      <input
        aria-label={t("find.text")}
        id="document-find-input"
        onChange={(event) => { setQuery(event.target.value); setCurrent(0); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
        }}
        ref={inputRef}
        type="search"
        value={query}
      />
      <span aria-live="polite" className="find-bar__count">
        {query ? (matches.length ? `${current + 1} / ${matches.length}` : t("find.none")) : ""}
      </span>
      <button aria-label={t("find.previous")} disabled={matches.length === 0} onClick={() => move(-1)} title={t("find.previous")} type="button">
        <ShellIcon className="find-bar__icon find-bar__icon--previous" name="chevron" />
      </button>
      <button aria-label={t("find.next")} disabled={matches.length === 0} onClick={() => move(1)} title={t("find.next")} type="button">
        <ShellIcon className="find-bar__icon find-bar__icon--next" name="chevron" />
      </button>
      <button aria-label={t("find.close")} onClick={onClose} title={t("find.close")} type="button">
        <ShellIcon className="find-bar__icon" name="close" />
      </button>
    </div>
  );
}

export default FindBar;

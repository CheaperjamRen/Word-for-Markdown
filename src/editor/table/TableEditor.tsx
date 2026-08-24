import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocumentController } from "../../app/use-document-controller";
import type { DocumentSession } from "../../documents/session";
import type { SourceBlock } from "../../contracts/markdown";
import type { ActiveEditorBridge, RichCommand, RichToolbarState } from "../active-editor";
import { TableActionIcon } from "./TableActionIcon";
import {
  parseGfmTable,
  replaceTableCellContents,
  serializeTableMatrix,
  tableMatrix,
  toggleCellFormat,
} from "./gfm-table";
import "./table-editor.css";
import { useLocale } from "../../i18n/locale";

interface Coordinate { row: number; column: number; }
interface CellSelection { anchor: Coordinate; focus: Coordinate; }
interface SelectionOverlay { left: number; top: number; width: number; height: number; }

function bounds(selection: CellSelection): { top: number; left: number; bottom: number; right: number } {
  return {
    top: Math.min(selection.anchor.row, selection.focus.row),
    left: Math.min(selection.anchor.column, selection.focus.column),
    bottom: Math.max(selection.anchor.row, selection.focus.row),
    right: Math.max(selection.anchor.column, selection.focus.column),
  };
}

function coordinates(selection: CellSelection, matrix: readonly (readonly string[])[]): Coordinate[] {
  const range = bounds(selection);
  const result: Coordinate[] = [];
  for (let row = range.top; row <= range.bottom; row += 1) {
    for (let column = range.left; column <= range.right; column += 1) {
      if (row < matrix.length && column < (matrix[row]?.length ?? 0)) result.push({ row, column });
    }
  }
  return result;
}

function formatState(values: readonly string[], format: "bold" | "italic" | "strikethrough" | "code"): "off" | "on" | "mixed" {
  const markers = { bold: ["**", "**"], italic: ["*", "*"], strikethrough: ["~~", "~~"], code: ["`", "`"] } as const;
  const [open, close] = markers[format];
  const enabled = values.filter((value) => value.startsWith(open) && value.endsWith(close)).length;
  return enabled === 0 ? "off" : enabled === values.length ? "on" : "mixed";
}

function cellHtml(value: string): string {
  return `<td>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</td>`;
}

function copyMatrix(matrix: readonly (readonly string[])[], selection: CellSelection): { text: string; html: string } {
  const range = bounds(selection);
  const rows: string[][] = [];
  for (let row = range.top; row <= range.bottom; row += 1) {
    rows.push(Array.from({ length: range.right - range.left + 1 }, (_, index) => matrix[row]?.[range.left + index] ?? ""));
  }
  return {
    text: rows.map((row) => row.join("\t")).join("\n"),
    html: `<table><tbody>${rows.map((row) => `<tr>${row.map(cellHtml).join("")}</tr>`).join("")}</tbody></table>`,
  };
}

function parseTsv(value: string): string[][] {
  const rows = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows.map((row) => row.split("\t"));
}

export interface TableEditorProps {
  block: SourceBlock;
  blockViewKey: string;
  candidateRevision: number;
  registerBridge?(bridge: ActiveEditorBridge): () => void;
  sessionId: string;
  controller: DocumentController;
  tab: DocumentSession;
}

export function TableEditor({
  block,
  blockViewKey,
  candidateRevision,
  registerBridge,
  sessionId,
  controller,
}: TableEditorProps) {
  const { t } = useLocale();
  const model = useMemo(() => parseGfmTable(block.raw), [block.raw]);
  const [matrix, setMatrix] = useState<readonly (readonly string[])[]>(() => model ? tableMatrix(model) : []);
  const [selection, setSelection] = useState<CellSelection>({ anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } });
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<Coordinate | null>(null);
  const [draft, setDraft] = useState("");
  const editingOriginalRef = useRef("");
  const finishingCellRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const [selectionOverlay, setSelectionOverlay] = useState<SelectionOverlay | null>(null);
  const matrixRef = useRef(matrix);
  const selectionRef = useRef(selection);
  const modelRef = useRef(model);
  const listenersRef = useRef(new Set<() => void>());
  matrixRef.current = matrix;
  selectionRef.current = selection;
  modelRef.current = model;

  useEffect(() => {
    if (!model) return;
    const next = tableMatrix(model);
    setMatrix(next);
    setSelection((current) => ({
      anchor: { row: Math.min(current.anchor.row, next.length - 1), column: Math.min(current.anchor.column, model.columns - 1) },
      focus: { row: Math.min(current.focus.row, next.length - 1), column: Math.min(current.focus.column, model.columns - 1) },
    }));
  }, [model]);

  const notify = useCallback(() => listenersRef.current.forEach((listener) => listener()), []);

  const commitMatrix = useCallback((next: readonly (readonly string[])[], structural = false) => {
    const currentModel = modelRef.current;
    if (!currentModel) return;
    const markdown = structural ? serializeTableMatrix(currentModel, next) : replaceTableCellContents(currentModel, next);
    if (markdown === block.raw) return;
    const result = controller.commitRichEdit({
      sessionId,
      baseCandidateRevision: candidateRevision,
      mutations: [{ kind: "replace-block", blockViewKey, markdown }],
      selectionAfter: null,
    });
    if (result.kind === "accepted") {
      setMatrix(next);
      const columns = Math.max(1, ...next.map((row) => row.length));
      setSelection((current) => ({
        anchor: {
          row: Math.min(current.anchor.row, Math.max(0, next.length - 1)),
          column: Math.min(current.anchor.column, columns - 1),
        },
        focus: {
          row: Math.min(current.focus.row, Math.max(0, next.length - 1)),
          column: Math.min(current.focus.column, columns - 1),
        },
      }));
      notify();
    }
  }, [block.raw, blockViewKey, candidateRevision, controller, notify, sessionId]);

  const beginEditing = useCallback((coordinate: Coordinate, source = matrixRef.current) => {
    const value = source[coordinate.row]?.[coordinate.column] ?? "";
    finishingCellRef.current = null;
    editingOriginalRef.current = value;
    setSelection({ anchor: coordinate, focus: coordinate });
    setDraft(value);
    setEditing(coordinate);
  }, []);

  const finishEditing = useCallback((
    action: "commit" | "cancel",
    nextCoordinate: Coordinate | null = null,
  ) => {
    if (!editing) return;
    const editingKey = `${editing.row}:${editing.column}`;
    finishingCellRef.current = editingKey;
    const nextMatrix = action === "commit"
      ? matrixRef.current.map((row, rowIndex) => row.map((value, columnIndex) =>
          rowIndex === editing.row && columnIndex === editing.column ? draft : value,
        ))
      : matrixRef.current;
    if (action === "commit") commitMatrix(nextMatrix);
    if (nextCoordinate) {
      const value = nextMatrix[nextCoordinate.row]?.[nextCoordinate.column] ?? "";
      editingOriginalRef.current = value;
      setSelection({ anchor: nextCoordinate, focus: nextCoordinate });
      setDraft(value);
      setEditing(nextCoordinate);
      return;
    }
    setEditing(null);
    setDraft(editingOriginalRef.current);
    queueMicrotask(() => rootRef.current?.focus());
  }, [commitMatrix, draft, editing]);

  const selectedCoordinates = useMemo(() => coordinates(selection, matrix), [matrix, selection]);
  const selectedCoordinateKeys = useMemo(
    () => new Set(selectedCoordinates.map(({ row, column }) => `${row}:${column}`)),
    [selectedCoordinates],
  );
  const selectedValues = useMemo(
    () => selectedCoordinates.map(({ row, column }) => matrix[row]?.[column] ?? ""),
    [matrix, selectedCoordinates],
  );
  useLayoutEffect(() => {
    const wrap = tableWrapRef.current;
    const range = bounds(selection);
    const first = cellRefs.current.get(`${range.top}:${range.left}`);
    const last = cellRefs.current.get(`${range.bottom}:${range.right}`);
    if (!wrap || !first || !last) {
      setSelectionOverlay(null);
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    setSelectionOverlay({
      left: firstRect.left - wrapRect.left + wrap.scrollLeft,
      top: firstRect.top - wrapRect.top + wrap.scrollTop,
      width: lastRect.right - firstRect.left,
      height: lastRect.bottom - firstRect.top,
    });
  }, [matrix, selection]);
  const runFormat = (format: "bold" | "italic" | "strikethrough" | "code") => {
    const current = formatState(selectedValues, format);
    const desired = current === "on" ? "off" : "on";
    const next = matrix.map((row, rowIndex) => row.map((value, columnIndex) => {
      if (!selectedCoordinateKeys.has(`${rowIndex}:${columnIndex}`)) return value;
      return toggleCellFormat(value, format, desired);
    }));
    commitMatrix(next);
  };

  const move = (row: number, column: number, extend: boolean) => {
    const next = {
      row: Math.max(0, Math.min(matrix.length - 1, row)),
      column: Math.max(0, Math.min((model?.columns ?? 1) - 1, column)),
    };
    setSelection((current) => extend ? { anchor: current.anchor, focus: next } : { anchor: next, focus: next });
  };

  const tabCoordinate = (coordinate: Coordinate, direction: -1 | 1): Coordinate | null => {
    const columns = model?.columns ?? 1;
    const index = coordinate.row * columns + coordinate.column + direction;
    if (index < 0 || index >= matrix.length * columns) return null;
    return { row: Math.floor(index / columns), column: index % columns };
  };

  const belowCoordinate = (coordinate: Coordinate): Coordinate | null =>
    coordinate.row + 1 < matrix.length
      ? { row: coordinate.row + 1, column: coordinate.column }
      : null;

  const bridge = useMemo<ActiveEditorBridge>(() => ({
    sessionId,
    candidateRevision,
    blockViewKey,
    mountToken: Symbol("table-editor"),
    getInsertionBlockViewKey: () => blockViewKey,
    getState(): RichToolbarState {
      return {
        canUndo: false,
        canRedo: false,
        canLink: false,
        canBlock: false,
        canList: false,
        block: "paragraph",
        formats: {
          bold: formatState(selectedCoordinates.map(({ row, column }) => matrixRef.current[row]?.[column] ?? ""), "bold"),
          italic: formatState(selectedCoordinates.map(({ row, column }) => matrixRef.current[row]?.[column] ?? ""), "italic"),
          strikethrough: formatState(selectedCoordinates.map(({ row, column }) => matrixRef.current[row]?.[column] ?? ""), "strikethrough"),
          code: formatState(selectedCoordinates.map(({ row, column }) => matrixRef.current[row]?.[column] ?? ""), "code"),
        },
        list: "none",
        linkUrl: null,
      };
    },
    restoreSelection: () => "unsupported",
    run(command: RichCommand) {
      if (command.kind !== "format") return "rejected";
      runFormat(command.value);
      return "ran";
    },
    focus() {
      rootRef.current?.focus();
      return rootRef.current ? "focused" : "stale";
    },
    subscribe(listener) {
      listenersRef.current.add(listener);
      return () => listenersRef.current.delete(listener);
    },
  }), [blockViewKey, candidateRevision, sessionId, selectedCoordinates, matrix]);

  useEffect(() => registerBridge?.(bridge), [bridge, registerBridge]);
  useEffect(() => {
    if (!dragging) return;
    const finish = () => setDragging(false);
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  }, [dragging]);

  if (!model) return <div className="table-editor__fallback">{t("table.fallback")}</div>;

  const isSelected = (row: number, column: number) => {
    const range = bounds(selection);
    return row >= range.top && row <= range.bottom && column >= range.left && column <= range.right;
  };
  const handlePaste = (event: React.ClipboardEvent) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    const incoming = parseTsv(text);
    const range = bounds(selection);
    const height = range.bottom - range.top + 1;
    const width = range.right - range.left + 1;
    const scalar = incoming.length === 1 && incoming[0]!.length === 1;
    if (!scalar && (incoming.length !== height || incoming[0]!.length !== width)) return;
    event.preventDefault();
    const next = matrix.map((row) => [...row]);
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let column = range.left; column <= range.right; column += 1) {
        next[row]![column] = scalar ? incoming[0]![0]! : incoming[row - range.top]![column - range.left]!;
      }
    }
    commitMatrix(next);
  };
  const handleCopy = (event: React.ClipboardEvent) => {
    const copied = copyMatrix(matrix, selection);
    event.clipboardData.setData("text/plain", copied.text);
    event.clipboardData.setData("text/html", copied.html);
    event.preventDefault();
  };
  const clearSelectedCells = () => {
    const selected = new Set(selectedCoordinates.map(({ row, column }) => `${row}:${column}`));
    const next = matrix.map((row, rowIndex) => row.map((value, columnIndex) =>
      selected.has(`${rowIndex}:${columnIndex}`) ? "" : value,
    ));
    commitMatrix(next);
  };
  const handleCut = (event: React.ClipboardEvent) => {
    const copied = copyMatrix(matrix, selection);
    try {
      event.clipboardData.setData("text/plain", copied.text);
      event.clipboardData.setData("text/html", copied.html);
    } catch {
      return;
    }
    event.preventDefault();
    clearSelectedCells();
  };
  const cutToClipboard = async () => {
    const copied = copyMatrix(matrix, selection);
    if (!navigator.clipboard) return;
    try {
      if (typeof navigator.clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
        const item = new ClipboardItem({
          "text/plain": new Blob([copied.text], { type: "text/plain" }),
          "text/html": new Blob([copied.html], { type: "text/html" }),
        });
        await navigator.clipboard.write([item]);
      } else if (typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(copied.text);
      } else {
        return;
      }
      clearSelectedCells();
    } catch {
      // Clipboard failure leaves the table and selection untouched.
    }
  };
  const addRow = () => {
    const index = bounds(selection).bottom + 1;
    const next = matrix.map((row) => [...row]);
    next.splice(index, 0, Array.from({ length: model.columns }, () => ""));
    commitMatrix(next, true);
  };
  const removeRow = () => {
    if (matrix.length <= 1) return;
    const range = bounds(selection);
    const firstBodyRow = Math.max(1, range.top);
    const lastBodyRow = Math.min(matrix.length - 1, range.bottom);
    if (firstBodyRow > lastBodyRow) return;
    const next = matrix.filter((_, row) => row < firstBodyRow || row > lastBodyRow);
    if (next.length === 1) next.push(Array.from({ length: model.columns }, () => ""));
    commitMatrix(next, true);
  };
  const addColumn = () => {
    const index = bounds(selection).right + 1;
    const next = matrix.map((row) => {
      const copy = [...row];
      copy.splice(index, 0, "");
      return copy;
    });
    if (model) commitMatrix(next, true);
  };
  const removeColumn = () => {
    if (model.columns <= 1) return;
    const range = bounds(selection);
    const firstColumn = Math.max(0, range.left);
    const lastColumn = Math.min(model.columns - 1, range.right);
    const next = matrix.map((row) => row.filter((_, column) => column < firstColumn || column > lastColumn));
    if (next.some((row) => row.length === 0)) next.forEach((row) => row.push(""));
    if (model) commitMatrix(next, true);
  };

  return (
    <div
      aria-label={t("table.editor")}
      className="table-editor"
      data-testid="table-editor"
      onCopy={handleCopy}
      onCut={handleCut}
      onPaste={handlePaste}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest?.("[contenteditable='true']")) return;
        if (event.ctrlKey || event.metaKey) {
          const key = event.key.toLowerCase();
          if (key === "b" || key === "i" || key === "e") {
            event.preventDefault();
            runFormat(key === "b" ? "bold" : key === "i" ? "italic" : "code");
          } else if (key === "d") {
            event.preventDefault();
            runFormat("strikethrough");
          } else if (key === "x") {
            event.preventDefault();
            void cutToClipboard();
          }
        } else if (event.key === "Enter" || event.key === "F2") {
          event.preventDefault();
          beginEditing(selection.focus);
        } else if (event.key === "Tab") {
          event.preventDefault();
          const current = selection.focus;
          const nextColumn = event.shiftKey ? current.column - 1 : current.column + 1;
          const nextRow = nextColumn < 0 ? current.row - 1 : nextColumn >= model.columns ? current.row + 1 : current.row;
          move(nextRow, (nextColumn + model.columns) % model.columns, false);
        } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault();
          const delta = event.key === "ArrowUp" ? [-1, 0] : event.key === "ArrowDown" ? [1, 0] : event.key === "ArrowLeft" ? [0, -1] : [0, 1];
          move(selection.focus.row + delta[0]!, selection.focus.column + delta[1]!, event.shiftKey);
        }
      }}
      onMouseLeave={() => { if (!dragging) return; }}
      ref={rootRef}
      role="grid"
      tabIndex={0}
    >
      <div aria-label={t("table.actions")} className="table-editor__toolbar" role="toolbar">
        <button aria-label={t("table.insertRow")} data-table-action="insert-row" onClick={addRow} title={t("table.insertRow")} type="button">
          <TableActionIcon action="insert-row" className="table-editor__icon" />
        </button>
        <button aria-label={t("table.deleteRow")} data-table-action="delete-row" data-table-destructive="true" onClick={removeRow} title={t("table.deleteRow")} type="button">
          <TableActionIcon action="delete-row" className="table-editor__icon" />
        </button>
        <button aria-label={t("table.insertColumn")} data-table-action="insert-column" onClick={addColumn} title={t("table.insertColumn")} type="button">
          <TableActionIcon action="insert-column" className="table-editor__icon" />
        </button>
        <button aria-label={t("table.deleteColumn")} data-table-action="delete-column" data-table-destructive="true" onClick={removeColumn} title={t("table.deleteColumn")} type="button">
          <TableActionIcon action="delete-column" className="table-editor__icon" />
        </button>
      </div>
      <div className="table-editor__table-wrap" ref={tableWrapRef}>
        <table>
          <thead><tr>{matrix[0]?.map((value, column) => (
          <th
            aria-selected={isSelected(0, column)}
            data-column={column}
            data-row={0}
            key={`head-${column}`}
            ref={(node) => {
              const key = `0:${column}`;
              if (node) cellRefs.current.set(key, node);
              else cellRefs.current.delete(key);
            }}
            onDoubleClick={() => beginEditing({ row: 0, column })}
            onMouseDown={(event) => {
              event.preventDefault();
              rootRef.current?.focus();
              const next = { row: 0, column };
              setSelection((current) => event.shiftKey ? { anchor: current.anchor, focus: next } : { anchor: next, focus: next });
              setDragging(true);
            }}
            onMouseEnter={() => { if (dragging) setSelection((current) => ({ anchor: current.anchor, focus: { row: 0, column } })); }}
            role="gridcell"
          ><CellValue
            coordinate={{ row: 0, column }}
            draft={draft}
            editing={editing?.row === 0 && editing.column === column}
            editLabel={t("table.editCell")}
            onBlur={() => {
              const key = `0:${column}`;
              if (finishingCellRef.current === key) {
                finishingCellRef.current = null;
                return;
              }
              finishEditing("commit");
            }}
            onCancel={() => finishEditing("cancel")}
            onEnter={() => finishEditing("commit", belowCoordinate({ row: 0, column }))}
            onTab={(direction) => finishEditing("commit", tabCoordinate({ row: 0, column }, direction))}
            setDraft={setDraft}
            value={value}
          /></th>
          ))}</tr></thead>
          <tbody>{matrix.slice(1).map((row, rowIndex) => <tr key={`row-${rowIndex}`}>
            {row.map((value, column) => {
              const actualRow = rowIndex + 1;
              return <td
                aria-selected={isSelected(actualRow, column)}
                data-column={column}
                data-row={actualRow}
                key={`${actualRow}-${column}`}
                ref={(node) => {
                  const key = `${actualRow}:${column}`;
                  if (node) cellRefs.current.set(key, node);
                  else cellRefs.current.delete(key);
                }}
                onDoubleClick={() => beginEditing({ row: actualRow, column })}
                onMouseDown={(event) => {
                  event.preventDefault();
                  rootRef.current?.focus();
                  const next = { row: actualRow, column };
                  setSelection((current) => event.shiftKey ? { anchor: current.anchor, focus: next } : { anchor: next, focus: next });
                  setDragging(true);
                }}
                onMouseEnter={() => { if (dragging) setSelection((current) => ({ anchor: current.anchor, focus: { row: actualRow, column } })); }}
                role="gridcell"
              ><CellValue
                coordinate={{ row: actualRow, column }}
                draft={draft}
                editing={editing?.row === actualRow && editing.column === column}
                editLabel={t("table.editCell")}
                onBlur={() => {
                  const key = `${actualRow}:${column}`;
                  if (finishingCellRef.current === key) {
                    finishingCellRef.current = null;
                    return;
                  }
                  finishEditing("commit");
                }}
                onCancel={() => finishEditing("cancel")}
                onEnter={() => finishEditing("commit", belowCoordinate({ row: actualRow, column }))}
                onTab={(direction) => finishEditing("commit", tabCoordinate({ row: actualRow, column }, direction))}
                setDraft={setDraft}
                value={value}
              /></td>;
            })}
          </tr>)}</tbody>
        </table>
        {selectionOverlay ? (
          <div
            aria-hidden="true"
            className="table-editor__selection-overlay"
            data-testid="table-selection-overlay"
            style={{
              height: selectionOverlay.height,
              left: selectionOverlay.left,
              top: selectionOverlay.top,
              width: selectionOverlay.width,
            }}
          />
        ) : null}
      </div>
      {selectedCoordinates.length > 1 ? (
        <span aria-live="polite" className="table-editor__selection-count">{t("table.selectedCells", { count: selectedCoordinates.length })}</span>
      ) : null}
    </div>
  );
}

function CellValue({
  coordinate,
  editLabel,
  editing,
  value,
  draft,
  setDraft,
  onBlur,
  onCancel,
  onEnter,
  onTab,
}: {
  coordinate: Coordinate;
  editLabel: string;
  editing: boolean;
  value: string;
  draft: string;
  setDraft(value: string): void;
  onBlur(): void;
  onCancel(): void;
  onEnter(): void;
  onTab(direction: -1 | 1): void;
}) {
  if (editing) return <div
    aria-label={editLabel}
    contentEditable
    data-column={coordinate.column}
    data-row={coordinate.row}
    onBlur={onBlur}
    onInput={(event) => setDraft(event.currentTarget.textContent ?? "")}
    onKeyDown={(event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        onTab(event.shiftKey ? -1 : 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onEnter();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }}
    key="editor"
    ref={(node) => { if (node && node.textContent !== draft) node.textContent = draft; node?.focus(); }}
    role="textbox"
    suppressContentEditableWarning
  />;
  return <div className="table-editor__cell-value" key="value"><ReactMarkdown remarkPlugins={[remarkGfm]}>{value || " "}</ReactMarkdown></div>;
}

export default TableEditor;

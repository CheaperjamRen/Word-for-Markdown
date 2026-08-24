export interface GfmTableCell {
  row: number;
  column: number;
  raw: string;
  contentStart: number;
  contentEnd: number;
}

export interface GfmTableModel {
  raw: string;
  newline: "\n" | "\r\n";
  leadingPipe: boolean;
  trailingPipe: boolean;
  columns: number;
  header: GfmTableCell[];
  delimiter: GfmTableCell[];
  rows: GfmTableCell[][];
}

function trimBounds(value: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(value[start]!)) start += 1;
  while (end > start && /\s/.test(value[end - 1]!)) end -= 1;
  return [start, end];
}

function splitRow(line: string, baseOffset: number, row: number): GfmTableCell[] {
  let from = 0;
  let to = line.length;
  const leadingPipe = line.startsWith("|");
  const trailingPipe = line.endsWith("|") && !line.endsWith("\\|");
  if (leadingPipe) from += 1;
  if (trailingPipe) to -= 1;
  const cells: GfmTableCell[] = [];
  let cellStart = from;
  let codeFence = 0;
  const pushCell = (segmentEnd: number) => {
    const [contentStart, contentEnd] = trimBounds(line, cellStart, segmentEnd);
    cells.push({
      row,
      column: cells.length,
      raw: line.slice(contentStart, contentEnd),
      contentStart: baseOffset + contentStart,
      contentEnd: baseOffset + contentEnd,
    });
  };
  for (let index = from; index < to; index += 1) {
    const character = line[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (line[index + run] === "`") run += 1;
      if (codeFence === 0) codeFence = run;
      else if (codeFence === run) codeFence = 0;
      index += run - 1;
      continue;
    }
    if (codeFence !== 0 || character !== "|") continue;
    pushCell(index);
    cellStart = index + 1;
  }
  pushCell(to);
  return cells;
}

function isDelimiter(value: string): boolean {
  return /^:?-+:?$/.test(value.trim());
}

export function parseGfmTable(raw: string): GfmTableModel | null {
  const lineEndings = raw.match(/\r\n|\n|\r/g) ?? [];
  if (new Set(lineEndings).size > 1) return null;
  const newline: "\n" | "\r\n" = lineEndings[0] === "\r\n" ? "\r\n" : "\n";
  const lines: Array<{ text: string; start: number }> = [];
  let offset = 0;
  for (const line of raw.split(/\r\n|\n/)) {
    lines.push({ text: line, start: offset });
    offset += line.length + newline.length;
  }
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]!.text, lines[0]!.start, 0);
  const delimiter = splitRow(lines[1]!.text, lines[1]!.start, 0);
  if (header.length === 0 || delimiter.length !== header.length || !delimiter.every((cell) => isDelimiter(cell.raw))) return null;
  const rows = lines.slice(2)
    .filter(({ text }) => text.trim().length > 0)
    .map(({ text, start }, index) => splitRow(text, start, index + 1));
  if (rows.some((row) => row.length > header.length)) return null;
  const first = lines[0]!.text;
  const trailing = first.endsWith("|") && !first.endsWith("\\|");
  return {
    raw,
    newline,
    leadingPipe: first.startsWith("|"),
    trailingPipe: trailing,
    columns: header.length,
    header,
    delimiter,
    rows,
  };
}

export function tableMatrix(model: GfmTableModel): string[][] {
  const matrix = [model.header, ...model.rows];
  return matrix.map((row) => Array.from({ length: model.columns }, (_, column) => row[column]?.raw ?? ""));
}

export function replaceTableCellContents(
  model: GfmTableModel,
  values: readonly (readonly string[])[],
): string {
  const cells = [model.header, ...model.rows];
  const edits: Array<{ from: number; to: number; value: string }> = [];
  for (let row = 0; row < Math.min(cells.length, values.length); row += 1) {
    for (let column = 0; column < model.columns; column += 1) {
      const cell = cells[row]?.[column];
      const value = values[row]?.[column];
      if (!cell || value === undefined || value === cell.raw) continue;
      edits.push({ from: cell.contentStart, to: cell.contentEnd, value: value.replace(/\r?\n/g, " ") });
    }
  }
  let result = model.raw;
  for (const edit of edits.sort((left, right) => right.from - left.from)) {
    result = result.slice(0, edit.from) + edit.value + result.slice(edit.to);
  }
  return result;
}

export function serializeTableMatrix(
  model: GfmTableModel,
  matrix: readonly (readonly string[])[],
): string {
  const columns = Math.max(model.columns, ...matrix.map((row) => row.length));
  const delimiter = Array.from({ length: columns }, (_, column) => model.delimiter[column]?.raw.trim() || "---");
  const renderRow = (row: readonly string[]) => {
    const body = Array.from({ length: columns }, (_, column) => row[column] ?? "").join(" | ");
    return `${model.leadingPipe ? "| " : ""}${body}${model.trailingPipe ? " |" : ""}`;
  };
  const rows = matrix.map(renderRow);
  rows.splice(1, 0, renderRow(delimiter));
  return rows.join(model.newline) + (model.raw.endsWith(model.newline) ? model.newline : "");
}

export function toggleCellFormat(value: string, format: "bold" | "italic" | "strikethrough" | "code", desired: "on" | "off"): string {
  const markers = {
    bold: ["**", "**"],
    italic: ["*", "*"],
    strikethrough: ["~~", "~~"],
    code: ["`", "`"],
  } as const;
  const [open, close] = markers[format];
  if (desired === "off" && value.startsWith(open) && value.endsWith(close) && value.length >= open.length + close.length) {
    return value.slice(open.length, -close.length);
  }
  if (desired === "on" && !(value.startsWith(open) && value.endsWith(close))) return `${open}${value}${close}`;
  return value;
}

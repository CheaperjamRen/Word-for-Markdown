import type { SourceHistoryGroup, SourceHistoryKind } from "../contracts/markdown";

export interface SourceHistoryEdit {
  kind: SourceHistoryKind;
  at: number;
  from: number;
  to: number;
  beforeHead: number;
  afterHead: number;
  hasLineBreak: boolean;
  deleteDirection: "backward" | "forward" | null;
}

export interface ActiveSourceHistoryGroup {
  group: SourceHistoryGroup;
  lastEdit: SourceHistoryEdit;
}

function rangesAreAdjacent(previous: SourceHistoryEdit, current: SourceHistoryEdit): boolean {
  if (current.kind === "typing") return current.from === previous.afterHead;
  return current.from === previous.afterHead || current.to === previous.afterHead;
}

export function continueSourceHistoryGroup(
  previous: ActiveSourceHistoryGroup | null,
  edit: SourceHistoryEdit,
  nextId: () => string,
): ActiveSourceHistoryGroup {
  const elapsed = previous === null ? Number.POSITIVE_INFINITY : edit.at - previous.lastEdit.at;
  const canContinue =
    previous !== null &&
    previous.group.kind === edit.kind &&
    (edit.kind === "typing" || edit.kind === "delete") &&
    previous.lastEdit.deleteDirection === edit.deleteDirection &&
    elapsed >= 0 &&
    elapsed < 500 &&
    !previous.lastEdit.hasLineBreak &&
    !edit.hasLineBreak &&
    edit.beforeHead === previous.lastEdit.afterHead &&
    rangesAreAdjacent(previous.lastEdit, edit);

  return {
    group: canContinue ? previous.group : { id: nextId(), kind: edit.kind },
    lastEdit: { ...edit },
  };
}

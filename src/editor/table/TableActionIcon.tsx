import type { SVGProps } from "react";

export type TableAction = "insert-row" | "delete-row" | "insert-column" | "delete-column";

/** A centered, low-density table glyph with one unmistakable action mark. */
export function TableActionIcon({ action, ...props }: { action: TableAction } & SVGProps<SVGSVGElement>) {
  const rowAction = action.endsWith("row");
  const insert = action.startsWith("insert");
  return (
    <svg
      aria-hidden="true"
      data-axis={rowAction ? "row" : "column"}
      data-operation={insert ? "insert" : "delete"}
      fill="none"
      viewBox="0 0 24 24"
      {...props}
    >
      <g data-table-skeleton={rowAction ? "row" : "column"}>
        <rect className="table-action-icon__base" height="12" rx="1" width="12" x="4" y="4" />
        <path className="table-action-icon__base" d="M4 8h12M10 4v12" />
      </g>
      {insert ? (
        <g className="table-action-icon__glyph table-action-icon__glyph--insert" data-action-mark="insert" data-mark-shape="arrow">
          <path d={rowAction ? "M12 17v5m0 0-2.5-2.5M12 22l2.5-2.5" : "M17 12h5m0 0-2.5-2.5M22 12l-2.5 2.5"} />
        </g>
      ) : (
        <g className="table-action-icon__glyph table-action-icon__glyph--delete" data-action-mark="delete" data-mark-shape="minus">
          {rowAction
            ? <rect className="table-action-icon__delete-badge" height="4" rx="1" width="10" x="7" y="18" />
            : <rect className="table-action-icon__delete-badge" height="10" rx="1" width="4" x="18" y="7" />}
          <path className="table-action-icon__delete-mark" d={rowAction ? "M9 20h6" : "M20 9v6"} />
        </g>
      )}
    </svg>
  );
}

import type { SVGProps } from "react";

const PATHS = {
  add: "M10 3.5v13M3.5 10h13",
  bold: "M6 3.5h4.5a3 3 0 0 1 0 6H6m0 0h5a3.5 3.5 0 0 1 0 7H6z",
  "bullet-list": "M4 5h.1M7 5h9M4 10h.1M7 10h9M4 15h.1M7 15h9",
  chevron: "m6 8 4 4 4-4",
  close: "m5.5 5.5 9 9m0-9-9 9",
  "code-block": "M4 3.5h12v13H4zM8 8l-2 2 2 2m4-4 2 2-2 2",
  document: "M5 2.75h6.5l3.5 3.5v11H5zM11.5 2.75v3.5H15M7.5 10h5M7.5 13h5",
  dots: "M4 10h.1M10 10h.1M16 10h.1",
  formula: "M5 5h7M8.5 5 6 15m5-6h4m-2-2v4",
  grip: "M7 5h.1M13 5h.1M7 10h.1M13 10h.1M7 15h.1M13 15h.1",
  "horizontal-rule": "M3 10h14",
  image: "M3 4h14v12H3zM6.5 8h.1M4.5 14l4-4 2.5 2.5 2-2 2.5 3.5",
  "inline-code": "m7 6-4 4 4 4m6-8 4 4-4 4m-2.5-9-3 18",
  italic: "M8 4h7M5 16h7m0-12L8 16",
  link: "M8.25 12.25 6.5 14a3.18 3.18 0 0 1-4.5-4.5l2-2A3.18 3.18 0 0 1 8.5 7m3.25.75L13.5 6A3.18 3.18 0 1 1 18 10.5l-2 2a3.18 3.18 0 0 1-4.5.5M7.5 10h5",
  mermaid: "M3 3h5v4H3zM12 13h5v4h-5zM3 13h5v4H3zM8 5h4.5v8M8 15h4",
  "number-list": "M3.5 4.5h1v4m-1 0h2M3.5 12.5c0-1 2-1 2 0 0 1-2 2h2M8 6h8M8 14h8",
  open: "M2.75 6.5h5l1.5-2h8v3M3.25 7.5h14l-2 9.5h-14z",
  outline: "M3 3.5h14v13H3zM7.5 3.5v13M10 6.5h4.5M10 10h4.5M10 13.5h3",
  quote: "M4 6h5v5H6l-2 3m8-8h5v5h-3l-2 3",
  reading: "M3.5 4.5c2.4-.8 4.7-.5 6.5 1v10c-1.8-1.5-4.1-1.8-6.5-1V4.5zm13 0c-2.4-.8-4.7-.5-6.5 1v10c1.8-1.5 4.1-1.8 6.5-1V4.5zM10 5.5v10",
  redo: "M14.5 5 18 8.5 14.5 12M18 8.5h-8a5 5 0 0 0-5 5",
  rich: "M4 4h12M4 8h8M4 12h12M4 16h8M14 7v4m-2-2h4",
  save: "M3 3h11l3 3v11H3zM6 3v5h7V3M6.5 17v-5h7v5",
  source: "M7 5 3 10l4 5M13 5l4 5-4 5M11 3 9 17",
  strike: "M6 5.5c.8-1 2-1.5 3.8-1.5 2.1 0 3.5.8 4.2 2M4 10h12m-2 3c-.8 2-2.4 3-4.4 3-2.2 0-3.7-.8-4.6-2",
  table: "M3 4h14v12H3zM3 8h14M8 4v12m4-8v8",
  "task-list": "M3 4h4v4H3zM9 6h8M4 14l1.5 1.5L8 12m1 2h8",
  undo: "M5.5 5 2 8.5 5.5 12M2 8.5h8a5 5 0 0 1 5 5",
} as const;

export type IconName = keyof typeof PATHS;

export function ShellIcon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20" {...props}>
      <path d={PATHS[name]} />
    </svg>
  );
}

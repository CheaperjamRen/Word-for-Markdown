export type DocumentLayout = "a4" | "a3" | "canvas";

export const DOCUMENT_LAYOUT_LABELS: Readonly<Record<DocumentLayout, string>> = {
  a4: "A4 纵向",
  a3: "A3 宽幅",
  canvas: "自由画布",
};

import type { IconName } from "./icons";
import type { MessageKey } from "../../i18n/messages";

export type ToolbarActionId =
  | "save" | "block-style"
  | "bold" | "italic" | "strike" | "inline-code" | "link"
  | "bullet-list" | "number-list" | "task-list" | "quote" | "code-block"
  | "table" | "image" | "formula" | "horizontal-rule" | "mermaid"
  | "undo" | "redo";

export type ToolbarPlacement = "core" | "wide" | "overflow-only";
export type ToolbarGroupId = "file" | "style" | "format" | "block" | "insert" | "history";
export type ToolbarCommandBehavior = "toggle" | "momentary";
export type ToolbarToggleState = "off" | "on" | "mixed";

export type ToolbarItem =
  | { kind: "save"; id: "save"; group: "file"; placement: "core"; label: "保存"; icon: IconName }
  | { kind: "block-style"; id: "block-style"; group: "style"; placement: "core"; label: "段落样式"; text: "正文" }
  | { kind: "command"; id: Exclude<ToolbarActionId, "save" | "block-style">; group: Exclude<ToolbarGroupId, "file" | "style">; placement: ToolbarPlacement; behavior: ToolbarCommandBehavior; label: string; icon: IconName; shortcut?: string }
  | { kind: "spacer"; id: "history-spacer" }
  | { kind: "overflow-trigger"; id: "more"; label: "更多" };

export interface ToolbarActionState {
  enabled: boolean;
  toggleState: ToolbarToggleState | null;
  busy: boolean;
  title: string;
  text?: string;
  choices?: readonly {
    value: string;
    label: string;
    selected: boolean;
    execute(): void;
  }[];
  linkEditor?: {
    url: string | null;
    apply(url: string): void;
    remove(): void;
  };
  execute(): void;
}

export type ToolbarStateById = Readonly<Record<ToolbarActionId, ToolbarActionState>>;
export type ToolbarCommandItem = Extract<ToolbarItem, { kind: "command" }>;

export interface ToolbarLayout {
  primary: readonly ToolbarItem[];
  overflowGroups: readonly {
    id: ToolbarGroupId;
    label: string;
    commands: readonly ToolbarCommandItem[];
  }[];
}

export const TOOLBAR_ITEMS: readonly ToolbarItem[] = [
  { kind: "save", id: "save", group: "file", placement: "core", label: "保存", icon: "save" },
  { kind: "block-style", id: "block-style", group: "style", placement: "core", label: "段落样式", text: "正文" },
  { kind: "command", id: "bold", group: "format", placement: "core", behavior: "toggle", label: "加粗", icon: "bold" },
  { kind: "command", id: "italic", group: "format", placement: "core", behavior: "toggle", label: "斜体", icon: "italic" },
  { kind: "command", id: "strike", group: "format", placement: "wide", behavior: "toggle", label: "删除线", icon: "strike" },
  { kind: "command", id: "inline-code", group: "format", placement: "wide", behavior: "toggle", label: "行内代码", icon: "inline-code" },
  { kind: "command", id: "link", group: "format", placement: "core", behavior: "momentary", label: "插入链接", icon: "link" },
  { kind: "command", id: "bullet-list", group: "block", placement: "core", behavior: "toggle", label: "项目列表", icon: "bullet-list" },
  { kind: "command", id: "number-list", group: "block", placement: "core", behavior: "toggle", label: "编号列表", icon: "number-list" },
  { kind: "command", id: "task-list", group: "block", placement: "core", behavior: "toggle", label: "任务列表", icon: "task-list" },
  { kind: "command", id: "quote", group: "block", placement: "core", behavior: "toggle", label: "引用", icon: "quote" },
  { kind: "command", id: "code-block", group: "block", placement: "wide", behavior: "toggle", label: "代码块", icon: "code-block" },
  { kind: "command", id: "table", group: "insert", placement: "core", behavior: "momentary", label: "插入表格", icon: "table" },
  { kind: "command", id: "image", group: "insert", placement: "wide", behavior: "momentary", label: "插入图片", icon: "image" },
  { kind: "command", id: "formula", group: "insert", placement: "wide", behavior: "momentary", label: "插入公式", icon: "formula" },
  { kind: "command", id: "horizontal-rule", group: "block", placement: "overflow-only", behavior: "momentary", label: "分隔线", icon: "horizontal-rule" },
  { kind: "command", id: "mermaid", group: "insert", placement: "overflow-only", behavior: "momentary", label: "Mermaid", icon: "mermaid" },
  { kind: "spacer", id: "history-spacer" },
  { kind: "command", id: "undo", group: "history", placement: "core", behavior: "momentary", label: "撤销", icon: "undo" },
  { kind: "command", id: "redo", group: "history", placement: "core", behavior: "momentary", label: "重做", icon: "redo" },
  { kind: "overflow-trigger", id: "more", label: "更多" },
] as const;

export const TOOLBAR_ACTION_IDS: readonly ToolbarActionId[] = TOOLBAR_ITEMS
  .filter((item): item is Exclude<ToolbarItem, { kind: "spacer" | "overflow-trigger" }> =>
    item.kind !== "spacer" && item.kind !== "overflow-trigger",
  )
  .map((item) => item.id);

const TOOLBAR_LABEL_KEYS: Readonly<Record<ToolbarActionId | "more", MessageKey>> = {
  save: "toolbar.save",
  "block-style": "toolbar.blockStyle",
  bold: "toolbar.bold",
  italic: "toolbar.italic",
  strike: "toolbar.strike",
  "inline-code": "toolbar.inlineCode",
  link: "toolbar.link",
  "bullet-list": "toolbar.bulletList",
  "number-list": "toolbar.numberList",
  "task-list": "toolbar.taskList",
  quote: "toolbar.quote",
  "code-block": "toolbar.codeBlock",
  table: "toolbar.table",
  image: "toolbar.image",
  formula: "toolbar.formula",
  "horizontal-rule": "toolbar.horizontalRule",
  mermaid: "toolbar.mermaid",
  undo: "toolbar.undo",
  redo: "toolbar.redo",
  more: "toolbar.more",
};

export function toolbarLabelKey(id: ToolbarActionId | "more"): MessageKey {
  return TOOLBAR_LABEL_KEYS[id];
}

export function toolbarGroupLabelKey(id: ToolbarGroupId): MessageKey | null {
  if (id === "format") return "toolbar.groupFormat";
  if (id === "block") return "toolbar.groupBlock";
  if (id === "insert") return "toolbar.groupInsert";
  return null;
}

const OVERFLOW_GROUPS: readonly { id: ToolbarGroupId; label: string }[] = [
  { id: "format", label: "格式" },
  { id: "block", label: "块" },
  { id: "insert", label: "插入" },
];

export function createToolbarLayout(compact: boolean): ToolbarLayout {
  const primary = TOOLBAR_ITEMS.filter((item) =>
    item.kind !== "command" || item.placement === "core" || (!compact && item.placement === "wide"),
  );
  const overflowCommands = TOOLBAR_ITEMS.filter((item): item is ToolbarCommandItem =>
    item.kind === "command" && (item.placement === "overflow-only" || (compact && item.placement === "wide")),
  );
  const overflowGroups = OVERFLOW_GROUPS.map((group) => ({
    ...group,
    commands: overflowCommands.filter((command) => command.group === group.id),
  })).filter((group) => group.commands.length > 0);
  return { primary, overflowGroups };
}

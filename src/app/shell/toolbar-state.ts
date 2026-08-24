import type { DocumentController } from "../use-document-controller";
import { documentCommandIsEnabled } from "../../documents/session";
import type {
  ActiveEditorBridge,
  ActiveEditorRegistry,
  RichCommand,
  RichFormat,
} from "../../editor/active-editor";
import type { ReadingSelectionSnapshot } from "../../editor/reading-selection";
import {
  TOOLBAR_ACTION_IDS,
  type ToolbarActionId,
  type ToolbarActionState,
  type ToolbarStateById,
} from "./toolbar-commands";
import { formatMessage, type MessageKey } from "../../i18n/messages";
import { toolbarLabelKey } from "./toolbar-commands";

const TOGGLE_ACTION_IDS = new Set<ToolbarActionId>([
  "bold",
  "italic",
  "strike",
  "inline-code",
  "bullet-list",
  "number-list",
  "task-list",
  "quote",
  "code-block",
]);

type ToolbarTranslator = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

const disabledState = (id: ToolbarActionId, t: ToolbarTranslator): ToolbarActionState => {
  const base = t(toolbarLabelKey(id));
  const shortcut = id === "undo" ? "Ctrl+Z" : id === "redo" ? "Ctrl+Y" : null;
  const title = shortcut ? `${base} (${shortcut})` : base;
  return {
    enabled: false,
    toggleState: TOGGLE_ACTION_IDS.has(id) ? "off" : null,
    busy: false,
    title,
    execute: () => undefined,
  };
};

const BLOCK_LABEL_KEYS = {
  paragraph: "block.paragraph",
  h1: "block.heading1",
  h2: "block.heading2",
  h3: "block.heading3",
  h4: "block.heading4",
  h5: "block.heading5",
  h6: "block.heading6",
  quote: "block.blockquote",
  code: "block.code",
} as const;

export function createToolbarStateById(
  controller: DocumentController,
  richRegistry?: ActiveEditorRegistry,
  readingContext?: {
    selection: ReadingSelectionSnapshot;
    run(command: RichCommand): void;
  },
  t: ToolbarTranslator = (key, values) => formatMessage("zh-CN", key, values),
): ToolbarStateById {
  const active = controller.tabs.find((tab) => tab.id === controller.activeTabId);
  const document = active?.kind === "document" ? active : null;
  const states = Object.fromEntries(
    TOOLBAR_ACTION_IDS.map((id) => [id, disabledState(id, t)]),
  ) as ToolbarStateById;
  if (!document) return states;
  const currentDocument = () => {
    const current = controller.tabs.find((tab) => tab.id === controller.activeTabId);
    return current?.kind === "document" ? current : null;
  };

  const shared = {
    ...states,
    save: {
      enabled: documentCommandIsEnabled(document, "save"),
      toggleState: null,
      busy: document.status === "saving",
      title: document.sourceBuffer
        ? t("toolbar.fixBeforeSave")
        : document.protectedRawBuffer
          ? t("toolbar.finishRawBeforeSave")
          : t("toolbar.saveShortcut"),
      execute: () => { void controller.save(document.id); },
    },
    undo: {
      get enabled() {
        const current = currentDocument();
        return Boolean(current && documentCommandIsEnabled(current, "undo"));
      },
      toggleState: null,
      busy: false,
      title: states.undo.title,
      execute: () => {
        const current = currentDocument();
        if (current && documentCommandIsEnabled(current, "undo")) controller.undo(current.id, current.revision);
      },
    },
    redo: {
      get enabled() {
        const current = currentDocument();
        return Boolean(current && documentCommandIsEnabled(current, "redo"));
      },
      toggleState: null,
      busy: false,
      title: states.redo.title,
      execute: () => {
        const current = currentDocument();
        if (current && documentCommandIsEnabled(current, "redo")) controller.redo(current.id, current.revision);
      },
    },
  };
  const bridge: Pick<ActiveEditorBridge, "blockViewKey" | "getInsertionBlockViewKey" | "getState" | "run" | "focus"> | null =
    document.mode === "rich" && richRegistry
      ? richRegistry.getActive(document.id, document.revision)
      : document.mode === "reading" &&
          readingContext?.selection.sessionId === document.id &&
          readingContext.selection.candidateRevision === document.revision
        ? {
            blockViewKey: readingContext.selection.blockViewKey,
            getInsertionBlockViewKey: () => readingContext.selection.blockViewKey,
            getState: () => readingContext.selection.state,
            run: (command) => {
              readingContext.run(command);
              return "ran";
            },
            focus: () => "focused",
          }
        : null;
  if (!bridge) return shared;
  const rich = bridge.getState();
  const insertionBlockViewKey = bridge.getInsertionBlockViewKey();
  const hasInsertionAnchor = insertionBlockViewKey !== null || document.candidate.blocks.length === 0;
  const activateFreshInsertedBlock = (
    result: ReturnType<DocumentController["commitRichEdit"]>,
    expectedKind: string,
  ) => {
    if (result.kind !== "accepted" || !richRegistry) return;
    const accepted = controller.tabs.find((tab) => tab.id === document.id);
    if (
      accepted?.kind !== "document" ||
      accepted.mode !== "rich" ||
      accepted.revision !== result.candidateRevision
    ) return;
    const previousKeys = new Set(document.blockViewKeys.values());
    const insertedKeys = accepted.candidate.blocks.flatMap((block) => {
      const key = accepted.blockViewKeys.get(block.id);
      return block.kind === expectedKind && key && !previousKeys.has(key) ? [key] : [];
    });
    if (insertedKeys.length !== 1) return;
    const insertedKey = insertedKeys[0]!;
    const token = Symbol(`insert-${expectedKind}`);
    richRegistry.requestActivation(accepted.id, accepted.revision, insertedKey, token);
    void richRegistry.waitFor(accepted.id, accepted.revision, insertedKey, token).then((insertedBridge) => {
      const live = controller.tabs.find((tab) => tab.id === accepted.id);
      if (
        insertedBridge &&
        live?.kind === "document" &&
        live.mode === "rich" &&
        live.revision === accepted.revision
      ) insertedBridge.focus();
      richRegistry.clearActivation(token);
    });
  };
  const richStates = { ...shared };
  const formatById = {
    bold: "bold",
    italic: "italic",
    strike: "strikethrough",
    "inline-code": "code",
  } as const satisfies Readonly<Record<"bold" | "italic" | "strike" | "inline-code", RichFormat>>;
  for (const [id, format] of Object.entries(formatById) as Array<
    [keyof typeof formatById, RichFormat]
  >) {
    const toggleState = rich.formats[format];
    richStates[id] = {
      ...states[id],
      enabled: true,
      toggleState,
      execute: () => {
        bridge.run({
          kind: "format",
          value: format,
          desired: toggleState === "on" ? "off" : "on",
        });
        bridge.focus();
      },
    };
  }
  const listById = {
    "bullet-list": "bullet",
    "number-list": "number",
    "task-list": "task",
  } as const;
  for (const [id, list] of Object.entries(listById) as Array<
    [keyof typeof listById, "bullet" | "number" | "task"]
  >) {
    richStates[id] = {
      ...states[id],
      enabled: rich.canList !== false,
      toggleState: rich.list === list ? "on" : "off",
      execute: () => {
        bridge.run({ kind: "list", value: list });
        bridge.focus();
      },
    };
  }
  for (const [id, block] of [["quote", "quote"], ["code-block", "code"]] as const) {
    richStates[id] = {
      ...states[id],
      enabled: rich.canBlock !== false,
      toggleState: rich.block === block ? "on" : "off",
      execute: () => {
        bridge.run({ kind: "block", value: rich.block === block ? "paragraph" : block });
        bridge.focus();
      },
    };
  }
  richStates.link = {
    ...states.link,
    enabled: rich.canLink || rich.linkUrl !== null,
    linkEditor: {
      url: rich.linkUrl,
      apply: (url) => {
        bridge.run({ kind: "link", url });
        bridge.focus();
      },
      remove: () => {
        bridge.run({ kind: "link", url: null });
        bridge.focus();
      },
    },
    execute: () => { bridge.focus(); },
  };
  const newline = document.candidate.newline === "crlf" ? "\r\n" : "\n";
  richStates["horizontal-rule"] = {
    ...states["horizontal-rule"],
    enabled: rich.canBlock !== false && hasInsertionAnchor,
    execute: () => {
      if (!hasInsertionAnchor) return;
      controller.commitRichEdit({
        sessionId: document.id,
        baseCandidateRevision: document.revision,
        mutations: [{
          kind: "insert-after",
          blockViewKey: insertionBlockViewKey,
          markdown: `${newline}${newline}---`,
        }],
        selectionAfter: null,
      });
    },
  };
  richStates.formula = {
    ...states.formula,
    enabled: hasInsertionAnchor,
    execute: () => {
      if (!hasInsertionAnchor) return;
      controller.commitRichEdit({
        sessionId: document.id,
        baseCandidateRevision: document.revision,
        mutations: [{
          kind: "insert-after",
          blockViewKey: insertionBlockViewKey,
          markdown: `${newline}${newline}$$\n\\int_{a}^{b} f(x)\\,dx\n$$`,
        }],
        selectionAfter: null,
      });
    },
  };
  richStates.mermaid = {
    ...states.mermaid,
    enabled: hasInsertionAnchor,
    execute: () => {
      if (!hasInsertionAnchor) return;
      controller.commitRichEdit({
        sessionId: document.id,
        baseCandidateRevision: document.revision,
        mutations: [{
          kind: "insert-after",
          blockViewKey: insertionBlockViewKey,
          markdown: ["", "", "```mermaid", "graph TD", `  A[${t("insert.diagramStart")}] --> B[${t("insert.diagramEnd")}]`, "```"].join(newline),
        }],
        selectionAfter: null,
      });
    },
  };
  const blockValues = Object.keys(BLOCK_LABEL_KEYS) as Array<keyof typeof BLOCK_LABEL_KEYS>;
  richStates["block-style"] = {
    ...states["block-style"],
    enabled: rich.canBlock !== false,
    text: t(BLOCK_LABEL_KEYS[rich.block]),
    choices: blockValues.map((value) => ({
      value,
      label: t(BLOCK_LABEL_KEYS[value]),
      selected: rich.block === value,
      execute: () => {
        bridge.run({ kind: "block", value });
        bridge.focus();
      },
    })),
    execute: () => { bridge.focus(); },
  };
  richStates.table = {
    ...states.table,
    enabled: hasInsertionAnchor,
    execute: () => {
      if (!hasInsertionAnchor) return;
      const result = controller.commitRichEdit({
        sessionId: document.id,
        baseCandidateRevision: document.revision,
        mutations: [{
          kind: "insert-after",
          blockViewKey: insertionBlockViewKey,
          markdown: `${newline}${newline}|  |  |  |${newline}| --- | --- | --- |${newline}|  |  |  |`,
        }],
        selectionAfter: null,
      });
      activateFreshInsertedBlock(result, "table");
    },
  };
  return richStates;
}

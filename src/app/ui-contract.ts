import type { UiContractSnapshot } from "../contracts/desktop";

type UiContractRole =
  | "ui-label"
  | "status"
  | "document"
  | "toolbar-icon"
  | "icon-button";

function visibleContractElement(
  root: ParentNode,
  role: UiContractRole,
): Element {
  const element = root.querySelector(`[data-ui-contract="${role}"]`);
  if (element) {
    const style = getComputedStyle(element);
    if (style.display !== "none" && style.visibility !== "hidden") {
      return element;
    }
  }

  throw new Error(`ui contract element ${role} is missing or hidden`);
}

export function collectComputedUiContract(
  root: ParentNode,
): UiContractSnapshot {
  const uiLabel = visibleContractElement(root, "ui-label");
  const status = visibleContractElement(root, "status");
  const documentSurface = visibleContractElement(root, "document");
  const toolbarIcon = visibleContractElement(root, "toolbar-icon");
  const iconButton = visibleContractElement(root, "icon-button");

  return {
    uiFontSize: getComputedStyle(uiLabel).fontSize,
    statusFontSize: getComputedStyle(status).fontSize,
    documentFontSize: getComputedStyle(documentSurface).fontSize,
    documentLineHeight: getComputedStyle(documentSurface).lineHeight,
    toolbarIconWidth: getComputedStyle(toolbarIcon).width,
    iconButtonHeight: getComputedStyle(iconButton).height,
  };
}

export function collectComputedReadingUiContract(
  root: ParentNode,
): UiContractSnapshot {
  const uiLabel = visibleContractElement(root, "ui-label");
  const status = visibleContractElement(root, "status");
  const documentSurface = visibleContractElement(root, "document");
  const ownerDocument = root instanceof Document ? root : (root as Node).ownerDocument;
  const tokenRoot = ownerDocument?.documentElement;
  if (!tokenRoot) throw new Error("reading ui contract token root is missing");
  const tokens = getComputedStyle(tokenRoot);
  const toolbarIconWidth = tokens.getPropertyValue("--toolbar-icon-size").trim();
  const iconButtonHeight = tokens.getPropertyValue("--icon-button-size").trim();
  if (!toolbarIconWidth || !iconButtonHeight) throw new Error("reading ui contract tokens are missing");

  return {
    uiFontSize: getComputedStyle(uiLabel).fontSize,
    statusFontSize: getComputedStyle(status).fontSize,
    documentFontSize: getComputedStyle(documentSurface).fontSize,
    documentLineHeight: getComputedStyle(documentSurface).lineHeight,
    toolbarIconWidth,
    iconButtonHeight,
  };
}

export interface ShellContractSnapshot extends UiContractSnapshot {
  tabbarHeight: string;
  menubarHeight: string;
  toolbarHeight: string;
  statusbarHeight: string;
  toolbarIconHeight: string;
  iconButtonWidth: string;
}

function visibleShellElement(root: ParentNode, role: "tabbar" | "menubar" | "toolbar" | "statusbar"): Element {
  const element = root.querySelector(`[data-shell-contract="${role}"]`);
  if (element) {
    const style = getComputedStyle(element);
    if (style.display !== "none" && style.visibility !== "hidden") return element;
  }
  throw new Error(`shell contract element ${role} is missing or hidden`);
}

export function collectComputedShellContract(root: ParentNode): ShellContractSnapshot {
  const base = collectComputedUiContract(root);
  const icon = visibleContractElement(root, "toolbar-icon");
  const button = visibleContractElement(root, "icon-button");
  return {
    tabbarHeight: getComputedStyle(visibleShellElement(root, "tabbar")).height,
    menubarHeight: getComputedStyle(visibleShellElement(root, "menubar")).height,
    toolbarHeight: getComputedStyle(visibleShellElement(root, "toolbar")).height,
    statusbarHeight: getComputedStyle(visibleShellElement(root, "statusbar")).height,
    ...base,
    toolbarIconHeight: getComputedStyle(icon).height,
    iconButtonWidth: getComputedStyle(button).width,
  };
}

const mountedSourceEditorContent = new WeakMap<HTMLElement, () => unknown>();

export function markSourceEditorContent(
  content: HTMLElement,
  resolveEditor: () => unknown,
): () => void {
  mountedSourceEditorContent.set(content, resolveEditor);
  return () => mountedSourceEditorContent.delete(content);
}

export function mountedSourceEditorForContent(content: HTMLElement): unknown | null {
  return mountedSourceEditorContent.get(content)?.() ?? null;
}

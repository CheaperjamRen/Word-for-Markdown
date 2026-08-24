export interface SourceEditorBridge {
  sessionId: string;
  candidateRevision: number;
  mountToken: symbol;
  hasSelection(): boolean;
  copy(): Promise<"copied" | "failed" | "stale">;
  selectAll(): "selected" | "stale";
  openFind(): "opened" | "stale";
  focus(): "focused" | "stale";
}

export interface ActiveSourceEditorRegistry {
  register(bridge: SourceEditorBridge): () => void;
  get(sessionId: string, candidateRevision: number): SourceEditorBridge | null;
  clear(): void;
}

export function createActiveSourceEditorRegistry(): ActiveSourceEditorRegistry {
  const bridges = new Map<string, SourceEditorBridge>();
  return {
    register(bridge) {
      bridges.set(bridge.sessionId, bridge);
      return () => {
        const current = bridges.get(bridge.sessionId);
        if (current?.mountToken === bridge.mountToken) bridges.delete(bridge.sessionId);
      };
    },
    get(sessionId, candidateRevision) {
      const bridge = bridges.get(sessionId);
      return bridge?.candidateRevision === candidateRevision ? bridge : null;
    },
    clear() {
      bridges.clear();
    },
  };
}

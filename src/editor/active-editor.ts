export type RichFormat = "bold" | "italic" | "strikethrough" | "code";
export type RichToggleState = "off" | "on" | "mixed";

export interface RichToolbarState {
  canUndo: boolean;
  canRedo: boolean;
  canLink: boolean;
  /** Whether the active surface accepts block/list commands. Tables opt out. */
  canBlock?: boolean;
  canList?: boolean;
  block: "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote" | "code";
  formats: Readonly<Record<RichFormat, RichToggleState>>;
  list: "none" | "bullet" | "number" | "task";
  linkUrl: string | null;
}

export type RichCommand =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "block"; value: RichToolbarState["block"] }
  | { kind: "format"; value: RichFormat; desired: "on" | "off" }
  | { kind: "list"; value: Exclude<RichToolbarState["list"], "none"> }
  | { kind: "link"; url: string | null }
  | { kind: "horizontal-rule" };

export interface RichSelectionBookmark {
  blockViewKey: string;
  anchorTextOffset: number;
  focusTextOffset: number;
}

export interface ActiveEditorBridge {
  sessionId: string;
  candidateRevision: number;
  blockViewKey: string;
  mountToken: symbol;
  getState(): RichToolbarState;
  getInsertionBlockViewKey(): string | null;
  restoreSelection(bookmark: RichSelectionBookmark): "restored" | "unsupported" | "stale";
  run(command: RichCommand): "ran" | "rejected" | "stale";
  focus(): "focused" | "stale";
  subscribe?(listener: () => void): () => void;
}

export interface ActiveEditorRegistry {
  register(bridge: ActiveEditorBridge): () => void;
  get(sessionId: string, revision: number, blockViewKey: string): ActiveEditorBridge | null;
  getActive(sessionId: string, revision: number): ActiveEditorBridge | null;
  requestActivation(sessionId: string, revision: number, blockViewKey: string, token: symbol): void;
  getActivation(
    sessionId: string,
    revision: number,
  ): { blockViewKey: string; token: symbol } | null;
  clearActivation(token: symbol): void;
  waitFor(
    sessionId: string,
    revision: number,
    blockViewKey: string,
    token: symbol,
  ): Promise<ActiveEditorBridge | null>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): number;
  cancel(token: symbol): void;
}

function keyOf(sessionId: string, revision: number, blockViewKey: string): string {
  return `${sessionId}\u0000${revision}\u0000${blockViewKey}`;
}

export function createActiveEditorRegistry(): ActiveEditorRegistry {
  const bridges = new Map<string, ActiveEditorBridge>();
  const bridgeSubscriptions = new Map<string, { mountToken: symbol; stop(): void }>();
  const activations = new Map<string, { blockViewKey: string; token: symbol }>();
  const listeners = new Set<() => void>();
  const waiters = new Map<symbol, {
    key: string;
    resolve(bridge: ActiveEditorBridge | null): void;
  }>();
  let snapshot = 0;
  const emit = () => {
    snapshot += 1;
    listeners.forEach((listener) => listener());
  };

  return {
    register(bridge) {
      const key = keyOf(bridge.sessionId, bridge.candidateRevision, bridge.blockViewKey);
      bridgeSubscriptions.get(key)?.stop();
      bridges.set(key, bridge);
      const stop = bridge.subscribe?.(emit) ?? (() => undefined);
      bridgeSubscriptions.set(key, { mountToken: bridge.mountToken, stop });
      for (const [token, waiter] of waiters) {
        if (waiter.key !== key) continue;
        waiters.delete(token);
        waiter.resolve(bridge);
      }
      emit();
      return () => {
        if (bridges.get(key)?.mountToken !== bridge.mountToken) return;
        bridgeSubscriptions.get(key)?.stop();
        bridgeSubscriptions.delete(key);
        bridges.delete(key);
        emit();
      };
    },
    get(sessionId, revision, blockViewKey) {
      return bridges.get(keyOf(sessionId, revision, blockViewKey)) ?? null;
    },
    getActive(sessionId, revision) {
      const matches = [...bridges.values()].filter(
        (bridge) => bridge.sessionId === sessionId && bridge.candidateRevision === revision,
      );
      return matches.length === 1 ? matches[0] : null;
    },
    requestActivation(sessionId, revision, blockViewKey, token) {
      activations.set(`${sessionId}\u0000${revision}`, { blockViewKey, token });
      emit();
    },
    getActivation(sessionId, revision) {
      return activations.get(`${sessionId}\u0000${revision}`) ?? null;
    },
    clearActivation(token) {
      let changed = false;
      for (const [key, activation] of activations) {
        if (activation.token !== token) continue;
        activations.delete(key);
        changed = true;
      }
      if (changed) emit();
    },
    waitFor(sessionId, revision, blockViewKey, token) {
      const key = keyOf(sessionId, revision, blockViewKey);
      const current = bridges.get(key);
      if (current) return Promise.resolve(current);
      return new Promise((resolve) => {
        const previous = waiters.get(token);
        previous?.resolve(null);
        waiters.set(token, { key, resolve });
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    cancel(token) {
      const waiter = waiters.get(token);
      if (!waiter) return;
      waiters.delete(token);
      waiter.resolve(null);
    },
  };
}

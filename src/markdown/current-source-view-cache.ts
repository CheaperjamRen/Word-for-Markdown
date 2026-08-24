import type { SourceDocument, SourceViewModel } from "../contracts/markdown";
import { buildSourceView } from "./source-view";

export interface CurrentSourceViewEntry {
  readonly sessionId: string;
  readonly candidateRevision: number;
  readonly candidate: SourceDocument;
  readonly view: SourceViewModel;
}

export class CurrentSourceViewCache {
  private readonly entries = new Map<string, CurrentSourceViewEntry>();

  constructor(private readonly buildView: typeof buildSourceView = buildSourceView) {}

  getOrBuild(
    sessionId: string,
    candidateRevision: number,
    candidate: SourceDocument,
  ): CurrentSourceViewEntry {
    const current = this.entries.get(sessionId);
    if (
      current &&
      current.candidateRevision === candidateRevision &&
      current.candidate === candidate
    ) return current;
    const entry: CurrentSourceViewEntry = {
      sessionId,
      candidateRevision,
      candidate,
      view: this.buildView(candidate),
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  evictSession(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  retainSessions(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of this.entries.keys()) {
      if (!sessionIds.has(sessionId)) this.entries.delete(sessionId);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

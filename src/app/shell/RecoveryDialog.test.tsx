import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DraftRecord } from "../../contracts/desktop";
import { RecoveryDialog } from "./RecoveryDialog";

const draft: DraftRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "session-1",
  canonicalPath: "C:\\docs\\note.md",
  baselineVersion: null,
  bytes: [35, 32, 65],
  candidateRevision: 2,
  rejectedSourceBuffer: null,
  updatedMs: 1,
};

describe("RecoveryDialog", () => {
  it("lists recoverable edits in an explicit dialog with timestamps and source-buffer context", async () => {
    const onRestore = vi.fn();
    const onDiscard = vi.fn();
    const onClose = vi.fn();
    const sourceDraft: DraftRecord = {
      ...draft,
      id: "00000000-0000-4000-8000-000000000002",
      canonicalPath: "C:\\docs\\source.md",
      rejectedSourceBuffer: {
        baseCandidateRevision: 1,
        baseCandidateSha256: "a",
        utf16CodeUnitsBase64: "QQA=",
        selection: null,
      },
      updatedMs: Date.UTC(2026, 7, 24, 2, 30),
    };
    render(<RecoveryDialog
      drafts={[draft, sourceDraft]}
      onRestore={onRestore}
      onDiscard={onDiscard}
      onClose={onClose}
    />);
    expect(screen.getByRole("dialog", { name: "恢复未保存编辑" })).toHaveTextContent("note.md");
    expect(screen.getByRole("dialog", { name: "恢复未保存编辑" })).toHaveTextContent("source.md");
    expect(screen.getByText("源码缓冲区")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    expect(screen.queryByText(/实现|调试|下一步|验证/)).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]);
    await userEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    expect(onRestore).toHaveBeenCalledWith(draft.id);
    expect(onDiscard).toHaveBeenCalledWith(draft.id);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

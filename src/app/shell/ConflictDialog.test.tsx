import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConflictDialog } from "./ConflictDialog";

describe("ConflictDialog", () => {
  it("offers explicit local, disk and Save As recovery choices", async () => {
    const onKeepLocal = vi.fn();
    const onUseDisk = vi.fn();
    const onSaveAs = vi.fn();
    render(<ConflictDialog kind="conflict" onKeepLocal={onKeepLocal} onUseDisk={onUseDisk} onSaveAs={onSaveAs} />);
    const user = userEvent.setup();
    expect(screen.getByRole("dialog", { name: "文件发生变化" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保留我的版本" }));
    await user.click(screen.getByRole("button", { name: "载入磁盘版本" }));
    await user.click(screen.getByRole("button", { name: "另存为" }));
    expect(onKeepLocal).toHaveBeenCalledOnce();
    expect(onUseDisk).toHaveBeenCalledOnce();
    expect(onSaveAs).toHaveBeenCalledOnce();
  });
});

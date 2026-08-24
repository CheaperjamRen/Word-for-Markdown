import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkPanel } from "./LinkPanel";

afterEach(cleanup);

describe("LinkPanel", () => {
  it("applies, removes and cancels through one product dialog", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onRemove = vi.fn();
    const onCancel = vi.fn();
    render(<LinkPanel initialUrl="https://old.example" onApply={onApply} onCancel={onCancel} onRemove={onRemove} />);
    const dialog = screen.getByRole("dialog", { name: "链接" });
    const input = screen.getByRole("textbox", { name: "链接地址" });
    await user.clear(input);
    await user.type(input, "https://new.example");
    await user.click(screen.getByRole("button", { name: "应用" }));
    expect(onApply).toHaveBeenCalledWith("https://new.example");

    await user.click(screen.getByRole("button", { name: "移除" }));
    expect(onRemove).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(dialog).toBeInTheDocument();
  });
});

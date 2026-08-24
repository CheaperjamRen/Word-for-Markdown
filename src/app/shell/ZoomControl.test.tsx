import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ZoomControl } from "./ZoomControl";

describe("ZoomControl", () => {
  it("shares minus, slider and plus through one setter", async () => {
    const setZoom = vi.fn();
    render(<ZoomControl value={100} onChange={setZoom} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "缩小文档" }));
    await user.click(screen.getByRole("button", { name: "放大文档" }));
    fireEvent.change(screen.getByRole("slider", { name: "文档缩放" }), { target: { value: "150" } });
    expect(setZoom).toHaveBeenCalledWith(90);
    expect(setZoom).toHaveBeenCalledWith(110);
    expect(setZoom).toHaveBeenLastCalledWith(150);
  });
});

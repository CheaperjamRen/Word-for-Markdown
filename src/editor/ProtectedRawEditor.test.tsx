import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ProtectedRawEditor } from "./ProtectedRawEditor";

afterEach(cleanup);

it("keeps the exact raw buffer editable and exposes only save and cancel actions", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <ProtectedRawEditor
      error="内容无法解析"
      onCancel={onCancel}
      onChange={onChange}
      onSave={onSave}
      value="<custom>raw</custom>"
    />,
  );
  const editor = screen.getByRole("textbox", { name: "局部 Markdown 源码" });
  expect(editor).toHaveFocus();
  expect(editor).toHaveValue("<custom>raw</custom>");
  expect(screen.getByRole("alert")).toHaveTextContent("内容无法解析");
  await user.type(editor, "x");
  expect(onChange).toHaveBeenLastCalledWith("<custom>raw</custom>x");
  await user.click(screen.getByRole("button", { name: "保存局部源码" }));
  expect(onSave).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(onCancel).toHaveBeenCalledOnce();
});

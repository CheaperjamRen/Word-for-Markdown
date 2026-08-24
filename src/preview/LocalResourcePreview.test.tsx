import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LocalResourcePreview } from "./LocalResourcePreview";

describe("LocalResourcePreview", () => {
  it("renders an accessible image or PDF preview with a close action", () => {
    const { rerender } = render(
      <LocalResourcePreview displayName="photo.png" canonicalPath="C:\\docs\\photo.png" mediaType="image" onClose={() => undefined} />,
    );
    expect(screen.getByRole("img", { name: "photo.png" })).toBeInTheDocument();
    rerender(
      <LocalResourcePreview displayName="guide.pdf" canonicalPath="C:\\docs\\guide.pdf" mediaType="pdf" onClose={() => undefined} />,
    );
    expect(screen.getByTitle("guide.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭 guide.pdf" })).toBeInTheDocument();
  });
});

import { describe, expect, it } from "vitest";
import { decodeUtf16CodeUnitsBase64, encodeUtf16CodeUnitsBase64, sha256Hex } from "./draft-codec";

describe("recovery draft codec", () => {
  it("round-trips ordinary, astral, and unpaired UTF-16 code units", () => {
    const value = "前😀后\uD800尾\uDC00";
    expect(decodeUtf16CodeUnitsBase64(encodeUtf16CodeUnitsBase64(value))).toBe(value);
  });

  it("rejects malformed UTF-16 payloads", () => {
    expect(() => decodeUtf16CodeUnitsBase64("AQ==")).toThrow();
    expect(() => decodeUtf16CodeUnitsBase64("not-base64!")).toThrow();
  });

  it("matches the Rust SHA-256 representation", async () => {
    await expect(sha256Hex(new TextEncoder().encode("hello"))).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

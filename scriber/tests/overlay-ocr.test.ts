import { describe, expect, it } from "vitest";

import { buildOverlayCutPath, parseOverlayDigits } from "../src/tooling/overlayOcr.js";

describe("overlay OCR parsing", () => {
  it("extracts digit text up to 6 chars", () => {
    expect(parseOverlayDigits(" 123456 ")).toBe(123456);
    expect(parseOverlayDigits("\n987\n")).toBe(987);
  });

  it("returns null when no valid 0..999999 number exists", () => {
    expect(parseOverlayDigits("")).toBeNull();
    expect(parseOverlayDigits("abc")).toBeNull();
    expect(parseOverlayDigits("1000000")).toBeNull();
  });
});

describe("overlay OCR cut path", () => {
  it("creates an OCR cut file path alongside the screenshot", () => {
    const cutPath = buildOverlayCutPath(
      "C:/tmp/screenshots/000001_abc123_before.png"
    ).replaceAll("\\", "/");
    expect(cutPath).toBe("C:/tmp/screenshots/000001_abc123_before_ocr_cut.png");
  });
});

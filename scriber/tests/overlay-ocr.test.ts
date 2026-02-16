import { describe, expect, it } from "vitest";

import { parseOverlayDigits } from "../src/tooling/overlayOcr.js";

describe("overlay OCR parsing", () => {
  it("extracts digit text up to 5 chars", () => {
    expect(parseOverlayDigits(" 12345 ")).toBe(12345);
    expect(parseOverlayDigits("\n987\n")).toBe(987);
  });

  it("returns null when no valid 0..65535 number exists", () => {
    expect(parseOverlayDigits("")).toBeNull();
    expect(parseOverlayDigits("abc")).toBeNull();
    expect(parseOverlayDigits("999999")).toBeNull();
    expect(parseOverlayDigits("70000")).toBeNull();
  });
});

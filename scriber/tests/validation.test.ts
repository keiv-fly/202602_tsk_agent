import { describe, expect, it } from "vitest";

import { validateActionSchema } from "../src/tooling/validation.js";

describe("action schema validation", () => {
  it("requires required fields and monotonic step numbers", () => {
    const result = validateActionSchema([
      {
        actionId: "a1",
        stepNumber: 1,
        timestamp: new Date().toISOString(),
        actionType: "click",
        url: "http://example.com",
        pageId: "p1",
        beforeScreenshotFileName: "000001_a1_before.png",
        atScreenshotFileName: "000001_a1_at.png",
        afterScreenshotFileName: "000001_a1_after.png",
        pageTitleBefore: "Before",
        pageTitleAfter: "After",
        urlBefore: "http://example.com",
        urlAfter: "http://example.com",
        primarySelector: "#id",
        fallbackSelectors: []
      },
      {
        actionId: "a2",
        stepNumber: 2,
        timestamp: new Date().toISOString(),
        actionType: "click",
        url: "http://example.com",
        pageId: "p1",
        beforeScreenshotFileName: "000002_a2_before.png",
        atScreenshotFileName: "000002_a2_at.png",
        afterScreenshotFileName: "000002_a2_after.png",
        pageTitleBefore: "Before",
        pageTitleAfter: "After",
        urlBefore: "http://example.com",
        urlAfter: "http://example.com",
        primarySelector: "#id",
        fallbackSelectors: []
      }
    ]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

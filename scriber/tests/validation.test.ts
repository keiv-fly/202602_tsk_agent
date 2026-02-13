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
        afterScreenshotFileName: "000001_a1_after.png",
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
        afterScreenshotFileName: "000002_a2_after.png",
        primarySelector: "#id",
        fallbackSelectors: []
      }
    ]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

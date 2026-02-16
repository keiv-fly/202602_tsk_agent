import { describe, expect, it } from "vitest";

import { validateActionSchema } from "../src/tooling/validation.js";

describe("action schema validation", () => {
  it("requires required fields and monotonic step numbers", () => {
    const result = validateActionSchema([
      {
        actionId: "a1",
        stepNumber: 1,
        timestamp: "2026-02-16T17:32:27.785Z",
        timeSinceVideoStartNs: 12_000_000,
        actionType: "click",
        url: "http://example.com",
        pageId: "p1",
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
        timestamp: "2026-02-16T17:32:27.794Z",
        timeSinceVideoStartNs: 21_000_000,
        actionType: "click",
        url: "http://example.com",
        pageId: "p1",
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

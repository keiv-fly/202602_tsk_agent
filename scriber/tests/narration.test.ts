import { describe, expect, it } from "vitest";

import { buildNarrationRecords } from "../src/tooling/narration.js";
import { ActionRecord } from "../src/tooling/types.js";

const mkAction = (overrides: Partial<ActionRecord>): ActionRecord => ({
  actionId: "a",
  stepNumber: 1,
  timestamp: "2026-02-14T09:35:09.000Z",
  timeSinceVideoStartNs: 0,
  actionType: "click",
  url: "https://example.com",
  pageId: "p1",
  pageTitleBefore: null,
  pageTitleAfter: null,
  urlBefore: null,
  urlAfter: null,
  primarySelector: null,
  fallbackSelectors: [],
  ...overrides
});

describe("narration builder", () => {
  it("drops orphan hover actions", () => {
    const actions: ActionRecord[] = [
      mkAction({
        actionId: "hover-1",
        stepNumber: 1,
        timestamp: "2026-02-14T09:35:10.000Z",
        timeSinceVideoStartNs: 10_000_000_000,
        actionType: "hover"
      }),
      mkAction({
        actionId: "click-1",
        stepNumber: 2,
        timestamp: "2026-02-14T09:35:12.500Z",
        timeSinceVideoStartNs: 12_500_000_000,
        actionType: "click"
      })
    ];

    const narration = buildNarrationRecords(actions);
    expect(narration.some((entry) => entry.kind === "hover")).toBe(false);
  });


  it("keeps hover actions that trigger a UI change", () => {
    const actions: ActionRecord[] = [
      mkAction({
        actionId: "hover-2",
        stepNumber: 4,
        actionType: "hover",
        details: { hoverUiChangeDetected: true }
      })
    ];

    const narration = buildNarrationRecords(actions);
    expect(narration.some((entry) => entry.kind === "hover")).toBe(true);
  });

  it("marks likely synthetic clicks as system-initiated", () => {
    const actions: ActionRecord[] = [
      mkAction({
        actionId: "click-2",
        stepNumber: 3,
        details: { likelySynthetic: true }
      })
    ];

    const [entry] = buildNarrationRecords(actions);
    expect(entry.notes.isUserInitiated).toBe(false);
    expect(entry.notes.syntheticReason).toContain("synthetic");
  });
});

import { describe, expect, it } from "vitest";

import { startTool } from "../src/tool.js";

/**
 * Groups startup checks to ensure the tool can bootstrap with expected
 * environment details.
 */
describe("scriber startup", () => {
  /**
   * # Goal
   * Confirm the tool can start and report the browser version.
   *
   * # What it Does
   * Launches the tool in headless mode and inspects the returned metadata.
   *
   * # Implementation details
   * Uses the public `startTool` API and asserts that `browserVersion` is set.
   *
   * # Requirement Coverage
   * - 2.1 Session start: supports headless mode for automated tests.
   *   Verifying headless startup validates the test-friendly path.
   */
  it("starts the tool in the environment", async () => {
    const result = await startTool({ headless: true });

    expect(result.browserVersion).toBeTruthy();
  });
});

/**
 * Validates required session metadata that should be produced when a new
 * recording session begins.
 */
describe("scriber session metadata", () => {
  /**
   * # Goal
   * Ensure each recording session provides a unique session identifier.
   *
   * # What it Does
   * Starts the tool and checks for a `sessionId` field on the returned payload.
   *
   * # Implementation details
   * Reads the `sessionId` from the result as optional data so the test fails
   * until the implementation adds it.
   *
   * # Requirement Coverage
   * - 2.1 Session start: each session shall receive a unique `sessionId`.
   *   This assertion enforces the presence of that identifier at startup.
   */
  it("returns a session identifier", async () => {
    const result = await startTool({ headless: true });
    const sessionId = (result as { sessionId?: string }).sessionId;

    expect(sessionId).toBeTruthy();
  });
});

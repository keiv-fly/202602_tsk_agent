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
    await result.stop();
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
    await result.stop();
  });
});

/**
 * Ensures extended session metadata fields are captured at startup for later
 * auditability.
 */
describe("scriber session metadata details", () => {
  /**
   * # Goal
   * Verify the tool exposes the browser user agent in session metadata.
   *
   * # What it Does
   * Starts the tool and inspects the returned payload for a `userAgent` field.
   *
   * # Implementation details
   * Reads `userAgent` as optional metadata so the assertion fails until the
   * implementation populates it.
   *
   * # Requirement Coverage
   * - 2.3 Session metadata: the tool shall record the user agent.
   *   This test enforces that the startup payload includes the user agent.
   */
  it("includes the browser user agent in the metadata", async () => {
    const result = await startTool({ headless: true });
    const userAgent = (result as { userAgent?: string }).userAgent;

    expect(userAgent).toBeTruthy();
    await result.stop();
  });
});

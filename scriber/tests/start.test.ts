import { describe, expect, it } from "vitest";

import { startTool } from "../src/tool.js";

describe("scriber startup", () => {
  it("starts the tool in the environment", async () => {
    const result = await startTool({ headless: true });

    expect(result.browserVersion).toBeTruthy();
  });
});

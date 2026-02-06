import { describe, expect, it } from "vitest";

import { formatStepNumber, snapshotFilename } from "../src/tooling/paths.js";

describe("artifact naming", () => {
  it("formats step numbers for chronology", () => {
    expect(formatStepNumber(3)).toBe("000003");
  });

  it("builds snapshot filenames with before/after suffixes", () => {
    const filename = snapshotFilename(12, "abc", "after", "png");
    expect(filename).toBe("000012_abc_after.png");
  });
});

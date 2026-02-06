import { describe, expect, it } from "vitest";

import { redactValue } from "../src/tooling/redaction.js";

describe("redaction", () => {
  it("masks password values", () => {
    const result = redactValue("secret", true, []);
    expect(result).toBe("********");
  });

  it("applies regex redaction rules", () => {
    const rules = [{ pattern: /\d{4}/g, replacement: "####" }];
    const result = redactValue("card 1234", false, rules);
    expect(result).toBe("card ####");
  });
});

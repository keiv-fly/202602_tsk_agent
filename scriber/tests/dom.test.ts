import { describe, expect, it } from "vitest";

import { gunzipHtml, gzipHtml } from "../src/tooling/dom.js";

describe("dom compression", () => {
  it("compresses and restores DOM snapshots with gzip", async () => {
    const html = "<html><body><p>Hello</p></body></html>";
    const compressed = await gzipHtml(html);
    const restored = await gunzipHtml(compressed);

    expect(restored).toBe(html);
  });
});

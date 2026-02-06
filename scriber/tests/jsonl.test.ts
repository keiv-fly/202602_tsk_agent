import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { appendJsonl, parseJsonl } from "../src/tooling/jsonl.js";

describe("jsonl writer", () => {
  it("appends JSON objects line-by-line", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "scriber-jsonl-"));
    const filePath = resolve(dir, "actions.jsonl");

    await appendJsonl(filePath, { step: 1 });
    await appendJsonl(filePath, { step: 2 });

    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ step: 1 });
    expect(JSON.parse(lines[1])).toEqual({ step: 2 });
  });

  it("ignores trailing partial lines after abrupt termination", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "scriber-jsonl-"));
    const filePath = resolve(dir, "actions.jsonl");

    await writeFile(
      filePath,
      `{"step":1}\n{"step":2}\n{"step":`,
      "utf8"
    );

    const content = await readFile(filePath, "utf8");
    const parsed = parseJsonl<{ step: number }>(content);

    expect(parsed).toHaveLength(2);
    expect(parsed.map((entry) => entry.step)).toEqual([1, 2]);
  });
});

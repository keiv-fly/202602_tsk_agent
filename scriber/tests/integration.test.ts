import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { startTool } from "../src/tool.js";
import { parseJsonl } from "../src/tooling/jsonl.js";
import { startTestServer, TestServer } from "./support/testSite.js";

const waitForArtifacts = async (page: { waitForTimeout: (ms: number) => Promise<void> }) => {
  await page.waitForTimeout(1200);
};

describe("scriber integration", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("produces session artifacts and linkage for a click", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/basic-click`,
      outputDir
    });

    await result.page.click("#toggle-btn");
    await waitForArtifacts(result.page);
    await result.stop();

    const files = await readdir(outputDir);
    expect(files).toContain("meta.json");
    expect(files).toContain("actions.json");
    expect(files).toContain("actions.jsonl");
    expect(files).toContain("video.webm");
    expect(files).toContain("dom");
    expect(files).toContain("narration.json");

    const actionsJson = JSON.parse(
      await readFile(resolve(outputDir, "actions.json"), "utf8")
    ) as Array<{ stepNumber: number; timestamp: string; actionId: string }>;
    const sortedActions = [...actionsJson].sort((left, right) => {
      const byStep = left.stepNumber - right.stepNumber;
      if (byStep !== 0) {
        return byStep;
      }
      const byTimestamp = left.timestamp.localeCompare(right.timestamp);
      if (byTimestamp !== 0) {
        return byTimestamp;
      }
      return left.actionId.localeCompare(right.actionId);
    });
    expect(actionsJson).toEqual(sortedActions);
  });

  it("renders a top-left elapsed-ms overlay for the session", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/basic-click`,
      outputDir
    });

    await result.page.waitForTimeout(150);
    const overlay = await result.page.evaluate(() => {
      const primaryElement = document.getElementById("__scriberFrameOverlay");
      if (!(primaryElement instanceof HTMLElement)) {
        return null;
      }
      const encodedElement = document.getElementById("__scriberEncodedFrameOverlay");
      const encodedBits =
        encodedElement instanceof HTMLElement
          ? Array.from(encodedElement.children).map((cell) => {
              if (!(cell instanceof HTMLElement)) {
                return 0;
              }
              return cell.style.backgroundColor === "rgb(0, 0, 0)" ? 1 : 0;
            })
          : null;
      return {
        text: primaryElement.textContent ?? "",
        position: primaryElement.style.position,
        top: primaryElement.style.top,
        left: primaryElement.style.left,
        width: primaryElement.style.width,
        fontFamily: primaryElement.style.fontFamily,
        fontWeight: primaryElement.style.fontWeight,
        fontSize: primaryElement.style.fontSize,
        lineHeight: primaryElement.style.lineHeight,
        letterSpacing: primaryElement.style.letterSpacing,
        padding: primaryElement.style.padding,
        border: primaryElement.style.border,
        webkitTextStroke: primaryElement.style.webkitTextStroke,
        textShadow: primaryElement.style.textShadow,
        textAlign: primaryElement.style.textAlign,
        backgroundColor: primaryElement.style.backgroundColor,
        encodedOverlay:
          encodedElement instanceof HTMLElement
            ? {
                position: encodedElement.style.position,
                top: encodedElement.style.top,
                left: encodedElement.style.left,
                width: encodedElement.style.width,
                height: encodedElement.style.height,
                display: encodedElement.style.display,
                gridTemplateColumns: encodedElement.style.gridTemplateColumns,
                gridTemplateRows: encodedElement.style.gridTemplateRows,
                bitCount: encodedElement.children.length,
                bits: encodedBits
              }
            : null
      };
    });

    expect(overlay).toBeTruthy();
    expect(overlay?.text).toMatch(/^\d{6}$/);
    expect(overlay?.position).toBe("fixed");
    expect(overlay?.top).toBe("6px");
    expect(overlay?.left).toBe("6px");
    expect(["6ch", "auto"]).toContain(overlay?.width);
    expect(overlay?.fontFamily).toContain("monospace");
    expect(overlay?.fontWeight).toBe("700");
    expect(overlay?.lineHeight).toBe("1");
    expect(overlay?.textAlign).toBe("right");
    expect(overlay?.backgroundColor).toBe("rgb(0, 0, 0)");

    expect(overlay?.encodedOverlay).toBeTruthy();
    expect(overlay?.encodedOverlay?.position).toBe("fixed");
    expect(overlay?.encodedOverlay?.top).toBe("74px");
    expect(overlay?.encodedOverlay?.left).toBe("6px");
    expect(overlay?.encodedOverlay?.width).toBe("20px");
    expect(overlay?.encodedOverlay?.height).toBe("20px");
    expect(overlay?.encodedOverlay?.display).toBe("grid");
    expect(overlay?.encodedOverlay?.gridTemplateColumns).toBe("repeat(5, 4px)");
    expect(overlay?.encodedOverlay?.gridTemplateRows).toBe("repeat(5, 4px)");
    expect(overlay?.encodedOverlay?.bitCount).toBe(25);

    const primaryValue = Number.parseInt(overlay?.text ?? "0", 10);
    expect(Number.isInteger(primaryValue)).toBe(true);
    const encodedBits = overlay?.encodedOverlay?.bits ?? [];
    expect(encodedBits).toHaveLength(25);

    const payload = encodedBits.reduce((aggregate, bit) => (aggregate << 1n) | BigInt(bit), 0n);
    const data = Number(payload >> 5n);
    const crc = Number(payload & 0x1fn);
    expect(data).toBe(primaryValue);

    const dataBytes = [(data >> 16) & 0xff, (data >> 8) & 0xff, data & 0xff];
    let crcState = 0xffffffff;
    for (const byte of dataBytes) {
      crcState ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        const mask = -(crcState & 1);
        crcState = (crcState >>> 1) ^ (0xedb88320 & mask);
      }
    }
    const crc32 = (crcState ^ 0xffffffff) >>> 0;
    expect(crc).toBe(crc32 & 0x1f);
    await result.stop();
  });

  it("finalizes artifacts when context is already closed before stop", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/basic-click`,
      outputDir
    });

    await result.page.click("#toggle-btn");
    await waitForArtifacts(result.page);
    await result.page.context().close();
    await expect(result.stop()).resolves.toBeUndefined();

    const files = await readdir(outputDir);
    expect(files).toContain("meta.json");
    expect(files).toContain("actions.json");
    expect(files).toContain("end.txt");
    expect(files).toContain("narration.json");

    const meta = JSON.parse(await readFile(resolve(outputDir, "meta.json"), "utf8")) as {
      endTimestamp?: string;
    };
    expect(typeof meta.endTimestamp).toBe("string");
  });

  it("finalizes artifacts after abrupt browser close during pending work", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/basic-click`,
      outputDir
    });

    await result.page.click("#toggle-btn");
    await result.page.context().browser()?.close();
    await expect(result.stop()).resolves.toBeUndefined();

    const files = await readdir(outputDir);
    expect(files).toContain("meta.json");
    expect(files).toContain("actions.json");
    expect(files).toContain("end.txt");
    expect(files).toContain("narration.json");

    const meta = JSON.parse(await readFile(resolve(outputDir, "meta.json"), "utf8")) as {
      endTimestamp?: string;
    };
    expect(typeof meta.endTimestamp).toBe("string");
  });

  it("generates selector candidates in priority order", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/selectors`,
      outputDir
    });

    await result.page.click("[data-testid='primary']");
    await waitForArtifacts(result.page);
    await result.stop();

    const actions = await parseJsonl<{ actionType: string; primarySelector: string | null }>(
      await readFile(resolve(outputDir, "actions.jsonl"), "utf8")
    );
    const clickAction = actions.find((action) => action.actionType === "click");
    expect(clickAction?.primarySelector).toBe('[data-testid="primary"]');
  });

});

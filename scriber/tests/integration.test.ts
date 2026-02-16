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
      const element = document.getElementById("__scriberFrameOverlay");
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      return {
        text: element.textContent ?? "",
        position: element.style.position,
        top: element.style.top,
        left: element.style.left,
        width: element.style.width,
        fontFamily: element.style.fontFamily,
        fontWeight: element.style.fontWeight,
        fontSize: element.style.fontSize,
        lineHeight: element.style.lineHeight,
        letterSpacing: element.style.letterSpacing,
        padding: element.style.padding,
        border: element.style.border,
        webkitTextStroke: element.style.webkitTextStroke,
        textShadow: element.style.textShadow,
        textAlign: element.style.textAlign,
        backgroundColor: element.style.backgroundColor
      };
    });

    expect(overlay).toBeTruthy();
    expect(overlay?.text).toMatch(/^\d{1,6}$/);
    expect(overlay?.position).toBe("fixed");
    expect(overlay?.top).toBe("6px");
    expect(overlay?.left).toBe("6px");
    expect(overlay?.width).toBe("6ch");
    expect(overlay?.fontFamily).toBe('"Roboto Mono", monospace');
    expect(overlay?.fontWeight).toBe("700");
    expect(overlay?.fontSize).toBe("21.6px");
    expect(overlay?.lineHeight).toBe("1");
    expect(overlay?.letterSpacing).toBe("0.06em");
    expect(overlay?.padding).toBe("2.4px 4.8px");
    expect(overlay?.border).toBe("3px solid rgb(255, 255, 0)");
    expect(overlay?.webkitTextStroke).toContain("1px");
    expect(overlay?.textShadow).toContain("1px");
    expect(overlay?.textShadow).toContain("-1px");
    expect(overlay?.textAlign).toBe("right");
    expect(overlay?.backgroundColor).toBe("rgb(0, 0, 0)");
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

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { startTool } from "../src/tool.js";
import { gunzipHtml } from "../src/tooling/dom.js";
import { parseJsonl } from "../src/tooling/jsonl.js";
import { snapshotPath } from "../src/tooling/paths.js";
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
    expect(files).toContain("screenshots");
    expect(files).toContain("dom");
    expect(files).toContain("narration.json");
  });

  it("renders a top-left frame modulo overlay for the session", async () => {
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
        textAlign: element.style.textAlign,
        border: element.style.border,
        borderRadius: element.style.borderRadius,
        background: element.style.background
      };
    });

    expect(overlay).toBeTruthy();
    expect(overlay?.text).toMatch(/^\d{1,5}$/);
    expect(overlay?.position).toBe("fixed");
    expect(overlay?.top).toBe("6px");
    expect(overlay?.left).toBe("6px");
    expect(overlay?.width).toBe("5ch");
    expect(overlay?.textAlign).toBe("right");
    expect(overlay?.border).toBe("2px solid rgb(255, 255, 0)");
    expect(overlay?.borderRadius).toBe("0px");
    expect(overlay?.background).toBe("rgb(0, 0, 0)");
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

  it("captures before/after DOM snapshots around clicks", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/basic-click`,
      outputDir
    });

    await result.page.click("#toggle-btn");
    await waitForArtifacts(result.page);
    await result.stop();

    const actions = await parseJsonl<{
      actionType: string;
      actionId: string;
      stepNumber: number;
      videoFrame: number;
      videoFrameMod65536: number;
      beforeScreenshotFileName: string | null;
      atScreenshotFileName: string | null;
      afterScreenshotFileName: string | null;
    }>(await readFile(resolve(outputDir, "actions.jsonl"), "utf8"));
    const clickAction = actions.find((action) => action.actionType === "click");
    expect(clickAction).toBeTruthy();
    if (!clickAction) {
      return;
    }
    expect(clickAction.beforeScreenshotFileName).toMatch(/_before\.png$/);
    expect(clickAction.atScreenshotFileName).toMatch(/_at\.png$/);
    expect(clickAction.afterScreenshotFileName).toMatch(/_after\.png$/);
    expect(clickAction.videoFrame).toBeGreaterThanOrEqual(0);
    expect(clickAction.videoFrameMod65536).toBe(clickAction.videoFrame % 65536);

    const beforeDomPath = snapshotPath(
      outputDir,
      "dom",
      clickAction.stepNumber,
      clickAction.actionId,
      "before",
      "html.gz"
    );
    const afterDomPath = snapshotPath(
      outputDir,
      "dom",
      clickAction.stepNumber,
      clickAction.actionId,
      "after",
      "html.gz"
    );
    const beforeHtml = await gunzipHtml(await readFile(beforeDomPath));
    const afterHtml = await gunzipHtml(await readFile(afterDomPath));

    expect(beforeHtml).toContain("Off");
    expect(afterHtml).toContain("On");

    const consolidatedActions = JSON.parse(
      await readFile(resolve(outputDir, "actions.json"), "utf8")
    ) as Array<{
      actionType: string;
      videoFrame: number;
      videoFrameMod65536: number;
      overlayOcr?: {
        before?: {
          value: number | null;
          cutScreenshotFileName: string | null;
          overlayRect: { left: number; top: number; width: number; height: number } | null;
          ocrCropRect: { left: number; top: number; width: number; height: number } | null;
          expectedVideoFrameMod65536: number;
          matchesExpected: boolean | null;
        };
        at?: {
          value: number | null;
          cutScreenshotFileName: string | null;
          overlayRect: { left: number; top: number; width: number; height: number } | null;
          ocrCropRect: { left: number; top: number; width: number; height: number } | null;
          expectedVideoFrameMod65536: number;
          matchesExpected: boolean | null;
        };
        after?: {
          value: number | null;
          cutScreenshotFileName: string | null;
          overlayRect: { left: number; top: number; width: number; height: number } | null;
          ocrCropRect: { left: number; top: number; width: number; height: number } | null;
          expectedVideoFrameMod65536: number;
          matchesExpected: boolean | null;
        };
      };
      beforeScreenshotFileName: string | null;
      atScreenshotFileName: string | null;
      afterScreenshotFileName: string | null;
    }>;
    const consolidatedClickAction = consolidatedActions.find(
      (action) => action.actionType === "click"
    );
    expect(consolidatedClickAction?.beforeScreenshotFileName).toMatch(/_before\.png$/);
    expect(consolidatedClickAction?.atScreenshotFileName).toMatch(/_at\.png$/);
    expect(consolidatedClickAction?.afterScreenshotFileName).toMatch(/_after\.png$/);
    expect(consolidatedClickAction?.videoFrameMod65536).toBe(
      (consolidatedClickAction?.videoFrame ?? 0) % 65536
    );
    expect(consolidatedClickAction?.overlayOcr?.before).toBeTruthy();
    expect(consolidatedClickAction?.overlayOcr?.at).toBeTruthy();
    expect(consolidatedClickAction?.overlayOcr?.after).toBeTruthy();
    expect(typeof consolidatedClickAction?.overlayOcr?.at?.expectedVideoFrameMod65536).toBe(
      "number"
    );
    const atOverlayRect = consolidatedClickAction?.overlayOcr?.at?.overlayRect;
    const atCropRect = consolidatedClickAction?.overlayOcr?.at?.ocrCropRect;
    expect(atOverlayRect == null || atOverlayRect.width > 0).toBe(true);
    expect(atOverlayRect == null || atOverlayRect.height > 0).toBe(true);
    expect(atCropRect == null || atCropRect.width > 0).toBe(true);
    expect(atCropRect == null || atCropRect.height > 0).toBe(true);
    if (atOverlayRect && atCropRect) {
      expect(atCropRect.width).toBeLessThanOrEqual(atOverlayRect.width + 2);
      expect(atCropRect.height).toBeLessThanOrEqual(atOverlayRect.height + 2);
    }
    if (consolidatedClickAction?.overlayOcr?.at?.value !== null) {
      expect(consolidatedClickAction?.overlayOcr?.at?.matchesExpected).toBeTypeOf("boolean");
    }
    const screenshotsDirEntries = await readdir(resolve(outputDir, "screenshots"));
    const atCutFileName = consolidatedClickAction?.overlayOcr?.at?.cutScreenshotFileName;
    expect(typeof atCutFileName === "string" || atCutFileName === null).toBe(true);
    if (atCutFileName) {
      expect(atCutFileName).toMatch(/_ocr_cut\.png$/);
      expect(screenshotsDirEntries).toContain(atCutFileName);
    }
  });

  it("waits for settled DOM mutations before after snapshots", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/delayed-mutations`,
      outputDir
    });

    await result.page.click("#mutate-btn");
    await waitForArtifacts(result.page);
    await result.stop();

    const actions = await parseJsonl<{ actionType: string; actionId: string; stepNumber: number }>(
      await readFile(resolve(outputDir, "actions.jsonl"), "utf8")
    );
    const clickAction = actions.find((action) => action.actionType === "click");
    expect(clickAction).toBeTruthy();
    if (!clickAction) {
      return;
    }

    const afterDomPath = snapshotPath(
      outputDir,
      "dom",
      clickAction.stepNumber,
      clickAction.actionId,
      "after",
      "html.gz"
    );
    const afterHtml = await gunzipHtml(await readFile(afterDomPath));
    expect(afterHtml).toContain("Done");
  });

  it("debounces input snapshots", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/inputs`,
      outputDir
    });

    await result.page.type("#text-input", "hello");
    await waitForArtifacts(result.page);
    await result.stop();

    const actions = await parseJsonl<{ actionType: string }>(
      await readFile(resolve(outputDir, "actions.jsonl"), "utf8")
    );
    const inputActions = actions.filter((action) => action.actionType === "fill");
    expect(inputActions).toHaveLength(1);
  });

  it("captures click provenance metadata for real and programmatic clicks", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/basic-click`,
      outputDir
    });

    await result.page.click("#toggle-btn");
    await result.page.evaluate(() => {
      const button = document.getElementById("toggle-btn");
      if (button instanceof HTMLElement) {
        button.click();
      }
    });
    await waitForArtifacts(result.page);
    await result.stop();

    const actions = await parseJsonl<{
      actionType: string;
      details?: {
        isTrusted?: boolean;
        eventSequence?: {
          pointerdown?: boolean;
          mousedown?: boolean;
          mouseup?: boolean;
        };
        programmaticClick?: boolean;
        likelySynthetic?: boolean;
      };
    }>(await readFile(resolve(outputDir, "actions.jsonl"), "utf8"));

    const clickActions = actions.filter((action) => action.actionType === "click");
    expect(clickActions.length).toBeGreaterThanOrEqual(2);
    expect(clickActions.some((action) => typeof action.details?.isTrusted === "boolean")).toBe(
      true
    );
    expect(clickActions.some((action) => action.details?.programmaticClick === true)).toBe(true);
    expect(clickActions.some((action) => action.details?.likelySynthetic === true)).toBe(true);
    expect(
      clickActions.some(
        (action) =>
          action.details?.eventSequence?.pointerdown === true &&
          action.details?.eventSequence?.mousedown === true &&
          action.details?.eventSequence?.mouseup === true
      )
    ).toBe(true);
  });

  it("records popup flows and tab switches", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/popup-a`,
      outputDir
    });

    const context = result.page.context();
    const popupPromise = context.waitForEvent("page");
    await result.page.click("#popup-btn");
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await popup.bringToFront();
    await popup.click("#approve-btn");
    await result.page.bringToFront();
    await popup.close();
    await waitForArtifacts(result.page);
    await result.stop();

    const actions = await parseJsonl<{ actionType: string; pageId: string }>(
      await readFile(resolve(outputDir, "actions.jsonl"), "utf8")
    );
    const popupAction = actions.find((action) => action.actionType === "popup");
    const tabSwitch = actions.find((action) => action.actionType === "switch_page");
    expect(popupAction).toBeTruthy();
    expect(tabSwitch).toBeTruthy();
    if (popupAction && tabSwitch) {
      expect(popupAction.pageId).not.toBe(tabSwitch.pageId);
    }
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

  it("redacts password values while preserving non-password inputs", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/inputs`,
      outputDir
    });

    await result.page.fill("#text-input", "Alice");
    await result.page.fill("#password-input", "secret");
    await waitForArtifacts(result.page);
    await result.stop();

    const actions = await parseJsonl<{
      actionType: string;
      target?: { type?: string; value?: string };
    }>(await readFile(resolve(outputDir, "actions.jsonl"), "utf8"));

    const fillActions = actions.filter((action) => action.actionType === "fill");
    const textAction = fillActions.find((action) => action.target?.type === "text");

    expect(textAction?.target?.value).toBe("Alice");
    expect(fillActions.some((action) => action.target?.value === "secret")).toBe(false);
  });

  it("trims hover text for narration-friendly payloads", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/hover-long-text`,
      outputDir
    });

    await result.page.hover("#long-hover");
    await waitForArtifacts(result.page);
    await result.stop();

    const actions = await parseJsonl<{
      actionType: string;
      target?: { text?: string };
      fallbackSelectors?: string[];
    }>(await readFile(resolve(outputDir, "actions.jsonl"), "utf8"));
    const hoverAction = actions.find((action) => action.actionType === "hover");
    expect(hoverAction).toBeTruthy();
    expect(hoverAction?.target?.text?.length).toBeLessThanOrEqual(120);
    expect(hoverAction?.fallbackSelectors?.every((selector) => selector.length <= 1000)).toBe(
      true
    );
  });

  it("keeps hover actions when hover causes a DOM change", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/hover-dom-change`,
      outputDir
    });

    await result.page.hover("#hover-menu");
    await waitForArtifacts(result.page);
    await result.stop();

    const narration = JSON.parse(
      await readFile(resolve(outputDir, "narration.json"), "utf8")
    ) as Array<{ kind: string; evidence: { afterShot: string | null } }>;

    const hoverNarration = narration.find((entry) => entry.kind === "hover");
    expect(hoverNarration).toBeTruthy();
    expect(typeof hoverNarration?.evidence.afterShot).toBe("string");
  });

  it("captures computed accessible names for robust targeting metadata", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/accessible-name`,
      outputDir
    });

    await result.page.fill("#search-box", "boots");
    await waitForArtifacts(result.page);
    await result.stop();

    const actions = await parseJsonl<{ actionType: string; target?: { accessibleName?: string } }>(
      await readFile(resolve(outputDir, "actions.jsonl"), "utf8")
    );

    const fillAction = actions.find((action) => action.actionType === "fill");
    expect(fillAction?.target?.accessibleName).toContain("Search Product");
  });

  it("writes narration-ready output", async () => {
    const outputDir = await mkdtemp(resolve(tmpdir(), "scriber-session-"));
    const result = await startTool({
      headless: true,
      startUrl: `${server.baseUrl}/basic-click`,
      outputDir
    });

    await result.page.click("#toggle-btn");
    await waitForArtifacts(result.page);
    await result.stop();

    const narration = JSON.parse(
      await readFile(resolve(outputDir, "narration.json"), "utf8")
    ) as Array<{ kind: string }>;

    expect(Array.isArray(narration)).toBe(true);
    expect(narration.length).toBeGreaterThan(0);
  });

});

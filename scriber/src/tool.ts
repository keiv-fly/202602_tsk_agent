import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

import { RecorderSession, ScriberRecorder } from "./tooling/recorder.js";
import { SessionMeta } from "./tooling/types.js";

export interface StartOptions {
  headless?: boolean;
  startUrl?: string;
  outputDir?: string;
  fullPageScreenshots?: boolean;
  viewport?: { width: number; height: number };
  debounceMs?: number;
  quietWindowMs?: number;
  quietTimeoutMs?: number;
}

export interface StartResult extends RecorderSession {
  browserVersion: string;
  sessionId: string;
  userAgent: string;
  startTimestamp: string;
  timezone: string;
}

const normalizeStartUrl = (value?: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "about:blank";
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^(about|file|data|chrome|edge|blob):/i.test(trimmed)) {
    return trimmed;
  }

  if (
    /^localhost(?::\d+)?(?:\/|$)/i.test(trimmed) ||
    /^127(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(trimmed) ||
    /^0\.0\.0\.0(?::\d+)?(?:\/|$)/.test(trimmed)
  ) {
    return `http://${trimmed}`;
  }

  return `https://${trimmed}`;
};

export const startTool = async (
  options: StartOptions = {}
): Promise<StartResult> => {
  const sessionId = randomUUID();
  const outputDir = resolve(options.outputDir ?? `sessions/${sessionId}`);
  await mkdir(outputDir, { recursive: true });
  await mkdir(resolve(outputDir, "screenshots"), { recursive: true });
  await mkdir(resolve(outputDir, "dom"), { recursive: true });

  const browser = await chromium.launch({
    headless: options.headless ?? true
  });

  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  const recorder = new ScriberRecorder({
    sessionId,
    outputDir,
    fullPageScreenshots: options.fullPageScreenshots ?? false,
    debounceMs: options.debounceMs ?? 500,
    quietWindowMs: options.quietWindowMs ?? 300,
    quietTimeoutMs: options.quietTimeoutMs ?? 5000,
    redactionRules: []
  });

  await recorder.attach(context);

  const startUrl = normalizeStartUrl(options.startUrl);
  await page.goto(startUrl);

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const timezone = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  );

  const startTimestamp = new Date().toISOString();
  const meta: SessionMeta = {
    sessionId,
    startTimestamp,
    browserType: "chromium",
    browserVersion: browser.version(),
    userAgent,
    viewport,
    timezone,
    playwrightVersion: recorder.playwrightVersion,
    startUrl
  };

  await writeFile(
    resolve(outputDir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );

  const stop = async () => {
    const endTimestamp = new Date().toISOString();
    await recorder.stop({ endTimestamp });
    const finalMeta: SessionMeta = { ...meta, endTimestamp };
    await writeFile(
      resolve(outputDir, "meta.json"),
      JSON.stringify(finalMeta, null, 2),
      "utf8"
    );
    await context.close();
    await browser.close();
  };

  return {
    browserVersion: browser.version(),
    sessionId,
    userAgent,
    startTimestamp,
    timezone,
    outputDir,
    page,
    stop,
    recorder
  };
};

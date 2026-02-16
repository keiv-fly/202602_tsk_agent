import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

import { RecorderSession, ScriberRecorder } from "./tooling/recorder.js";
import { SessionMeta } from "./tooling/types.js";

export interface StartOptions {
  headless?: boolean;
  startUrl?: string;
  outputDir?: string;
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

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
const RECORDED_VIDEO_FILE = "video.webm";

const resolveExistingVideoPath = async (outputDir: string) => {
  const { readdir, rename } = await import("node:fs/promises");
  const entries = await readdir(outputDir, { withFileTypes: true });
  const webmNames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".webm"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (webmNames.length === 0) {
    return null;
  }

  if (webmNames.includes(RECORDED_VIDEO_FILE)) {
    return resolve(outputDir, RECORDED_VIDEO_FILE);
  }

  const fallbackPath = resolve(outputDir, webmNames[0]);
  const canonicalPath = resolve(outputDir, RECORDED_VIDEO_FILE);
  try {
    await rename(fallbackPath, canonicalPath);
    return canonicalPath;
  } catch {
    // Keep the fallback path if a rename fails for any reason.
    return fallbackPath;
  }
};

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

const padTwo = (value: number) => value.toString().padStart(2, "0");

const formatSessionTimestamp = (date: Date) => {
  return [
    date.getFullYear(),
    padTwo(date.getMonth() + 1),
    padTwo(date.getDate())
  ].join("") + `_${padTwo(date.getHours())}${padTwo(date.getMinutes())}`;
};

const sanitizeSessionDomain = (value: string) => {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
};

const deriveSessionDomain = (startUrl: string) => {
  try {
    const url = new URL(startUrl);
    if (url.hostname) {
      return sanitizeSessionDomain(url.hostname);
    }
  } catch {
    // Fall back to a generic identifier for non-URL inputs.
  }
  return "unknown";
};

const buildSessionId = (startUrl: string, startedAt: Date) => {
  return `${formatSessionTimestamp(startedAt)}_${deriveSessionDomain(startUrl)}`;
};

const normalizeViewport = (viewport?: {
  width: number;
  height: number;
}): { width: number; height: number } => {
  const width =
    typeof viewport?.width === "number" && Number.isFinite(viewport.width)
      ? Math.max(1, Math.floor(viewport.width))
      : DEFAULT_VIEWPORT.width;
  const height =
    typeof viewport?.height === "number" && Number.isFinite(viewport.height)
      ? Math.max(1, Math.floor(viewport.height))
      : DEFAULT_VIEWPORT.height;
  return { width, height };
};

export const startTool = async (
  options: StartOptions = {}
): Promise<StartResult> => {
  const startUrl = normalizeStartUrl(options.startUrl);
  const startedAt = new Date();
  const sessionId = buildSessionId(startUrl, startedAt);
  const outputDir = resolve(options.outputDir ?? `sessions/${sessionId}`);
  await mkdir(outputDir, { recursive: true });
  await mkdir(resolve(outputDir, "dom"), { recursive: true });

  const viewport = normalizeViewport(options.viewport);
  const headless = options.headless ?? true;
  const browser = await chromium.launch({
    headless,
    args: headless ? [] : [`--window-size=${viewport.width},${viewport.height}`]
  });

  const videoPath = resolve(outputDir, RECORDED_VIDEO_FILE);
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    recordVideo: {
      dir: outputDir,
      size: viewport
    }
  });
  const page = await context.newPage();
  const pageVideo = page.video();
  const sessionStartTimestamp = new Date().toISOString();

  const recorder = new ScriberRecorder({
    sessionId,
    outputDir,
    sessionStartTimestamp,
    debounceMs: options.debounceMs ?? 500,
    quietWindowMs: options.quietWindowMs ?? 300,
    quietTimeoutMs: options.quietTimeoutMs ?? 5000,
    redactionRules: []
  });

  await recorder.attach(context);

  await page.goto(startUrl);

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const timezone = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  );

  const meta: SessionMeta = {
    sessionId,
    startTimestamp: sessionStartTimestamp,
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
    await recorder.prepareStop();
    let contextCloseError: string | null = null;
    let finalizedVideoPath: string | null = null;
    try {
      await context.close();
    } catch (error) {
      // The browser/window may have been closed manually before stop().
      contextCloseError = error instanceof Error ? error.message : String(error);
    }
    let saveAsError: string | null = null;
    if (pageVideo) {
      try {
        await pageVideo.saveAs(videoPath);
        finalizedVideoPath = videoPath;
        await pageVideo.delete();
      } catch (error) {
        // No video frames (e.g. very short session) — skip save and cleanup
        saveAsError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!finalizedVideoPath) {
      finalizedVideoPath = await resolveExistingVideoPath(outputDir);
    }

    await recorder.finalizeStop({
      endTimestamp,
      sessionStartTimestamp,
      videoPath: finalizedVideoPath
    });

    const finalMeta: SessionMeta = { ...meta, endTimestamp };
    await writeFile(
      resolve(outputDir, "meta.json"),
      JSON.stringify(finalMeta, null, 2),
      "utf8"
    );
    try {
      await browser.close();
    } catch {
      // Ignore browser-close errors if the process already exited.
    }
  };

  return {
    browserVersion: browser.version(),
    sessionId,
    userAgent,
    startTimestamp: sessionStartTimestamp,
    timezone,
    outputDir,
    page,
    stop,
    recorder
  };
};

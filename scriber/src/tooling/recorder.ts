import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance as nodePerformance } from "node:perf_hooks";
import { basename, resolve } from "node:path";

import type { BrowserContext, Page } from "playwright";
const require = createRequire(import.meta.url);
const { version: playwrightVersion } = require("playwright/package.json") as {
  version: string;
};

import { InputDebouncer } from "./debounce.js";
import { gzipHtml } from "./dom.js";
import { appendJsonl } from "./jsonl.js";
import { buildNarrationRecords } from "./narration.js";
import { snapshotPath } from "./paths.js";
import { RedactionRule, redactValue } from "./redaction.js";
import {
  ActionRecord,
  ActionType,
  OverlayCropRect,
  OverlayOcrSnapshot,
  SnapshotDescriptor,
  TargetMetadata
} from "./types.js";
import {
  buildOverlayCutPath,
  createOverlayOcrWorker,
  readOverlayNumberFromScreenshot,
  TESSERACT_BEST_ENG_LANG_PATH,
  TESSERACT_BEST_OEM,
  type OverlayOcrRawResult
} from "./overlayOcr.js";
import { extractFramesFromVideo } from "./video.js";

export interface RecorderSession {
  outputDir: string;
  page: Page;
  stop: () => Promise<void>;
  recorder: ScriberRecorder;
}

interface RecorderOptions {
  sessionId: string;
  outputDir: string;
  sessionStartTimestamp: string;
  debounceMs: number;
  quietWindowMs: number;
  quietTimeoutMs: number;
  redactionRules: RedactionRule[];
}

interface PendingInput {
  actionId: string;
  stepNumber: number;
  pageId: string;
  url: string;
  timestamp: string;
  target?: TargetMetadata;
  selectors: { primarySelector: string | null; fallbackSelectors: string[] };
  details?: Record<string, unknown>;
}

interface PreActionPayload {
  selectors?: { primarySelector: string | null; fallbackSelectors: string[] };
  target?: TargetMetadata;
  timestamp: number;
}

interface PreActionEvidence {
  capturedAt: number;
  target?: TargetMetadata;
  selector: string | null;
  domGzip: Buffer;
  pageTitle: string | null;
  url: string;
  overlayRect: OverlayCropRect | null;
  textRect: OverlayCropRect | null;
}

interface PendingVideoSnapshot {
  action: ActionRecord;
  descriptor: SnapshotDescriptor;
  screenshotPath: string;
  capturedAt: number;
  overlayRect: OverlayCropRect | null;
  textRect: OverlayCropRect | null;
}

interface SnapshotOverlayCapture {
  overlayRect: OverlayCropRect | null;
  textRect: OverlayCropRect | null;
}

interface SnapshotCapturePayload extends SnapshotOverlayCapture {
  capturedAt: number;
  html: string;
}

const VIDEO_FRAME_RATE = 30;
const VIDEO_FRAME_MODULUS = 65536;
const OCR_CALIBRATION_MIN_CONFIDENCE = 70;
const OCR_CALIBRATION_MAX_ABS_DELTA_FRAMES = 180;
const LOCAL_SEARCH_RADIUS_FRAMES = 2;
const LOCAL_SEARCH_MIN_CONFIDENCE = 70;
const OCR_BEST_MODEL_RETRY_MIN_CONFIDENCE = 92;
const nowEpochMs = () => nodePerformance.timeOrigin + nodePerformance.now();

export class ScriberRecorder {
  private options: RecorderOptions;
  private sessionStartMs: number;
  private context: BrowserContext | null = null;
  private pageIds = new Map<Page, string>();
  private primaryPage: Page | null = null;
  private lastPageUrlById = new Map<string, string>();
  private stepNumber = 0;
  private actions: ActionRecord[] = [];
  private inputDebouncer: InputDebouncer<PendingInput>;
  private closing = false;
  private stopPrepared = false;
  private pendingTasks = new Set<Promise<void>>();
  private preActionEvidenceByPage = new Map<string, PreActionEvidence>();
  private pendingVideoSnapshots: PendingVideoSnapshot[] = [];

  public readonly playwrightVersion = playwrightVersion;

  constructor(options: RecorderOptions) {
    this.options = options;
    const parsedStartMs = new Date(options.sessionStartTimestamp).getTime();
    this.sessionStartMs = Number.isFinite(parsedStartMs) ? parsedStartMs : nowEpochMs();
    this.inputDebouncer = new InputDebouncer(options.debounceMs, {
      onStart: async () => undefined,
      onFlush: async (pending) => {
        const page = this.getPageById(pending.pageId);
        const frameInfo = this.buildVideoFrameInfo(pending.timestamp);
        const action: ActionRecord = {
          actionId: pending.actionId,
          stepNumber: pending.stepNumber,
          timestamp: pending.timestamp,
          actionType: "fill",
          url: pending.url,
          pageId: pending.pageId,
          videoFrame: frameInfo.videoFrame,
          videoFrameMod65536: frameInfo.videoFrameMod65536,
          beforeScreenshotFileName: null,
          atScreenshotFileName: null,
          afterScreenshotFileName: null,
          pageTitleBefore: null,
          pageTitleAfter: null,
          urlBefore: null,
          urlAfter: null,
          target: pending.target,
          primarySelector: pending.selectors.primarySelector,
          fallbackSelectors: pending.selectors.fallbackSelectors,
          details: pending.details
        };
        if (page && this.shouldCaptureEvidence("fill")) {
          const hasPreActionEvidence = await this.applyPreActionEvidence(pending.pageId, action);
          if (!hasPreActionEvidence) {
            action.urlBefore = page.url();
            action.pageTitleBefore = await this.safeGetPageTitle(page);
            await this.safeCaptureSnapshot(page, action, {
              actionId: pending.actionId,
              stepNumber: pending.stepNumber,
              pageId: pending.pageId,
              phase: "before"
            });
          }
          await this.safeWaitForTimeout(page, 300);
          await this.safeCaptureSnapshot(page, action, {
            actionId: pending.actionId,
            stepNumber: pending.stepNumber,
            pageId: pending.pageId,
            phase: "at"
          });
          await this.safeWaitForTimeout(page, 800);
          await this.waitForDomQuiet(pending.pageId);
          await this.safeCaptureSnapshot(page, action, {
            actionId: pending.actionId,
            stepNumber: pending.stepNumber,
            pageId: pending.pageId,
            phase: "after"
          });
          action.urlAfter = page.url();
          action.pageTitleAfter = await this.safeGetPageTitle(page);
        }
        await this.writeAction(action);
      }
    });
  }

  async attach(context: BrowserContext) {
    this.context = context;
    await this.ensureDirectories();
    await context.addInitScript({
      content: createInitScript(this.sessionStartMs, VIDEO_FRAME_RATE, VIDEO_FRAME_MODULUS)
    });
    context.on("page", (page) => {
      void this.registerPage(page);
    });
    for (const page of context.pages()) {
      await this.registerPage(page);
    }
  }

  private async ensureDirectories() {
    await mkdir(resolve(this.options.outputDir, "dom"), { recursive: true });
    await mkdir(resolve(this.options.outputDir, "screenshots"), { recursive: true });
  }

  private async registerPage(page: Page) {
    if (!this.context) {
      return;
    }
    const pageId = randomUUID();
    this.pageIds.set(page, pageId);
    if (!this.primaryPage) {
      this.primaryPage = page;
      this.track(
        this.recordAction(page, {
          actionType: "goto",
          url: page.url(),
          target: undefined,
          selectors: { primarySelector: null, fallbackSelectors: [] }
        })
      );
    }

    await page.exposeBinding(
      "__scriberEmit",
      (source, payload: RecorderPayload) => {
        void this.handlePayload(page, payload, source);
      }
    );

    await page.exposeBinding(
      "__scriberPrepareAction",
      (_source, payload: PreActionPayload) => {
        void this.handlePreAction(page, payload);
      }
    );

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        const pageId = this.getPageId(page);
        const previousUrl = this.lastPageUrlById.get(pageId);
        this.lastPageUrlById.set(pageId, frame.url());
        if (!previousUrl || previousUrl === frame.url()) {
          return;
        }
        this.track(
          this.recordAction(page, {
            actionType: "navigation",
            url: frame.url(),
            target: undefined,
            selectors: { primarySelector: null, fallbackSelectors: [] }
          })
        );
      }
    });

    page.on("close", () => {
      this.pageIds.delete(page);
    });

    const opener = await page.opener();
    const isPopup = opener || (this.primaryPage && page !== this.primaryPage);
    if (isPopup) {
      this.track(
        this.recordAction(page, {
          actionType: "popup",
          url: page.url(),
          target: undefined,
          selectors: { primarySelector: null, fallbackSelectors: [] },
          details: { popupId: pageId, openerPageId: opener ? this.getPageId(opener) : null }
        })
      );
      const tabSwitchPage = opener ?? this.primaryPage ?? page;
      this.track(
        this.recordAction(tabSwitchPage, {
          actionType: "switch_page",
          url: tabSwitchPage.url(),
          target: undefined,
          selectors: { primarySelector: null, fallbackSelectors: [] },
          details: { pageId: this.getPageId(page) }
        })
      );
    }

    page.on("dialog", (dialog) => {
      this.track(
        this.recordAction(page, {
          actionType: "dialog",
          url: page.url(),
          target: undefined,
          selectors: { primarySelector: null, fallbackSelectors: [] },
          details: {
            dialogType: dialog.type(),
            message: dialog.message(),
            defaultValue: dialog.defaultValue()
          }
        })
      );
    });

    this.lastPageUrlById.set(pageId, page.url());
  }

  async prepareStop() {
    this.closing = true;
    if (this.stopPrepared) {
      return;
    }
    while (true) {
      if (this.inputDebouncer.hasPending) {
        await this.inputDebouncer.flush();
      }
      const tasks = [...this.pendingTasks];
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
      if (!this.inputDebouncer.hasPending && this.pendingTasks.size === 0) {
        break;
      }
    }
    this.stopPrepared = true;
  }

  async finalizeStop({
    endTimestamp,
    sessionStartTimestamp,
    videoPath
  }: {
    endTimestamp: string;
    sessionStartTimestamp: string;
    videoPath: string | null;
  }) {
    await this.prepareStop();
    await this.materializeVideoSnapshots(videoPath, sessionStartTimestamp);
    const actionsPath = resolve(this.options.outputDir, "actions.json");
    await writeFile(
      actionsPath,
      JSON.stringify(this.actions, null, 2),
      "utf8"
    );
    await writeFile(
      resolve(this.options.outputDir, "end.txt"),
      endTimestamp,
      "utf8"
    );
    await writeFile(
      resolve(this.options.outputDir, "narration.json"),
      JSON.stringify(buildNarrationRecords(this.actions), null, 2),
      "utf8"
    );
  }

  private async handlePreAction(page: Page, payload: PreActionPayload) {
    if (this.closing) {
      return;
    }
    const pageId = this.getPageId(page);
    const evidence = await this.capturePreActionEvidence(page, payload);
    if (!evidence) {
      return;
    }
    this.preActionEvidenceByPage.set(pageId, evidence);
  }

  private async capturePreActionEvidence(page: Page, payload: PreActionPayload) {
    try {
      const snapshotPayload = await this.captureSnapshotPayload(page);
      return {
        capturedAt: payload.timestamp,
        target: payload.target,
        selector: payload.selectors?.primarySelector ?? null,
        domGzip: await gzipHtml(`<!doctype html>${snapshotPayload.html}`),
        pageTitle: await this.safeGetPageTitle(page),
        url: page.url(),
        overlayRect: snapshotPayload.overlayRect,
        textRect: snapshotPayload.textRect
      } as PreActionEvidence;
    } catch {
      return null;
    }
  }

  private isPreActionMatch(action: ActionRecord, evidence: PreActionEvidence) {
    const actionTime = new Date(action.timestamp).getTime();
    const delta = actionTime - evidence.capturedAt;
    if (delta < 0 || delta > 2000) {
      return false;
    }
    const actionSelector = action.primarySelector ?? null;
    if (evidence.selector && actionSelector) {
      return evidence.selector === actionSelector;
    }
    const actionId = action.target?.id;
    const evidenceId = evidence.target?.id;
    if (actionId && evidenceId) {
      return actionId === evidenceId;
    }
    return true;
  }

  private async applyPreActionEvidence(pageId: string, action: ActionRecord) {
    const evidence = this.preActionEvidenceByPage.get(pageId);
    if (!evidence || !this.isPreActionMatch(action, evidence)) {
      return false;
    }
    const domPath = snapshotPath(
      this.options.outputDir,
      "dom",
      action.stepNumber,
      action.actionId,
      "before",
      "html.gz"
    );
    await writeFile(domPath, evidence.domGzip);
    action.urlBefore = evidence.url;
    action.pageTitleBefore = evidence.pageTitle;
    this.registerSnapshotForVideo(
      action,
      {
        actionId: action.actionId,
        stepNumber: action.stepNumber,
        pageId,
        phase: "before"
      },
      evidence.capturedAt,
      {
        overlayRect: evidence.overlayRect,
        textRect: evidence.textRect
      }
    );
    this.preActionEvidenceByPage.delete(pageId);
    return true;
  }

  private async handlePayload(
    page: Page,
    payload: RecorderPayload,
    source: { frame: { url(): string } }
  ) {
    if (this.closing) {
      return;
    }
    const url = payload.url ?? source.frame.url();
    const selectors = payload.selectors ?? {
      primarySelector: null,
      fallbackSelectors: []
    };
    const target = payload.target;
    if (target?.text) {
      target.text = target.text.slice(0, 120);
    }
    const actionType = payload.actionType;
    let details = payload.details;


    if (target?.value) {
      target.value = redactValue(
        target.value,
        target.isPassword,
        this.options.redactionRules
      );
    }

    if (actionType === "fill") {
      this.track(this.handleInput(page, url, target, selectors, details));
      return;
    }

    this.track(
      this.recordAction(page, {
        actionType,
        url,
        target,
        selectors,
        details
      })
    );
  }

  private async handleInput(
    page: Page,
    url: string,
    target: TargetMetadata | undefined,
    selectors: { primarySelector: string | null; fallbackSelectors: string[] },
    details?: Record<string, unknown>
  ) {
    const existing = this.inputDebouncer.getPending();
    if (
      existing &&
      (existing.pageId !== this.getPageId(page) ||
        existing.selectors.primarySelector !== selectors.primarySelector)
    ) {
      await this.inputDebouncer.flush();
    }
    const refreshed = this.inputDebouncer.getPending();
    const actionId = refreshed?.actionId ?? randomUUID();
    const stepNumber = refreshed?.stepNumber ?? this.nextStepNumber();
    const timestamp = refreshed?.timestamp ?? new Date().toISOString();
    const pending: PendingInput = {
      actionId,
      stepNumber,
      pageId: this.getPageId(page),
      url,
      timestamp,
      target,
      selectors,
      details
    };

    await this.inputDebouncer.push(pending);
  }

  private async recordAction(
    page: Page,
    payload: {
      actionType: ActionType;
      url: string;
      target: TargetMetadata | undefined;
      selectors: { primarySelector: string | null; fallbackSelectors: string[] };
      details?: Record<string, unknown>;
    }
  ) {
    if (this.inputDebouncer.hasPending) {
      await this.inputDebouncer.flush();
    }

    const actionId = randomUUID();
    const stepNumber = this.nextStepNumber();
    const pageId = this.getPageId(page);
    const timestamp = new Date().toISOString();
    const frameInfo = this.buildVideoFrameInfo(timestamp);

    const action: ActionRecord = {
      actionId,
      stepNumber,
      timestamp,
      actionType: payload.actionType,
      url: payload.url,
      pageId,
      videoFrame: frameInfo.videoFrame,
      videoFrameMod65536: frameInfo.videoFrameMod65536,
      beforeScreenshotFileName: null,
      atScreenshotFileName: null,
      afterScreenshotFileName: null,
      pageTitleBefore: null,
      pageTitleAfter: null,
      urlBefore: null,
      urlAfter: null,
      target: payload.target,
      primarySelector: payload.selectors.primarySelector,
      fallbackSelectors: payload.selectors.fallbackSelectors,
      details: payload.details
    };

    const shouldCapture =
      this.shouldCaptureEvidence(payload.actionType) ||
      (payload.actionType === "hover" && payload.details?.hoverUiChangeDetected === true);

    if (shouldCapture) {
      const hasPreActionEvidence = await this.applyPreActionEvidence(pageId, action);
      if (!hasPreActionEvidence) {
        action.urlBefore = page.url();
        action.pageTitleBefore = await this.safeGetPageTitle(page);
        await this.safeCaptureSnapshot(page, action, {
          actionId,
          stepNumber,
          pageId,
          phase: "before"
        });
      }
      await this.safeWaitForTimeout(page, 300);
      await this.safeCaptureSnapshot(page, action, {
        actionId,
        stepNumber,
        pageId,
        phase: "at"
      });
    }

    if (shouldCapture) {
      await this.safeWaitForTimeout(page, 800);
      await this.waitForDomQuiet(pageId);
      await this.safeCaptureSnapshot(page, action, {
        actionId,
        stepNumber,
        pageId,
        phase: "after"
      });
      action.urlAfter = page.url();
      action.pageTitleAfter = await this.safeGetPageTitle(page);
    }
    await this.writeAction(action);
  }

  private shouldCaptureEvidence(actionType: ActionType) {
    return [
      "click",
      "fill",
      "press",
      "select",
      "navigation",
      "goto",
      "dialog",
      "set_input_files",
      "check"
    ].includes(actionType);
  }

  private async safeGetPageTitle(page: Page) {
    try {
      return await page.title();
    } catch {
      return null;
    }
  }

  private async safeWaitForTimeout(page: Page, timeoutMs: number) {
    try {
      await page.waitForTimeout(timeoutMs);
    } catch {
      // Ignore wait errors when page/context closes during shutdown.
    }
  }

  private async safeCaptureSnapshot(
    page: Page,
    action: ActionRecord,
    descriptor: SnapshotDescriptor
  ) {
    try {
      const snapshotCapture = await this.captureSnapshot(page, descriptor);
      this.registerSnapshotForVideo(
        action,
        descriptor,
        snapshotCapture.capturedAt,
        {
          overlayRect: snapshotCapture.overlayRect,
          textRect: snapshotCapture.textRect
        }
      );
    } catch {
      // Ignore snapshot errors (e.g., page closed).
    }
  }

  private setScreenshotFileName(
    action: ActionRecord,
    phase: SnapshotDescriptor["phase"],
    fileName: string | null
  ) {
    if (phase === "before") {
      action.beforeScreenshotFileName = fileName;
      return;
    }
    if (phase === "at") {
      action.atScreenshotFileName = fileName;
      return;
    }
    action.afterScreenshotFileName = fileName;
  }

  private setOverlayOcrSnapshot(
    action: ActionRecord,
    phase: SnapshotDescriptor["phase"],
    overlayOcr: OverlayOcrSnapshot
  ) {
    if (!action.overlayOcr) {
      action.overlayOcr = {};
    }
    action.overlayOcr[phase] = overlayOcr;
  }

  private registerSnapshotForVideo(
    action: ActionRecord,
    descriptor: SnapshotDescriptor,
    capturedAt: number,
    overlayCapture: SnapshotOverlayCapture
  ) {
    const screenshotPath = snapshotPath(
      this.options.outputDir,
      "screenshots",
      descriptor.stepNumber,
      descriptor.actionId,
      descriptor.phase,
      "png"
    );
    this.setScreenshotFileName(action, descriptor.phase, basename(screenshotPath));
    this.pendingVideoSnapshots.push({
      action,
      descriptor,
      screenshotPath,
      capturedAt,
      overlayRect: overlayCapture.overlayRect,
      textRect: overlayCapture.textRect
    });
  }

  private async materializeVideoSnapshots(
    videoPath: string | null,
    sessionStartTimestamp: string
  ) {
    if (this.pendingVideoSnapshots.length === 0) {
      return;
    }
    if (!videoPath) {
      for (const snapshot of this.pendingVideoSnapshots) {
        this.setScreenshotFileName(snapshot.action, snapshot.descriptor.phase, null);
      }
      return;
    }
    const sessionStartMs = new Date(sessionStartTimestamp).getTime();
    if (!Number.isFinite(sessionStartMs)) {
      for (const snapshot of this.pendingVideoSnapshots) {
        this.setScreenshotFileName(snapshot.action, snapshot.descriptor.phase, null);
      }
      return;
    }

    const snapshots = [...this.pendingVideoSnapshots].sort(
      (left, right) => left.capturedAt - right.capturedAt
    );
    const frameAdjustmentToMs = (frameAdjustment: number) =>
      (frameAdjustment * 1000) / VIDEO_FRAME_RATE;
    const computeOffsetMs = (baseOffsetMs: number, frameAdjustment: number) =>
      Math.max(0, baseOffsetMs - frameAdjustmentToMs(frameAdjustment));
    const getSnapshotTargetTimeMs = (snapshot: PendingVideoSnapshot) => {
      const actionTimeMs = new Date(snapshot.action.timestamp).getTime();
      if (!Number.isFinite(actionTimeMs)) {
        return snapshot.capturedAt;
      }
      const phaseOffsetMs =
        snapshot.descriptor.phase === "before"
          ? -300
          : snapshot.descriptor.phase === "after"
            ? 800
            : 0;
      return actionTimeMs + phaseOffsetMs;
    };
    const cleanupScreenshotArtifacts = async (screenshotPath: string) => {
      await Promise.allSettled([
        unlink(screenshotPath),
        unlink(buildOverlayCutPath(screenshotPath))
      ]);
    };
    const cleanupAllScreenshotArtifacts = async () => {
      await Promise.all(
        snapshots.map((snapshot) => cleanupScreenshotArtifacts(snapshot.screenshotPath))
      );
    };

    const targetCaptureTimesMs = snapshots.map((snapshot) =>
      getSnapshotTargetTimeMs(snapshot)
    );
    const baseOffsetsMs = targetCaptureTimesMs.map((targetTimeMs) =>
      Math.max(0, targetTimeMs - sessionStartMs)
    );

    const buildExtractionRequests = (frameAdjustment = 0) =>
      snapshots.map((snapshot, index) => ({
        outputPath: snapshot.screenshotPath,
        offsetMs: computeOffsetMs(baseOffsetsMs[index] ?? 0, frameAdjustment)
      }));

    await cleanupAllScreenshotArtifacts();
    let outcomes = await extractFramesFromVideo(videoPath, buildExtractionRequests(0));
    type OverlayOcrWorker = Awaited<ReturnType<typeof createOverlayOcrWorker>>;
    let ocrWorker: OverlayOcrWorker | null = null;
    let ocrWorkerError: string | null = null;
    let bestOcrWorker: OverlayOcrWorker | null = null;
    let bestOcrWorkerError: string | null = null;
    const expectedFrames = targetCaptureTimesMs.map((targetTimeMs) =>
      this.buildVideoFrameInfoFromMs(targetTimeMs, sessionStartMs)
    );
    if (!ocrWorker && !ocrWorkerError) {
      try {
        ocrWorker = await createOverlayOcrWorker();
      } catch (error) {
        ocrWorkerError = error instanceof Error ? error.message : String(error);
      }
    }
    const getBestOcrWorker = async () => {
      if (bestOcrWorker || bestOcrWorkerError) {
        return bestOcrWorker;
      }
      try {
        bestOcrWorker = await createOverlayOcrWorker({
          langPath: TESSERACT_BEST_ENG_LANG_PATH,
          oem: TESSERACT_BEST_OEM
        });
      } catch (error) {
        bestOcrWorkerError = error instanceof Error ? error.message : String(error);
      }
      return bestOcrWorker;
    };

    const readOverlayOcr = async (
      worker: OverlayOcrWorker,
      imagePath: string,
      snapshot: Pick<PendingVideoSnapshot, "overlayRect" | "textRect">
    ) => {
      const baselineResult = await readOverlayNumberFromScreenshot(
        worker,
        imagePath,
        {
          overlayRect: snapshot.overlayRect,
          textRect: snapshot.textRect
        }
      );
      const confidence = baselineResult.confidence ?? 0;
      if (confidence >= OCR_BEST_MODEL_RETRY_MIN_CONFIDENCE) {
        return baselineResult;
      }
      const bestWorker = await getBestOcrWorker();
      if (!bestWorker) {
        return baselineResult;
      }
      const bestResult = await readOverlayNumberFromScreenshot(bestWorker, imagePath, {
        overlayRect: snapshot.overlayRect,
        textRect: snapshot.textRect
      });
      return bestResult.error && bestResult.value === null ? baselineResult : bestResult;
    };

    const getFrameDistance = (value: number | null, expected: number) => {
      if (value === null) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.abs(this.normalizeSignedFrameDelta(value - expected));
    };

    const getSearchScore = (
      ocrResult: OverlayOcrRawResult | null,
      expectedVideoFrameMod65536: number
    ) => {
      if (!ocrResult || ocrResult.value === null) {
        return Number.POSITIVE_INFINITY;
      }
      const confidence = ocrResult.confidence ?? 0;
      if (confidence < LOCAL_SEARCH_MIN_CONFIDENCE) {
        return Number.POSITIVE_INFINITY;
      }
      return getFrameDistance(ocrResult.value, expectedVideoFrameMod65536);
    };

    const evaluateOcr = async (currentOutcomes: boolean[]) => {
      const ocrResults: Array<OverlayOcrRawResult | null> = [];
      if (!ocrWorker) {
        return ocrResults;
      }
      for (const [index, snapshot] of snapshots.entries()) {
        if (!currentOutcomes[index]) {
          ocrResults.push(null);
          continue;
        }
        const ocrResult = await readOverlayOcr(
          ocrWorker,
          snapshot.screenshotPath,
          snapshot
        );
        ocrResults.push(ocrResult);
      }
      return ocrResults;
    };

    let ocrResults = await evaluateOcr(outcomes);
    let calibrationFrameDelta = 0;
    if (ocrWorker) {
      calibrationFrameDelta = this.computeOcrCalibrationFrameDelta(
        ocrResults.map((ocrResult, index) => ({
          value: ocrResult?.value ?? null,
          confidence: ocrResult?.confidence ?? null,
          expectedVideoFrameMod65536: expectedFrames[index]?.videoFrameMod65536 ?? 0
        }))
      );
      if (Math.abs(calibrationFrameDelta) >= 2) {
        await cleanupAllScreenshotArtifacts();
        outcomes = await extractFramesFromVideo(
          videoPath,
          buildExtractionRequests(calibrationFrameDelta)
        );
        ocrResults = await evaluateOcr(outcomes);
      }
    }

    if (ocrWorker) {
      for (const [index, snapshot] of snapshots.entries()) {
        if (!outcomes[index]) {
          continue;
        }
        const expectedFrameInfo = expectedFrames[index] ?? { videoFrameMod65536: 0 };
        const baselineResult = ocrResults[index] ?? null;
        if (
          !baselineResult ||
          baselineResult.value === null ||
          (baselineResult.confidence ?? 0) < LOCAL_SEARCH_MIN_CONFIDENCE ||
          baselineResult.value === expectedFrameInfo.videoFrameMod65536
        ) {
          continue;
        }

        let bestLocalFrameAdjustment = 0;
        let bestResult = baselineResult;
        let bestScore = getSearchScore(bestResult, expectedFrameInfo.videoFrameMod65536);
        let bestConfidence = bestResult?.confidence ?? 0;

        for (
          let localFrameAdjustment = -LOCAL_SEARCH_RADIUS_FRAMES;
          localFrameAdjustment <= LOCAL_SEARCH_RADIUS_FRAMES;
          localFrameAdjustment += 1
        ) {
          if (localFrameAdjustment === 0) {
            continue;
          }
          const candidatePath = `${snapshot.screenshotPath}.local_${localFrameAdjustment >= 0 ? "p" : "m"}${Math.abs(localFrameAdjustment)}.png`;
          await cleanupScreenshotArtifacts(candidatePath);
          const candidateOutcome = await extractFramesFromVideo(videoPath, [
            {
              outputPath: candidatePath,
              offsetMs: computeOffsetMs(
                baseOffsetsMs[index] ?? 0,
                calibrationFrameDelta + localFrameAdjustment
              )
            }
          ]);
          if (!candidateOutcome[0]) {
            await cleanupScreenshotArtifacts(candidatePath);
            continue;
          }
          const candidateResult = await readOverlayOcr(
            ocrWorker,
            candidatePath,
            snapshot
          );
          const candidateScore = getSearchScore(
            candidateResult,
            expectedFrameInfo.videoFrameMod65536
          );
          const candidateConfidence = candidateResult.confidence ?? 0;
          if (
            candidateScore < bestScore ||
            (candidateScore === bestScore &&
              candidateConfidence > bestConfidence &&
              Math.abs(localFrameAdjustment) < Math.abs(bestLocalFrameAdjustment))
          ) {
            bestLocalFrameAdjustment = localFrameAdjustment;
            bestResult = candidateResult;
            bestScore = candidateScore;
            bestConfidence = candidateConfidence;
          }
          await cleanupScreenshotArtifacts(candidatePath);
        }

        if (bestLocalFrameAdjustment !== 0) {
          await cleanupScreenshotArtifacts(snapshot.screenshotPath);
          const replacementOutcome = await extractFramesFromVideo(videoPath, [
            {
              outputPath: snapshot.screenshotPath,
              offsetMs: computeOffsetMs(
                baseOffsetsMs[index] ?? 0,
                calibrationFrameDelta + bestLocalFrameAdjustment
              )
            }
          ]);
          const extracted = replacementOutcome[0] ?? false;
          outcomes[index] = extracted;
          if (!extracted) {
            ocrResults[index] = null;
            continue;
          }
          bestResult = await readOverlayOcr(ocrWorker, snapshot.screenshotPath, snapshot);
        }

        ocrResults[index] = bestResult;
      }
    }

    for (const [index, snapshot] of snapshots.entries()) {
      if (!outcomes[index]) {
        this.setScreenshotFileName(snapshot.action, snapshot.descriptor.phase, null);
        continue;
      }
      const expectedFrameInfo = expectedFrames[index] ?? { videoFrameMod65536: 0 };
      const ocrResult = ocrResults[index] ?? null;
      if (!ocrResult) {
        const candidateCropRect = snapshot.textRect ?? snapshot.overlayRect;
        this.setOverlayOcrSnapshot(snapshot.action, snapshot.descriptor.phase, {
          value: null,
          text: null,
          confidence: null,
          cutScreenshotFileName: null,
          overlayRect: snapshot.overlayRect,
          ocrCropRect: candidateCropRect,
          expectedVideoFrameMod65536: expectedFrameInfo.videoFrameMod65536,
          matchesExpected: null,
          error: ocrWorkerError ?? "OCR worker unavailable"
        });
        continue;
      }
      this.setOverlayOcrSnapshot(snapshot.action, snapshot.descriptor.phase, {
        value: ocrResult.value,
        text: ocrResult.text,
        confidence: ocrResult.confidence,
        cutScreenshotFileName: ocrResult.cutScreenshotFileName,
        overlayRect: ocrResult.overlayRect,
        ocrCropRect: ocrResult.cropRect,
        expectedVideoFrameMod65536: expectedFrameInfo.videoFrameMod65536,
        matchesExpected:
          ocrResult.value === null
            ? null
            : ocrResult.value === expectedFrameInfo.videoFrameMod65536,
        error: ocrResult.error
      });
    }
    const terminateWorkerSafely = async (worker: OverlayOcrWorker | null) => {
      if (!worker) {
        return;
      }
      try {
        await worker.terminate();
      } catch {
        // Ignore OCR worker shutdown errors.
      }
    };
    await terminateWorkerSafely(ocrWorker);
    await terminateWorkerSafely(bestOcrWorker);
  }

  private async writeAction(action: ActionRecord) {
    const jsonlPath = resolve(this.options.outputDir, "actions.jsonl");
    const jsonPath = resolve(this.options.outputDir, "actions.json");
    await appendJsonl(jsonlPath, action);
    this.actions.push(action);
    await writeFile(jsonPath, JSON.stringify(this.actions, null, 2), "utf8");
  }

  private async waitForDomQuiet(pageId: string) {
    const page = this.getPageById(pageId);
    if (!page) {
      return;
    }
    try {
      await page.evaluate(
        ({ quietWindowMs, quietTimeoutMs }) => {
          return new Promise<void>((resolve) => {
            const timeoutId = setTimeout(() => {
              observer.disconnect();
              resolve();
            }, quietTimeoutMs);

            let quietTimer: number | undefined;
            const resetQuietTimer = () => {
              if (quietTimer) {
                window.clearTimeout(quietTimer);
              }
              quietTimer = window.setTimeout(() => {
                clearTimeout(timeoutId);
                observer.disconnect();
                resolve();
              }, quietWindowMs);
            };

            const observer = new MutationObserver(() => {
              resetQuietTimer();
            });
            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true
            });
            resetQuietTimer();
          });
        },
        {
          quietWindowMs: this.options.quietWindowMs,
          quietTimeoutMs: this.options.quietTimeoutMs
        }
      );
    } catch {
      // Ignore settle errors; snapshots will still capture current DOM.
    }
  }

  private async captureSnapshot(
    page: Page,
    descriptor: SnapshotDescriptor
  ): Promise<SnapshotCapturePayload> {
    const domPath = snapshotPath(
      this.options.outputDir,
      "dom",
      descriptor.stepNumber,
      descriptor.actionId,
      descriptor.phase,
      "html.gz"
    );

    const snapshotPayload = await this.captureSnapshotPayload(page);

    const gzipBuffer = await gzipHtml(snapshotPayload.html);
    await writeFile(domPath, gzipBuffer);
    return snapshotPayload;
  }

  private async captureSnapshotPayload(page: Page): Promise<SnapshotCapturePayload> {
    return await page.evaluate(() => {
      const capturedAt = performance.timeOrigin + performance.now();
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      const inputs = clone.querySelectorAll("input");
      inputs.forEach((input) => {
        if (
          input instanceof HTMLInputElement &&
          input.type.toLowerCase() === "password"
        ) {
          input.value = "********";
          input.setAttribute("value", "********");
        }
      });

      const dpr = window.devicePixelRatio || 1;
      const viewportWidth = Math.max(1, Math.round(window.innerWidth * dpr));
      const viewportHeight = Math.max(1, Math.round(window.innerHeight * dpr));
      let overlayRect: OverlayCropRect | null = null;
      let textRect: OverlayCropRect | null = null;
      const overlay = document.getElementById("__scriberFrameOverlay");
      if (overlay instanceof HTMLElement) {
        const bounds = overlay.getBoundingClientRect();
        const style = window.getComputedStyle(overlay);
        const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
        const borderRight = Number.parseFloat(style.borderRightWidth) || 0;
        const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
        const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
        const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
        const paddingRight = Number.parseFloat(style.paddingRight) || 0;
        const paddingTop = Number.parseFloat(style.paddingTop) || 0;
        const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;

        const overlayRawLeft = Math.floor(bounds.left * dpr);
        const overlayRawTop = Math.floor(bounds.top * dpr);
        const overlayRawRight = Math.ceil((bounds.left + bounds.width) * dpr);
        const overlayRawBottom = Math.ceil((bounds.top + bounds.height) * dpr);
        const overlayClampedLeft = Math.min(Math.max(0, overlayRawLeft), viewportWidth - 1);
        const overlayClampedTop = Math.min(Math.max(0, overlayRawTop), viewportHeight - 1);
        const overlayClampedRight = Math.min(
          Math.max(overlayClampedLeft + 1, overlayRawRight),
          viewportWidth
        );
        const overlayClampedBottom = Math.min(
          Math.max(overlayClampedTop + 1, overlayRawBottom),
          viewportHeight
        );
        overlayRect = {
          left: overlayClampedLeft,
          top: overlayClampedTop,
          width: Math.max(1, overlayClampedRight - overlayClampedLeft),
          height: Math.max(1, overlayClampedBottom - overlayClampedTop)
        };

        const contentLeft = bounds.left + borderLeft + paddingLeft;
        const contentTop = bounds.top + borderTop + paddingTop;
        const contentWidth = Math.max(
          1,
          bounds.width - borderLeft - borderRight - paddingLeft - paddingRight
        );
        const contentHeight = Math.max(
          1,
          bounds.height - borderTop - borderBottom - paddingTop - paddingBottom
        );
        const textRawLeft = Math.floor(contentLeft * dpr);
        const textRawTop = Math.floor(contentTop * dpr);
        const textRawRight = Math.ceil((contentLeft + contentWidth) * dpr);
        const textRawBottom = Math.ceil((contentTop + contentHeight) * dpr);
        const textClampedLeft = Math.min(Math.max(0, textRawLeft), viewportWidth - 1);
        const textClampedTop = Math.min(Math.max(0, textRawTop), viewportHeight - 1);
        const textClampedRight = Math.min(
          Math.max(textClampedLeft + 1, textRawRight),
          viewportWidth
        );
        const textClampedBottom = Math.min(
          Math.max(textClampedTop + 1, textRawBottom),
          viewportHeight
        );
        textRect = {
          left: textClampedLeft,
          top: textClampedTop,
          width: Math.max(1, textClampedRight - textClampedLeft),
          height: Math.max(1, textClampedBottom - textClampedTop)
        };
      }

      return {
        capturedAt,
        html: clone.outerHTML,
        overlayRect,
        textRect
      };
    });
  }

  private nextStepNumber() {
    this.stepNumber += 1;
    return this.stepNumber;
  }

  private buildVideoFrameInfo(timestamp: string) {
    const actionTimeMs = new Date(timestamp).getTime();
    return this.buildVideoFrameInfoFromMs(actionTimeMs, this.sessionStartMs);
  }

  private buildVideoFrameInfoFromMs(actionTimeMs: number, sessionStartMs: number) {
    if (!Number.isFinite(actionTimeMs) || !Number.isFinite(sessionStartMs)) {
      return { videoFrame: 0, videoFrameMod65536: 0 };
    }
    const elapsedMs = Math.max(0, actionTimeMs - sessionStartMs);
    const videoFrame = Math.floor((elapsedMs * VIDEO_FRAME_RATE) / 1000);
    return {
      videoFrame,
      videoFrameMod65536: videoFrame % VIDEO_FRAME_MODULUS
    };
  }

  private normalizeSignedFrameDelta(frameDelta: number) {
    const halfModulus = VIDEO_FRAME_MODULUS / 2;
    return (
      (((frameDelta + halfModulus) % VIDEO_FRAME_MODULUS) + VIDEO_FRAME_MODULUS) %
        VIDEO_FRAME_MODULUS -
      halfModulus
    );
  }

  private computeOcrCalibrationFrameDelta(
    samples: Array<{
      value: number | null;
      confidence: number | null;
      expectedVideoFrameMod65536: number;
    }>
  ) {
    const deltas = samples
      .flatMap((sample) => {
        if (sample.value === null) {
          return [];
        }
        const confidence = sample.confidence ?? 0;
        if (confidence < OCR_CALIBRATION_MIN_CONFIDENCE) {
          return [];
        }
        const delta = this.normalizeSignedFrameDelta(
          sample.value - sample.expectedVideoFrameMod65536
        );
        if (Math.abs(delta) > OCR_CALIBRATION_MAX_ABS_DELTA_FRAMES) {
          return [];
        }
        return [delta];
      })
      .sort((left, right) => left - right);

    if (deltas.length === 0) {
      return 0;
    }

    const middle = Math.floor(deltas.length / 2);
    if (deltas.length % 2 === 1) {
      return deltas[middle] ?? 0;
    }

    const left = deltas[middle - 1] ?? 0;
    const right = deltas[middle] ?? 0;
    return Math.round((left + right) / 2);
  }

  private getPageId(page: Page) {
    return this.pageIds.get(page) ?? "unknown";
  }

  private getPageById(pageId: string) {
    for (const [page, id] of this.pageIds.entries()) {
      if (id === pageId) {
        return page;
      }
    }
    return null;
  }

  private track(task: Promise<void>) {
    const guardedTask = task.catch(() => {
      // Background capture can fail during rapid shutdown; continue finalizing artifacts.
    });
    this.pendingTasks.add(guardedTask);
    guardedTask.finally(() => {
      this.pendingTasks.delete(guardedTask);
    });
  }
}

interface RecorderPayload {
  actionType: ActionType;
  url?: string;
  selectors?: { primarySelector: string | null; fallbackSelectors: string[] };
  target?: TargetMetadata;
  details?: Record<string, unknown>;
}

const createInitScript = (
  sessionStartMs: number,
  frameRate: number,
  frameModulus: number
) => `
(() => {
  const SCRIBER_SESSION_START_MS = ${sessionStartMs};
  const SCRIBER_VIDEO_FRAME_RATE = ${frameRate};
  const SCRIBER_VIDEO_FRAME_MODULUS = ${frameModulus};

  const getEpochMs = () => performance.timeOrigin + performance.now();

  const buildCssPath = (element) => {
    if (!(element instanceof Element)) return null;
    const path = [];
    while (element && element.nodeType === Node.ELEMENT_NODE) {
      let selector = element.nodeName.toLowerCase();
      if (element.id) {
        selector += '#' + CSS.escape(element.id);
        path.unshift(selector);
        break;
      } else {
        let sibling = element;
        let nth = 1;
        while (sibling.previousElementSibling) {
          sibling = sibling.previousElementSibling;
          if (sibling.nodeName === element.nodeName) {
            nth += 1;
          }
        }
        selector += ':nth-of-type(' + nth + ')';
      }
      path.unshift(selector);
      element = element.parentElement;
    }
    return path.join(' > ');
  };

  const buildXPath = (element) => {
    if (!(element instanceof Element)) return null;
    if (element.id) {
      return '//*[@id="' + element.id + '"]';
    }
    const parts = [];
    while (element && element.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = element.previousSibling;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === element.nodeName) {
          index += 1;
        }
        sibling = sibling.previousSibling;
      }
      parts.unshift(element.nodeName.toLowerCase() + '[' + index + ']');
      element = element.parentElement;
    }
    return '/' + parts.join('/');
  };

  const implicitRole = (target) => {
    if (!(target instanceof Element)) return undefined;
    const tag = target.tagName.toLowerCase();
    if (tag === 'a' && target.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'img';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const type = (target.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return undefined;
  };

  const getAssociatedLabelText = (target) => {
    if (!(target instanceof Element)) return undefined;
    const labelledBy = target.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/).filter(Boolean);
      const labelledText = ids
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      if (labelledText) return labelledText;
    }
    const labelAttr = target.getAttribute('aria-label');
    if (labelAttr?.trim()) return labelAttr.trim();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      if (target.labels && target.labels.length > 0) {
        const text = Array.from(target.labels)
          .map((label) => label.textContent?.trim())
          .filter(Boolean)
          .join(' ')
          .trim();
        if (text) return text;
      }
    }
    const title = target.getAttribute('title');
    if (title?.trim()) return title.trim();
    const alt = target.getAttribute('alt');
    if (alt?.trim()) return alt.trim();
    const text = target.textContent?.trim();
    if (text) return text;
    const value = target.getAttribute('value');
    if (value?.trim()) return value.trim();
    return undefined;
  };

  const normalizeName = (value) => value?.replace(/\s+/g, ' ').trim();

  const getVideoFrame = (timestampMs) => {
    if (!Number.isFinite(timestampMs)) {
      return 0;
    }
    const elapsedMs = Math.max(0, timestampMs - SCRIBER_SESSION_START_MS);
    return Math.floor((elapsedMs * SCRIBER_VIDEO_FRAME_RATE) / 1000);
  };

  let frameOverlay = null;
  const ensureFrameOverlay = () => {
    if (frameOverlay instanceof HTMLElement && frameOverlay.isConnected) {
      return frameOverlay;
    }
    const existing = document.getElementById('__scriberFrameOverlay');
    if (existing instanceof HTMLElement) {
      frameOverlay = existing;
      return frameOverlay;
    }
    const root = document.documentElement || document.body;
    if (!root) {
      return null;
    }
    frameOverlay = document.createElement('div');
    frameOverlay.id = '__scriberFrameOverlay';
    frameOverlay.setAttribute('aria-hidden', 'true');
    frameOverlay.style.display = 'inline-block';
    frameOverlay.style.position = 'fixed';
    frameOverlay.style.top = '6px';
    frameOverlay.style.left = '6px';
    frameOverlay.style.width = '5ch';
    frameOverlay.style.padding = '0 2px';
    frameOverlay.style.textAlign = 'right';
    frameOverlay.style.border = '2px solid #ff0';
    frameOverlay.style.borderRadius = '0';
    frameOverlay.style.background = '#000';
    frameOverlay.style.color = '#fff';
    frameOverlay.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    frameOverlay.style.fontSize = '12px';
    frameOverlay.style.lineHeight = '1';
    frameOverlay.style.fontVariantNumeric = 'tabular-nums';
    frameOverlay.style.pointerEvents = 'none';
    frameOverlay.style.userSelect = 'none';
    frameOverlay.style.zIndex = '2147483647';
    root.appendChild(frameOverlay);
    return frameOverlay;
  };

  const updateFrameOverlay = () => {
    const overlay = ensureFrameOverlay();
    if (!overlay) {
      return;
    }
    const frame = getVideoFrame(getEpochMs());
    overlay.textContent = String(frame % SCRIBER_VIDEO_FRAME_MODULUS);
  };

  const startFrameOverlayLoop = () => {
    const tick = () => {
      updateFrameOverlay();
      window.requestAnimationFrame(tick);
    };
    tick();
  };
  startFrameOverlayLoop();

  const buildSelectors = (target) => {
    if (!(target instanceof Element)) {
      return { primarySelector: null, fallbackSelectors: [] };
    }
    const fallback = [];
    const dataTestId = target.getAttribute('data-testid');
    const dataTest = target.getAttribute('data-test');
    if (dataTestId) fallback.push('[data-testid="' + dataTestId + '"]');
    if (!dataTestId && dataTest) fallback.push('[data-test="' + dataTest + '"]');
    if (target.id) fallback.push('#' + CSS.escape(target.id));
    const role = target.getAttribute('role') || implicitRole(target) || target.tagName.toLowerCase();
    const name = normalizeName(getAssociatedLabelText(target));
    if (role && name) {
      const escapedName = name.replace(/"/g, '\"');
      fallback.push('role=' + role + '[name="' + escapedName + '"]');
    }
    if (target.textContent && target.textContent.trim()) {
      fallback.push('text="' + target.textContent.trim() + '"');
    }
    const cssPath = buildCssPath(target);
    if (cssPath) fallback.push(cssPath);
    const xpath = buildXPath(target);
    if (xpath) fallback.push('xpath=' + xpath);
    const primarySelector = fallback.shift() ?? null;
    return { primarySelector, fallbackSelectors: fallback };
  };

  const buildTarget = (target) => {
    if (!(target instanceof Element)) return undefined;
    const text = target.textContent?.trim() || undefined;
    const isInput = target instanceof HTMLInputElement;
    const isPassword = isInput && target.type.toLowerCase() === 'password';
    return {
      tagName: target.tagName.toLowerCase(),
      id: target.id || undefined,
      className: target.className || undefined,
      name: target.getAttribute('name') || undefined,
      accessibleName: normalizeName(getAssociatedLabelText(target)),
      type: isInput ? target.type : undefined,
      value: isPassword ? '********' : (isInput ? target.value : undefined),
      role: target.getAttribute('role') || implicitRole(target) || undefined,
      ariaLabel: target.getAttribute('aria-label') || undefined,
      text,
      isPassword
    };
  };

  const emit = (payload) => {
    if (window.__scriberEmit) {
      window.__scriberEmit(payload);
    }
  };

  const emitPrepareAction = (target) => {
    if (!window.__scriberPrepareAction) {
      return;
    }
    window.__scriberPrepareAction({
      timestamp: getEpochMs(),
      selectors: buildSelectors(target),
      target: buildTarget(target)
    });
  };

  const truncateText = (value, maxLength = 1000) => {
    if (typeof value !== 'string') return value;
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  };

  const truncateHoverPayload = (target, selectors) => {
    if (target?.text) {
      target.text = truncateText(target.text);
    }
    if (Array.isArray(selectors?.fallbackSelectors)) {
      selectors.fallbackSelectors = selectors.fallbackSelectors.map((selector) =>
        truncateText(selector)
      );
    }
  };

  const domDigest = () => {
    const nodeCount = document.getElementsByTagName('*').length;
    const hiddenCount = document.querySelectorAll('[hidden]').length;
    const textLength = document.body?.innerText?.length ?? 0;
    return [nodeCount, hiddenCount, textLength].join('|');
  };

  const actionHandler = (event, actionType, details) => {
    const target = event.target;
    const selectors = buildSelectors(target);
    const targetMetadata = buildTarget(target);
    if (actionType === 'hover') {
      truncateHoverPayload(targetMetadata, selectors);
    }
    emit({
      actionType,
      url: window.location.href,
      selectors,
      target: targetMetadata,
      details
    });
  };

  const getModifiers = (event) => ({
    alt: !!event.altKey,
    ctrl: !!event.ctrlKey,
    meta: !!event.metaKey,
    shift: !!event.shiftKey
  });

  const CLICK_EVENT_MATCH_WINDOW_MS = 1500;

  const isSameOrRelatedTarget = (a, b) => {
    if (!(a instanceof Node) || !(b instanceof Node)) {
      return false;
    }
    return a === b || a.contains(b) || b.contains(a);
  };

  const capturePointerContext = (event) => {
    const isPointerEvent =
      typeof PointerEvent !== 'undefined' && event instanceof PointerEvent;
    return {
      timestamp: performance.now(),
      target: event.target,
      isTrusted: event.isTrusted,
      button: event.button,
      buttons: event.buttons,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: isPointerEvent ? event.pointerType : undefined
    };
  };

  const getRelativeTimingMs = (record, now) =>
    record ? Number((now - record.timestamp).toFixed(3)) : null;

  const getRelatedContext = (record, target, now) => {
    if (!record) {
      return null;
    }
    if (now - record.timestamp > CLICK_EVENT_MATCH_WINDOW_MS) {
      return null;
    }
    if (!isSameOrRelatedTarget(record.target, target)) {
      return null;
    }
    return record;
  };

  const buildClickDiagnostics = (event, pointerDown, mouseDown, mouseUp, programmaticClick) => {
    const now = performance.now();
    const relatedPointerDown = getRelatedContext(pointerDown, event.target, now);
    const relatedMouseDown = getRelatedContext(mouseDown, event.target, now);
    const relatedMouseUp = getRelatedContext(mouseUp, event.target, now);
    const relatedProgrammatic = getRelatedContext(programmaticClick, event.target, now);
    const hasPointerSequence = !!(
      relatedPointerDown &&
      relatedMouseDown &&
      relatedMouseUp
    );
    const likelySynthetic =
      event.isTrusted === false || !hasPointerSequence || !!relatedProgrammatic;

    return {
      isTrusted: event.isTrusted,
      clickCount: event.detail,
      sourceEventType: event.constructor?.name || 'MouseEvent',
      eventSequence: {
        pointerdown: !!relatedPointerDown,
        mousedown: !!relatedMouseDown,
        mouseup: !!relatedMouseUp
      },
      programmaticClick: !!relatedProgrammatic,
      likelySynthetic,
      pointerType:
        relatedPointerDown?.pointerType ||
        (typeof PointerEvent !== 'undefined' && event instanceof PointerEvent
          ? event.pointerType
          : undefined),
      timingsMs: {
        sincePointerDown: getRelativeTimingMs(relatedPointerDown, now),
        sinceMouseDown: getRelativeTimingMs(relatedMouseDown, now),
        sinceMouseUp: getRelativeTimingMs(relatedMouseUp, now),
        sinceProgrammaticClick: getRelativeTimingMs(relatedProgrammatic, now)
      },
      coordinates: {
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY
      }
    };
  };

  let dragSource = null;
  let pageScrollTimer;
  let elementScrollTimers = new WeakMap();
  let hoverTimer;
  let lastPointerDown = null;
  let lastMouseDown = null;
  let lastMouseUp = null;
  let lastProgrammaticClick = null;
  let syntheticCursor = null;

  const getSyntheticCursor = () => {
    if (syntheticCursor && syntheticCursor.isConnected) {
      return syntheticCursor;
    }
    const existing = document.getElementById('__scriberSyntheticCursor');
    if (existing instanceof HTMLElement) {
      syntheticCursor = existing;
      return syntheticCursor;
    }
    const root = document.documentElement || document.body;
    if (!root) {
      return null;
    }
    syntheticCursor = document.createElement('div');
    syntheticCursor.id = '__scriberSyntheticCursor';
    syntheticCursor.setAttribute('aria-hidden', 'true');
    syntheticCursor.style.position = 'fixed';
    syntheticCursor.style.top = '0';
    syntheticCursor.style.left = '0';
    syntheticCursor.style.width = '14px';
    syntheticCursor.style.height = '14px';
    syntheticCursor.style.border = '2px solid rgba(255, 255, 255, 0.95)';
    syntheticCursor.style.background = 'rgba(0, 0, 0, 0.35)';
    syntheticCursor.style.borderRadius = '999px';
    syntheticCursor.style.boxSizing = 'border-box';
    syntheticCursor.style.mixBlendMode = 'difference';
    syntheticCursor.style.pointerEvents = 'none';
    syntheticCursor.style.zIndex = '2147483647';
    syntheticCursor.style.opacity = '0';
    syntheticCursor.style.transform = 'translate(-9999px, -9999px)';
    syntheticCursor.style.transition = 'opacity 80ms linear';
    syntheticCursor.style.willChange = 'transform, opacity';
    root.appendChild(syntheticCursor);
    return syntheticCursor;
  };

  const moveSyntheticCursor = (event) => {
    const cursor = getSyntheticCursor();
    if (!cursor) {
      return;
    }
    const x = Math.round(event.clientX - 7);
    const y = Math.round(event.clientY - 7);
    cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    cursor.style.opacity = '1';
  };

  const hideSyntheticCursor = () => {
    const cursor = getSyntheticCursor();
    if (!cursor) {
      return;
    }
    cursor.style.opacity = '0';
  };

  const pulseSyntheticCursor = () => {
    const cursor = getSyntheticCursor();
    if (!cursor) {
      return;
    }
    cursor.animate(
      [
        { transform: cursor.style.transform + ' scale(1)', opacity: 1 },
        { transform: cursor.style.transform + ' scale(1.35)', opacity: 0.75 },
        { transform: cursor.style.transform + ' scale(1)', opacity: 1 }
      ],
      { duration: 180, easing: 'ease-out' }
    );
  };

  document.addEventListener('pointermove', (event) => {
    moveSyntheticCursor(event);
  }, true);
  document.addEventListener('mousemove', (event) => {
    moveSyntheticCursor(event);
  }, true);
  document.addEventListener('pointerout', (event) => {
    if (event.relatedTarget === null) {
      hideSyntheticCursor();
    }
  }, true);
  window.addEventListener('blur', () => {
    hideSyntheticCursor();
  });

  document.addEventListener('pointerdown', (event) => {
    moveSyntheticCursor(event);
    pulseSyntheticCursor();
    emitPrepareAction(event.target);
    lastPointerDown = capturePointerContext(event);
  }, true);

  document.addEventListener('mousedown', (event) => {
    lastMouseDown = capturePointerContext(event);
  }, true);

  document.addEventListener('mouseup', (event) => {
    lastMouseUp = capturePointerContext(event);
  }, true);

  const originalElementClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function(...args) {
    lastProgrammaticClick = {
      timestamp: performance.now(),
      target: this,
      isTrusted: false
    };
    return originalElementClick.apply(this, args);
  };

  document.addEventListener('click', (event) => {
    const clickDiagnostics = buildClickDiagnostics(
      event,
      lastPointerDown,
      lastMouseDown,
      lastMouseUp,
      lastProgrammaticClick
    );
    actionHandler(event, 'click', {
      button: event.button,
      modifiers: getModifiers(event),
      ...clickDiagnostics
    });
  }, true);
  document.addEventListener('dblclick', (event) => {
    actionHandler(event, 'dblclick', { modifiers: getModifiers(event) });
  }, true);

  document.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (target instanceof Element && ['html', 'body'].includes(target.tagName.toLowerCase())) {
      return;
    }
    const digestBefore = domDigest();
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const latestTarget = event.target;
      if (latestTarget instanceof Element && ['html', 'body'].includes(latestTarget.tagName.toLowerCase())) {
        return;
      }
      actionHandler(event, 'hover', {
        hoverUiChangeDetected: digestBefore !== domDigest()
      });
    }, 120);
  }, true);

  document.addEventListener('dragstart', (event) => {
    dragSource = event.target instanceof Element ? buildSelectors(event.target).primarySelector : null;
  }, true);
  document.addEventListener('drop', (event) => {
    if (!dragSource) return;
    actionHandler(event, 'drag_and_drop', {
      sourceSelector: dragSource,
      targetSelector: buildSelectors(event.target).primarySelector
    });
    dragSource = null;
  }, true);

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      actionHandler(event, 'fill');
    }
  }, true);

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      actionHandler(event, 'check', { checked: target.checked });
      return;
    }
    if (target instanceof HTMLInputElement && target.type === 'radio') {
      actionHandler(event, 'check', { checked: true });
      return;
    }
    if (target instanceof HTMLSelectElement) {
      actionHandler(event, 'select', { value: target.value });
      return;
    }
    if (target instanceof HTMLInputElement && target.type === 'file') {
      actionHandler(event, 'set_input_files', { files: Array.from(target.files || []).map((f) => f.name) });
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt') {
      return;
    }
    emitPrepareAction(event.target);
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
    if (hasModifier) {
      const keys = [];
      if (event.ctrlKey) keys.push('Control');
      if (event.metaKey) keys.push('Meta');
      if (event.altKey) keys.push('Alt');
      if (event.shiftKey) keys.push('Shift');
      keys.push(event.key);
      actionHandler(event, 'hotkey', { combo: keys.join('+') });
      return;
    }
    if (event.key.length === 1) {
      return;
    }
    actionHandler(event, 'press', { key: event.key });
  }, true);

  document.addEventListener('scroll', (event) => {
    const target = event.target;
    if (target === document || target === document.documentElement || target === document.body) {
      clearTimeout(pageScrollTimer);
      pageScrollTimer = setTimeout(() => {
        emit({ actionType: 'scroll_page', url: window.location.href, selectors: { primarySelector: null, fallbackSelectors: [] }, details: { positionY: window.scrollY } });
      }, 150);
      return;
    }
    if (target instanceof Element) {
      const existing = elementScrollTimers.get(target);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        emit({
          actionType: 'scroll_element',
          url: window.location.href,
          selectors: buildSelectors(target),
          target: buildTarget(target),
          details: { scrollTop: target.scrollTop }
        });
      }, 150);
      elementScrollTimers.set(target, timer);
    }
  }, true);

  const originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function(...args) {
    emit({
      actionType: 'scroll_into_view',
      url: window.location.href,
      selectors: buildSelectors(this),
      target: buildTarget(this)
    });
    return originalScrollIntoView.apply(this, args);
  };

  let historyIndex = history.length;
  const wrapHistory = (method) => {
    const original = history[method];
    history[method] = function(...args) {
      const result = original.apply(this, args);
      emit({ actionType: 'navigation', url: window.location.href, selectors: { primarySelector: null, fallbackSelectors: [] } });
      return result;
    };
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', () => {
    const nextLength = history.length;
    const actionType = nextLength < historyIndex ? 'goBack' : 'goForward';
    historyIndex = nextLength;
    emit({ actionType, url: window.location.href, selectors: { primarySelector: null, fallbackSelectors: [] } });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      emit({ actionType: 'switch_page', url: window.location.href, selectors: { primarySelector: null, fallbackSelectors: [] } });
    }
  });
})();
`;

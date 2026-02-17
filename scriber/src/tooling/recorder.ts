import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance as nodePerformance } from "node:perf_hooks";
import { resolve } from "node:path";

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
  SnapshotDescriptor,
  TargetMetadata
} from "./types.js";

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
  timestampNs: number;
  target?: TargetMetadata;
  selectors: { primarySelector: string | null; fallbackSelectors: string[] };
  details?: Record<string, unknown>;
}

interface PreActionPayload {
  selectors?: { primarySelector: string | null; fallbackSelectors: string[] };
  target?: TargetMetadata;
  timestampNs: number;
}

interface PreActionEvidence {
  capturedAtNs: number;
  target?: TargetMetadata;
  selector: string | null;
  domGzip: Buffer;
  pageTitle: string | null;
  url: string;
}

interface SnapshotCapturePayload {
  html: string;
  overlayRect: OverlayCropRect | null;
  textRect: OverlayCropRect | null;
}

const nowEpochMs = () => nodePerformance.timeOrigin + nodePerformance.now();
const compareActionsForOutput = (left: ActionRecord, right: ActionRecord) => {
  const byStep = left.stepNumber - right.stepNumber;
  if (byStep !== 0) {
    return byStep;
  }
  const byTimestamp = left.timestamp.localeCompare(right.timestamp);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  return left.actionId.localeCompare(right.actionId);
};
const sortActionsForOutput = (actions: ActionRecord[]) =>
  [...actions].sort(compareActionsForOutput);

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

  public readonly playwrightVersion = playwrightVersion;

  constructor(options: RecorderOptions) {
    this.options = options;
    const parsedStartMs = new Date(options.sessionStartTimestamp).getTime();
    this.sessionStartMs = Number.isFinite(parsedStartMs) ? parsedStartMs : nowEpochMs();
    this.inputDebouncer = new InputDebouncer(options.debounceMs, {
      onStart: async () => undefined,
      onFlush: async (pending) => {
        const page = this.getPageById(pending.pageId);
        const action: ActionRecord = {
          actionId: pending.actionId,
          stepNumber: pending.stepNumber,
          timestamp: this.formatTimestampFromNs(pending.timestampNs),
          timeSinceVideoStartNs: this.buildTimeSinceVideoStartNs(pending.timestampNs),
          actionType: "fill",
          url: pending.url,
          pageId: pending.pageId,
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
      content: createInitScript(this.sessionStartMs)
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

  async finalizeStop({ endTimestamp }: { endTimestamp: string }) {
    await this.prepareStop();
    const sortedActions = sortActionsForOutput(this.actions);
    const actionsPath = resolve(this.options.outputDir, "actions.json");
    await writeFile(
      actionsPath,
      JSON.stringify(sortedActions, null, 2),
      "utf8"
    );
    await writeFile(
      resolve(this.options.outputDir, "end.txt"),
      endTimestamp,
      "utf8"
    );
    await writeFile(
      resolve(this.options.outputDir, "narration.json"),
      JSON.stringify(buildNarrationRecords(sortedActions), null, 2),
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
        capturedAtNs: payload.timestampNs,
        target: payload.target,
        selector: payload.selectors?.primarySelector ?? null,
        domGzip: await gzipHtml(`<!doctype html>${snapshotPayload.html}`),
        pageTitle: await this.safeGetPageTitle(page),
        url: page.url()
      } as PreActionEvidence;
    } catch {
      return null;
    }
  }

  private isPreActionMatch(action: ActionRecord, evidence: PreActionEvidence) {
    const deltaNs = action.timeSinceVideoStartNs - evidence.capturedAtNs;
    if (deltaNs < 0 || deltaNs > 2_000_000_000) {
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
      this.track(
        this.handleInput(page, url, target, selectors, details, payload.timestampNs)
      );
      return;
    }

    this.track(
      this.recordAction(page, {
        actionType,
        url,
        target,
        selectors,
        details,
        timestampNs: payload.timestampNs
      })
    );
  }

  private async handleInput(
    page: Page,
    url: string,
    target: TargetMetadata | undefined,
    selectors: { primarySelector: string | null; fallbackSelectors: string[] },
    details?: Record<string, unknown>,
    browserTimestampNs?: number
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
    const timestampNs = await this.resolveActionTimestampNs(
      page,
      refreshed?.timestampNs ?? browserTimestampNs
    );
    const pending: PendingInput = {
      actionId,
      stepNumber,
      pageId: this.getPageId(page),
      url,
      timestampNs,
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
      timestampNs?: number;
    }
  ) {
    if (this.inputDebouncer.hasPending) {
      await this.inputDebouncer.flush();
    }

    const actionId = randomUUID();
    const stepNumber = this.nextStepNumber();
    const pageId = this.getPageId(page);
    const actionTimestampNs = await this.resolveActionTimestampNs(page, payload.timestampNs);

    const action: ActionRecord = {
      actionId,
      stepNumber,
      timestamp: this.formatTimestampFromNs(actionTimestampNs),
      timeSinceVideoStartNs: this.buildTimeSinceVideoStartNs(actionTimestampNs),
      actionType: payload.actionType,
      url: payload.url,
      pageId,
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
      if (descriptor.phase === "at") {
        action.overlayRect = snapshotCapture.overlayRect;
        action.ocrCropRect = snapshotCapture.textRect ?? snapshotCapture.overlayRect;
      }
    } catch {
      // Ignore snapshot errors (e.g., page closed).
    }
  }

  private async writeAction(action: ActionRecord) {
    const jsonlPath = resolve(this.options.outputDir, "actions.jsonl");
    const jsonPath = resolve(this.options.outputDir, "actions.json");
    await appendJsonl(jsonlPath, action);
    this.actions.push(action);
    await writeFile(jsonPath, JSON.stringify(sortActionsForOutput(this.actions), null, 2), "utf8");
  }

  private async resolveActionTimestampNs(
    page: Page | null,
    browserTimestampNs?: number
  ): Promise<number> {
    if (typeof browserTimestampNs === "number" && Number.isFinite(browserTimestampNs)) {
      return Math.max(0, Math.floor(browserTimestampNs));
    }
    if (page) {
      const pageNowNs = await this.getBrowserElapsedNs(page);
      if (typeof pageNowNs === "number" && Number.isFinite(pageNowNs)) {
        return Math.max(0, Math.floor(pageNowNs));
      }
    }
    const elapsedMs = Math.max(0, nowEpochMs() - this.sessionStartMs);
    return Math.floor(elapsedMs * 1_000_000);
  }

  private async getBrowserElapsedNs(page: Page): Promise<number | null> {
    try {
      return await page.evaluate((sessionStartMs) => {
        const elapsedMs = Math.max(0, performance.timeOrigin + performance.now() - sessionStartMs);
        return Math.floor(elapsedMs * 1_000_000);
      }, this.sessionStartMs);
    } catch {
      return null;
    }
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

  private buildTimeSinceVideoStartNs(timestampNs: number) {
    if (!Number.isFinite(timestampNs)) {
      return 0;
    }
    return Math.max(0, Math.floor(timestampNs));
  }

  private formatTimestampFromNs(timestampNs: number) {
    if (!Number.isFinite(timestampNs)) {
      return new Date(this.sessionStartMs).toISOString();
    }
    const timestampMs = this.sessionStartMs + Math.max(0, timestampNs) / 1_000_000;
    return new Date(timestampMs).toISOString();
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
  timestampNs?: number;
}

const createInitScript = (sessionStartMs: number) => `
(() => {
  const SCRIBER_SESSION_START_MS = ${sessionStartMs};
  const SCRIBER_OVERLAY_MAX_MS = 999999;
  const SCRIBER_NS_PER_MS = 1_000_000;

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

  const getElapsedNs = (timestampMs) => {
    if (!Number.isFinite(timestampMs)) {
      return 0;
    }
    const elapsedMs = Math.max(0, timestampMs - SCRIBER_SESSION_START_MS);
    return Math.floor(elapsedMs * SCRIBER_NS_PER_MS);
  };

  const getOverlayMs = (timestampMs) => {
    const elapsedNs = getElapsedNs(timestampMs);
    const elapsedMs = Math.floor(elapsedNs / SCRIBER_NS_PER_MS);
    return Math.min(elapsedMs, SCRIBER_OVERLAY_MAX_MS);
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
    frameOverlay.className = 'ocr-digits';
    frameOverlay.setAttribute('aria-hidden', 'true');
    frameOverlay.style.display = 'inline-block';
    frameOverlay.style.position = 'fixed';
    frameOverlay.style.top = '6px';
    frameOverlay.style.left = '6px';
    frameOverlay.style.width = '6ch';
    frameOverlay.style.padding = '2.4px 4.8px';
    frameOverlay.style.textAlign = 'right';
    frameOverlay.style.border = '3px solid #ffff00';
    frameOverlay.style.backgroundColor = '#000000';
    frameOverlay.style.color = '#FFFFFF';
    frameOverlay.style.fontFamily = '"Roboto Mono", monospace';
    frameOverlay.style.fontWeight = '700';
    frameOverlay.style.fontSize = '21.6px';
    frameOverlay.style.lineHeight = '1';
    frameOverlay.style.letterSpacing = '0.06em';
    frameOverlay.style.fontVariantNumeric = 'tabular-nums lining-nums';
    frameOverlay.style.webkitTextStroke = '1px #000000';
    frameOverlay.style.textShadow = '1px 0 #000, -1px 0 #000, 0 1px #000, 0 -1px #000';
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
    const elapsedMs = getOverlayMs(getEpochMs());
    overlay.textContent = String(elapsedMs).padStart(6, '0');
  };

  const startFrameOverlayLoop = () => {
    const tick = () => {
      updateFrameOverlay();
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
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

  const emitAction = (payload) => {
    emit({
      ...payload,
      timestampNs: getElapsedNs(getEpochMs())
    });
  };

  const emitPrepareAction = (target) => {
    if (!window.__scriberPrepareAction) {
      return;
    }
    window.__scriberPrepareAction({
      timestampNs: getElapsedNs(getEpochMs()),
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
    emitAction({
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
        emitAction({ actionType: 'scroll_page', url: window.location.href, selectors: { primarySelector: null, fallbackSelectors: [] }, details: { positionY: window.scrollY } });
      }, 150);
      return;
    }
    if (target instanceof Element) {
      const existing = elementScrollTimers.get(target);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        emitAction({
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
    emitAction({
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
      emitAction({ actionType: 'navigation', url: window.location.href, selectors: { primarySelector: null, fallbackSelectors: [] } });
      return result;
    };
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', () => {
    const nextLength = history.length;
    const actionType = nextLength < historyIndex ? 'goBack' : 'goForward';
    historyIndex = nextLength;
    emitAction({ actionType, url: window.location.href, selectors: { primarySelector: null, fallbackSelectors: [] } });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      emitAction({ actionType: 'switch_page', url: window.location.href, selectors: { primarySelector: null, fallbackSelectors: [] } });
    }
  });
})();
`;

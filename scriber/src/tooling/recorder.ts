import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { BrowserContext, Page } from "playwright";
const require = createRequire(import.meta.url);
const { version: playwrightVersion } = require("playwright/package.json") as {
  version: string;
};

import { InputDebouncer } from "./debounce.js";
import { gzipHtml } from "./dom.js";
import { appendJsonl } from "./jsonl.js";
import { snapshotPath } from "./paths.js";
import { RedactionRule, redactValue } from "./redaction.js";
import {
  ActionRecord,
  ActionType,
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

interface RecordedAction {
  action: ActionRecord;
  snapshots: SnapshotDescriptor[];
}

export class ScriberRecorder {
  private options: RecorderOptions;
  private context: BrowserContext | null = null;
  private pageIds = new Map<Page, string>();
  private primaryPage: Page | null = null;
  private lastPageUrlById = new Map<string, string>();
  private stepNumber = 0;
  private actions: RecordedAction[] = [];
  private inputDebouncer: InputDebouncer<PendingInput>;
  private closing = false;
  private pendingTasks = new Set<Promise<void>>();

  public readonly playwrightVersion = playwrightVersion;

  constructor(options: RecorderOptions) {
    this.options = options;
    this.inputDebouncer = new InputDebouncer(options.debounceMs, {
      onStart: async (pending) => {
        const page = this.getPageById(pending.pageId);
        if (!page) {
          return;
        }
        await this.safeCaptureSnapshot(page, {
          actionId: pending.actionId,
          stepNumber: pending.stepNumber,
          pageId: pending.pageId,
          phase: "before"
        });
      },
      onFlush: async (pending) => {
        await this.writeAction({
          actionId: pending.actionId,
          stepNumber: pending.stepNumber,
          timestamp: pending.timestamp,
          actionType: "fill",
          url: pending.url,
          pageId: pending.pageId,
          beforeScreenshotFileName: null,
          afterScreenshotFileName: null,
          target: pending.target,
          primarySelector: pending.selectors.primarySelector,
          fallbackSelectors: pending.selectors.fallbackSelectors,
          details: pending.details
        });
      }
    });
  }

  async attach(context: BrowserContext) {
    this.context = context;
    await this.ensureDirectories();
    await context.addInitScript({ content: createInitScript() });
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

  async stop({ endTimestamp }: { endTimestamp: string }) {
    this.closing = true;
    if (this.inputDebouncer.hasPending) {
      await this.inputDebouncer.flush();
    }
    await Promise.all(this.pendingTasks);
    const actionsPath = resolve(this.options.outputDir, "actions.json");
    await writeFile(
      actionsPath,
      JSON.stringify(this.actions.map((entry) => entry.action), null, 2),
      "utf8"
    );
    await writeFile(
      resolve(this.options.outputDir, "end.txt"),
      endTimestamp,
      "utf8"
    );
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
    const actionType = payload.actionType;
    const details = payload.details;

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
        details: payload.details
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

    const action: ActionRecord = {
      actionId,
      stepNumber,
      timestamp: new Date().toISOString(),
      actionType: payload.actionType,
      url: payload.url,
      pageId,
      beforeScreenshotFileName: null,
      afterScreenshotFileName: null,
      target: payload.target,
      primarySelector: payload.selectors.primarySelector,
      fallbackSelectors: payload.selectors.fallbackSelectors,
      details: payload.details
    };

    if (payload.actionType === "click") {
      await this.safeCaptureSnapshot(page, {
        actionId,
        stepNumber,
        pageId,
        phase: "before"
      });
    }

    await this.writeAction(action);
    if (payload.actionType === "click") {
      await this.waitForDomQuiet(pageId);
      await this.safeCaptureSnapshot(page, {
        actionId,
        stepNumber,
        pageId,
        phase: "after"
      });
    }
  }

  private async safeCaptureSnapshot(
    page: Page,
    descriptor: SnapshotDescriptor
  ) {
    try {
      await this.captureSnapshot(page, descriptor);
    } catch {
      // Ignore snapshot errors (e.g., page closed).
    }
  }

  private async writeAction(action: ActionRecord) {
    const actionsPath = resolve(this.options.outputDir, "actions.jsonl");
    await appendJsonl(actionsPath, action);
    this.actions.push({ action, snapshots: [] });
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

  private async captureSnapshot(page: Page, descriptor: SnapshotDescriptor) {
    const domPath = snapshotPath(
      this.options.outputDir,
      "dom",
      descriptor.stepNumber,
      descriptor.actionId,
      descriptor.phase,
      "html.gz"
    );

    const html = await page.evaluate(() => {
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
      return clone.outerHTML;
    });

    const gzipBuffer = await gzipHtml(html);
    await writeFile(domPath, gzipBuffer);
  }

  private nextStepNumber() {
    this.stepNumber += 1;
    return this.stepNumber;
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
    this.pendingTasks.add(task);
    task.finally(() => {
      this.pendingTasks.delete(task);
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

const createInitScript = () => `
(() => {
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
    const role = target.getAttribute('role') || target.tagName.toLowerCase();
    const name = target.getAttribute('aria-label') || target.textContent?.trim();
    if (role && name) fallback.push('role=' + role + '[name="' + name + '"]');
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
      type: isInput ? target.type : undefined,
      value: isPassword ? '********' : (isInput ? target.value : undefined),
      role: target.getAttribute('role') || undefined,
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

  document.addEventListener('pointerdown', (event) => {
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
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const latestTarget = event.target;
      if (latestTarget instanceof Element && ['html', 'body'].includes(latestTarget.tagName.toLowerCase())) {
        return;
      }
      actionHandler(event, 'hover');
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

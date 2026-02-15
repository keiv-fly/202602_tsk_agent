import { ActionRecord, NarrationRecord } from "./types.js";

const NAVIGATION_ACTIONS = new Set(["goto", "navigation", "goBack", "goForward"]);
const FOLLOW_UP_ACTIONS = new Set([
  "click",
  "fill",
  "press",
  "select",
  "navigation",
  "dialog",
  "set_input_files",
  "check",
  "hotkey"
]);

const trimText = (value: string | undefined, max = 120) => {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
};

const isLikelySystemTriggeredClick = (action: ActionRecord) => {
  if (action.actionType !== "click") {
    return false;
  }
  return (
    action.details?.likelySynthetic === true ||
    action.details?.programmaticClick === true ||
    action.details?.isTrusted === false
  );
};

const hasMeaningfulFollowUp = (actions: ActionRecord[], index: number) => {
  const hover = actions[index];
  const hoverTs = new Date(hover.timestamp).getTime();
  for (let i = index + 1; i < actions.length; i += 1) {
    const candidate = actions[i];
    const delta = new Date(candidate.timestamp).getTime() - hoverTs;
    if (delta > 1000) {
      return false;
    }
    if (candidate.pageId !== hover.pageId) {
      continue;
    }
    if (FOLLOW_UP_ACTIONS.has(candidate.actionType)) {
      return true;
    }
  }
  return false;
};

const shouldKeepForNarration = (actions: ActionRecord[], index: number) => {
  const action = actions[index];
  if (action.actionType !== "hover") {
    return true;
  }
  return hasMeaningfulFollowUp(actions, index);
};

export const buildNarrationRecords = (actions: ActionRecord[]): NarrationRecord[] => {
  let navigationGroup = 0;
  return actions
    .filter((_, index) => shouldKeepForNarration(actions, index))
    .map((action) => {
      if (NAVIGATION_ACTIONS.has(action.actionType)) {
        navigationGroup += 1;
      }
      const synthetic = isLikelySystemTriggeredClick(action);
      return {
        stepNumber: action.stepNumber,
        t: action.timestamp,
        kind: action.actionType,
        url: action.url,
        pageId: action.pageId,
        navigationGroup,
        target: {
          role: action.target?.role ?? action.target?.tagName,
          name: trimText(action.target?.ariaLabel ?? action.target?.name),
          selector: action.primarySelector,
          visibleText: trimText(action.target?.text)
        },
        evidence: {
          beforeShot: action.beforeScreenshotFileName,
          atShot: action.atScreenshotFileName,
          afterShot: action.afterScreenshotFileName,
          titleBefore: action.pageTitleBefore,
          titleAfter: action.pageTitleAfter,
          urlBefore: action.urlBefore,
          urlAfter: action.urlAfter
        },
        notes: {
          isUserInitiated: !synthetic,
          syntheticReason: synthetic ? "Programmatic or synthetic click metadata detected." : undefined
        }
      };
    });
};

export type ActionType =
  // Represents a single mouse click on an element.
  | "click"
  // Represents a double-click action.
  | "dblclick"
  // Represents moving the mouse over an element.
  | "hover"
  // Represents dragging one element onto another.
  | "drag_and_drop"
  // Represents setting the final value of an input field.
  | "fill"
  // Represents pressing a single non-shortcut key.
  | "press"
  // Represents keyboard shortcuts (e.g., Control+S).
  | "hotkey"
  // Represents checking or unchecking checkbox/radio controls.
  | "check"
  // Represents selecting an option in a <select> element.
  | "select"
  // Represents uploading files through a file input.
  | "set_input_files"
  // Represents explicit navigation to a URL.
  | "goto"
  // Represents URL changes caused by in-page interactions or redirects.
  | "navigation"
  // Represents browser back navigation.
  | "goBack"
  // Represents browser forward navigation.
  | "goForward"
  // Represents a newly opened popup/tab.
  | "popup"
  // Represents switching active tab/window.
  | "switch_page"
  // Represents alert/confirm/prompt/beforeunload interactions.
  | "dialog"
  // Represents scrolling an element into view before interaction.
  | "scroll_into_view"
  // Represents scrolling the main page to a vertical position.
  | "scroll_page"
  // Represents scrolling inside a scrollable element.
  | "scroll_element";

export interface SelectorInfo {
  primarySelector: string | null;
  fallbackSelectors: string[];
}

export interface TargetMetadata {
  tagName?: string;
  id?: string;
  className?: string;
  name?: string;
  accessibleName?: string;
  type?: string;
  value?: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  isPassword?: boolean;
}

export interface ActionRecord extends SelectorInfo {
  actionId: string;
  stepNumber: number;
  timestamp: string;
  timeSinceVideoStartNs: number;
  actionType: ActionType;
  url: string;
  pageId: string;
  pageTitleBefore: string | null;
  pageTitleAfter: string | null;
  urlBefore: string | null;
  urlAfter: string | null;
  overlayRect?: OverlayCropRect | null;
  ocrCropRect?: OverlayCropRect | null;
  secondaryOverlayRect?: OverlayCropRect | null;
  secondaryOcrCropRect?: OverlayCropRect | null;
  encodedOverlayRect?: OverlayCropRect | null;
  encodedOcrCropRect?: OverlayCropRect | null;
  target?: TargetMetadata;
  details?: Record<string, unknown>;
}

export interface OverlayCropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SnapshotDescriptor {
  actionId: string;
  stepNumber: number;
  pageId: string;
  phase: "before" | "at" | "after";
}

export interface NarrationRecord {
  stepNumber: number;
  t: string;
  kind: ActionType;
  url: string;
  pageId: string;
  navigationGroup: number;
  target?: {
    role?: string;
    name?: string;
    selector?: string | null;
    visibleText?: string;
  };
  evidence: {
    beforeShot: string | null;
    atShot: string | null;
    afterShot: string | null;
    titleBefore: string | null;
    titleAfter: string | null;
    urlBefore: string | null;
    urlAfter: string | null;
  };
  notes: {
    isUserInitiated: boolean;
    syntheticReason?: string;
  };
}

export interface SessionMeta {
  sessionId: string;
  startTimestamp: string;
  endTimestamp?: string;
  browserType: string;
  browserVersion: string;
  userAgent: string;
  viewport: { width: number; height: number };
  timezone: string;
  playwrightVersion: string;
  startUrl: string;
}

export type ActionType =
  | "click"
  | "input"
  | "change"
  | "submit"
  | "navigate"
  | "popup_open"
  | "tab_switch";

export interface SelectorInfo {
  primarySelector: string | null;
  fallbackSelectors: string[];
}

export interface TargetMetadata {
  tagName?: string;
  id?: string;
  className?: string;
  name?: string;
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
  actionType: ActionType;
  url: string;
  pageId: string;
  target?: TargetMetadata;
}

export interface SnapshotDescriptor {
  actionId: string;
  stepNumber: number;
  pageId: string;
  phase: "before" | "after";
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

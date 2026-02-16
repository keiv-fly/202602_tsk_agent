import { ActionRecord } from "./types.js";

export const validateActionSchema = (actions: ActionRecord[]) => {
  if (actions.length === 0) {
    return { valid: true, errors: [] as string[] };
  }
  const errors: string[] = [];
  let lastStep = 0;
  actions.forEach((action, index) => {
    if (!action.actionId) {
      errors.push(`Missing actionId at index ${index}`);
    }
    if (!action.pageId) {
      errors.push(`Missing pageId at index ${index}`);
    }
    if (!action.url) {
      errors.push(`Missing url at index ${index}`);
    }
    if (
      typeof action.timestamp !== "string" ||
      action.timestamp.length === 0 ||
      Number.isNaN(Date.parse(action.timestamp))
    ) {
      errors.push(`Invalid timestamp at index ${index}`);
    }
    if (
      !Number.isInteger(action.timeSinceVideoStartNs) ||
      action.timeSinceVideoStartNs < 0
    ) {
      errors.push(`Invalid timeSinceVideoStartNs at index ${index}`);
    }
    if (action.stepNumber <= lastStep) {
      errors.push(`Step number not monotonic at index ${index}`);
    }
    lastStep = action.stepNumber;
  });

  return { valid: errors.length === 0, errors };
};

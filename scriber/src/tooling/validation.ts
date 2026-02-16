import { ActionRecord } from "./types.js";

export const validateActionSchema = (actions: ActionRecord[]) => {
  const VIDEO_FRAME_MODULUS = 65536;
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
    if (!action.timestamp) {
      errors.push(`Missing timestamp at index ${index}`);
    }
    if (!Number.isInteger(action.videoFrame) || action.videoFrame < 0) {
      errors.push(`Invalid videoFrame at index ${index}`);
    }
    if (
      !Number.isInteger(action.videoFrameMod65536) ||
      action.videoFrameMod65536 < 0 ||
      action.videoFrameMod65536 >= VIDEO_FRAME_MODULUS
    ) {
      errors.push(`Invalid videoFrameMod65536 at index ${index}`);
    }
    if (
      Number.isInteger(action.videoFrame) &&
      Number.isInteger(action.videoFrameMod65536) &&
      action.videoFrame % VIDEO_FRAME_MODULUS !== action.videoFrameMod65536
    ) {
      errors.push(`videoFrameMod65536 mismatch at index ${index}`);
    }
    if (action.stepNumber <= lastStep) {
      errors.push(`Step number not monotonic at index ${index}`);
    }
    lastStep = action.stepNumber;
  });

  return { valid: errors.length === 0, errors };
};

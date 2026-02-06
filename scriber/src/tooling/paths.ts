import { resolve } from "node:path";

export const formatStepNumber = (stepNumber: number) =>
  stepNumber.toString().padStart(6, "0");

export const snapshotFilename = (
  stepNumber: number,
  actionId: string,
  phase: "before" | "after",
  extension: string
) => `${formatStepNumber(stepNumber)}_${actionId}_${phase}.${extension}`;

export const snapshotPath = (
  baseDir: string,
  directory: "screenshots" | "dom",
  stepNumber: number,
  actionId: string,
  phase: "before" | "after",
  extension: string
) => resolve(baseDir, directory, snapshotFilename(stepNumber, actionId, phase, extension));

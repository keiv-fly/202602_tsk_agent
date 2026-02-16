import Tesseract from "tesseract.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const OVERLAY_RECT = {
  left: 2,
  top: 2,
  width: 96,
  height: 40
};

export interface OverlayOcrRawResult {
  text: string | null;
  value: number | null;
  confidence: number | null;
  error: string | null;
}

export const parseOverlayDigits = (input: string | null | undefined) => {
  if (!input) {
    return null;
  }
  const normalized = input.replace(/\s+/g, "");
  const match = normalized.match(/\d{1,5}/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[0], 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    return null;
  }
  return parsed;
};

export const createOverlayOcrWorker = async () => {
  const cachePath = resolve(tmpdir(), "scriber-tesseract-cache");
  const worker = await Tesseract.createWorker("eng", 1, {
    logger: () => undefined,
    cachePath
  });
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist: "0123456789"
  });
  return worker;
};

export const readOverlayNumberFromScreenshot = async (
  worker: Awaited<ReturnType<typeof createOverlayOcrWorker>>,
  imagePath: string
): Promise<OverlayOcrRawResult> => {
  try {
    const result = await worker.recognize(imagePath, {
      rectangle: OVERLAY_RECT
    });
    const text = result.data.text?.trim() ?? null;
    return {
      text,
      value: parseOverlayDigits(text),
      confidence: Number.isFinite(result.data.confidence)
        ? result.data.confidence
        : null,
      error: null
    };
  } catch (error) {
    return {
      text: null,
      value: null,
      confidence: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

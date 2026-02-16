import Tesseract from "tesseract.js";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, parse, resolve } from "node:path";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import type { OverlayCropRect } from "./types.js";

const execFileAsync = promisify(execFile);

const FALLBACK_OVERLAY_RECT: OverlayCropRect = {
  left: 2,
  top: 2,
  width: 96,
  height: 40
};
const OCR_SCALE_FACTOR = 3;
const OCR_TEXT_MARGIN_PX = 1;

const clampInt = (value: number) => Math.max(0, Math.floor(value));
const clampSize = (value: number) => Math.max(1, Math.round(value));

const normalizeCropRect = (
  rect: OverlayCropRect | null | undefined
): OverlayCropRect | null => {
  if (!rect) {
    return null;
  }
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return null;
  }
  return {
    left: clampInt(rect.left),
    top: clampInt(rect.top),
    width: clampSize(rect.width),
    height: clampSize(rect.height)
  };
};

const expandRect = (
  rect: OverlayCropRect,
  horizontalPx: number,
  verticalPx: number
): OverlayCropRect => {
  const insetX = Math.max(0, Math.round(horizontalPx));
  const insetY = Math.max(0, Math.round(verticalPx));
  const left = Math.max(0, rect.left - insetX);
  const top = Math.max(0, rect.top - insetY);
  const width = clampSize(rect.width + insetX * 2);
  const height = clampSize(rect.height + insetY * 2);
  return { left, top, width, height };
};

const insetRect = (
  rect: OverlayCropRect,
  horizontalPx: number,
  verticalPx: number
): OverlayCropRect => {
  const insetX = Math.max(0, Math.round(horizontalPx));
  const insetY = Math.max(0, Math.round(verticalPx));
  const width = Math.max(1, rect.width - insetX * 2);
  const height = Math.max(1, rect.height - insetY * 2);
  const left = rect.left + Math.max(0, Math.floor((rect.width - width) / 2));
  const top = rect.top + Math.max(0, Math.floor((rect.height - height) / 2));
  return { left, top, width, height };
};

const resolveCropRects = (hints?: OverlayOcrCropHints) => {
  const fallbackOverlay = normalizeCropRect(FALLBACK_OVERLAY_RECT);
  const overlayRect = normalizeCropRect(hints?.overlayRect) ?? fallbackOverlay;
  const textRect = normalizeCropRect(hints?.textRect);
  const baseRect =
    textRect ??
    (overlayRect ? insetRect(overlayRect, 2, 2) : null) ??
    fallbackOverlay;
  const cropRect = baseRect
    ? expandRect(baseRect, OCR_TEXT_MARGIN_PX, OCR_TEXT_MARGIN_PX)
    : null;
  return { overlayRect, cropRect };
};

export interface OverlayOcrCropHints {
  overlayRect?: OverlayCropRect | null;
  textRect?: OverlayCropRect | null;
}

export interface OverlayOcrRawResult {
  text: string | null;
  value: number | null;
  confidence: number | null;
  cutScreenshotFileName: string | null;
  overlayRect: OverlayCropRect | null;
  cropRect: OverlayCropRect | null;
  error: string | null;
}

export const parseOverlayDigits = (input: string | null | undefined) => {
  if (!input) {
    return null;
  }
  const normalized = input.replace(/\s+/g, "");
  const match = normalized.match(/\d+/);
  if (!match) {
    return null;
  }
  if (match[0].length > 6) {
    return null;
  }
  const parsed = Number.parseInt(match[0], 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 999999) {
    return null;
  }
  return parsed;
};

export const TESSERACT_BEST_ENG_LANG_PATH =
  "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0";
export const TESSERACT_BEST_OEM = Tesseract.OEM.TESSERACT_LSTM_COMBINED;

export interface CreateOverlayOcrWorkerOptions {
  langPath?: string;
  oem?: Tesseract.OEM;
}

export const createOverlayOcrWorker = async (
  options: CreateOverlayOcrWorkerOptions = {}
) => {
  const cachePath = resolve(tmpdir(), "scriber-tesseract-cache");
  const worker = await Tesseract.createWorker(
    "eng",
    options.oem ?? Tesseract.OEM.LSTM_ONLY,
    {
      logger: () => undefined,
      cachePath,
      ...(options.langPath ? { langPath: options.langPath } : {})
    }
  );
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist: "0123456789"
  });
  return worker;
};

export const buildOverlayCutPath = (imagePath: string) => {
  const parsed = parse(imagePath);
  const ext = parsed.ext || ".png";
  return resolve(parsed.dir, `${parsed.name}_ocr_cut${ext}`);
};

const cropOverlayForOcr = async (imagePath: string, hints?: OverlayOcrCropHints) => {
  const cutPath = buildOverlayCutPath(imagePath);
  const { overlayRect, cropRect } = resolveCropRects(hints);
  if (typeof ffmpegPath !== "string" || ffmpegPath.length === 0) {
    return {
      cutPath: null as string | null,
      overlayRect,
      cropRect,
      error: "ffmpeg binary unavailable for OCR crop"
    };
  }
  if (!cropRect) {
    return {
      cutPath: null as string | null,
      overlayRect,
      cropRect,
      error: "overlay crop rectangle unavailable for OCR"
    };
  }
  try {
    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        imagePath,
        "-vf",
        `crop=${cropRect.width}:${cropRect.height}:${cropRect.left}:${cropRect.top},format=gray,scale=iw*${OCR_SCALE_FACTOR}:ih*${OCR_SCALE_FACTOR}:flags=neighbor,eq=contrast=1.8:brightness=0.03`,
        "-frames:v",
        "1",
        "-y",
        cutPath
      ],
      { windowsHide: true }
    );
    return {
      cutPath,
      overlayRect,
      cropRect,
      error: null
    };
  } catch (error) {
    return {
      cutPath: null as string | null,
      overlayRect,
      cropRect,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

export const readOverlayNumberFromScreenshot = async (
  worker: Awaited<ReturnType<typeof createOverlayOcrWorker>>,
  imagePath: string,
  hints?: OverlayOcrCropHints
): Promise<OverlayOcrRawResult> => {
  const crop = await cropOverlayForOcr(imagePath, hints);
  if (!crop.cutPath) {
    return {
      text: null,
      value: null,
      confidence: null,
      cutScreenshotFileName: null,
      overlayRect: crop.overlayRect,
      cropRect: crop.cropRect,
      error: crop.error
    };
  }
  try {
    const result = await worker.recognize(crop.cutPath);
    const text = result.data.text?.trim() ?? null;
    return {
      text,
      value: parseOverlayDigits(text),
      confidence: Number.isFinite(result.data.confidence)
        ? result.data.confidence
        : null,
      cutScreenshotFileName: basename(crop.cutPath),
      overlayRect: crop.overlayRect,
      cropRect: crop.cropRect,
      error: null
    };
  } catch (error) {
    return {
      text: null,
      value: null,
      confidence: null,
      cutScreenshotFileName: basename(crop.cutPath),
      overlayRect: crop.overlayRect,
      cropRect: crop.cropRect,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

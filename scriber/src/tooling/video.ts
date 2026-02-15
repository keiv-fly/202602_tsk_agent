import { execFile } from "node:child_process";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

export interface VideoFrameExtractionRequest {
  outputPath: string;
  offsetMs: number;
}

const runFfmpeg = async (args: string[]) => {
  if (typeof ffmpegPath !== "string" || ffmpegPath.length === 0) {
    return false;
  }
  await execFileAsync(ffmpegPath, args, { windowsHide: true });
  return true;
};

export const extractFramesFromVideo = async (
  videoPath: string,
  requests: VideoFrameExtractionRequest[]
) => {
  const outcomes: boolean[] = [];
  for (const request of requests) {
    const offsetSeconds = Math.max(0, request.offsetMs) / 1000;
    const offset = offsetSeconds.toFixed(3);
    try {
      const extracted = await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        offset,
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-y",
        request.outputPath
      ]);
      outcomes.push(extracted);
    } catch {
      outcomes.push(false);
    }
  }
  return outcomes;
};

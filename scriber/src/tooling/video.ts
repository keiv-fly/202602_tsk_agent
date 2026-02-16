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
  let successCount = 0;
  let failureCount = 0;
  for (const [index, request] of requests.entries()) {
    const offsetSeconds = Math.max(0, request.offsetMs) / 1000;
    const offset = offsetSeconds.toFixed(3);
    try {
      const extracted = await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        videoPath,
        // Use accurate seek for frame extraction so UI states
        // right around fast interactions (e.g., modal dismiss)
        // map to the expected before/at/after screenshots.
        "-ss",
        offset,
        "-frames:v",
        "1",
        "-y",
        request.outputPath
      ]);
      outcomes.push(extracted);
      if (extracted) {
        successCount += 1;
      } else {
        failureCount += 1;
      }
    } catch {
      outcomes.push(false);
      failureCount += 1;
    }
  }
  return outcomes;
};

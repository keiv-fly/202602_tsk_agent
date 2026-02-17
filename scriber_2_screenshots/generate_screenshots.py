from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import cv2
import pytesseract
from tqdm import tqdm


DEFAULT_OCR_CONFIDENCE_THRESHOLD = 92.0


@dataclass(frozen=True)
class FrameOcrResult:
    frame_index: int
    ms: int | None


def load_actions(actions_path: Path) -> list[dict]:
    with actions_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_actions(actions: list[dict], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(actions, f, indent=2)
        f.write("\n")


def _extract_int(text: str) -> int | None:
    digits = re.findall(r"\d+", text)
    if not digits:
        return None
    return int("".join(digits))


def extract_ms_from_ocr_data(ocr_data: dict, min_confidence: float) -> int | None:
    best_conf = -1.0
    best_text = ""

    for text, conf_raw in zip(ocr_data.get("text", []), ocr_data.get("conf", []), strict=False):
        text = (text or "").strip()
        if not text:
            continue
        try:
            conf = float(conf_raw)
        except (TypeError, ValueError):
            continue
        if conf > best_conf:
            best_conf = conf
            best_text = text

    if best_conf < min_confidence:
        return None

    return _extract_int(best_text)


def _crop_frame(frame, crop_rect: tuple[int, int, int, int] | None):
    if crop_rect is None:
        return frame
    left, top, width, height = crop_rect
    return frame[top : top + height, left : left + width]


def run_ocr_on_video(
    video_path: Path,
    crop_rect: tuple[int, int, int, int] | None,
    min_confidence: float = DEFAULT_OCR_CONFIDENCE_THRESHOLD,
) -> tuple[list[FrameOcrResult], list]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Unable to open video: {video_path}")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames < 0:
        total_frames = 0

    frame_results: list[FrameOcrResult] = []
    frames: list = []

    for frame_index in tqdm(range(total_frames), desc=f"OCR {video_path.name}"):
        ok, frame = cap.read()
        if not ok:
            break

        roi = _crop_frame(frame, crop_rect)
        ocr_data = pytesseract.image_to_data(
            roi,
            output_type=pytesseract.Output.DICT,
            config="--psm 7",
        )
        ms = extract_ms_from_ocr_data(ocr_data, min_confidence=min_confidence)
        frame_results.append(FrameOcrResult(frame_index=frame_index, ms=ms))
        frames.append(frame)

    cap.release()
    return frame_results, frames


def write_ocr_ms_file(results: Sequence[FrameOcrResult], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        for result in results:
            f.write(f"{result.ms if result.ms is not None else 'None'}\n")


def find_frame_index(
    frame_results: Sequence[FrameOcrResult],
    target_ms: int,
    mode: str,
) -> int:
    valid = [(r.frame_index, r.ms) for r in frame_results if r.ms is not None]
    if not valid:
        return 0

    if mode == "at_or_before":
        candidate = [idx for idx, ms in valid if ms <= target_ms]
        return candidate[-1] if candidate else valid[0][0]
    if mode == "at_or_after":
        candidate = [idx for idx, ms in valid if ms >= target_ms]
        return candidate[0] if candidate else valid[-1][0]

    raise ValueError(f"Unsupported mode: {mode}")


def capture_action_screenshots(
    actions: list[dict],
    frame_results: Sequence[FrameOcrResult],
    frames: Sequence,
    screenshots_dir: Path,
) -> list[dict]:
    screenshots_dir.mkdir(parents=True, exist_ok=True)
    updated_actions: list[dict] = []

    for action in actions:
        target_ms = int(round((action.get("timeSinceVideoStartNs") or 0) / 1_000_000))

        before_target = max(target_ms - 300, 0)
        at_target = target_ms
        after_target = target_ms + 800

        before_idx = find_frame_index(frame_results, before_target, mode="at_or_before")
        at_idx = find_frame_index(frame_results, at_target, mode="at_or_before")
        after_idx = find_frame_index(frame_results, after_target, mode="at_or_after")

        action_id = action.get("actionId") or f"step_{action.get('stepNumber', 'unknown')}"
        before_path = screenshots_dir / f"{action_id}_before.png"
        at_path = screenshots_dir / f"{action_id}_at.png"
        after_path = screenshots_dir / f"{action_id}_after.png"

        cv2.imwrite(str(before_path), frames[before_idx])
        cv2.imwrite(str(at_path), frames[at_idx])
        cv2.imwrite(str(after_path), frames[after_idx])

        action_copy = dict(action)
        action_copy["screenshotTimesMs"] = {
            "before": before_target,
            "at": at_target,
            "after": after_target,
        }
        action_copy["screenshots"] = {
            "before": str(before_path),
            "at": str(at_path),
            "after": str(after_path),
        }
        updated_actions.append(action_copy)

    return updated_actions


def determine_crop_rect(actions: Iterable[dict]) -> tuple[int, int, int, int] | None:
    for action in actions:
        rect = action.get("ocrCropRect")
        if rect:
            return (int(rect["left"]), int(rect["top"]), int(rect["width"]), int(rect["height"]))
    return (0, 0, 120, 50)


def process_session(session_dir: Path, min_confidence: float) -> None:
    scriber_dir = session_dir / "01_scriber"
    actions_path = scriber_dir / "actions.json"
    video_path = scriber_dir / "video.webm"

    if not actions_path.exists() or not video_path.exists():
        return

    analytics_dir = session_dir / "02_scriber_analytics"
    screenshots_dir = analytics_dir / "screenshots"

    actions = load_actions(actions_path)
    crop_rect = determine_crop_rect(actions)

    frame_results, frames = run_ocr_on_video(video_path, crop_rect=crop_rect, min_confidence=min_confidence)

    write_ocr_ms_file(frame_results, analytics_dir / "ocr_ms_per_frame.txt")
    updated_actions = capture_action_screenshots(actions, frame_results, frames, screenshots_dir)
    save_actions(updated_actions, analytics_dir / "actions.json")


def is_session_dir(path: Path) -> bool:
    return (path / "01_scriber").is_dir()


def resolve_session_dirs(target_dir: Path) -> list[Path]:
    if is_session_dir(target_dir):
        return [target_dir]

    session_dirs = sorted(
        (p for p in target_dir.iterdir() if p.is_dir() and is_session_dir(p)),
        key=lambda p: p.name,
    )
    if not session_dirs:
        raise RuntimeError(
            f"No session directories found in: {target_dir}. "
            "Expected a session folder with 01_scriber or a parent directory containing sessions."
        )
    return session_dirs


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create analytics outputs and screenshots from Scriber sessions.")
    parser.add_argument(
        "input_dir",
        type=Path,
        nargs="?",
        default=Path("sessions"),
        help=(
            "Path to process. Can be either a single session folder "
            "(containing 01_scriber) or a parent directory containing session folders."
        ),
    )
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=DEFAULT_OCR_CONFIDENCE_THRESHOLD,
        help="Minimum OCR confidence required for frame ms values.",
    )
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    input_dir: Path = args.input_dir
    if not input_dir.exists():
        raise RuntimeError(f"Input directory does not exist: {input_dir}")
    if not input_dir.is_dir():
        raise RuntimeError(f"Input path is not a directory: {input_dir}")

    for session_dir in resolve_session_dirs(input_dir):
        print(f"Session directory: {session_dir.name}")
        process_session(session_dir, min_confidence=args.min_confidence)


if __name__ == "__main__":
    main()

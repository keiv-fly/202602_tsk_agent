from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import cv2
import numpy as np
from tqdm import tqdm


DEFAULT_TEMPLATE_SCORE_THRESHOLD = 0.43
DEFAULT_DIGIT_COUNT = 6
DEFAULT_RECORDER_TS_PATH = (
    Path(__file__).resolve().parents[1] / "scriber" / "src" / "tooling" / "recorder.ts"
)
GLYPH_CANVAS_SIZE = (26, 38)


@dataclass(frozen=True)
class OverlayTemplateStyle:
    digit_count: int = DEFAULT_DIGIT_COUNT
    font_size_px: float = 21.6
    line_height: float = 1.0
    letter_spacing_em: float = 0.06
    font_weight: int = 700


@dataclass(frozen=True)
class FrameOcrResult:
    frame_index: int
    ms: int | None


@dataclass(frozen=True)
class FrameTemplateMatch:
    value: int | None
    score: float


def load_actions(actions_path: Path) -> list[dict]:
    with actions_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_actions(actions: list[dict], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(actions, f, indent=2)
        f.write("\n")


def _parse_css_number(value: str, unit: str | None = None) -> float | None:
    value = value.strip()
    if unit is not None and not value.endswith(unit):
        return None
    if unit is not None:
        value = value[: -len(unit)]
    try:
        return float(value)
    except ValueError:
        return None


def load_overlay_template_style(
    recorder_ts_path: Path = DEFAULT_RECORDER_TS_PATH,
) -> OverlayTemplateStyle:
    if not recorder_ts_path.exists():
        return OverlayTemplateStyle()

    source = recorder_ts_path.read_text(encoding="utf-8")
    matches = re.findall(r"frameOverlay\.style\.(\w+)\s*=\s*'([^']+)';", source)
    if not matches:
        return OverlayTemplateStyle()

    style_values = {key: value for key, value in matches}

    width_ch = _parse_css_number(style_values.get("width", ""), "ch")
    font_size_px = _parse_css_number(style_values.get("fontSize", ""), "px")
    line_height = _parse_css_number(style_values.get("lineHeight", ""))
    letter_spacing_em = _parse_css_number(style_values.get("letterSpacing", ""), "em")

    font_weight_raw = style_values.get("fontWeight", "")
    try:
        font_weight = int(float(font_weight_raw))
    except ValueError:
        font_weight = OverlayTemplateStyle.font_weight

    return OverlayTemplateStyle(
        digit_count=int(width_ch) if width_ch is not None and width_ch >= 1 else DEFAULT_DIGIT_COUNT,
        font_size_px=font_size_px
        if font_size_px is not None and font_size_px > 0
        else OverlayTemplateStyle.font_size_px,
        line_height=line_height if line_height is not None and line_height > 0 else OverlayTemplateStyle.line_height,
        letter_spacing_em=letter_spacing_em
        if letter_spacing_em is not None and letter_spacing_em >= 0
        else OverlayTemplateStyle.letter_spacing_em,
        font_weight=font_weight if font_weight > 0 else OverlayTemplateStyle.font_weight,
    )


def _estimate_font_scale(crop_width: int, crop_height: int, style: OverlayTemplateStyle) -> float:
    font = cv2.FONT_HERSHEY_DUPLEX
    thickness = 2 if style.font_weight >= 700 else 1
    base_size, _ = cv2.getTextSize("0", font, 1.0, thickness)
    base_width, base_height = max(1, base_size[0]), max(1, base_size[1])

    est_dpr = crop_height / max(1.0, style.font_size_px * style.line_height)
    target_spacing = style.letter_spacing_em * style.font_size_px * est_dpr
    target_char_width = max(
        5.0,
        (crop_width - max(0.0, target_spacing) * (style.digit_count - 1)) / style.digit_count,
    )
    target_char_height = max(8.0, style.font_size_px * est_dpr)
    width_scale = target_char_width / base_width
    height_scale = target_char_height / base_height
    return float(max(0.2, min(width_scale, height_scale)))


def _render_digit_template(
    digit: str,
    cell_width: int,
    cell_height: int,
    font_scale: float,
    font_weight: int,
) -> np.ndarray:
    canvas = np.zeros((cell_height, cell_width), dtype=np.uint8)
    font = cv2.FONT_HERSHEY_DUPLEX
    thickness = 2 if font_weight >= 700 else 1
    (text_width, text_height), baseline = cv2.getTextSize(digit, font, font_scale, thickness)
    x = max(0, (cell_width - text_width) // 2)
    y = max(text_height, (cell_height + text_height) // 2 - baseline // 2)
    cv2.putText(
        canvas,
        digit,
        (x, y),
        font,
        font_scale,
        255,
        thickness,
        cv2.LINE_AA,
    )
    _, binary = cv2.threshold(canvas, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    return binary


def _extract_centered_glyph(binary_image: np.ndarray) -> np.ndarray:
    points = cv2.findNonZero(binary_image)
    if points is None:
        return np.zeros((GLYPH_CANVAS_SIZE[1], GLYPH_CANVAS_SIZE[0]), dtype=np.uint8)
    x, y, width, height = cv2.boundingRect(points)
    glyph = binary_image[y : y + height, x : x + width]
    side = max(width, height)
    square = np.zeros((side, side), dtype=np.uint8)
    x_offset = (side - width) // 2
    y_offset = (side - height) // 2
    square[y_offset : y_offset + height, x_offset : x_offset + width] = glyph
    return cv2.resize(square, GLYPH_CANVAS_SIZE, interpolation=cv2.INTER_NEAREST)


def build_digit_templates(crop_rect: tuple[int, int, int, int], style: OverlayTemplateStyle) -> dict[str, np.ndarray]:
    _, _, crop_width, crop_height = crop_rect
    cell_width = max(5, int(round(crop_width / max(1, style.digit_count))))
    cell_height = max(8, crop_height)
    scale = _estimate_font_scale(crop_width, crop_height, style)
    templates: dict[str, np.ndarray] = {}
    for digit in "0123456789":
        template = _render_digit_template(
            digit=digit,
            cell_width=cell_width,
            cell_height=cell_height,
            font_scale=scale,
            font_weight=style.font_weight,
        )
        templates[digit] = _extract_centered_glyph(template)
    return templates


def _crop_frame(frame, crop_rect: tuple[int, int, int, int] | None):
    if crop_rect is None:
        return frame
    left, top, width, height = crop_rect
    return frame[top : top + height, left : left + width]


def match_overlay_digits(
    roi,
    templates: dict[str, np.ndarray],
    digit_count: int,
    min_score: float,
) -> FrameTemplateMatch:
    if roi is None or roi.size == 0:
        return FrameTemplateMatch(value=None, score=0.0)

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY) if roi.ndim == 3 else roi.copy()
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)

    width = binary.shape[1]
    boundaries = np.linspace(0, width, digit_count + 1, dtype=np.int32)

    predicted_digits: list[str] = []
    scores: list[float] = []

    for i in range(digit_count):
        left = int(boundaries[i])
        right = int(boundaries[i + 1])
        if right <= left:
            return FrameTemplateMatch(value=None, score=0.0)
        cell = binary[:, left:right]
        glyph = _extract_centered_glyph(cell)
        best_digit = "0"
        best_score = -1.0
        for digit, template in templates.items():
            score = float(cv2.matchTemplate(glyph, template, cv2.TM_CCOEFF_NORMED)[0, 0])
            if score > best_score:
                best_score = score
                best_digit = digit
        predicted_digits.append(best_digit)
        scores.append(best_score)

    average_score = float(sum(scores) / len(scores)) if scores else 0.0
    if average_score < min_score:
        return FrameTemplateMatch(value=None, score=average_score)

    return FrameTemplateMatch(value=int("".join(predicted_digits)), score=average_score)


def run_template_matching_on_video(
    video_path: Path,
    crop_rect: tuple[int, int, int, int] | None,
    style: OverlayTemplateStyle,
    min_score: float = DEFAULT_TEMPLATE_SCORE_THRESHOLD,
) -> tuple[list[FrameOcrResult], list]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Unable to open video: {video_path}")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames < 0:
        total_frames = 0

    frame_results: list[FrameOcrResult] = []
    frames: list = []
    templates: dict[str, np.ndarray] | None = (
        build_digit_templates(crop_rect, style) if crop_rect is not None else None
    )

    for frame_index in tqdm(range(total_frames), desc=f"Template match {video_path.name}"):
        ok, frame = cap.read()
        if not ok:
            break

        roi = _crop_frame(frame, crop_rect)
        match = (
            match_overlay_digits(
                roi,
                templates=templates,
                digit_count=style.digit_count,
                min_score=min_score,
            )
            if templates is not None
            else FrameTemplateMatch(value=None, score=0.0)
        )
        ms = match.value
        if ms is None:
            cap_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            if np.isfinite(cap_ms):
                ms = max(0, int(round(float(cap_ms))))
        frame_results.append(FrameOcrResult(frame_index=frame_index, ms=ms))
        frames.append(frame)

    cap.release()
    return frame_results, frames


def write_frame_ms_file(results: Sequence[FrameOcrResult], output_path: Path) -> None:
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


def process_session(
    session_dir: Path,
    min_template_score: float,
    recorder_ts_path: Path = DEFAULT_RECORDER_TS_PATH,
) -> None:
    scriber_dir = session_dir / "01_scriber"
    actions_path = scriber_dir / "actions.json"
    video_path = scriber_dir / "video.webm"

    if not actions_path.exists() or not video_path.exists():
        return

    analytics_dir = session_dir / "02_scriber_analytics"
    screenshots_dir = analytics_dir / "screenshots"

    actions = load_actions(actions_path)
    crop_rect = determine_crop_rect(actions)
    style = load_overlay_template_style(recorder_ts_path)

    frame_results, frames = run_template_matching_on_video(
        video_path,
        crop_rect=crop_rect,
        style=style,
        min_score=min_template_score,
    )

    write_frame_ms_file(frame_results, analytics_dir / "ocr_ms_per_frame.txt")
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
        "--min-template-score",
        type=float,
        default=DEFAULT_TEMPLATE_SCORE_THRESHOLD,
        help="Minimum average template matching score required for frame ms values.",
    )
    parser.add_argument(
        "--recorder-ts-path",
        type=Path,
        default=DEFAULT_RECORDER_TS_PATH,
        help="Path to scriber/src/tooling/recorder.ts used to derive overlay style templates.",
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
        process_session(
            session_dir,
            min_template_score=args.min_template_score,
            recorder_ts_path=args.recorder_ts_path,
        )


if __name__ == "__main__":
    main()

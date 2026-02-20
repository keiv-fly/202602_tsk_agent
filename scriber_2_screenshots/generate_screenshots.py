from __future__ import annotations

import argparse
import csv
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
PER_DIGIT_METRIC_COLUMNS = tuple(f"digit_{idx}_match" for idx in range(1, DEFAULT_DIGIT_COUNT + 1))
ENCODED_GRID_SIZE = 5
ENCODED_DATA_BITS = 20
ENCODED_CRC_BITS = 5
ENCODED_TOTAL_BITS = ENCODED_DATA_BITS + ENCODED_CRC_BITS


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
    digit_match_metrics: tuple[float | None, ...] = ()


@dataclass(frozen=True)
class FrameTemplateMatch:
    value: int | None
    score: float
    digit_metrics: tuple[float | None, ...] = ()


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


def _crop_frame(frame, crop_rect: tuple[int, int, int, int] | None):
    if crop_rect is None:
        return frame
    left, top, width, height = crop_rect
    return frame[top : top + height, left : left + width]


def _normalize_similarity_metric(score: float) -> float:
    if not np.isfinite(score):
        return 0.0
    return float(max(0.0, min(1.0, score)))


def _normalize_binary_digit_image(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image.copy()
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    return binary


def _add_black_border(image: np.ndarray) -> np.ndarray:
    return cv2.copyMakeBorder(
        image,
        top=1,
        bottom=1,
        left=1,
        right=1,
        borderType=cv2.BORDER_CONSTANT,
        value=0,
    )


def _resize_to_shape(image: np.ndarray, target_shape: tuple[int, int]) -> np.ndarray:
    target_height, target_width = target_shape
    if target_height <= 0 or target_width <= 0:
        return image
    return cv2.resize(image, (target_width, target_height), interpolation=cv2.INTER_NEAREST)


def _compute_digit_similarity(candidate: np.ndarray, template: np.ndarray) -> float:
    normalized_candidate = _normalize_binary_digit_image(candidate)
    normalized_template = _normalize_binary_digit_image(template)
    resized_candidate = _resize_to_shape(normalized_candidate, normalized_template.shape[:2])
    abs_diff = cv2.absdiff(resized_candidate, normalized_template)
    similarity = 1.0 - (float(np.mean(abs_diff)) / 255.0)
    return _normalize_similarity_metric(similarity)


def load_digit_templates(template_dir: Path) -> dict[str, np.ndarray]:
    templates: dict[str, np.ndarray] = {}
    for digit in range(10):
        template_path = template_dir / f"{digit}.png"
        if not template_path.exists():
            continue
        template_image = cv2.imread(str(template_path), cv2.IMREAD_GRAYSCALE)
        if template_image is None or template_image.size == 0:
            continue
        templates[str(digit)] = _normalize_binary_digit_image(template_image)
    return templates


def parse_overlay_digits(input_text: str | None, max_digits: int = DEFAULT_DIGIT_COUNT) -> int | None:
    if not input_text:
        return None
    normalized = re.sub(r"\s+", "", input_text)
    match = re.search(r"\d+", normalized)
    if match is None:
        return None
    digits = match.group(0)
    if len(digits) > max(1, max_digits):
        return None
    parsed = int(digits)
    if parsed < 0 or parsed > 999_999:
        return None
    return parsed


def _pad_digit_metrics(
    metrics: Sequence[float | None],
    digit_count: int,
) -> tuple[float | None, ...]:
    padded = list(metrics[: max(0, digit_count)])
    while len(padded) < digit_count:
        padded.append(None)
    return tuple(padded)


def _average_digit_metric(metrics: Sequence[float | None]) -> float:
    present_metrics = [metric for metric in metrics if metric is not None]
    if not present_metrics:
        return 0.0
    return _normalize_similarity_metric(float(sum(present_metrics) / len(present_metrics)))


def _best_digit_match(
    digit_image: np.ndarray,
    templates: dict[str, np.ndarray],
) -> tuple[str | None, float]:
    best_digit: str | None = None
    best_similarity = 0.0
    for template_digit, template_image in templates.items():
        similarity = _compute_digit_similarity(digit_image, template_image)
        if similarity >= best_similarity:
            best_similarity = similarity
            best_digit = template_digit
    return best_digit, best_similarity


def match_overlay_digits(
    roi,
    templates: dict[str, np.ndarray],
    digit_count: int,
    min_score: float,
) -> FrameTemplateMatch:
    if roi is None or roi.size == 0:
        return FrameTemplateMatch(value=None, score=0.0, digit_metrics=_pad_digit_metrics([], digit_count))
    if not templates:
        return FrameTemplateMatch(value=None, score=0.0, digit_metrics=_pad_digit_metrics([], digit_count))

    otsu_binary = _build_otsu_binary(roi)
    digit_crops = _extract_digit_crops(roi, otsu_binary)[:digit_count]
    matched_digits: list[str] = []
    digit_metrics: list[float | None] = []

    for crop in digit_crops:
        bordered_digit = _add_black_border(_normalize_binary_digit_image(crop))
        digit, similarity = _best_digit_match(bordered_digit, templates)
        if digit is None:
            digit_metrics.append(None)
            continue
        matched_digits.append(digit)
        digit_metrics.append(_normalize_similarity_metric(similarity))

    padded_metrics = _pad_digit_metrics(digit_metrics, digit_count)
    aggregate_score = _average_digit_metric(padded_metrics)
    value = parse_overlay_digits("".join(matched_digits), max_digits=digit_count)

    if len(matched_digits) != digit_count:
        value = None
    if aggregate_score < min_score:
        value = None

    return FrameTemplateMatch(value=value, score=aggregate_score, digit_metrics=padded_metrics)


def _crc32(bytes_seq: Sequence[int]) -> int:
    crc = 0xFFFFFFFF
    for byte in bytes_seq:
        crc ^= int(byte) & 0xFF
        for _ in range(8):
            mask = -(crc & 1)
            crc = (crc >> 1) ^ (0xEDB88320 & mask)
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF


def decode_encoded_overlay_ms(roi: np.ndarray) -> tuple[int | None, tuple[float | None, ...]]:
    if roi is None or roi.size == 0:
        return None, ()

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY) if roi.ndim == 3 else roi
    height, width = gray.shape[:2]
    if height < ENCODED_GRID_SIZE or width < ENCODED_GRID_SIZE:
        return None, ()

    bit_values: list[int] = []
    metrics: list[float] = []
    for row in range(ENCODED_GRID_SIZE):
        start_y = int(round(row * height / ENCODED_GRID_SIZE))
        end_y = int(round((row + 1) * height / ENCODED_GRID_SIZE))
        for col in range(ENCODED_GRID_SIZE):
            start_x = int(round(col * width / ENCODED_GRID_SIZE))
            end_x = int(round((col + 1) * width / ENCODED_GRID_SIZE))
            cell = gray[start_y:end_y, start_x:end_x]
            if cell.size == 0:
                metrics.append(0.0)
                bit_values.append(0)
                continue
            darkness = 1.0 - (float(np.mean(cell)) / 255.0)
            normalized_darkness = _normalize_similarity_metric(darkness)
            metrics.append(normalized_darkness)
            bit_values.append(1 if normalized_darkness >= 0.5 else 0)

    if len(bit_values) < ENCODED_TOTAL_BITS:
        return None, tuple(metrics)

    payload = 0
    for bit in bit_values[:ENCODED_TOTAL_BITS]:
        payload = (payload << 1) | bit

    received_crc = payload & ((1 << ENCODED_CRC_BITS) - 1)
    elapsed_ms = payload >> ENCODED_CRC_BITS
    if elapsed_ms < 0 or elapsed_ms > ((1 << ENCODED_DATA_BITS) - 1):
        return None, tuple(metrics)

    data_bytes = [
        (elapsed_ms >> 16) & 0xFF,
        (elapsed_ms >> 8) & 0xFF,
        elapsed_ms & 0xFF,
    ]
    expected_crc = _crc32(data_bytes) & ((1 << ENCODED_CRC_BITS) - 1)
    if received_crc != expected_crc:
        return None, tuple(metrics)

    return elapsed_ms, tuple(metrics)


def run_template_matching_on_video(
    video_path: Path,
    crop_rect: tuple[int, int, int, int] | None,
    style: OverlayTemplateStyle,
    min_score: float = DEFAULT_TEMPLATE_SCORE_THRESHOLD,
) -> tuple[list[FrameOcrResult], list, float]:
    del style
    del min_score
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Unable to open video: {video_path}")

    frame_rate_fps = float(cap.get(cv2.CAP_PROP_FPS))
    if not np.isfinite(frame_rate_fps) or frame_rate_fps <= 0:
        frame_rate_fps = 0.0

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames < 0:
        total_frames = 0

    frame_results: list[FrameOcrResult] = []
    frames: list = []

    for frame_index in tqdm(range(total_frames), desc=f"Bit decode {video_path.name}"):
        ok, frame = cap.read()
        if not ok:
            break

        roi = _crop_frame(frame, crop_rect)
        ms, metrics = decode_encoded_overlay_ms(roi)
        frame_results.append(
            FrameOcrResult(
                frame_index=frame_index,
                ms=ms,
                digit_match_metrics=metrics,
            )
        )
        frames.append(frame)

    cap.release()
    return frame_results, frames, frame_rate_fps


def write_frame_ms_file(results: Sequence[FrameOcrResult], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        for result in results:
            f.write(f"{result.ms if result.ms is not None else 'None'}\n")


def write_frame_ms_table_file(results: Sequence[FrameOcrResult], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["id", "ocr_ms", *PER_DIGIT_METRIC_COLUMNS])
        for result in results:
            metrics = _pad_digit_metrics(result.digit_match_metrics, DEFAULT_DIGIT_COUNT)
            metric_cells = [f"{metric:.6f}" if metric is not None else "" for metric in metrics]
            writer.writerow(
                [result.frame_index, result.ms if result.ms is not None else "None", *metric_cells]
            )


def write_number_check_outputs(
    frame_results: Sequence[FrameOcrResult],
    frames: Sequence,
    crop_rect: tuple[int, int, int, int] | None,
    output_dir: Path,
    frame_rate_fps: float,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    table_path = output_dir / "screenshot_number_table.csv"
    for stale_image in output_dir.glob("second_*.png"):
        stale_image.unlink()

    available_count = min(len(frame_results), len(frames))
    if available_count <= 0:
        with table_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["screenshot_name", "id", "ocr_ms", *PER_DIGIT_METRIC_COLUMNS])
        return

    if frame_rate_fps > 0:
        max_second = int((available_count - 1) / frame_rate_fps)
        second_frame_indices = [
            max(0, min(int(round(second * frame_rate_fps)), available_count - 1))
            for second in range(max_second + 1)
        ]
    else:
        # Fall back to 1 FPS-equivalent indexing when the container reports no FPS.
        second_frame_indices = list(range(available_count))

    with table_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["screenshot_name", "id", "ocr_ms", *PER_DIGIT_METRIC_COLUMNS])

        for second, frame_idx in enumerate(second_frame_indices):
            frame = frames[frame_idx]
            cropped = _crop_frame(frame, crop_rect)

            screenshot_name = f"second_{second:06d}.png"
            screenshot_path = output_dir / screenshot_name
            cv2.imwrite(str(screenshot_path), cropped)

            selected_result = frame_results[frame_idx]
            metrics = _pad_digit_metrics(selected_result.digit_match_metrics, DEFAULT_DIGIT_COUNT)
            metric_cells = [f"{metric:.6f}" if metric is not None else "" for metric in metrics]
            writer.writerow(
                [
                    screenshot_name,
                    selected_result.frame_index,
                    selected_result.ms if selected_result.ms is not None else "None",
                    *metric_cells,
                ]
            )


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


def _normalize_crop_rect(rect: dict | None) -> tuple[int, int, int, int] | None:
    if not rect:
        return None
    try:
        left = int(rect["left"])
        top = int(rect["top"])
        width = int(rect["width"])
        height = int(rect["height"])
    except (KeyError, TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return (left, top, width, height)


def determine_crop_rect(actions: Iterable[dict]) -> tuple[int, int, int, int] | None:
    for action in actions:
        rect = _normalize_crop_rect(action.get("encodedOcrCropRect"))
        if rect:
            return rect
    for action in actions:
        rect = _normalize_crop_rect(action.get("ocrCropRect"))
        if rect:
            return rect
    return (0, 0, 120, 50)


def determine_secondary_ocr_capture(
    actions: Iterable[dict],
    overlay_settle_delay_ms: int = 500,
) -> tuple[tuple[int, int, int, int], int] | None:
    for action in actions:
        crop_rect = _normalize_crop_rect(action.get("secondaryOcrCropRect"))
        if crop_rect is None:
            continue
        action_time_ns = action.get("timeSinceVideoStartNs") or 0
        try:
            action_time_ms = int(round(float(action_time_ns) / 1_000_000))
        except (TypeError, ValueError):
            action_time_ms = 0
        target_ms = max(0, action_time_ms + max(0, int(overlay_settle_delay_ms)))
        return (crop_rect, target_ms)
    return None


def _clear_digit_output_files(directory: Path) -> None:
    for digit in range(10):
        digit_path = directory / f"{digit}.png"
        if digit_path.exists():
            digit_path.unlink()
    for legacy_digit_path in directory.glob("digit_*.png"):
        legacy_digit_path.unlink()


def _find_non_black_ranges(non_black_mask: np.ndarray) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    if non_black_mask.size == 0:
        return ranges

    start_idx: int | None = 0 if bool(non_black_mask[0]) else None
    for idx in range(1, int(non_black_mask.size)):
        if start_idx is None and bool(non_black_mask[idx]):
            start_idx = idx
            continue
        if start_idx is not None and not bool(non_black_mask[idx]):
            ranges.append((start_idx, idx))
            start_idx = None

    if start_idx is not None:
        ranges.append((start_idx, int(non_black_mask.size)))
    return ranges


def _build_otsu_binary(cropped_overlay: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(cropped_overlay, cv2.COLOR_BGR2GRAY) if cropped_overlay.ndim == 3 else cropped_overlay
    _, otsu_binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    return otsu_binary


def _extract_digit_crops(cropped_overlay: np.ndarray, otsu_binary: np.ndarray) -> list[np.ndarray]:
    column_max = otsu_binary.max(axis=0)
    non_black_columns = column_max > 0
    column_ranges = _find_non_black_ranges(non_black_columns)

    digit_crops: list[np.ndarray] = []
    for start_col, end_col in column_ranges:
        digit_crop = cropped_overlay[:, start_col:end_col]
        if digit_crop.size == 0:
            continue

        digit_binary = otsu_binary[:, start_col:end_col]
        row_max = digit_binary.max(axis=1)
        non_black_rows = np.flatnonzero(row_max > 0)
        if non_black_rows.size == 0:
            continue

        top = int(non_black_rows[0])
        bottom = int(non_black_rows[-1]) + 1
        digit_crops.append(digit_crop[top:bottom, :])

    return digit_crops


def _write_digit_crops(
    digit_crops: Sequence[np.ndarray],
    output_dir: Path,
    padded_output_dir: Path,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    padded_output_dir.mkdir(parents=True, exist_ok=True)
    _clear_digit_output_files(output_dir)
    _clear_digit_output_files(padded_output_dir)

    for digit, crop in enumerate(digit_crops[:10]):
        output_path = output_dir / f"{digit}.png"
        cv2.imwrite(str(output_path), crop)

        border_value = 0 if crop.ndim == 2 else (0, 0, 0)
        padded_crop = cv2.copyMakeBorder(
            crop,
            top=1,
            bottom=1,
            left=1,
            right=1,
            borderType=cv2.BORDER_CONSTANT,
            value=border_value,
        )
        padded_path = padded_output_dir / f"{digit}.png"
        cv2.imwrite(str(padded_path), padded_crop)


def _read_video_frame_at_ms(video_path: Path, target_ms: int) -> np.ndarray | None:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return None

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    safe_total_frames = max(total_frames, 1)
    if fps > 0:
        requested_idx = int(round((max(0, target_ms) / 1000.0) * fps))
    else:
        requested_idx = 0
    requested_idx = max(0, min(requested_idx, safe_total_frames - 1))

    cap.set(cv2.CAP_PROP_POS_FRAMES, requested_idx)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        return None
    return frame


def write_secondary_ocr_digits_image(
    actions: Iterable[dict],
    video_path: Path,
    output_path: Path,
    overlay_settle_delay_ms: int = 500,
) -> None:
    digits_dir = output_path.parent
    padded_digits_dir = digits_dir.with_name("ocr_digits_2")
    otsu_output_path = digits_dir / "ocr_digits_otsu.png"

    selection = determine_secondary_ocr_capture(
        actions,
        overlay_settle_delay_ms=overlay_settle_delay_ms,
    )
    if selection is None:
        if output_path.exists():
            output_path.unlink()
        if otsu_output_path.exists():
            otsu_output_path.unlink()
        _clear_digit_output_files(digits_dir)
        _clear_digit_output_files(padded_digits_dir)
        return

    crop_rect, target_ms = selection
    frame = _read_video_frame_at_ms(video_path, target_ms)
    if frame is None or frame.size == 0:
        return
    cropped = _crop_frame(frame, crop_rect)
    if cropped is None or cropped.size == 0:
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), cropped)
    otsu_binary = _build_otsu_binary(cropped)
    cv2.imwrite(str(otsu_output_path), otsu_binary)
    digit_crops = _extract_digit_crops(cropped, otsu_binary)
    _write_digit_crops(digit_crops, output_dir=digits_dir, padded_output_dir=padded_digits_dir)


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
    write_secondary_ocr_digits_image(
        actions=actions,
        video_path=video_path,
        output_path=analytics_dir / "ocr_digits" / "ocr_digits.png",
        overlay_settle_delay_ms=500,
    )

    frame_results, frames, frame_rate_fps = run_template_matching_on_video(
        video_path,
        crop_rect=crop_rect,
        style=style,
        min_score=min_template_score,
    )

    write_frame_ms_file(frame_results, analytics_dir / "ocr_ms_per_frame.txt")
    write_frame_ms_table_file(frame_results, analytics_dir / "ocr_ms_per_frame_table.csv")
    write_number_check_outputs(
        frame_results=frame_results,
        frames=frames,
        crop_rect=crop_rect,
        output_dir=analytics_dir / "check_number_ocr",
        frame_rate_fps=frame_rate_fps,
    )
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
        help="Minimum average per-digit similarity required for frame ms values.",
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

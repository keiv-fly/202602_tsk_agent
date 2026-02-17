from pathlib import Path

import cv2
import numpy as np

from scriber_2_screenshots.generate_screenshots import (
    FrameOcrResult,
    OverlayTemplateStyle,
    _estimate_font_scale,
    _render_digit_template,
    build_digit_templates,
    capture_action_screenshots,
    determine_crop_rect,
    find_frame_index,
    load_overlay_template_style,
    match_overlay_digits,
    parse_args,
    process_session,
    resolve_session_dirs,
)


def test_load_overlay_template_style_parses_recorder_css_values(tmp_path: Path) -> None:
    recorder_ts = tmp_path / "recorder.ts"
    recorder_ts.write_text(
        "\n".join(
            [
                "frameOverlay.style.width = '7ch';",
                "frameOverlay.style.fontSize = '20px';",
                "frameOverlay.style.lineHeight = '1.2';",
                "frameOverlay.style.letterSpacing = '0.08em';",
                "frameOverlay.style.fontWeight = '600';",
            ]
        ),
        encoding="utf-8",
    )

    style = load_overlay_template_style(recorder_ts)

    assert style == OverlayTemplateStyle(
        digit_count=7,
        font_size_px=20,
        line_height=1.2,
        letter_spacing_em=0.08,
        font_weight=600,
    )


def test_match_overlay_digits_reads_synthetic_roi() -> None:
    style = OverlayTemplateStyle(digit_count=6)
    crop_rect = (0, 0, 120, 48)
    templates = build_digit_templates(crop_rect, style)
    height = crop_rect[3]
    width = crop_rect[2]
    boundaries = np.linspace(0, width, style.digit_count + 1, dtype=np.int32)
    expected_text = "012345"
    font_scale = _estimate_font_scale(crop_rect[2], crop_rect[3], style)

    gray = np.zeros((height, width), dtype=np.uint8)
    for i, digit in enumerate(expected_text):
        left = int(boundaries[i])
        right = int(boundaries[i + 1])
        cell = gray[:, left:right]
        rendered = _render_digit_template(
            digit=digit,
            cell_width=max(1, right - left),
            cell_height=height,
            font_scale=font_scale,
            font_weight=style.font_weight,
        )
        cell[:, :] = rendered

    roi = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    result = match_overlay_digits(roi, templates=templates, digit_count=style.digit_count, min_score=0.1)

    assert result.value == int(expected_text)


def test_find_frame_index_before_and_after_modes() -> None:
    results = [
        FrameOcrResult(frame_index=0, ms=100),
        FrameOcrResult(frame_index=1, ms=250),
        FrameOcrResult(frame_index=2, ms=None),
        FrameOcrResult(frame_index=3, ms=900),
    ]

    assert find_frame_index(results, 275, mode="at_or_before") == 1
    assert find_frame_index(results, 875, mode="at_or_after") == 3


def test_capture_action_screenshots_writes_three_images(tmp_path: Path, monkeypatch) -> None:
    actions = [{"actionId": "a1", "timeSinceVideoStartNs": 500_000_000}]
    results = [
        FrameOcrResult(frame_index=0, ms=0),
        FrameOcrResult(frame_index=1, ms=200),
        FrameOcrResult(frame_index=2, ms=500),
        FrameOcrResult(frame_index=3, ms=1300),
    ]
    frames = ["f0", "f1", "f2", "f3"]

    def fake_imwrite(path: str, frame) -> bool:
        Path(path).write_text(str(frame), encoding="utf-8")
        return True

    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.cv2.imwrite", fake_imwrite)

    updated = capture_action_screenshots(actions, results, frames, tmp_path)

    assert (tmp_path / "a1_before.png").exists()
    assert (tmp_path / "a1_at.png").exists()
    assert (tmp_path / "a1_after.png").exists()
    assert updated[0]["screenshotTimesMs"] == {"before": 200, "at": 500, "after": 1300}


def test_determine_crop_rect_uses_action_ocr_crop_rect() -> None:
    actions = [{"ocrCropRect": {"left": 1, "top": 2, "width": 3, "height": 4}}]
    assert determine_crop_rect(actions) == (1, 2, 3, 4)


def test_process_session_creates_analytics_files(tmp_path: Path, monkeypatch) -> None:
    session_dir = tmp_path / "sessions" / "example"
    scriber_dir = session_dir / "01_scriber"
    scriber_dir.mkdir(parents=True)

    (scriber_dir / "actions.json").write_text(
        '[{"actionId":"x","timeSinceVideoStartNs":1000000000}]', encoding="utf-8"
    )
    (scriber_dir / "video.webm").write_text("placeholder", encoding="utf-8")

    fake_results = [FrameOcrResult(frame_index=0, ms=1000)]
    fake_frames = ["frame"]

    def fake_run_template_matching_on_video(video_path, crop_rect, style, min_score):
        return fake_results, fake_frames

    def fake_imwrite(path: str, frame) -> bool:
        Path(path).write_text(str(frame), encoding="utf-8")
        return True

    monkeypatch.setattr(
        "scriber_2_screenshots.generate_screenshots.run_template_matching_on_video",
        fake_run_template_matching_on_video,
    )
    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.cv2.imwrite", fake_imwrite)

    process_session(session_dir, min_template_score=0.2)

    analytics = session_dir / "02_scriber_analytics"
    assert (analytics / "actions.json").exists()
    assert (analytics / "ocr_ms_per_frame.txt").read_text(encoding="utf-8").strip() == "1000"
    assert (analytics / "screenshots" / "x_before.png").exists()


def test_parse_args_defaults_to_sessions_dir() -> None:
    args = parse_args([])
    assert args.input_dir == Path("sessions")


def test_parse_args_accepts_input_dir_positional() -> None:
    args = parse_args(["my_sessions"])
    assert args.input_dir == Path("my_sessions")
    assert args.min_template_score == 0.43


def test_resolve_session_dirs_returns_single_session_if_input_is_session(tmp_path: Path) -> None:
    session_dir = tmp_path / "20260216_a"
    (session_dir / "01_scriber").mkdir(parents=True)

    selected = resolve_session_dirs(session_dir)
    assert selected == [session_dir]


def test_resolve_session_dirs_returns_all_sessions_inside_parent(tmp_path: Path) -> None:
    sessions_dir = tmp_path / "sessions"
    (sessions_dir / "20260216_a" / "01_scriber").mkdir(parents=True)
    (sessions_dir / "20260216_b" / "01_scriber").mkdir(parents=True)

    selected = resolve_session_dirs(sessions_dir)
    assert selected == [sessions_dir / "20260216_a", sessions_dir / "20260216_b"]

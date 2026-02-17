from pathlib import Path

import numpy as np

from scriber_2_screenshots.generate_screenshots import (
    FrameOcrResult,
    OverlayTemplateStyle,
    capture_action_screenshots,
    determine_secondary_ocr_capture,
    determine_crop_rect,
    find_frame_index,
    load_overlay_template_style,
    match_overlay_digits,
    parse_overlay_digits,
    parse_args,
    process_session,
    resolve_session_dirs,
    write_secondary_ocr_digits_image,
    write_number_check_outputs,
    write_frame_ms_table_file,
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


def test_parse_overlay_digits_allows_up_to_default_digit_count() -> None:
    assert parse_overlay_digits("  012345  ") == 12345
    assert parse_overlay_digits("1234567") is None


def test_match_overlay_digits_reads_tesseract_result(monkeypatch) -> None:
    class FakeOutput:
        DICT = "DICT"

    class FakePytesseract:
        Output = FakeOutput

        @staticmethod
        def image_to_data(image, config, output_type):
            assert "--psm 7" in config
            return {"text": ["012345"], "conf": ["94"]}

    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.pytesseract", FakePytesseract)

    roi = np.zeros((16, 64, 3), dtype=np.uint8)
    result = match_overlay_digits(roi, templates={}, digit_count=6, min_score=0.1)
    assert result.value == 12345
    assert result.score == 0.94


def test_match_overlay_digits_respects_min_confidence_threshold(monkeypatch) -> None:
    class FakeOutput:
        DICT = "DICT"

    class FakePytesseract:
        Output = FakeOutput

        @staticmethod
        def image_to_data(image, config, output_type):
            return {"text": ["999"], "conf": ["12"]}

    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.pytesseract", FakePytesseract)

    roi = np.zeros((12, 32, 3), dtype=np.uint8)
    result = match_overlay_digits(roi, templates={}, digit_count=6, min_score=0.2)
    assert result.value is None
    assert result.score == 0.12


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


def test_write_frame_ms_table_file_writes_ms_and_probability(tmp_path: Path) -> None:
    output_path = tmp_path / "ocr_ms_per_frame_table.csv"
    write_frame_ms_table_file(
        [
            FrameOcrResult(frame_index=0, ms=100, match_probability=0.81234),
            FrameOcrResult(frame_index=1, ms=None, match_probability=0.0),
        ],
        output_path,
    )

    content = output_path.read_text(encoding="utf-8")
    assert "id,ocr_ms,match_probability" in content
    assert "0,100,0.812340" in content
    assert "1,None,0.000000" in content


def test_write_number_check_outputs_writes_crops_and_table(tmp_path: Path, monkeypatch) -> None:
    frame_results = [
        FrameOcrResult(frame_index=0, ms=0),
        FrameOcrResult(frame_index=1, ms=900),
        FrameOcrResult(frame_index=2, ms=1400),
        FrameOcrResult(frame_index=3, ms=2200),
    ]
    frames = [np.zeros((10, 20, 3), dtype=np.uint8) for _ in range(4)]

    def fake_imwrite(path: str, frame) -> bool:
        Path(path).write_text(f"{frame.shape[1]}x{frame.shape[0]}", encoding="utf-8")
        return True

    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.cv2.imwrite", fake_imwrite)

    write_number_check_outputs(
        frame_results=frame_results,
        frames=frames,
        crop_rect=(2, 3, 6, 4),
        output_dir=tmp_path,
    )

    assert (tmp_path / "second_000000.png").exists()
    assert (tmp_path / "second_000001.png").exists()
    assert (tmp_path / "second_000002.png").exists()

    table_content = (tmp_path / "screenshot_number_table.csv").read_text(encoding="utf-8")
    assert "screenshot_name,id,ocr_ms" in table_content
    assert "second_000000.png,0,0" in table_content
    assert "second_000001.png,1,900" in table_content
    assert "second_000002.png,2,1400" in table_content


def test_write_number_check_outputs_uses_last_frame_ms_and_cleans_stale_images(
    tmp_path: Path, monkeypatch
) -> None:
    frame_results = [
        FrameOcrResult(frame_index=0, ms=0),
        FrameOcrResult(frame_index=1, ms=999_999),
        FrameOcrResult(frame_index=2, ms=2_000),
    ]
    frames = [np.zeros((10, 20, 3), dtype=np.uint8) for _ in range(3)]
    stale_image = tmp_path / "second_999999.png"
    stale_image.write_text("stale", encoding="utf-8")

    def fake_imwrite(path: str, frame) -> bool:
        Path(path).write_text(f"{frame.shape[1]}x{frame.shape[0]}", encoding="utf-8")
        return True

    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.cv2.imwrite", fake_imwrite)

    write_number_check_outputs(
        frame_results=frame_results,
        frames=frames,
        crop_rect=(2, 3, 6, 4),
        output_dir=tmp_path,
    )

    assert not stale_image.exists()
    table_lines = (tmp_path / "screenshot_number_table.csv").read_text(encoding="utf-8").splitlines()
    assert len(table_lines) == 4  # header + seconds 0,1,2


def test_determine_crop_rect_uses_action_ocr_crop_rect() -> None:
    actions = [{"ocrCropRect": {"left": 1, "top": 2, "width": 3, "height": 4}}]
    assert determine_crop_rect(actions) == (1, 2, 3, 4)


def test_determine_secondary_ocr_capture_uses_first_overlay_event_plus_delay() -> None:
    actions = [
        {"timeSinceVideoStartNs": 100_000_000},
        {
            "timeSinceVideoStartNs": 2_000_000_000,
            "secondaryOcrCropRect": {"left": 11, "top": 43, "width": 135, "height": 23},
        },
        {
            "timeSinceVideoStartNs": 2_500_000_000,
            "secondaryOcrCropRect": {"left": 99, "top": 99, "width": 1, "height": 1},
        },
    ]
    assert determine_secondary_ocr_capture(actions) == ((11, 43, 135, 23), 2500)


def test_write_secondary_ocr_digits_image_writes_cropped_secondary_overlay(
    tmp_path: Path, monkeypatch
) -> None:
    actions = [
        {
            "timeSinceVideoStartNs": 1_000_000_000,
            "secondaryOcrCropRect": {"left": 2, "top": 3, "width": 31, "height": 8},
        }
    ]
    frame_results = [
        FrameOcrResult(frame_index=0, ms=500),
        FrameOcrResult(frame_index=1, ms=1200),
        FrameOcrResult(frame_index=2, ms=1800),
    ]
    frames = [np.zeros((12, 40, 3), dtype=np.uint8) for _ in range(3)]
    for digit in range(10):
        left = 3 + (digit * 3)
        frames[2][5:9, left : left + 2] = 255

    def fake_imwrite(path: str, frame) -> bool:
        Path(path).write_text(f"{frame.shape[1]}x{frame.shape[0]}", encoding="utf-8")
        return True

    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.cv2.imwrite", fake_imwrite)

    output_path = tmp_path / "ocr_digits" / "ocr_digits.png"
    write_secondary_ocr_digits_image(
        actions=actions,
        frame_results=frame_results,
        frames=frames,
        output_path=output_path,
        overlay_settle_delay_ms=500,
    )

    digits_dir = tmp_path / "ocr_digits"
    padded_dir = tmp_path / "ocr_digits_2"
    assert output_path.exists()
    assert output_path.read_text(encoding="utf-8") == "31x8"
    assert (digits_dir / "ocr_digits_otsu.png").exists()
    assert (digits_dir / "ocr_digits_otsu.png").read_text(encoding="utf-8") == "31x8"

    for digit in range(10):
        assert (digits_dir / f"{digit}.png").exists()
        assert (digits_dir / f"{digit}.png").read_text(encoding="utf-8") == "2x4"
        assert (padded_dir / f"{digit}.png").exists()
        assert (padded_dir / f"{digit}.png").read_text(encoding="utf-8") == "4x6"


def test_process_session_creates_analytics_files(tmp_path: Path, monkeypatch) -> None:
    session_dir = tmp_path / "sessions" / "example"
    scriber_dir = session_dir / "01_scriber"
    scriber_dir.mkdir(parents=True)

    (scriber_dir / "actions.json").write_text(
        (
            '[{"actionId":"x","timeSinceVideoStartNs":1000000000,'
            '"secondaryOcrCropRect":{"left":2,"top":3,"width":6,"height":4}}]'
        ),
        encoding="utf-8",
    )
    (scriber_dir / "video.webm").write_text("placeholder", encoding="utf-8")

    fake_results = [FrameOcrResult(frame_index=0, ms=1000)]
    fake_frames = [np.zeros((12, 24, 3), dtype=np.uint8)]

    def fake_run_template_matching_on_video(video_path, crop_rect, style, min_score):
        return fake_results, fake_frames

    def fake_imwrite(path: str, frame) -> bool:
        Path(path).write_text(str(frame), encoding="utf-8")
        return True

    monkeypatch.setattr(
        "scriber_2_screenshots.generate_screenshots.run_template_matching_on_video",
        fake_run_template_matching_on_video,
    )
    monkeypatch.setattr(
        "scriber_2_screenshots.generate_screenshots.ensure_tesseract_runtime_ready",
        lambda: "test-version",
    )
    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.cv2.imwrite", fake_imwrite)

    process_session(session_dir, min_template_score=0.2)

    analytics = session_dir / "02_scriber_analytics"
    assert (analytics / "actions.json").exists()
    assert (analytics / "ocr_ms_per_frame.txt").read_text(encoding="utf-8").strip() == "1000"
    assert (analytics / "ocr_ms_per_frame_table.csv").exists()
    assert (analytics / "check_number_ocr" / "screenshot_number_table.csv").exists()
    assert (analytics / "ocr_digits" / "ocr_digits.png").exists()
    assert (analytics / "ocr_digits" / "ocr_digits_otsu.png").exists()
    assert (analytics / "ocr_digits_2").is_dir()
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

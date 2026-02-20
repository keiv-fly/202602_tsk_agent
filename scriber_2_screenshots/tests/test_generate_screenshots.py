from pathlib import Path

import numpy as np

from scriber_2_screenshots.generate_screenshots import (
    FrameOcrResult,
    OverlayTemplateStyle,
    capture_action_screenshots,
    decode_encoded_overlay_ms,
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


def test_match_overlay_digits_uses_template_similarity() -> None:
    roi = np.zeros((12, 60), dtype=np.uint8)
    templates: dict[str, np.ndarray] = {}
    cursor = 1

    for idx, digit in enumerate("012345"):
        glyph = np.zeros((6, 5), dtype=np.uint8)
        glyph[0, 0] = 255
        glyph[-1, -1] = 255
        for col in range(glyph.shape[1]):
            glyph[(idx + col) % glyph.shape[0], col] = 255
        roi[2:8, cursor : cursor + glyph.shape[1]] = glyph
        templates[digit] = np.pad(glyph, ((1, 1), (1, 1)), mode="constant", constant_values=0)
        cursor += glyph.shape[1] + 1

    result = match_overlay_digits(roi, templates=templates, digit_count=6, min_score=0.1)
    assert result.value == 12345
    assert result.score > 0.99
    assert len(result.digit_metrics) == 6
    assert all(metric is not None and metric > 0.99 for metric in result.digit_metrics)




def test_decode_encoded_overlay_ms_reads_valid_payload() -> None:
    target_ms = 54321

    def crc32(bytes_seq: list[int]) -> int:
        crc = 0xFFFFFFFF
        for byte in bytes_seq:
            crc ^= byte & 0xFF
            for _ in range(8):
                mask = -(crc & 1)
                crc = (crc >> 1) ^ (0xEDB88320 & mask)
        return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF

    crc = crc32([(target_ms >> 16) & 0xFF, (target_ms >> 8) & 0xFF, target_ms & 0xFF]) & 0x1F
    payload = (target_ms << 5) | crc
    bits = [((payload >> bit) & 1) for bit in range(24, -1, -1)]

    roi = np.full((50, 50), 255, dtype=np.uint8)
    bit_idx = 0
    for row in range(5):
        for col in range(5):
            value = 0 if bits[bit_idx] == 1 else 255
            roi[row * 10 : (row + 1) * 10, col * 10 : (col + 1) * 10] = value
            bit_idx += 1

    decoded_ms, metrics = decode_encoded_overlay_ms(roi)

    assert decoded_ms == target_ms
    assert len(metrics) == 25


def test_decode_encoded_overlay_ms_rejects_crc_mismatch() -> None:
    roi = np.full((50, 50), 255, dtype=np.uint8)
    roi[0:10, 0:10] = 0
    decoded_ms, _ = decode_encoded_overlay_ms(roi)
    assert decoded_ms is None

def test_match_overlay_digits_respects_min_similarity_threshold() -> None:
    roi = np.zeros((12, 60), dtype=np.uint8)
    templates: dict[str, np.ndarray] = {}
    cursor = 1

    for idx, digit in enumerate("012345"):
        glyph = np.zeros((6, 5), dtype=np.uint8)
        glyph[0, 0] = 255
        glyph[-1, -1] = 255
        for col in range(glyph.shape[1]):
            glyph[(idx + col) % glyph.shape[0], col] = 255
        roi[2:8, cursor : cursor + glyph.shape[1]] = glyph
        templates[digit] = np.pad(glyph, ((1, 1), (1, 1)), mode="constant", constant_values=0)
        cursor += glyph.shape[1] + 1

    result = match_overlay_digits(roi, templates=templates, digit_count=6, min_score=1.01)
    assert result.value is None
    assert result.score <= 1.0


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


def test_write_frame_ms_table_file_writes_ms_and_per_digit_metrics(tmp_path: Path) -> None:
    output_path = tmp_path / "ocr_ms_per_frame_table.csv"
    write_frame_ms_table_file(
        [
            FrameOcrResult(
                frame_index=0,
                ms=100,
                digit_match_metrics=(0.81234, 0.91, 0.92, 0.93, 0.94, 0.95),
            ),
            FrameOcrResult(frame_index=1, ms=None, digit_match_metrics=(0.0, 0.0)),
        ],
        output_path,
    )

    content = output_path.read_text(encoding="utf-8")
    assert "id,ocr_ms,digit_1_match,digit_2_match,digit_3_match,digit_4_match,digit_5_match,digit_6_match" in content
    assert "0,100,0.812340,0.910000,0.920000,0.930000,0.940000,0.950000" in content
    assert "1,None,0.000000,0.000000,,,," in content


def test_write_number_check_outputs_writes_crops_and_table(tmp_path: Path, monkeypatch) -> None:
    frame_results = [
        FrameOcrResult(frame_index=0, ms=0),
        FrameOcrResult(frame_index=1, ms=120),
        FrameOcrResult(frame_index=2, ms=140),
        FrameOcrResult(frame_index=3, ms=160),
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
        frame_rate_fps=1.0,
    )

    assert (tmp_path / "second_000000.png").exists()
    assert (tmp_path / "second_000001.png").exists()
    assert (tmp_path / "second_000002.png").exists()
    assert (tmp_path / "second_000003.png").exists()

    table_content = (tmp_path / "screenshot_number_table.csv").read_text(encoding="utf-8")
    assert "screenshot_name,id,ocr_ms,digit_1_match,digit_2_match,digit_3_match,digit_4_match,digit_5_match,digit_6_match" in table_content
    assert "second_000000.png,0,0" in table_content
    assert "second_000001.png,1,120" in table_content
    assert "second_000002.png,2,140" in table_content
    assert "second_000003.png,3,160" in table_content


def test_write_number_check_outputs_uses_frame_rate_and_cleans_stale_images(
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
        frame_rate_fps=1.0,
    )

    assert not stale_image.exists()
    table_lines = (tmp_path / "screenshot_number_table.csv").read_text(encoding="utf-8").splitlines()
    assert len(table_lines) == 4  # header + seconds 0,1,2 at 1fps with 3 frames


def test_determine_crop_rect_prefers_encoded_crop_rect() -> None:
    actions = [
        {"ocrCropRect": {"left": 1, "top": 2, "width": 3, "height": 4}},
        {"encodedOcrCropRect": {"left": 10, "top": 20, "width": 30, "height": 40}},
    ]
    assert determine_crop_rect(actions) == (10, 20, 30, 40)


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
    frames = [np.zeros((12, 40, 3), dtype=np.uint8) for _ in range(3)]
    for digit in range(10):
        left = 3 + (digit * 3)
        frames[2][5:9, left : left + 2] = 255

    class FakeCapture:
        def __init__(self, source_frames):
            self._frames = source_frames
            self._position = 0

        def isOpened(self) -> bool:
            return True

        def get(self, prop):
            if prop == 5:  # cv2.CAP_PROP_FPS
                return 1.0
            if prop == 7:  # cv2.CAP_PROP_FRAME_COUNT
                return float(len(self._frames))
            return 0.0

        def set(self, prop, value):
            if prop == 1:  # cv2.CAP_PROP_POS_FRAMES
                self._position = int(value)
                return True
            return False

        def read(self):
            if self._position < 0 or self._position >= len(self._frames):
                return False, None
            return True, self._frames[self._position]

        def release(self):
            return None

    def fake_imwrite(path: str, frame) -> bool:
        Path(path).write_text(f"{frame.shape[1]}x{frame.shape[0]}", encoding="utf-8")
        return True

    monkeypatch.setattr(
        "scriber_2_screenshots.generate_screenshots.cv2.VideoCapture",
        lambda _path: FakeCapture(frames),
    )
    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.cv2.imwrite", fake_imwrite)

    output_path = tmp_path / "ocr_digits" / "ocr_digits.png"
    write_secondary_ocr_digits_image(
        actions=actions,
        video_path=tmp_path / "video.webm",
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
        return fake_results, fake_frames, 1.0

    def fake_imwrite(path: str, frame) -> bool:
        Path(path).write_text(str(frame), encoding="utf-8")
        return True

    def fake_write_secondary(actions, video_path, output_path, overlay_settle_delay_ms):
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("secondary", encoding="utf-8")
        (output_path.parent / "ocr_digits_otsu.png").write_text("otsu", encoding="utf-8")
        padded_dir = output_path.parent.with_name("ocr_digits_2")
        padded_dir.mkdir(parents=True, exist_ok=True)
        for digit in range(10):
            (padded_dir / f"{digit}.png").write_text("digit", encoding="utf-8")

    monkeypatch.setattr(
        "scriber_2_screenshots.generate_screenshots.run_template_matching_on_video",
        fake_run_template_matching_on_video,
    )
    monkeypatch.setattr(
        "scriber_2_screenshots.generate_screenshots.write_secondary_ocr_digits_image",
        fake_write_secondary,
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

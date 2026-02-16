from pathlib import Path

from scriber_2_screenshots.generate_screenshots import (
    FrameOcrResult,
    capture_action_screenshots,
    determine_crop_rect,
    extract_ms_from_ocr_data,
    find_frame_index,
    process_session,
)


def test_extract_ms_from_ocr_data_respects_confidence_threshold() -> None:
    ocr_data = {
        "text": ["", "1234", "9999"],
        "conf": ["-1", "91", "96"],
    }

    assert extract_ms_from_ocr_data(ocr_data, min_confidence=92) == 9999
    assert extract_ms_from_ocr_data(ocr_data, min_confidence=97) is None


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

    def fake_run_ocr_on_video(video_path, crop_rect, min_confidence):
        return fake_results, fake_frames

    def fake_imwrite(path: str, frame) -> bool:
        Path(path).write_text(str(frame), encoding="utf-8")
        return True

    monkeypatch.setattr(
        "scriber_2_screenshots.generate_screenshots.run_ocr_on_video",
        fake_run_ocr_on_video,
    )
    monkeypatch.setattr("scriber_2_screenshots.generate_screenshots.cv2.imwrite", fake_imwrite)

    process_session(session_dir, min_confidence=92)

    analytics = session_dir / "02_scriber_analytics"
    assert (analytics / "actions.json").exists()
    assert (analytics / "ocr_ms_per_frame.txt").read_text(encoding="utf-8").strip() == "1000"
    assert (analytics / "screenshots" / "x_before.png").exists()

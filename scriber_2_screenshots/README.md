# `scriber_2_screenshots`

Generate action-aligned screenshots and analytics from Scriber session recordings.

## What this script does

The entrypoint `generate_screenshots.py`:

- reads `actions.json` and `video.webm` from each session's `01_scriber` folder
- extracts digit templates from the secondary overlay (`ocr_digits_2/0.png` ... `9.png`)
- uses template matching to read the top-left overlay number on each frame
- uses style values from `scriber/src/tooling/recorder.ts` to determine expected digit length
- captures three screenshots per action (`before`, `at`, `after`)
- writes analytics artifacts to `02_scriber_analytics`
- writes a per-frame CSV table with OCR value and frame id (`ocr_ms_per_frame_table.csv`)
- writes `check_number_ocr/` with one cropped screenshot per second based on video FPS (`id ~= second * fps`) and a screenshot table including the selected frame id and OCR value

## Prerequisites

- Python 3.10+

## Install Python dependencies

From the repository root:

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install opencv-python tqdm pytest
```

## Run

From the repository root:

```bash
python generate_screenshots.py
```

Input selection behavior:

- no positional argument: process all sessions inside `sessions/`
- positional argument is a session folder (contains `01_scriber/`): process only that session
- positional argument is a parent folder containing session folders: process all valid sessions inside it

Examples:

- process one specific session folder:

  ```bash
  python generate_screenshots.py sessions/20260216_2151_www.thegoodride.com
  ```

- set OCR confidence threshold (default: `0.43`):

  ```bash
  python generate_screenshots.py sessions --min-template-score 0.40
  ```

- override the recorder source file used to derive template style:

  ```bash
  python -m scriber_2_screenshots.generate_screenshots sessions --recorder-ts-path scriber/src/tooling/recorder.ts
  ```

## Expected input layout

For each session directory:

```text
sessions/<session_name>/
  01_scriber/
    actions.json
    video.webm
```

If either file is missing, that session is skipped.

## Output layout

```text
sessions/<session_name>/
  02_scriber_analytics/
    actions.json
    ocr_ms_per_frame.txt
    ocr_ms_per_frame_table.csv
    check_number_ocr/
      screenshot_number_table.csv
      second_000000.png
      second_000001.png
      ...
    screenshots/
      <actionId>_before.png
      <actionId>_at.png
      <actionId>_after.png
```

## Run tests

```bash
pytest scriber_2_screenshots/tests -q
```

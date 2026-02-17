# `scriber_2_screenshots`

Generate action-aligned screenshots and analytics from Scriber session recordings.

## What this script does

The entrypoint `generate_screenshots.py`:

- reads `actions.json` and `video.webm` from each session's `01_scriber` folder
- runs OCR on video frames to estimate each frame timestamp
- captures three screenshots per action (`before`, `at`, `after`)
- writes analytics artifacts to `02_scriber_analytics`

## Prerequisites

- Python 3.10+
- Tesseract OCR installed and available on `PATH`
  - Windows: install Tesseract and reopen your terminal so `tesseract --version` works

## Install Python dependencies

From the repository root:

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install opencv-python pytesseract tqdm pytest
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
  python -m scriber_2_screenshots.generate_screenshots sessions/20260216_2151_www.thegoodride.com
  ```

- set OCR confidence threshold (default: `92`):

  ```bash
  python -m scriber_2_screenshots.generate_screenshots sessions --min-confidence 90
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
    screenshots/
      <actionId>_before.png
      <actionId>_at.png
      <actionId>_after.png
```

## Run tests

```bash
pytest scriber_2_screenshots/tests -q
```

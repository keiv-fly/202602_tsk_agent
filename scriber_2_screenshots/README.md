# `scriber_2_screenshots`

Generate action-aligned screenshots and analytics from Scriber session recordings.

## What this script does

The entrypoint `generate_screenshots.py`:

- reads `actions.json` and `video.webm` from each session's `01_scriber` folder
- uses OpenCV template matching to read the overlay digits on each frame
- derives template style values from `scriber/src/tooling/recorder.ts` so matching stays aligned with Scriber CSS
- captures three screenshots per action (`before`, `at`, `after`)
- writes analytics artifacts to `02_scriber_analytics`

## Prerequisites

- Python 3.10+
- No Tesseract install required

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
  python -m scriber_2_screenshots.generate_screenshots sessions/20260216_2151_www.thegoodride.com
  ```

- set template score threshold (default: `0.43`):

  ```bash
  python -m scriber_2_screenshots.generate_screenshots sessions --min-template-score 0.40
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
    screenshots/
      <actionId>_before.png
      <actionId>_at.png
      <actionId>_after.png
```

## Run tests

```bash
pytest scriber_2_screenshots/tests -q
```

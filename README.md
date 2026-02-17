# 202602_tsk_agent

Task Scribe Go Agent

## Scriber

The `scriber/` directory contains the Playwright-based session recorder scaffolding.

- Install dependencies: `cd scriber && npm install`
- Run tests: `npm test`
- Start (placeholder): `npm run record`

## Scriber 2 Screenshots

The `scriber_2_screenshots/` directory contains the Python OCR pipeline that turns recorded Scriber sessions into per-action screenshots and analytics files.

- Full guide: `scriber_2_screenshots/README.md`
- Quick run (from repo root): `python generate_screenshots.py`
- Run tests: `pytest scriber_2_screenshots/tests -q`

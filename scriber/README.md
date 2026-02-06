# Scriber

Scriber is a Playwright-based browser session recorder. This initial scaffolding validates that the tool can start inside the configured environment.

## Requirements

- Node.js 20+
- npm

## Setup

```bash
cd scriber
npm install
```

## Run (record)

```bash
npm run record
```

`npm run record` launches a visible browser window by default. Use `HEADLESS=true`
to run the recorder without a UI:

```bash
HEADLESS=true npm run record
```

## Tests

```bash
npm test
```

# Browser Session Recorder — Requirements (Standalone Playwright)

## 1. Purpose & Scope

The tool SHALL record interactive browser sessions using standalone Playwright scripts, capturing:

* user-initiated actions
* computed DOM state
* screenshots **before and after** actions
* across multiple tabs / popup windows (login flows expected)

The tool is intended for session recording, forensic inspection, and best-effort replay.

---

## 2. Session Lifecycle

### 2.1 Session start

* The tool SHALL allow the user to input a start URL (CLI prompt or local UI).
* The tool SHALL launch a visible browser (`headless: false`) using Playwright.
* Each session SHALL receive a unique `sessionId`.

### 2.2 Session end

* The user SHALL be able to terminate recording gracefully.
* On termination, all buffered data SHALL be flushed to disk.

### 2.3 Session metadata

The tool SHALL record:

* sessionId
* start/end timestamps
* browser type/version
* user agent
* viewport size
* timezone
* Playwright version

---

## 3. Action Recording

### 3.1 Recorded action types

The tool SHALL record:

* `click`, `input`, `change`, `submit`, `navigate`, `popup_open`, `tab_switch`

### 3.2 Action payload

Each action SHALL include:

* `actionId` (unique)
* `stepNumber` (monotonic)
* timestamp
* action type
* URL
* `pageId`
* target element metadata (when applicable)
* selector information (§4)

### 3.3 Append-only logging

* Actions SHALL be written incrementally to `actions.jsonl`.
* The log SHALL remain valid even if the session terminates unexpectedly.
* An optional consolidated `actions.json` MAY be produced at session end.

---

## 4. Selector Generation (Replayability)

### 4.1 Selector candidates

For target elements, the tool SHALL generate and store selector candidates in this order:

1. `data-testid` / `data-test`
2. stable `id`
3. ARIA role + accessible name
4. text selector
5. CSS path
6. XPath

### 4.2 Selector storage

Each action SHALL store:

* `primarySelector`
* `fallbackSelectors[]`

---

## 5. Snapshots (Visual & DOM)

### 5.1 Snapshot policy

* The tool SHALL capture snapshots **before and after** each meaningful action.
* A snapshot consists of:

  * screenshot
  * computed DOM dump

### 5.2 Snapshot triggers

Snapshots SHALL be taken for:

* `click`, `submit`, `navigate`, `popup_open`, `tab_switch`

Input actions SHALL be debounced, with snapshots taken after a period of inactivity.

---

## 6. Screenshot Capture

### 6.1 Screenshot type

* Screenshots SHALL default to viewport-only.
* Full-page screenshots MAY be enabled via configuration.

### 6.2 Screenshot association

Each screenshot SHALL be associated with:

* `actionId`
* `pageId`
* `phase` (`before` / `after`)

---

## 7. DOM Capture

### 7.1 DOM content

The tool SHALL capture computed DOM:

* `document.documentElement.outerHTML`

### 7.2 Storage

* DOM snapshots SHALL be stored on disk.
* DOM snapshots SHALL be gzip-compressed.

---

## 8. Action Completion & Page Settling

### 8.1 Settled condition

Before “after” snapshots, the tool SHALL wait for page settle via:

* MutationObserver “DOM quiet window”, and
* max timeout fallback

### 8.2 SPA compatibility

Settling logic SHALL work for SPA frameworks and async rendering.

---

## 9. Multi-Tab & Popup Support

### 9.1 Page tracking

* The tool SHALL support multiple pages within one browser context.
* Each page SHALL be assigned a stable `pageId`.

### 9.2 Popup handling

* New windows/tabs SHALL be recorded as `popup_open`.
* Focus changes SHALL be recorded as `tab_switch`.

### 9.3 Association

All actions and artifacts SHALL reference the relevant `pageId`.

---

## 10. Storage Layout

### 10.1 Directory structure

The tool SHALL write:

```
sessions/<sessionId>/
  meta.json
  actions.jsonl
  screenshots/
  dom/
```

### 10.2 File naming

* Artifacts SHALL be step-numbered for chronology.
* Artifacts SHALL be traceable to `actionId`.

---

## 11. Privacy & Data Protection

### 11.1 Input handling

* Password fields SHALL always be masked.
* By default, non-password input values SHALL NOT be stored verbatim; store length + field metadata only.

### 11.2 Opt-in storage

* Storing raw input values SHALL require explicit configuration.
* Regex-based redaction rules SHALL be supported.

---

## 12. Replay Requirements

### 12.1 Replay mode

* The tool SHALL support best-effort replay.
* Replay SHALL try `primarySelector` then fallbacks.

### 12.2 Failure handling

* Selector failures SHALL be logged and replay continues by default.
* Assisted replay MAY pause and request user interaction on selector failure.

---

## 13. Non-Goals (Baseline)

Baseline does not require:

* assertions / CI test runner usage
* visual diffing
* full HAR capture

---

## 14. Success Criteria

The tool is successful if it can:

* record a login flow involving popups
* produce before/after screenshot timeline per action
* capture accurate DOM states per action
* replay with minimal manual intervention

---

# 15. Test-Driven Development Requirements

## 15.1 Test environment (deterministic by default)

* The project SHALL include a **local deterministic test site** served from localhost for automated tests.
* The automated test suite SHALL NOT depend on external network availability or third-party site stability.
* Real-site tests (if present) SHALL be limited to a small smoke suite and SHALL be non-blocking (e.g., nightly or manual).

## 15.2 Test pyramid

The test suite SHALL include:

### 15.2.1 Unit tests (no browser)

Unit tests SHALL validate:

1. **JSONL writer**

   * appends valid JSON objects line-by-line
   * remains parseable after abrupt termination (partial line handling defined)
2. **Schema validation**

   * required fields exist (`actionId`, `stepNumber`, `pageId`, `url`, timestamps)
   * `stepNumber` strictly monotonic
3. **File naming + linkage**

   * step numbering format
   * `before/after` suffixing
   * artifact path references match actual generated files
4. **Redaction**

   * password fields always masked
   * regex redaction behaves as configured
5. **DOM compression**

   * DOM snapshots are gzip-compressed and round-trip decompress correctly
6. **Debounce logic**

   * input events coalesce according to configured inactivity window

### 15.2.2 Local browser integration tests (Playwright + local test site)

Integration tests SHALL execute Playwright against the local test site and validate end-to-end artifact production.

The suite SHALL include at least:

A) **Session artifacts & linkage**

* Start session → perform one click → stop session
* Assert: `meta.json`, `actions.jsonl`, referenced screenshots and DOM files exist.

B) **Before/after snapshots correctness**

* Test page: button toggles visible text on click
* Assert: DOM-before contains old text; DOM-after contains new text; both screenshots exist.

C) **Settled logic correctness (DOM quiet window)**

* Test page: click triggers multiple DOM mutations over time
* Assert: “after” snapshot captures final state, not intermediate.

D) **Input debouncing**

* Test page: input field
* Type a burst of characters
* Assert: snapshots are not taken per keystroke; only after inactivity threshold.

E) **Multi-tab / popup login flow**

* Test page A opens popup page B (simulating OAuth/login approval)
* Assert:

  * `popup_open` recorded with a new `pageId`
  * `tab_switch` recorded appropriately
  * snapshots and DOM dumps are associated with correct `pageId`
  * recording continues after popup closes

F) **Selector candidate generation**

* Test page includes elements with: `data-testid`, `id`, ARIA labels, and text-only buttons
* Assert: stored selector candidates include expected strategies and correct preference ordering.

G) **Privacy defaults**

* Test page includes password and non-password inputs
* Assert: password value never stored; non-password value stored as length/metadata by default.

H) **Crash-safety of actions.jsonl**

* Simulate abrupt termination after writing multiple actions (or kill child process in test harness)
* Assert: `actions.jsonl` remains readable up to last complete line and tool-defined behavior for incomplete line is honored.

## 15.3 Real-site smoke tests (optional, non-blocking)

If implemented:

* Smoke tests SHALL verify only coarse outcomes (e.g., “a navigation action was logged and a screenshot was created”).
* Smoke tests SHALL avoid brittle selectors and SHALL not be required for PR merge.

## 15.4 Test site routes (minimum set)

The local deterministic test site SHALL provide routes to cover required behaviors:

* `/basic-click` (text toggle)
* `/delayed-mutations` (async DOM updates)
* `/spa-route` (History API route change)
* `/inputs` (text + password)
* `/popup-a`, `/popup-b` (popup login flow)


## 16. Headless Environment & Screenshot Testing Requirements

### 16.1 Headless compatibility

* The tool SHALL support full operation in **headless browser environments** (e.g., CI systems, containerized runners, Codex Web).
* In headless mode, the tool SHALL be able to:

  * record user actions
  * capture screenshots
  * capture computed DOM snapshots
  * write all artifacts to disk

### 16.2 Screenshot guarantees

* Screenshots captured in headless environments SHALL represent the browser’s rendered output (offscreen rendering).
* The tool SHALL NOT require a physical display or GPU acceleration to produce screenshots.

### 16.3 Testing assertions for screenshots

* Automated tests SHALL NOT rely on pixel-level comparison of screenshots.
* Screenshot-related assertions SHALL be limited to:

  * file existence
  * non-zero dimensions
  * correct association with `actionId`, `pageId`, and snapshot phase (`before` / `after`)
* Visual correctness SHALL be validated indirectly via DOM state assertions, not image equality.

### 16.4 Determinism considerations

* Tests SHALL explicitly set viewport size to ensure consistent screenshot dimensions.
* Test pages MAY disable animations and transitions to reduce rendering variability across environments.

### 16.5 Parity with headful execution

* Headless execution SHALL be treated as a first-class mode for TDD and CI.
* Any feature required by the test suite SHALL be supported in both headless and headful browser modes.

### 17. Programming Language & Runtime Requirements

#### 17.1 Language

* The implementation SHALL be written in **TypeScript** (not plain JavaScript).
* The repository SHALL enable **strict type-checking** (`"strict": true`) and SHALL fail builds/tests on type errors.

#### 17.2 “Type-check before execution”

Pick one of these enforceable interpretations (you can include both):

**A) CI / dev command requirement (recommended)**

* All run commands (`record`, `replay`, `test`) SHALL be preceded by a TypeScript type-check step, e.g.:

  * `npm run typecheck` MUST pass before `npm run record` / `npm run replay` / `npm test` is considered successful.
* The project SHALL provide:

  * `npm run typecheck` (runs `tsc --noEmit`)
  * `npm test` (runs tests and includes typecheck, or depends on it)

#### 17.3 Node.js version & package manager

* The project SHALL target **Node.js LTS** (pin a minimum version in `package.json` `engines.node`, e.g. `>=20`).
* The project SHALL specify the package manager (npm/pnpm/yarn) and include a lockfile.

#### 17.4 Tooling / linting

* The project SHOULD include ESLint + Prettier (or equivalent) with a single `npm run lint`.
* The project SHOULD use a consistent TS config (`tsconfig.json`) shared by app and tests.

#### 17.5 Execution model

* The project SHALL support running TypeScript sources directly in development using **`tsx`**.
* The project SHALL provide `npm run typecheck` that runs `tsc --noEmit` and MUST pass for CI and before executing core commands.

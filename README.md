# Glitch Reaper

Glitch Reaper is a Manifest V3 browser extension for capturing actionable frontend failures during development and QA. It detects runtime errors, failed requests and resources, long main-thread stalls, and sustained memory growth, then stores each failure as a structured report.

## Features

- uncaught JavaScript errors and unhandled promise rejections
- `console.error` capture
- failed `fetch` and XMLHttpRequest requests, including HTTP 4xx and 5xx responses
- failed scripts, stylesheets, images, fonts, and other page resources
- long-task and page-stall detection
- memory-growth heuristics using heap, DOM-node, and listener samples
- duplicate grouping with occurrence counts
- manual reports with `Ctrl+Shift+G`
- local persistence with retention and report-count limits
- optional Supabase synchronization
- JSON import and export

## Installation

### Chrome, Edge, Brave, or Opera

1. Extract the Chromium build.
2. Open the browser extensions page and enable Developer mode.
3. Select **Load unpacked**.
4. Select the extracted directory containing `manifest.json`.

### Firefox

1. Extract the Firefox build.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on**.
4. Select `manifest.json` from the extracted directory.

## Configuration

1. Open Glitch Reaper and enter a project name and browser profile name.
2. Choose **Local Browser** or **Supabase Cloud** storage.
3. On **Bug Detection**, enter the website domain to monitor.
4. Enable bug detection and reload the connected website.

Connected Websites accepts exact hosts and wildcard subdomains such as `*.staging.example.com`. Excluded Websites takes precedence over connected host rules.

## Reports

Automatic reports can include the failure type, severity, status, timestamps, occurrence count, sanitized page URL, stack trace, source location, request metadata, resource metadata, performance duration, memory measurements, and browser environment details.

Matching automatic failures are grouped by a stable fingerprint. Manual reports remain separate so unrelated visual or logic issues on the same page are not merged.

## Storage

### Local Browser

Reports are stored with the extension storage API. Retention and maximum-report limits are applied before writes so the local cache remains bounded.

### Supabase Cloud

Cloud mode uses the schema in `supabase/schema.sql` and restricted Postgres RPC functions. The extension expects a Supabase project URL, publishable key, Glitch Reaper project ID, ingest token, and an optional admin token.

The ingest token submits reports. The admin token is required to list cloud reports, change status, or delete records. Direct anonymous table access is revoked by the schema, and project tokens are stored as hashes.

Use a Supabase publishable key in the extension. Do not place secret or `service_role` keys in client code.

## Development

Requires Node.js 20 or newer.

```bash
npm run check
```

The browser-rendering smoke suite uses Playwright:

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
npm run test:ui
```

Set `CHROMIUM_PATH` to use a specific Chromium executable.

## Project structure

- `service-worker.js` — persistence, report merging, import/export, and cloud sync
- `shared/incident-utils.js` — validation, sanitizing, normalization, and fingerprints
- `detectors/page-monitor.js` — isolated-world detector coordination and performance sampling
- `detectors/page-runtime.js` — page-world console, network, route, and listener instrumentation
- `dashboard/` — bug dashboard, settings, and onboarding
- `manual-report/` — manual bug reporter
- `supabase/schema.sql` — private cloud tables and restricted RPC functions
- `tests/` — source, logic, storage, layout, performance, and UI checks
- `ARCHITECTURE.md` — runtime and data-flow design
- `PRIVACY.md` — report data and sanitizing rules

## Limitations

Memory-leak reports are heuristic. They flag sustained growth for investigation with browser profiling tools but cannot identify the exact retained object.

Visual and business-logic faults that do not produce a browser failure signal should be submitted through the manual reporter.

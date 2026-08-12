# Architecture

## Runtime contexts

Glitch Reaper uses four extension contexts.

### Page runtime

`detectors/page-runtime.js` runs in the page's main JavaScript world. It observes APIs that cannot be wrapped reliably from an isolated content-script world, including `console.error`, `fetch`, XMLHttpRequest, route changes and event-listener counts.

Signals are emitted as small JSON events. Report storage and sanitizing do not happen in the page runtime.

### Page monitor

`detectors/page-monitor.js` runs as an isolated content script. It combines browser error events, resource failures, runtime signals, performance measurements and memory samples into normalized incident payloads.

Nearby failures are batched before messaging the extension worker. Memory samples use bounded history windows and only create a report after sustained growth meets the configured thresholds.

### Service worker

`service-worker.js` owns persistent state and cloud operations. It:

- normalizes incoming incidents
- merges matching automatic reports
- preserves manual reports as separate entries
- applies retention and report-count limits
- manages browser profile metadata
- exports and imports report files
- queues Supabase uploads
- reconciles cloud and local state

Storage writes and cloud mutations are serialized to avoid stale writes replacing newer state.

### Dashboard and reporter

`dashboard/` reads state from the service worker and sends explicit commands for settings, report status, import/export and sync actions.

`manual-report/` collects a title, description and severity, then sends the report through the same service-worker normalization path used by automatic incidents.

## Data flow

```text
website failure
    ↓
page runtime / page monitor
    ↓
normalized incident message
    ↓
service worker
    ↓
local extension storage
    ↓
optional Supabase sync
    ↓
dashboard
```

## Storage keys

- `gr_settings`
- `gr_incidents`
- `gr_profiles`
- `gr_sync`

The worker normalizes stored data on startup before it is returned to detectors or UI code.

## Detector scope

Automatic detection listens to fault and performance signals including runtime errors, rejected promises, failed resources, network failures, long tasks, route changes and bounded memory samples.

## Cloud access model

The Supabase schema keeps project and incident tables private. Browser clients call restricted RPC functions with a publishable key plus a Glitch Reaper project token.

The ingest token is limited to report submission. The admin token is required for report listing, status changes and deletion.

Firefox declares cloud-transmitted data as optional collection permissions. The dashboard requests those permissions only when cloud configuration is complete, and the worker checks the permission state again before every RPC call.

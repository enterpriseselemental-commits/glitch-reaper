# Glitch Reaper

Glitch Reaper is a Manifest V3 browser extension for capturing frontend failures and turning them into structured, searchable bug reports.

It monitors selected websites for runtime errors, failed requests, broken resources, performance stalls, and suspicious memory growth. Reports are stored locally and can optionally be synchronized through Supabase.

## Features

* uncaught JavaScript errors
* unhandled promise rejections
* optional `console.error` capture
* failed `fetch` and `XMLHttpRequest` requests
* HTTP `4xx` and `5xx` responses
* failed scripts, stylesheets, images, fonts, and media
* long main-thread tasks
* page stalls
* sustained memory growth
* duplicate incident grouping
* manual reports
* local persistence
* configurable retention
* JSON import and export
* optional Supabase sync
* website allowlists and exclusions
* report sanitization

## Browser support

| Browser      | Support        |
| ------------ | -------------- |
| Chrome       | Chromium build |
| Edge         | Chromium build |
| Brave        | Chromium build |
| Opera        | Chromium build |
| Vivaldi      | Chromium build |
| Arc          | Chromium build |
| Firefox 140+ | Firefox build  |

Safari and mobile browsers are not currently supported.

## Detection

### JavaScript

Glitch Reaper captures uncaught JavaScript errors and unhandled promise rejections with the source information exposed by the browser.

Available evidence can include:

* message
* stack trace
* source file
* line and column
* page URL
* first occurrence
* latest occurrence
* occurrence count

`console.error()` capture can be enabled separately.

### Network

`fetch` and `XMLHttpRequest` are instrumented in the page runtime.

Network reports can include:

```json
{
  "method": "GET",
  "url": "https://example.com/api/profile",
  "status": 500,
  "duration": 284
}
```

Failed requests and HTTP error responses are recorded without storing request or response bodies.

### Resources

Failed page resources are captured with the available resource URL and type.

Supported signals include:

* scripts
* stylesheets
* images
* fonts
* media

### Performance

Glitch Reaper monitors long main-thread tasks and abnormal event-loop delays.

Large timing gaps associated with browser suspension are ignored where possible to reduce false positives.

### Memory

Memory monitoring samples available page state over time.

Depending on browser support, this can include:

* JavaScript heap usage
* DOM node count
* listener count

Reports are generated only when growth remains above the configured threshold across the detection window.

Memory reports indicate suspicious growth. Exact leak sources still require browser heap or allocation profiling.

## Incidents

All reports are normalized into a shared incident format before storage.

```json
{
  "id": "incident_01",
  "fingerprint": "2fcf0e4d...",
  "kind": "fetch_http_error",
  "title": "Request returned HTTP 500",
  "severity": "high",
  "status": "found",
  "source": "automatic",
  "occurrences": 3,
  "firstSeen": 1786551000000,
  "lastSeen": 1786551200000,
  "page": {
    "url": "https://example.com/profile"
  },
  "evidence": {
    "method": "GET",
    "url": "https://example.com/api/profile",
    "status": 500,
    "duration": 284
  }
}
```

Detector-specific information is stored under `evidence`.

### Deduplication

Automatic incidents use stable fingerprints derived from failure metadata.

Repeated occurrences update the existing report rather than creating another entry.

The report retains:

```json
{
  "occurrences": 18,
  "firstSeen": 1786551000000,
  "lastSeen": 1786551800000
}
```

Manual reports remain separate.

## Manual reports

Not every bug produces a browser-level failure.

The manual reporter covers:

* visual defects
* broken interactions
* incorrect state
* business logic problems
* missing feedback
* incorrect output

Shortcut:

```text
Windows / Linux: Ctrl + Shift + G
macOS:           Command + Shift + G
```

Manual reports pass through the same normalization, sanitization, and storage pipeline as automatic incidents.

## Website scope

Detection is restricted to configured hosts.

Supported patterns include:

```text
example.com
staging.example.com
*.example.com
```

Excluded hosts always take precedence over connected hosts.

This keeps instrumentation scoped to the sites explicitly configured in Glitch Reaper.

## Storage

Glitch Reaper supports local storage and optional Supabase synchronization.

### Local

Local data is stored through the browser extension storage API.

Primary records:

```text
gr_settings
gr_incidents
gr_profiles
gr_sync
```

Incident storage is bounded by configured retention and report count limits.

### Supabase

Cloud synchronization uses the schema in:

```text
supabase/schema.sql
```

The schema defines:

```text
glitch_reaper_projects
glitch_reaper_incidents
```

Browser clients interact through restricted Postgres RPC functions:

```text
gr_ping
gr_ingest_incidents
gr_list_incidents
gr_update_incident_status
gr_delete_incident
```

Project creation is handled by:

```text
gr_create_project
```

Cloud configuration uses:

```text
Supabase Project URL
Supabase Publishable Key
Glitch Reaper Project ID
Ingest Token
Admin Token
```

The ingest token permits report submission.

The admin token permits:

* listing reports
* changing status
* reopening reports
* deleting reports

Project tokens are stored as hashes.

Secret or `service_role` credentials should never be placed in the extension.

## Synchronization

Cloud mode is local first.

Reports are persisted locally before an upload is attempted.

Failed uploads remain pending and can be retried later.

During reconciliation, newer pending local state is preserved when the remote copy is older.

This prevents temporary cloud failures from interrupting report capture or overwriting newer local changes.

## Import and export

Reports can be exported as JSON and imported into another Glitch Reaper installation.

Exports include report and profile data.

Cloud credentials and project tokens are excluded.

Imported incidents are validated before storage. Matching automatic incidents are deduplicated during import.

## Sanitization

Report data is sanitized before persistence.

### URLs

URL processing removes:

* embedded usernames
* embedded passwords
* fragments
* query strings when query collection is disabled

When query collection is enabled, common sensitive parameters are redacted.

Examples include:

```text
token
auth
password
secret
session
cookie
email
phone
address
account
card
pin
```

### Text

Captured technical text is checked for common sensitive value patterns, including:

* email addresses
* phone numbers
* bearer tokens
* API keys
* access tokens
* refresh tokens
* passwords
* payment number patterns

Report strings and nested evidence are also size limited before storage.

See [`PRIVACY.md`](PRIVACY.md) for the full data handling policy.

## Architecture

Glitch Reaper separates page instrumentation from extension state and persistence.

```text
page
⬇
page-runtime.js
⬇
page-monitor.js
⬇
service-worker.js
  │
  ├── local storage
  └── Supabase
```

### `detectors/page-runtime.js`

Runs in the website's main JavaScript context.

Responsible for:

* console instrumentation
* `fetch`
* `XMLHttpRequest`
* route changes
* listener instrumentation

### `detectors/page-monitor.js`

Runs as the isolated content script.

Responsible for:

* runtime errors
* promise rejections
* resource failures
* runtime signals
* long tasks
* page stalls
* memory sampling
* detector batching
* manual reporter integration

### `service-worker.js`

Owns persistent extension state.

Responsible for:

* validation
* sanitization
* fingerprinting
* duplicate merging
* retention
* report limits
* profiles
* import and export
* cloud synchronization
* status changes
* deletion

### `shared/incident-utils.js`

Shared incident logic for:

* settings normalization
* host matching
* URL sanitization
* text sanitization
* fingerprint generation
* incident normalization
* merging
* browser detection
* schema validation

Detailed runtime behavior is documented in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Repository structure

```text
glitch-reaper/
├── dashboard/
├── detectors/
├── icons/
├── manual-report/
├── shared/
├── supabase/
│   └── schema.sql
├── tests/
├── manifest.json
├── manifest.firefox.json
├── service-worker.js
├── package.json
├── requirements-dev.txt
├── ARCHITECTURE.md
├── PRIVACY.md
├── .editorconfig
└── .gitignore
```

## Limitations

Memory leak detection is heuristic and should be followed by heap or allocation profiling.

Visual and business logic failures that do not produce a browser-level signal require a manual report.

Glitch Reaper currently targets desktop Chromium and Firefox extension environments.

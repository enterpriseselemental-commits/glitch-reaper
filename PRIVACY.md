# Privacy

Glitch Reaper stores technical evidence when a detector creates a report or when a user submits the manual report form.

## Report data

Depending on the detector, a report can contain:

- report id, type, title, description, severity and status
- detection timestamps and occurrence count
- sanitized page URL and optional page title
- JavaScript error message, stack, source file, line and column
- request method, sanitized URL, status and duration
- failed resource URL and resource type
- long-task or page-stall duration
- memory, DOM-node and listener growth measurements
- configured profile name and browser environment details
- local or cloud synchronization state

## Sanitizing

Before report data is stored:

- URL usernames, passwords and fragments are removed
- query strings are removed unless query storage is enabled
- common credential, contact and payment query keys are redacted
- common email, phone, payment-number and credential patterns are scrubbed from free text
- stack traces and nested evidence are length-limited

Manual report text is passed through the same text sanitizing rules before storage.

## Host controls

Detectors activate only when the current hostname matches **Connected Websites** and does not match **Excluded Websites**.

Host rules accept exact domains and wildcard subdomains such as `*.staging.example.com`.

## Local storage

Local data is stored with the browser extension storage API. The configured retention period and maximum report count are applied to the incident cache.

Where supported, extension storage access is restricted to trusted extension contexts.

## Cloud storage

Supabase Cloud is optional. The provided SQL schema:

- enables row-level security on project and incident tables
- revokes direct anonymous table access
- exposes only the RPC functions required by Glitch Reaper
- stores project access tokens as password hashes
- limits each ingest request to a bounded batch size

The publishable key is a browser-side Supabase key. Secret and `service_role` keys must not be stored in the extension.

The admin token should only be entered on trusted developer installations.

On Firefox, cloud-transmitted report categories are declared as optional data-collection permissions. Cloud requests are not sent until those permissions are granted, and RPC calls are rejected if the permission is later unavailable.

## Exported reports

Report exports contain incident and profile data. Supabase connection credentials and project tokens are not included in exported report files.

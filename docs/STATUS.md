# Implementation status report (2026-10-30)

How things were verified: `npm test` runs 25 automated integration and unit tests against the real HTTP server, plus the original `smoke-test.js` and `label-workflow-test.js`. A scripted browser walkthrough (Playwright) covered every page on desktop and mobile with no console errors or CSP violations. External services were replaced by local mock servers that speak their documented protocols. **No call was made to the live Anthropic, Google or Voyage APIs.**

## Fully implemented and tested

- **Synthetic demo** unchanged: 18 scenarios, keyword vs. alternate-term comparison, evaluation and label worksheet (existing tests pass). It now sits behind a Demo / Real data switch.
- **Authentication and authorization**: first-admin setup (localhost or setup token), scrypt passwords, lockout, sessions, CSRF and Origin checks, four roles, permission checks on every endpoint, sessions ended on role or password change.
- **Tenant isolation and source sharing**: tests read across tenants, unshare mid-review, and confirm admins can't see private mailboxes.
- **Demo / Real separation**: synthetic records are stored with `is_synthetic = 1` and filtered in SQL. Each mode's search sees only its own records.
- **File ingestion**: PDF (pdfjs), DOCX and XLSX (built-in ZIP reader), CSV, TXT. Magic-byte type checks, size limit, duplicate detection, stored originals, deletion.
- **Message imports**: SMS Backup & Restore XML, WhatsApp export (Android and iOS formats), CSV. Grouped into one record per conversation per day.
- **Database connectors**: SQLite (real file), PostgreSQL (real Postgres engine via PGlite, including proof that our read-only transaction blocks writes), MySQL session behavior (mocked connection). Allowlists, identifier validation, bound parameters, tenant column, schema-drift detection, deletion propagation, preview.
- **Hybrid search**: FTS5/BM25 on primary and alternate terms, vector similarity (tested with a deterministic test embedder), RRF fusion, exclusions, strict dates, soft or strict department and type filters, match-type labels, reasons, snippets, grouping, facets, sorting, pagination.
- **Evidence-grounded summaries**: citation verification removes invented records and quotes that aren't in the excerpt; prompt-injection text stays inside untrusted tags.
- **Evaluation**: precision at 10 and 50, and pooled recall at 10, from staff decisions only (shown as "–" until decisions exist); false positives; execution metrics; decision history.
- **Audit logs** (filter, export, secrets scrubbed), **search history**, **settings**, **user management**, **retention**, **AI usage and cost tracking**.
- **UI**: seven sections plus sign-in, keeping the existing visual identity and all three themes, responsive down to 390 px, keyboard focus, labelled controls, loading, empty and error states. Every control is wired to a tested endpoint.

## Implemented, awaiting credentials for live verification

- **Claude** (planning and summaries): request format (`/v1/messages`, `anthropic-version`, `output_config.format` json_schema), retries (429/5xx/529 with `retry-after`), refusal and truncation handling, usage tracking and fallback are all tested against a mock. **To verify live**: set `ANTHROPIC_API_KEY`, draft a plan, and confirm Settings shows real token counts.
- **Gmail**: OAuth with PKCE, state checks, token encryption, refresh, revocation, full and incremental (History API) sync, attachments, spam and trash skipping, deletion propagation, disconnect. All tested against a mock Google server. **To verify live**: create OAuth credentials (docs/SETUP.md §6), connect a test mailbox, and check sync, search, then disconnect at myaccount.google.com/permissions.
- **Semantic search providers** (Voyage, OpenAI-compatible): request code written; ranking tested with a test embedder. **To verify live**: set the `EMBEDDINGS_*` variables, sync, and look for *Similar meaning* results.
- **PostgreSQL and MySQL over the network**: the `pg` and `mysql2` drivers are wired, but only tested via PGlite and a mocked MySQL connection. **To verify live**: connect to a staging database with a read-only user.
- **OCR for images**: `tesseract.js` is wired with honest fallbacks. It needs language data downloaded on first use (or `OCR_LANG_PATH`), so it isn't exercised in automated tests.

## Partially implemented

- **Per-record permissions**: the schema and filters support `access_permissions.roles` and `access_permissions.users`, but connectors currently set sharing at source level only. Gmail label-level or folder-level sharing isn't built.
- **Entity extraction** is rule-based (dates, emails, money, capitalized names). Claude isn't used at ingest time, to keep cost and data exposure down.
- **Scaling**: rate limits and background sync are in-process; run one instance. Vectors use brute-force search in SQLite (fine for tens of thousands of chunks).
- **Scanned PDFs** without a text layer are stored and flagged, but not OCR'd (that needs page rendering). Image OCR works.
- **No multi-factor authentication or SSO**. Put production deployments behind SSO or a VPN.

## Not feasible because of external restrictions

- **Reading SMS, iMessage or WhatsApp directly from phones**: Android and iOS don't let web services read messages, and WhatsApp has no API for reading a user's chats. Import of user-created exports is supported instead.
- **Unrestricted phone storage access**: by design, only files the user picks in the system file chooser.
- **Google Drive, OneDrive, SharePoint, Outlook**: shown as *Planned*. The connector interface is ready, but no code has been built or tested, so they aren't claimed as working.

## Governance note

The original README sets two gates: no model calls until Bellevue's approved model, hosting and AI review are in place, and no city documents until their terms are confirmed. This build respects both by default: Demo mode is the default, and Claude and every connector stay off until someone configures them. Turning them on is a policy decision for the project team.

## Search permission (added)

- A permission screen (`consent.html`) appears after sign-in. Users choose "Everything I can access" or "Only the sources I choose", and must acknowledge audit logging. Real-data searches are blocked (HTTP 428) until they answer. The demo stays available.
- Users can change or withdraw the permission from Settings → Search permission. Every change is audited.
- Phone SMS and chat apps still need exports. This permission controls what the app searches; it cannot give a web server access to a phone.
- Covered by `tests/consent.test.mjs`.

## Android texts without exports (Phone Link)

- New connector **Android texts (Phone Link)** (`server/connectors/phonelink.mjs`). It reads the copy of SMS that Windows Phone Link keeps in `%LOCALAPPDATA%\Packages\Microsoft.YourPhone_*\LocalCache\Indexed\*\System\Database\phone.db`.
- Microsoft does not document that file. The connector detects the message table and its columns by name, and **Check this PC** reports the table names and counts (never message text). If a Phone Link update changes the layout, the check shows what it found instead of guessing.
- The live file is never opened. It is copied, together with its WAL journal, to `data/tmp`, read there, and the copy is deleted.
- Only someone at the PC itself (localhost) can connect it. The source is private to them by default.
- New texts are picked up every `PHONELINK_SYNC_MINUTES` and right before each search.
- Limits: Android only (iPhone texts are not stored this way), only what Phone Link has synced (recent texts), MMS pictures are not included, and WhatsApp still needs an export.
- Not yet verified against a real Phone Link file. Tested with a stand-in database in `tests/phonelink.test.mjs`.

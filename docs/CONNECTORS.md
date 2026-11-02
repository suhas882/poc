# Connectors: architecture, security and readiness

How the app connects to real sources, what each connector does, and what still needs outside approval. Setup steps for each provider are in [SETUP.md](SETUP.md) sections 6 to 8; endpoints are in [API.md](API.md).

## Architecture

```
Connected Sources page ──► /api/connectors (discovery)   /api/sources (lifecycle, health)
                           │
                           ▼
        server/connectors/registry.mjs   one table of source types: category, how it signs in, whether it syncs,
                           │             which connector does the work, lifecycle state, whether approval is needed
          ┌────────────────┼──────────────────────┬──────────────────┬─────────────────┐
     gmail.mjs        gdrive.mjs           microsoft.mjs        database.mjs      phonelink.mjs
  (Google OAuth,     (Drive, uses the     (Outlook, OneDrive,  (PostgreSQL,      (Android texts
   Gmail)            Google OAuth client)  SharePoint)          MySQL, SQLite)    on this PC)
          └────────────────┴──────────┬───────────┴──────────────────┴─────────────────┘
                                      ▼
   startSync (routes/sources.mjs): one sync per source at a time, background job row in sync_jobs,
   diagnostics, automatic retries for quotas and outages
                                      ▼
   ingest/pipeline.mjs upsertRecord: normalize → dedupe (checksum) → entities → chunks → FTS5 (BM25) → embeddings
                                      ▼
   search/hybrid.mjs: access filter in SQL first → BM25 on terms → BM25 on related wording → vector similarity
   → reciprocal-rank fusion (k = 60) → exclusions → grouping → "why it matched"
```

Every syncing connector has the same surface: `sync(source, {full, diag})` returns counts, and `disconnect(source)` returns `{revoked}`. Uploads, message imports and public documents are explicit imports instead, written by `POST /api/uploads`.

There is one sign-in system per provider, not one per source: `GmailConnector` is the Google OAuth client for Gmail and Drive, and `MicrosoftConnector` is the Microsoft identity client for Outlook, OneDrive and SharePoint. Each source still holds its own token with only its own scope.

What this app does **not** contain, despite older plans naming them: there is no ChromaDB (vectors live in SQLite), no separate "Evidence Grader" (results get a match score, a reason and an "arguably responsive" band), and no Celery or Redis (syncs are in-process background jobs, enough for one server). Record text is never sent to a language model: only the request text and plan are (test C3). The citation-checking summarizer in `server/ai/summarizer.mjs` stays unused until the project team approves sending record text to a model.

## Who can search a source

Connected sources (Gmail, Google Drive, Outlook, OneDrive, SharePoint, databases) are shared with **everyone in the organization who can search** by default, so every login sees the same connected sources and the same "Connected" state on the connector cards. When connecting, the person can choose **Only me** or **Only these roles** instead, and the owner or a Supervisor can change it later with **Sharing** (audited as `source.updated`). Only the owner sees "Reconnect needed" on a shared source; others keep searching what is already indexed.

Two kinds stay personal by default: each person's **uploads and message imports** collection, and **Android texts (Phone Link)**, where the employee reviews their own texts and sends only city business to a clerk. Organizations never see each other's sources.

## Source lifecycle

| State | Meaning | Searchable |
|---|---|---|
| `authorization_required` | Connector is ready on this server; this person has not signed in. | – |
| `pending_approval` | Connected by a non-Supervisor while **Approve new sources** is on. Not synced. | No |
| `connected` | Connected, nothing indexed yet. | Yes |
| `syncing` | A sync is running. | Yes (what is indexed) |
| `indexed` | Synced, records indexed. | Yes |
| `reauthorization_required` | The provider refused the stored access (revoked, expired, scope removed). | Yes, as last indexed; reported as partial |
| `error` | The last sync failed for another reason; Sync history shows the endpoint, status and provider message. | Yes, reported as partial |
| `needs_setup` | The server is missing credentials (for example `MICROSOFT_CLIENT_ID`). | – |
| `unsupported` / `not_connected` | Not built, or a pack placeholder (Teams). Always listed as NOT searched. | No |

Discovery (`GET /api/connectors`) only reports these states. It never signs in, starts a sync or reads anything.

## Connectors

Test column: **Live** means run against the real service with a real account; **Fake** means a local stand-in server that speaks the provider's documented API. A fake-server pass shows the code follows the API; it is not proof the live service works.

| Source | Scope or access | Sync | Deletions | Test |
|---|---|---|---|---|
| Gmail | `gmail.readonly` | History API after a first listing; skips messages already indexed | Yes | **Live** 2026-10-31: 519 messages synced from a real mailbox. Fake: rate limits, refresh, revoke |
| Google Drive | `drive.readonly` | Changes feed from a stored page token; Docs/Sheets/Slides exported | Yes (removed and trashed) | Fake only. Live: Drive API confirmed enabled in project 716431953394 (2026-11-01); sign-in not yet done |
| Outlook mail | `Mail.Read`, `User.Read` | Window of `MICROSOFT_MAIL_DAYS`; immutable IDs; skips Deleted Items and Junk | Yes | Fake only. Live blocked: no Microsoft app registration yet |
| OneDrive | `Files.Read`, `User.Read` | Delta API | Yes | Fake only. Live blocked: no Microsoft app registration yet |
| SharePoint | `Sites.Read.All` (delegated), work accounts only | Delta API on the site's document library | Yes | Fake only. Live blocked: needs a Microsoft 365 work account |
| Teams | – | Not built: needs organization-wide admin consent | – | – |
| PostgreSQL / MySQL / SQLite | Read-only account, allowlisted tables and columns, bound parameters, timeouts | Full re-read with change detection | Yes | PGlite (real Postgres engine), SQLite file, mocked MySQL session |
| Uploads (PDF, scanned PDF, DOCX, XLSX, CSV, TXT, MD, JSON, images) | Files the user picks | – | When deleted here | Real extraction and real OCR (pdfjs + tesseract, offline) in tests; ClamAV against a fake clamd |
| Message exports (SMS XML, WhatsApp, CSV) | Files the user picks | – | When deleted here | `ingest-search.test.mjs` |
| Android texts (Phone Link) | Read-only copy of Phone Link's database on this PC | On change, before searches | Yes | Stand-in database; **"Check this PC" found the real Phone Link file on 2026-11-01** |

## Security assessment

| Control | Where | Tested by |
|---|---|---|
| Read-only scopes only; no send, modify or delete scopes requested | `GOOGLE_SCOPES`, `MICROSOFT_SCOPES` | gmail, gdrive, microsoft tests assert the exact scope |
| OAuth: PKCE S256, one-time state bound to the user, 10-minute expiry | `authorize` / `handleCallback` in each connector | gmail test (other user, replay, declined) |
| Tokens and DB passwords encrypted at rest (AES-256-GCM, key outside the database) | `security.mjs` `Vault`, `source_credentials` | tests check the database file has no plaintext token |
| Existing refresh token kept when a reconnect returns none | `handleCallback` | gmail, microsoft tests (rotation kept) |
| Credentials never reach the browser | `sourceView` returns only `credentials: stored_encrypted` | `sources-lifecycle.test.mjs` |
| Organization isolation, source sharing and per-record roles/users applied in SQL before ranking | `accessFilter` in `search/hybrid.mjs` | `isolation.test.mjs` (keyword, vector, hybrid, preview, expansion, export, report, listings, other organization) |
| No record text to a language model | `ai/planner.mjs`, C3 rule | `claude.test.mjs` |
| Prompt injection in records is data, not instructions | records never reach the model; planner input is wrapped | `claude.test.mjs` G1 |
| SSRF: OAuth and Graph next-page links must stay on the provider's host; SharePoint addresses must be `https://….sharepoint.com`; OneDrive downloads go to the pre-signed URL without the token | `microsoft.mjs` | microsoft tests |
| Database writes impossible: read-only transaction or session, SELECT-only query builder, identifier allowlists | `connectors/database.mjs` | `database.test.mjs` (write blocked on real Postgres engine) |
| Upload checks: type sniffing, size limit, duplicates, optional ClamAV, originals outside the web root | `routes/sources.mjs`, `ingest/scan.mjs` | `uploads-security.test.mjs` |
| CSRF and Origin checks, session cookies, lockout, rate limits | `app.mjs`, `auth.mjs` | `auth.test.mjs` |
| Tamper-evident audit log, including approvals and refused uploads | `audit.mjs` | workflow D1/G3 test |

Known gaps: no multi-factor sign-in or SSO (put production behind SSO or a VPN); in-process jobs and rate limits mean one server instance; vectors are brute-force in SQLite (fine for tens of thousands of chunks); OCR quality depends on the scan, and only the first `OCR_MAX_PDF_PAGES` pages of a scanned PDF are read.

## Production readiness checklist

- [ ] HTTPS address set as `PUBLIC_URL`; `TRUST_PROXY=true` only behind a proxy you control.
- [ ] `CREDENTIAL_ENCRYPTION_KEY` and `IP_HASH_SALT` set from a secrets store, not the repository.
- [ ] Persistent disk for `DATA_DIR` (Render paid disk, or AWS EC2/Lightsail), with backups of `records.db`.
- [ ] Google: production redirect URI registered; OAuth app verified by Google (restricted scopes need a security assessment), or kept *Internal* to a Workspace domain.
- [ ] Microsoft: production redirect URI registered; tenant administrator consent where user consent is off; a Microsoft 365 tenant to test SharePoint.
- [ ] ClamAV running and `CLAMAV_REQUIRED=true` if uploads come from outside staff.
- [ ] **Approve new sources** switched on if Clerks may connect sources.
- [ ] Bellevue approvals still open (STATUS-FOR-MADHU.md): approved model and hosting, AI records retention, system of record.

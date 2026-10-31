# API reference

Every endpoint returns JSON shaped as `{ "ok": true, "data": …, "meta"?: … }`, or on error `{ "ok": false, "error": { "code", "message", "details"? } }`. Messages are written for the person using the app.

Requests that change data need the session cookie and an `X-CSRF-Token` header. The token comes from `GET /api/auth/status` or the sign-in response. List endpoints accept `page` and `pageSize`, and return `meta: { page, pageSize, total }`.

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | none | Liveness check. |
| GET | `/api/auth/status` | none | Mode, whether setup is needed, current user, CSRF token. |
| POST | `/api/auth/setup` | none (only when no users exist; localhost or `setupToken`) | Create the organization and first administrator. |
| POST | `/api/auth/login` | none | `{email, password}`. Sets the session cookie. |
| POST | `/api/auth/logout` | signed in | End the session. |
| GET | `/api/system/status` | sources.read | What is configured: Claude, embeddings, Gmail, encryption, OCR, drivers. |
| GET | `/api/users` · POST `/api/users` · PATCH `/api/users/:id` | users.manage | List, create, change role, disable, reset password. |
| GET | `/api/connectors` | sources.read | Connector catalog with honest availability. |
| GET | `/api/sources` | sources.read | Sources visible to the user, with status, counts, scopes and sharing. |
| PATCH | `/api/sources/:id` | sources.manage (owner or admin) | `{name?, visibility?, allowedRoles?, query?}`. |
| POST | `/api/sources/:id/sync` | sources.manage | Start a background sync (`{full?: true}`). Returns `202 {jobId}`. |
| GET | `/api/sources/:id/jobs` | sources.read | Last 20 sync jobs. |
| DELETE | `/api/sources/:id` | sources.manage | Disconnect: revoke at the provider, delete credentials, records and files. |
| POST | `/api/connectors/gmail/authorize` | sources.manage | `{query?, shareWithRoles?}` → `{url}` for Google's consent page. |
| GET | `/oauth/google/callback` | signed in | OAuth redirect target. Redirects to `/sources.html?connected=…` or `?error=…`. |
| POST | `/api/uploads?kind=document\|messages&sourceId=` | uploads.create | Raw file body plus an `X-File-Name` header. Returns the extraction result. |
| GET | `/api/sources/:id/records` | records.read | Records in a source (for managing uploads). |
| DELETE | `/api/records/:id` | sources.manage | Delete an uploaded document or message record. |
| POST | `/api/connectors/database/inspect` | sources.manage | Test a connection and list tables and columns. |
| POST | `/api/sources/database` | sources.manage | Create a read-only database source with a table and column mapping. |
| POST | `/api/sources/:id/preview` | sources.manage | `{table, keyword?, since?}` → at most 20 rows, read-only. |
| POST | `/api/searches/plan` | search.run | `{requestText, mode}` → `{searchId, plan, origin, model, fallbackReason, sources}`. |
| POST | `/api/searches/:id/run` | search.run (owner) | `{plan, confirmed: true}` → `{total, stats}`. |
| GET | `/api/searches/:id` | own search, or history.read_all | Request, confirmed plan, status, summary. |
| GET | `/api/searches/:id/results` | records.read | Filters: `sourceType, matchType, band, department, judgment, group=1`, and `sort=newest\|oldest\|title`. Includes facets. |
| POST | `/api/searches/:id/summary` | search.run | Claude evidence summary with verified citations. |
| GET | `/api/searches/:id/export?format=csv\|json` | export.create | Audited export. |
| GET | `/api/searches?scope=all&mode=&q=` | history.read_own / history.read_all | Search history. |
| GET | `/api/records/:id` | records.read | Full record (audited), related thread items. |
| GET | `/api/records/:id/original` | records.read | Original uploaded file (audited). |
| PUT | `/api/searches/:id/evaluations/:recordId` | evaluate.write | `{judgment: relevant\|not_relevant\|unsure, note?}`. |
| GET | `/api/evaluations/summary?scope=all&mode=` | evaluate.write or history.read_all | Metrics from staff decisions, false positives, history. |
| GET | `/api/audit` · `/api/audit/export` | audit.read | Filter by `action, category, userId, outcome, from, to`. CSV export is audited. |
| GET | `/api/settings` · PATCH `/api/settings` | signed in · settings.manage | Organization defaults. |
| POST | `/api/settings/retention/apply` | settings.manage | Run the retention purge now. |
| GET | `/api/usage` | usage.read | Claude calls, tokens and estimated cost for the last 30 days. |

## Search plan shape

```json
{
  "summary": "…", "keywords": [], "alternateTerms": [], "phrases": [], "people": [], "organizations": [], "locations": [],
  "dateFrom": "2025-01-01", "dateTo": "2025-03-31", "departments": [], "recordTypes": [],
  "filterDepartments": false, "filterRecordTypes": false, "sourceIds": [], "exclusions": [],
  "clarifyingQuestions": [], "notes": []
}
```

`sourceIds: []` means every source the user may search. Departments and record types raise a record's ranking unless `filterDepartments` or `filterRecordTypes` is true, in which case they become strict filters.

## Search permission

After sign-in, anyone who can search must choose what the app may search for them before running a real-data search. Until they do, `POST /api/searches/plan` and `/run` return `428 consent_required`, and `/api/auth/status` reports `consentRequired: true`.

- `GET /api/consent` returns `{ consent, version, sources }`, where `sources` is every real source the user can access.
- `PUT /api/consent` with `{ scope: "all" | "selected", sourceIds: [], acknowledged: true }` grants or changes the permission. With `selected`, only the listed sources are ever searched. Sources added later are not included.
- `DELETE /api/consent` withdraws the permission.

Every change is written to the audit log (`consent.granted`, `consent.changed`, `consent.withdrawn`). Raising `CONSENT_VERSION` in `server/consent.mjs` asks everyone again.

## Phone Link (Android texts)

- `GET /api/connectors/phonelink/check`: whether Phone Link's file was found, which table and columns were recognized, and message and conversation counts with the date range. Requires `sources.manage` and a request from localhost.
- `POST /api/connectors/phonelink/connect` with `{ acknowledged: true }`: creates a private `messages` source with `config.provider = "phonelink"` and starts the first sync.
- `POST /api/sources/:id/sync` re-reads Phone Link. Searches also refresh it automatically when the file has changed.

## PC sync helper

- `GET/POST /api/agent-tokens` and `DELETE /api/agent-tokens/:id` (signed in, `sources.manage`): list, create (`{ name, acknowledged: true }`, which returns the key once and creates a private source) and revoke helper keys.
- `GET /api/agent/whoami` and `POST /api/agent/messages` (`Authorization: Bearer prs_agent_...`): used by `agent/phonelink-sync.mjs`. The messages body is `{ messages: [{ conversation, from, to, at, body }] }`, at most 2000 per request. Each conversation-day sent replaces the stored copy of that day.

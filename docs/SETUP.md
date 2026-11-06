# Setup

## Two ways to run it

| | Real sources | Sign-in |
|---|---|---|
| Your PC (`start.bat`) | Allowed (`REAL_SOURCES=true` is set by start.bat) | Create the first Supervisor account at http://localhost:8765 |
| Hosted demo (Render, later AWS) | Off. Leave `REAL_SOURCES` unset. | Visitors choose a demo role. Each visitor gets a private workspace with invented accounts, deleted after three days. |

With real sources off, the server refuses Gmail, staff uploads, message imports, database connectors, Phone Link and the PC sync helper. Only invented records and public documents (with web address, retrieval date and a terms check) are allowed. Nothing in the web interface can turn real sources on.

Admin switches in Settings (off by default): Phone Link texts (needs real sources), second-person approval, and approval of new sources (a Supervisor approves each source another role connects before it is synced or searched). City packs (Bellevue, Sample City) hold departments, record types, holidays, wording, review rules, the broad-plan warning level and the source map.

# Setup, configuration and deployment

## 1. Requirements

- Node.js **24 or newer** (24 LTS recommended). The server uses Node's built-in SQLite module.
- No database server is needed for the app itself: its data lives in `data/records.db`.

## 2. Install and run

```powershell
npm install          # installs the PDF reader, plus optional pg, mysql2 and tesseract.js drivers
npm run build        # compiles app.ts and client/*.ts (the compiled .js files are committed too)
copy .env.example .env   # macOS/Linux: cp .env.example .env
node server.js
```

Open http://localhost:8765/.

- **Demo mode** (the default) works straight away with the 18 synthetic requests. It needs no account and makes no server or AI calls.
- **Real data mode**: open `/login.html` on the same computer and create the first administrator. The setup form only works from `localhost`, or from anywhere if you set `SETUP_TOKEN` and enter it. On a server with no browser, use the CLI instead:

  ```powershell
  $env:ADMIN_PASSWORD="a long passphrase"; node scripts/create-admin.mjs --email you@city.gov --name "Your Name" --org "City of Example"
  ```

Add more people under **Settings → Users and roles**. The roles are:

| Role | Can |
| --- | --- |
| Administrator | Everything, including users, settings and every source's settings. Sees only the records shared with them, like everyone else. |
| Records officer | Connect sources, upload, search, review, export. |
| Reviewer | Search sources shared with reviewers, and record relevance decisions. |
| Auditor | Read audit logs and everyone's search history. Cannot search or open records. |

## 3. Credential encryption (required before connecting Gmail or a password-protected database)

Generate a key and keep it outside the database, for example in your host's secret manager:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set it as `CREDENTIAL_ENCRYPTION_KEY`. In development, if no key is set, one is generated at `data/.credential-key` and the server prints a warning. With `NODE_ENV=production`, connectors refuse to store secrets until a key is set.

## 4. Claude

1. Create an API key in the Claude Console (console.anthropic.com).
2. Set `ANTHROPIC_API_KEY`. Optionally set `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`).
3. Optional: set `ANTHROPIC_PRICE_INPUT_PER_MTOK` and `ANTHROPIC_PRICE_OUTPUT_PER_MTOK` from Anthropic's pricing page so Settings can show an estimated cost. Token counts are always recorded.

Claude drafts search plans and writes evidence summaries. It uses structured outputs (`output_config.format` with a JSON schema), and every response is validated again on the server. If the key is missing or a call fails, plans fall back to local rules and the interface says so. Summaries are simply unavailable. The key never reaches the browser.

## 5. Semantic (vector) search, optional

Keyword (BM25) search works without it. Anthropic does not offer an embeddings API, so choose one of these:

- **Voyage AI** (the option Anthropic's docs point to): `EMBEDDINGS_PROVIDER=voyage`, `EMBEDDINGS_API_KEY=…`, and `EMBEDDINGS_MODEL=` set to a current model from docs.voyageai.com.
- **Any OpenAI-compatible `/embeddings` endpoint**, including a model you host yourself: `EMBEDDINGS_PROVIDER=openai-compatible`, `EMBEDDINGS_BASE_URL=http://…/v1`, `EMBEDDINGS_MODEL=…`.

Vectors are stored in SQLite and searched by cosine similarity, with no extra infrastructure. That's fine for tens of thousands of chunks; beyond that, move to pgvector. Records are embedded after each sync or upload. After switching models, run a sync on each source and existing chunks are embedded with the new model.

## 5a. Sign in with Google or Microsoft

The sign-in page shows **Continue with Google** and **Continue with Microsoft** when that provider's credentials (sections 6 and 6a) are set and real sources are on. Nothing extra needs registering: sign-in reuses the same redirect URIs as the connectors.

- Only people a Supervisor has already added (Settings → Users) can sign in this way. The provider's **verified** email must match; the first sign-in then links the provider's stable account ID to that user. Accounts are never created by signing in.
- **New people** who sign in with Google or Microsoft and have no account land on **Request access**. It shows the name and email the provider verified (they cannot be edited), and asks for an organization and a reason. Nothing is created: the request waits in **Settings → Access requests**, where a Supervisor approves it with a role (the account is created in the Supervisor's own organization and linked to the exact provider account that asked, by its account ID, never by email) or rejects it. One open request per provider account and per email; every request and decision is audited. A request that names an organization on this server is shown only to that organization's Supervisors.
- Approved people have no usable password; they sign in with the account they asked from and land on Connected Sources, where each service (Gmail, Drive, Outlook, OneDrive, SharePoint) is connected separately.
- Once a person has a Google (or Microsoft) account linked, a different account from that provider showing the same email is refused rather than linked.
- Sign-in asks only for identity (`openid email profile`; Microsoft also `User.Read`). Its tokens are used once to read the identity and are not stored. Reading mail or files is a separate consent per source, offered straight after sign-in on Connected Sources.
- Microsoft work accounts are matched by their user principal name (a domain the organization verified), not the editable `email` claim. Personal Microsoft accounts use the account's own address.
- Authorization code flow with PKCE, a nonce, and a one-time state in a 10-minute encrypted cookie. Every sign-in and refusal is in the audit log.
- Google: no extra scope needs adding to the consent screen for sign-in (`openid`, `email` and `profile` are non-sensitive).

## 5b. One-time owner setup, then users just connect

The application owner sets up Google (section 6) and Microsoft (section 6a) **once**, on the server: client IDs and secrets live only in environment variables or the downloaded client file, never in the browser. After that, every approved user connects their own accounts from **Connected Sources** by signing in and granting permission; they never create projects, registrations, keys or redirect URIs. Each user's tokens are stored encrypted per source and are never used for anyone else.

**Settings → Application Integration Settings** (Supervisors only) shows whether that setup works: client credentials accepted, redirect URIs valid, Gmail API and Drive API enabled, Microsoft registration present, and what each provider still requires. **Check configuration** asks Google and Microsoft whether the client is accepted (using a deliberately invalid code, so no one is signed in), and probes the APIs only with the checking Supervisor's own connections. Secrets and tokens are never shown. Every check is audited.

What one-time setup cannot remove: Google's verification for the restricted Gmail and Drive scopes before people outside the test-user list can connect (or an Internal app in a Workspace domain), and, for some Microsoft organizations, an administrator's consent. SharePoint needs a Microsoft 365 work or school account.

## 6. Gmail and Google Drive

Both use the same Google OAuth client. Each source gets its own token with only its own scope: `gmail.readonly` for Gmail, `drive.readonly` for Drive.

1. In Google Cloud Console, create a project and **enable the Gmail API** (and the **Google Drive API** for Drive).
2. Under **OAuth consent screen**, choose *Internal* if you use Google Workspace (only your domain can connect). Add the scopes `https://www.googleapis.com/auth/gmail.readonly` and, for Drive, `https://www.googleapis.com/auth/drive.readonly`. Both are **restricted scopes**: an *External* app in *Testing* works only for the listed test users, and its refresh tokens expire after 7 days. Publishing it to production does not skip review: Google requires OAuth verification and, for restricted scopes, a security assessment before people outside the test-user list can connect. An *Internal* app (Google Workspace) needs neither.
3. Under **Credentials**, create an **OAuth client ID** of type *Web application*. Add the authorized redirect URI `PUBLIC_URL/oauth/google/callback` (for example `http://localhost:8765/oauth/google/callback`, or your https address in production).
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (plus `GOOGLE_REDIRECT_URI` if it differs from the default).
5. In the app, go to **Connected Sources → Connect Gmail** (or **Connect Google Drive**), read the consent summary, and continue to Google. Google shows its consent screen once per source; after that the stored, encrypted refresh token keeps the source working across sessions, and a new consent is only asked for if the access is revoked or expires.

How it behaves:
- The flow is authorization code with PKCE and a one-time, user-bound `state`. Only `gmail.readonly` is requested.
- Messages matching the filter (default `newer_than:2y`) are indexed, along with attachments in supported formats. Spam and trash are skipped.
- Sync is incremental through Gmail's History API. Deleted or trashed messages are removed from the index.
- **Disconnect** revokes the token at Google and deletes the stored credentials and every indexed message and attachment.
- Drive: the first sync lists My Drive and files shared with the user (not the trash); later syncs read only Drive's Changes feed, including edits, trashed and removed files. Google Docs, Sheets and Slides are exported as text or CSV; other files are downloaded when their format is supported (up to `GDRIVE_MAX_FILE_BYTES`).
- In Google Workspace, an administrator may need to allow the app under *Security → API controls*.
- If a sync stops with `rateLimitExceeded`, Gmail's per-minute quota was hit. The sync waits and retries on its own; what was fetched is kept, and already indexed messages are never fetched again. **Sync history** shows the endpoint, HTTP status and Google's reason for every failed run.

## 6a. Outlook mail, OneDrive and SharePoint (Microsoft Graph)

Outlook and OneDrive work with personal Microsoft accounts (Outlook.com, Hotmail, Live) and work or school accounts. SharePoint exists only for work or school (Microsoft 365) accounts.

**Teams is not built.** Reading channel messages needs `ChannelMessage.Read.All`, which requires an administrator's consent for the whole organization, and there is no personal-account equivalent. Until a Microsoft 365 tenant grants that, Teams stays listed as NOT searched. Exports from Microsoft Purview eDiscovery can be uploaded instead.

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com) (a personal account such as Outlook.com works) and open **App registrations → New registration**.
2. Name it (for example *Public Records Search*). Under **Supported account types**, choose *Accounts in any organizational directory and personal Microsoft accounts*.
3. Under **Redirect URI**, choose platform *Web* and enter `PUBLIC_URL/oauth/microsoft/callback`, for example `http://localhost:8765/oauth/microsoft/callback` (Microsoft allows http only for localhost; use your https address in production).
4. Copy the **Application (client) ID**. Then open **Certificates & secrets → New client secret** and copy the secret's **Value** (it is shown once).
5. Under **API permissions**, add *Microsoft Graph → Delegated*: `Mail.Read`, `Files.Read`, `User.Read`, `offline_access`, and for SharePoint `Sites.Read.All`. None of these need administrator consent for a personal account. In a work tenant the administrator may have turned off user consent; then use **Grant admin consent** on this page (or ask the tenant administrator to).
6. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` in `.env` and restart the server. **Settings → Server configuration** shows the redirect URI the server expects.
7. In the app, go to **Connected Sources → Connect Outlook mail**, **Connect OneDrive** or **Connect SharePoint** (enter the site address, for example `https://contoso.sharepoint.com/sites/Records`), read the consent summary, and continue to Microsoft.

How it behaves:
- Authorization code with PKCE and a one-time, user-bound `state`. Each source asks only for its own scope: `Mail.Read` for Outlook, `Files.Read` for OneDrive.
- Outlook: mail received in the last two years (`MICROSOFT_MAIL_DAYS`), from every folder except Deleted Items and Junk, plus attachments in supported formats. Immutable message IDs are used, so moving a message does not re-index it. Messages that are deleted or moved to Deleted Items or Junk are removed from the index.
- OneDrive: PDF, Word, Excel, CSV, text and image files up to 10 MB (`MICROSOFT_MAX_FILE_BYTES`). Sync uses Graph's delta API, so later runs pick up only changes and deletions. Files are downloaded from Microsoft's pre-signed link without sending the token there.
- Throttling (HTTP 429 with `Retry-After`) waits and retries. Sync history shows the Graph endpoint, status and Microsoft's error code for failed runs.
- Once Outlook or OneDrive is connected, the "Exchange mail" or "OneDrive" placeholder no longer appears as NOT searched.
- **Disconnect** deletes the stored tokens and every indexed item. Microsoft has no revoke call for this flow; to remove the app from the account too, use [account.live.com/consent/Manage](https://account.live.com/consent/Manage) (personal) or [myapps.microsoft.com](https://myapps.microsoft.com) (work).

- SharePoint: one source per site, reading the site's default document library with the same delta sync as OneDrive. Only `https://….sharepoint.com` addresses are accepted.

## 6b. Sync retries and source approval

- A sync that fails on a quota or a temporary outage (`gmail_rate_limited`, `gmail_unavailable`, `microsoft_throttled`, `microsoft_unavailable`) retries on its own `SYNC_RETRIES` times (default 3), waiting `SYNC_RETRY_DELAY_MS` × attempt (default 2 minutes). Indexed items are never fetched twice. Only one sync per source runs at a time.
- With **Approve new sources** on (Settings → Admin switches), a source connected by anyone but a Supervisor waits as *Awaiting approval*: it is not synced, not searched and visible only to its owner and Supervisors until a Supervisor approves or rejects it on Connected Sources. Every request, approval and rejection is in the audit log.

## 7. Uploads, phone files and message exports

- **Documents**: PDF, DOCX, XLSX, CSV, TXT, MD, JSON and images. JSON is indexed as `path: value` lines so field names stay searchable; invalid JSON is refused. On a phone, the browser's file picker opens the system file chooser, which is the only access the app gets.
- **Checks on every upload**: the file's bytes must match its extension, the size limit applies (`UPLOAD_MAX_BYTES`), identical files are not stored twice, and the original is kept outside the web root. Each record keeps its file name, size, SHA-256, uploader and upload time.
- **Malware scanning (optional)**: run ClamAV's `clamd` and set `CLAMAV_HOST` (and `CLAMAV_PORT`, default 3310). Every upload and message export is scanned before it is parsed or stored; infected files are refused and logged as `upload.rejected`. With `CLAMAV_REQUIRED=true` uploads are refused while the scanner is unreachable; otherwise they go through marked `not_scanned`.
- **Scanned PDFs** (no text layer) are read by OCR on this server: each page is rendered with pdfjs and `@napi-rs/canvas` (both installed with `pdfjs-dist`) and read by `tesseract.js`. Up to `OCR_MAX_PDF_PAGES` pages (default 20) at `OCR_PDF_SCALE` (default 2, about 144 dpi). The same applies to scanned PDFs from Gmail, Drive, Outlook, OneDrive and SharePoint. Nothing is sent to an outside service.
- **OCR**: `tesseract.js` is installed as an optional dependency. It downloads `eng.traineddata` on first use; for offline servers, point `OCR_LANG_PATH` at a folder that contains it. Set `OCR_ENABLED=false` to turn it off.
- **Messages**: phones don't let web services read SMS or chat apps, so import exports you make yourself:
  - Android **SMS Backup & Restore** XML.
  - WhatsApp **Export chat** (.txt, "without media").
  - CSV with `date, from, to, body` columns (optional `conversation`).
  - iPhone has no built-in SMS export. Use a desktop export tool that writes CSV.

## 8. Databases (read-only)

**Connected Sources → Connect PostgreSQL / MySQL / SQLite**:
1. Enter connection details and click **Test connection and list tables**.
2. Choose each table's ID, title, text columns, and optionally date, department and a link template.
3. Choose who can search it.

- Use a database account with **read-only** permissions. The app also opens read-only transactions with a statement timeout, and only runs SELECTs it builds itself, with bound parameters, on allowlisted tables and columns.
- For a shared database, set the *organization column* and value so only your rows are copied.
- SQLite files must be placed in `data/connectors/`.

## 9. Deploying

- Run behind HTTPS and set `PUBLIC_URL=https://…` (this turns on `Secure` cookies). Set `NODE_ENV=production`, `CREDENTIAL_ENCRYPTION_KEY`, and `TRUST_PROXY=true` if a proxy sets `X-Forwarded-For`.
- `DATA_DIR` must be on a **persistent disk**. Back up `records.db`, the `uploads/` folder, and your key.
- **Render**: the included `render.yaml` deploys the *public synthetic demo* (`DEMO_ONLY=true`) on the free plan. For real data, use a paid instance with a persistent disk mounted at `DATA_DIR`. Then remove `DEMO_ONLY` and add the variables above, plus `SETUP_TOKEN` for first-run setup.
- The rate limits and session store are in memory and SQLite, so run **one** instance. Scaling out needs a shared store.

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Node.js … is too old` | Install Node 24 LTS or newer. |
| Setup says "only from this computer" | Open the app via `http://localhost:8765`, or set `SETUP_TOKEN` and enter it, or use `scripts/create-admin.mjs`. |
| Gmail: `redirect_uri_mismatch` | The URI registered in Google Cloud must equal `PUBLIC_URL/oauth/google/callback` exactly. |
| Gmail: "Read access … was not granted" | The consent screen's checkbox for Gmail was unticked. Connect again and leave it ticked. |
| Gmail source shows *Needs attention* | Access was revoked or expired. Use **Reconnect Gmail** on the card. |
| Database: `schema_changed` | A mapped column was renamed or dropped. Remove and reconnect the source with the new columns. |
| Plans say "Drafted by local rules" | Claude isn't configured or the call failed; the reason is shown on the plan. Check Settings and the server log. |
| Images upload but aren't searchable | OCR is unavailable; see the note on the uploaded file and section 7. |

## Hosting on Render or AWS: keep the data

The app stores everything in one SQLite file (`DATA_DIR/records.db`). That folder has to survive restarts and deploys:

- **Render:** the free plan's disk is erased on every deploy and restart (and free services restart after about 15 idle minutes). Use a paid instance with a **persistent disk**, and set `DATA_DIR` to its mount path (see the comments in `render.yaml`). Set `PUBLIC_URL` to your https address.
- **AWS:** run it on EC2 or Lightsail with an EBS volume (or the instance's own disk), with `DATA_DIR` pointing at that volume. Put it behind HTTPS (a load balancer, CloudFront, or Caddy/nginx) and set `PUBLIC_URL`. Take EBS snapshots for backups. Avoid platforms whose disks reset (for example App Runner or Fargate without EFS).
- Set `CREDENTIAL_ENCRYPTION_KEY` in the host's environment so stored credentials can still be decrypted after a move.

## Android texts: companion app (recommended)

Pair your Android phone once and its texts sync automatically, with no export and no Phone Link. See [ANDROID.md](ANDROID.md) for building the app, the Google Play SMS policy, and testing steps. Pair from the site's **https** address: a phone cannot reach `localhost`.

## Android texts on a hosted server: PC sync helper

Note: recent Windows Phone Link versions encrypt their message database, so this helper may find no readable texts. Use the companion app above instead.

A hosted server cannot read files on your PC, so Phone Link texts reach it through a small helper on the Windows PC:

1. On the Windows PC where Phone Link is set up, in this project folder, double-click `phonelink-sync.bat`. Enter the site's https address, then press Enter to pair. The helper shows a pairing code such as `ABCD-2345`.
2. On the website, go to Connected Sources → Android texts (Phone Link) → **PC sync helper**, type the code and confirm. The helper receives its key by itself within a few seconds. Codes expire after 10 minutes and work once.
3. It sends your texts, then checks for new ones every few minutes. To run it at sign-in, put a shortcut to `phonelink-sync.bat` in `shell:startup`.

You can still create a key on the website (under "Or create a key to paste into the helper") and paste it at step 1 instead of pressing Enter.

Options: `phonelink-sync.bat --once` (send what is new, then exit), `--full` (resend everything), `--pair` (pair again with a new code, for example after revoking the key), `--setup` (change the address, then pair or paste a key). The key is saved in `agent/phonelink-sync.json`, which is in `.gitignore`. Keep it private, and revoke it on the website if the PC is lost. If the server's data was reset, the helper notices the source is empty and sends everything again.

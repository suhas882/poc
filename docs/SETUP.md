# Setup

## Two ways to run it

| | Real sources | Sign-in |
|---|---|---|
| Your PC (`start.bat`) | Allowed (`REAL_SOURCES=true` is set by start.bat) | Create the first Supervisor account at http://localhost:8765 |
| Hosted demo (Render, later AWS) | Off. Leave `REAL_SOURCES` unset. | Visitors choose a demo role. Each visitor gets a private workspace with invented accounts, deleted after three days. |

With real sources off, the server refuses Gmail, staff uploads, message imports, database connectors, Phone Link and the PC sync helper. Only invented records and public documents (with web address, retrieval date and a terms check) are allowed. Nothing in the web interface can turn real sources on.

Admin switches in Settings (off by default): Phone Link texts (needs real sources) and second-person approval. City packs (Bellevue, Sample City) hold departments, record types, holidays, wording, review rules, the broad-plan warning level and the source map.

# Setup, configuration and deployment

## 1. Requirements

- Node.js **22.13 or newer** (24 LTS recommended). The server uses Node's built-in SQLite module.
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

## 6. Gmail

1. In Google Cloud Console, create a project and **enable the Gmail API**.
2. Under **OAuth consent screen**, choose *Internal* if you use Google Workspace (only your domain can connect). Add the scope `https://www.googleapis.com/auth/gmail.readonly`. It's a restricted scope: an *External* app needs Google's verification before anyone outside the test-user list can connect.
3. Under **Credentials**, create an **OAuth client ID** of type *Web application*. Add the authorized redirect URI `PUBLIC_URL/oauth/google/callback` (for example `http://localhost:8765/oauth/google/callback`, or your https address in production).
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (plus `GOOGLE_REDIRECT_URI` if it differs from the default).
5. In the app, go to **Connected Sources → Connect Gmail**, read the consent summary, and continue to Google.

How it behaves:
- The flow is authorization code with PKCE and a one-time, user-bound `state`. Only `gmail.readonly` is requested.
- Messages matching the filter (default `newer_than:2y`) are indexed, along with attachments in supported formats. Spam and trash are skipped.
- Sync is incremental through Gmail's History API. Deleted or trashed messages are removed from the index.
- **Disconnect** revokes the token at Google and deletes the stored credentials and every indexed message and attachment.
- In Google Workspace, an administrator may need to allow the app under *Security → API controls*.

## 7. Uploads, phone files and message exports

- **Documents**: PDF, DOCX, XLSX, CSV, TXT and images. On a phone, the browser's file picker opens the system file chooser, which is the only access the app gets.
- **Scanned PDFs** have no text layer. Upload page images instead (OCR), or OCR the PDF elsewhere first.
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
| `Node.js … is too old` | Install Node 22.13+ (24 LTS). |
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

## Android texts on a hosted server: PC sync helper

A hosted server cannot read files on your PC, so Phone Link texts reach it through a small helper on the Windows PC:

1. On the website, go to Connected Sources → Android texts (Phone Link) → **PC sync helper**, and create a key (shown once).
2. On the Windows PC where Phone Link is set up, in this project folder, double-click `phonelink-sync.bat`. Paste the site's https address and the key.
3. It sends your texts, then checks for new ones every few minutes. To run it at sign-in, put a shortcut to `phonelink-sync.bat` in `shell:startup`.

Options: `phonelink-sync.bat --once` (send what is new, then exit), `--full` (resend everything), `--setup` (change the address or key). The key is saved in `agent/phonelink-sync.json`, which is in `.gitignore`. Keep it private, and revoke it on the website if the PC is lost. If the server's data was reset, the helper notices the source is empty and sends everything again.

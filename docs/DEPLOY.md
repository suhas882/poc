# Deploying: Azure now, AWS (or anywhere) later

Nothing in the app is specific to a cloud. Two ways to run it, both configured only through environment variables:

- **Option A, Azure App Service (Web App):** runs the code directly, no Docker. Quickest start.
- **Option B, a VM with Docker** (`Dockerfile`, `docker-compose.yml`, Caddy for HTTPS): the same files on Azure, AWS EC2
  or Lightsail, or any Linux server.

Moving between them, or to AWS later, is "back up, copy, restore, point the name at the new server".

**The one thing to know about storage.** All state is one SQLite database plus uploaded files in one folder. SQLite is
safest on a local disk (option B). App Service keeps files on a network share, where SQLite needs `SQLITE_JOURNAL_MODE=DELETE`
and a single instance; that is fine for this POC. Never put the data folder on Azure Files or AWS EFS shared by several
instances. (Moving to managed PostgreSQL is a larger change; not needed for the POC.)

## Option A: Azure App Service (Web App), no Docker needed

Simplest to start with. App Service runs the code directly, gives you `https://<name>.azurewebsites.net` with its
certificate, and builds from GitHub. Two rules because App Service keeps files on a network share (`/home`):
`SQLITE_JOURNAL_MODE=DELETE`, and **exactly one instance** (no scale-out, no deployment-slot swaps on live data).
Fine for this POC; for more users or heavier syncs, use the VM (option B) or move the data to a managed database.

1. **Create a resource → Web App** (choose **Web App**, *not* "Web App + Database": that adds a PostgreSQL or MySQL
   server this app does not use, and you would pay for it).
   - Publish: **Code**. Runtime stack: **Node 24 LTS**. Operating system: **Linux**. Region: near your users.
   - Pricing plan: **Basic B1** or higher (Free F1 sleeps and has no "Always On"; B1 is about the cost of a small VM).
   - Name, for example `records-poc` → `https://records-poc.azurewebsites.net`.
2. **Deployment Center** → Source **GitHub** → your repository and branch. Azure adds a GitHub Actions workflow that
   installs, builds (`npm run build`) and deploys on every push. (Commit and push this project first.)
3. **Settings → Environment variables → App settings** (these are the server's environment; the browser never sees them):

   | Name | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `REAL_SOURCES` | `true` |
   | `PUBLIC_URL` | `https://records-poc.azurewebsites.net` |
   | `TRUST_PROXY` | `true` |
   | `DATA_DIR` | `/home/data` (kept across restarts and deployments) |
   | `SQLITE_JOURNAL_MODE` | `DELETE` |
   | `OCR_LANG_PATH` | `/home/site/wwwroot` |
   | `CREDENTIAL_ENCRYPTION_KEY` | `openssl rand -base64 32`, or the old server's key when moving data |
   | `IP_HASH_SALT` | `openssl rand -hex 16` |
   | `SETUP_TOKEN` | only for an empty server (first Supervisor) |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google Cloud |
   | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` | from Entra |

   For secrets you can use Key Vault references instead of plain values (`@Microsoft.KeyVault(SecretUri=…)`).
   App Service sets `PORT` itself; leave it alone. The startup command is the default (`npm start`).
4. **Settings → Configuration → General settings:** Always On **On**, HTTPS Only **On**, ARR affinity Off.
   **Monitoring → Health check:** path `/api/health`.
5. **Scale out:** keep **1 instance**. Do not enable autoscale.
6. Register the redirect URIs with Google and Microsoft (step 3 below, with your `azurewebsites.net` host).
7. **Moving your existing data:** run `node scripts/backup.mjs` locally, then upload the backup's `records.db` and its
   `uploads` and `connectors` folders into `/home/data` (App Service → **Advanced Tools (Kudu) → Debug console**, drag and drop),
   with the app stopped. Use the same `CREDENTIAL_ENCRYPTION_KEY` as the old server. Then start the app.
8. **Backups:** enable **Settings → Backups** (copies `/home`, including the database), and/or run
   `node scripts/backup.mjs` from the Kudu SSH console.

Moving later: the code is unchanged on a VM, AWS or anywhere else; restore a backup there (option B, step 5).

## Option B: a VM with Docker (any cloud)

### What you need

- An Azure subscription. A **B2s** VM (2 vCPU, 4 GB) is comfortable with OCR; a **B1s** works for light use and is in
  the 12-month free tier (750 hours a month).
- The values for `deploy/.env.production.example`: Google and Microsoft client IDs and secrets, and two random secrets.

### 1. Create the VM (Azure portal, about 5 minutes)

1. **Create a resource → Virtual machine.** Image *Ubuntu Server 24.04 LTS*, size *B2s* (or *B1s*), authentication *SSH public key*.
2. **Inbound ports:** allow **SSH (22), HTTP (80), HTTPS (443)**. Nothing else; the app's own port 8765 stays closed.
3. **Disks:** the default Premium SSD is fine (the database lives on it).
4. After creation: **Networking → Public IP → Configuration → DNS name label**, for example `records-poc`. Your free
   address becomes `records-poc.<region>.cloudapp.azure.com`. Use your own domain instead if you have one (an A record
   pointing at the public IP).

Azure CLI equivalent (optional):

```bash
az group create -n records-poc -l eastus
az vm create -g records-poc -n records-poc --image Ubuntu2404 --size Standard_B2s --admin-username azureuser --generate-ssh-keys --public-ip-address-dns-name records-poc
az vm open-port -g records-poc -n records-poc --port 80 --priority 1001
az vm open-port -g records-poc -n records-poc --port 443 --priority 1002
```

### 2. Install Docker on the VM

```bash
ssh azureuser@records-poc.eastus.cloudapp.azure.com
git clone https://github.com/<you>/<repo>.git app && cd app
bash deploy/install-docker.sh      # then log out and back in
```

### 3. Register the new address with Google and Microsoft

Sign-in and connections only work on addresses the providers know. Add (keep the localhost ones for development):

- **Google Cloud → Credentials → your OAuth client → Authorized redirect URIs:** `https://<your host>/oauth/google/callback`
- **Microsoft Entra → App registrations → your app → Authentication → Web → Redirect URIs:** `https://<your host>/oauth/microsoft/callback`

Microsoft accepts `http` only for localhost, so the server address must be https (Caddy provides it).

### 4. Settings

```bash
cp deploy/.env.production.example .env.production
nano .env.production
```

- `DOMAIN` and `PUBLIC_URL`: the host from step 1.
- `CREDENTIAL_ENCRYPTION_KEY`:
  - **New server, no old data:** generate one: `openssl rand -base64 32`
  - **Moving your existing data:** use the **same key** as the old server, the single line in its `data/.credential-key`
    file. Otherwise every stored Google, Microsoft and database connection must be reconnected.
- `IP_HASH_SALT`: `openssl rand -hex 16`.
- Google and Microsoft client IDs and secrets.
- `SETUP_TOKEN`: only for an empty server, to create the first Supervisor from your browser (`openssl rand -hex 16`).

`.env.production` stays on the server: it is git-ignored and excluded from the image. Restrict it: `chmod 600 .env.production`.

### 5. Bring your existing data (optional)

On the old machine (the server can keep running; the snapshot is consistent):

```bash
node scripts/backup.mjs          # prints the folder, for example data/backups/2026-11-02T10-00-00
scp -r data/backups/2026-11-02T10-00-00 azureuser@<your host>:~/restore
```

On the VM, before the first start:

```bash
docker compose --env-file .env.production build
docker compose --env-file .env.production run --rm --no-deps -u root -v ~/restore:/restore app \
  sh -c "cp /restore/records.db /data/records.db && cp -r /restore/uploads /restore/connectors /data/ 2>/dev/null; chown -R node:node /data"
```

### 6. Start

```bash
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production logs -f app     # look for [deploy] WARNING lines
```

Caddy fetches the HTTPS certificate on the first request (ports 80 and 443 must be reachable). Then open
`https://<your host>`, sign in, and in **Settings → Application Integration Settings** click **Check configuration**.

## Backups

```bash
# A consistent snapshot of the database plus uploaded originals, kept 14 deep inside the data volume:
docker compose --env-file .env.production exec app node scripts/backup.mjs
```

Run it nightly from the VM's crontab (`crontab -e`):

```
15 2 * * * cd ~/app && docker compose --env-file .env.production exec -T app node scripts/backup.mjs >> ~/backup.log 2>&1
```

Copy backups off the server, or a dead disk takes them along. On Azure, also enable **VM → Backup** (Azure Backup).
Backups never contain the encryption key; keep that in your password manager or a secret store.

## Updating

```bash
cd ~/app && git pull
docker compose --env-file .env.production up -d --build     # migrations run on start; data is kept
```

## Moving to AWS later

1. Create an **EC2** instance (Ubuntu 24.04, t3.small or larger) or a **Lightsail** instance; open 22, 80, 443.
2. Steps 2, 4 and 5 above, unchanged (same `install-docker.sh`, same `.env.production` with the **same key**, restore
   the latest backup from the Azure VM).
3. Point your DNS name at the new server. If you used the Azure `cloudapp.azure.com` name, choose a new name and add
   its redirect URIs with Google and Microsoft (step 3). A domain of your own makes a move a one-record change.
4. Start (step 6), check, then switch off the Azure VM.

Elastic Container Service, App Runner or Kubernetes can run the same image, but they need a persistent **block** disk
for `/data` (not EFS), for the same SQLite reason.

## Checklist

- [ ] HTTPS address in `PUBLIC_URL`; `[deploy]` warnings gone from the log.
- [ ] Redirect URIs registered with Google and Microsoft; **Check configuration** shows no errors.
- [ ] Encryption key saved somewhere other than the server.
- [ ] Nightly backup running and copied off the server.
- [ ] Google OAuth still in *Testing*: only test users can connect until the app is verified (docs/SETUP.md, section 5b).

// @ts-check
/**
 * Application Integration Settings: the owner configures Google and Microsoft once on the server; every approved
 * user then connects their own accounts. This module reports whether that one-time setup is complete and working.
 *
 * Nothing secret leaves this module: no client secret, no token, no file path beyond the file name.
 * Checks never use one user's tokens for another: a live API probe uses only the checking Supervisor's own
 * connected sources; otherwise the status comes from what recent syncs in the organization recorded (metadata only).
 */
const ago = (iso) => iso ? iso.slice(0, 16).replace('T', ' ') : null;

/** A redirect URI must be https, except http on this computer for development. */
function redirectProblem(uri) {
  let u;
  try { u = new URL(uri); } catch { return 'Not a valid address.'; }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
  return 'Must be https (http is accepted only for localhost). Set PUBLIC_URL to the https address users open.';
}

/**
 * Ask the provider's token endpoint whether the client ID and secret are accepted, without signing anyone in.
 * Google: redeem a code that cannot exist; Google checks the client before the code (invalid_grant = client OK).
 * Microsoft, single-directory app: ask for an app-only token (client_credentials), which is issued only when the
 * secret is right; the token is discarded unused. Microsoft's answer to a made-up code (AADSTS9002313, malformed
 * request) comes before the secret is checked, so it proves nothing and is reported as unconfirmed.
 */
async function probeClient(fetchFn, url, params, provider) {
  try {
    const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => ({}));
    const err = String(j.error || ''), desc = String(j.error_description || '');
    const aad = /AADSTS(\d+)/.exec(desc)?.[1];
    if (provider === 'microsoft' && params.grant_type === 'client_credentials' && res.ok && j.access_token) return { ok: true, detail: 'Microsoft accepted the client ID and secret (an app token was issued and discarded).' };
    if (provider === 'google' && err === 'invalid_grant') return { ok: true, detail: 'Google accepted the client ID and secret.' };
    if (err === 'invalid_client' || err === 'unauthorized_client' || ['7000215', '7000222', '700016'].includes(aad || '')) {
      return { ok: false, detail: aad === '7000222' ? 'The client secret has expired. Create a new one.' : aad === '700016' ? 'Microsoft does not know this client ID (check the tenant and Supported account types).' : 'The client ID or secret was refused. Copy them again from the provider console.' };
    }
    return { ok: null, detail: `Unexpected answer (${err || res.status}${aad ? `, AADSTS${aad}` : ''}); try a real sign-in.` };
  } catch (e) {
    return { ok: null, detail: `Could not reach the provider: ${e instanceof Error ? e.message.slice(0, 120) : 'network error'}.` };
  }
}

/** Latest evidence from syncs in this organization: did an API answer, or refuse because it is disabled? (No tokens used.) */
function evidence(db, tenantId, types, disabledCode) {
  const ok = db.get(`SELECT MAX(j.finished_at) AS at FROM sync_jobs j JOIN sources s ON s.id = j.source_id WHERE s.tenant_id = ? AND s.type IN (${types.map(() => '?').join(',')}) AND j.status = 'succeeded'`, tenantId, ...types).at;
  const off = db.get(`SELECT MAX(j.finished_at) AS at, MAX(j.provider_message) AS msg FROM sync_jobs j JOIN sources s ON s.id = j.source_id WHERE s.tenant_id = ? AND s.type IN (${types.map(() => '?').join(',')}) AND j.error_code = ?`, tenantId, ...types, disabledCode);
  if (off?.at && (!ok || off.at > ok)) return { state: 'disabled', detail: `Refused as disabled at ${ago(off.at)}: ${off.msg || 'API not enabled'}.`, checkedAt: off.at };
  if (ok) return { state: 'enabled', detail: `Answered a sync at ${ago(ok)}.`, checkedAt: ok };
  return { state: 'unknown', detail: 'Not verified yet. The first connection of this kind will show it, or connect one yourself and run the check.', checkedAt: null };
}

/**
 * @param {any} s app services
 * @param {{id: string, tenantId: string}} user the Supervisor asking
 * @param {{live?: boolean}} [opts] live: also call the providers (Check Configuration)
 */
export async function integrationStatus(s, user, { live = false } = {}) {
  const { config, db } = s;
  const g = config.google, m = config.microsoft;
  const errors = [];
  const now = new Date().toISOString();

  // ---------- Google ----------
  const gConfigured = Boolean(g.clientId && g.clientSecret);
  const gRedirect = { uri: g.redirectUri, problem: redirectProblem(g.redirectUri) };
  let gClient = { ok: gConfigured ? null : false, detail: gConfigured ? 'Not checked yet. Use Check configuration.' : 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, and no client_secret_….json was found.' };
  const gmailApi = evidence(db, user.tenantId, ['gmail'], 'gmail_api_disabled');
  const driveApi = evidence(db, user.tenantId, ['gdrive'], 'gmail_api_disabled');
  if (live && gConfigured) {
    gClient = await probeClient(s.gmail.fetch, g.tokenUrl, { code: 'configuration-check-not-a-real-code', client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: g.redirectUri, grant_type: 'authorization_code' }, 'google');
    // Live API probes only with the checking Supervisor's own connected sources.
    for (const [type, target, label] of [['gmail', gmailApi, 'Gmail API'], ['gdrive', driveApi, 'Google Drive API']]) {
      const own = db.get("SELECT * FROM sources WHERE tenant_id = ? AND owner_user_id = ? AND type = ? AND status != 'disconnected' ORDER BY updated_at DESC LIMIT 1", user.tenantId, user.id, type);
      if (!own) continue;
      try {
        const token = await s.gmail.accessToken(own);
        if (type === 'gmail') await s.gmail.api(token, '/users/me/profile'); else await s.gdrive.api(token, '/about?fields=user(emailAddress)');
        Object.assign(target, { state: 'enabled', detail: `Answered just now, using your own ${type === 'gmail' ? 'Gmail' : 'Drive'} connection.`, checkedAt: now });
      } catch (err) {
        const code = /** @type {any} */ (err)?.code;
        if (code === 'gmail_api_disabled') Object.assign(target, { state: 'disabled', detail: err instanceof Error ? err.message : `${label} is disabled.`, checkedAt: now });
        else Object.assign(target, { state: target.state, detail: `${target.detail} (Live check with your connection failed: ${err instanceof Error ? err.message.slice(0, 160) : 'error'})` });
      }
    }
  }
  const project = String(g.clientId || '').split('-')[0];
  const googleReq = [
    `Gmail API and Google Drive API must be enabled in Google Cloud project ${project || '(unknown)'}.`,
    'The OAuth consent screen must list gmail.readonly and drive.readonly under Data access.',
    'While the app is in Testing, only people on its test-user list can connect, and their access expires after 7 days. Publishing removes both limits, but gmail.readonly and drive.readonly are restricted scopes: Google requires OAuth verification and a security assessment before anyone outside the test-user list can connect. A Google Workspace domain can instead mark the app Internal.',
    `Authorized redirect URI to register exactly: ${g.redirectUri}`
  ];
  if (gClient.ok === false) errors.push(`Google: ${gClient.detail}`);
  if (gRedirect.problem) errors.push(`Google redirect URI: ${gRedirect.problem}`);
  if (gmailApi.state === 'disabled') errors.push(`Gmail API: ${gmailApi.detail}`);
  if (driveApi.state === 'disabled') errors.push(`Google Drive API: ${driveApi.detail} Enable it at https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${project}`);

  // ---------- Microsoft ----------
  const mConfigured = Boolean(m.clientId && m.clientSecret);
  const mRedirect = { uri: m.redirectUri, problem: redirectProblem(m.redirectUri) };
  let mClient = { ok: mConfigured ? null : false, detail: mConfigured ? 'Not checked yet. Use Check configuration.' : 'MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are not set. Register an app in Microsoft Entra (docs/SETUP.md, section 6a).' };
  // A definitive secret check needs a specific directory; "common", "organizations" and "consumers" cannot issue app tokens.
  const multi = ['common', 'organizations', 'consumers'].includes(String(m.tenant).toLowerCase());
  if (live && mConfigured && !multi) mClient = await probeClient(s.microsoft.fetch, `${m.authBase}/${m.tenant}/oauth2/v2.0/token`, { client_id: m.clientId, client_secret: m.clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }, 'microsoft');
  if (live && mConfigured && multi) mClient = { ok: null, detail: `Configured for tenant "${m.tenant}". Microsoft can only confirm the secret against one specific directory, so it is confirmed by the first real sign-in.` };
  const graph = {
    outlook: evidence(db, user.tenantId, ['outlook'], 'microsoft_access_denied'),
    onedrive: evidence(db, user.tenantId, ['onedrive'], 'microsoft_access_denied'),
    sharepoint: evidence(db, user.tenantId, ['sharepoint'], 'microsoft_access_denied'),
    teams: evidence(db, user.tenantId, ['teams'], 'microsoft_access_denied')
  };
  const microsoftReq = [
    'App registration with Supported account types "Accounts in any organizational directory and personal Microsoft accounts" (tenant "common").',
    'Delegated Microsoft Graph permissions: User.Read, Mail.Read, Files.Read, Sites.Read.All, Chat.Read, offline_access. Microsoft does not let this server read them back; each is confirmed the first time someone consents.',
    'Personal accounts (Outlook.com, Hotmail): Outlook Mail and OneDrive. SharePoint needs a Microsoft 365 work or school account.',
    'Some organizations turn off user consent: their administrator must grant consent for the app once (Enterprise applications, Permissions).',
    `Web redirect URI to register exactly: ${m.redirectUri}`
  ];
  if (mClient.ok === false) errors.push(`Microsoft: ${mClient.detail}`);
  if (mConfigured && mRedirect.problem) errors.push(`Microsoft redirect URI: ${mRedirect.problem}`);

  const vaultOk = Boolean(s.vault);
  if (!vaultOk) errors.push('Credential encryption is missing: set CREDENTIAL_ENCRYPTION_KEY. Without it no one can connect an account.');
  const ready = (configured, client, redirect) => !configured ? 'not_configured' : !vaultOk || client.ok === false || redirect.problem ? 'blocked' : client.ok === true ? 'ready' : 'unverified';
  return {
    checkedAt: live ? now : null,
    encryption: { ok: vaultOk, source: config.encryptionKey ? 'environment' : vaultOk ? 'development key file' : 'missing' },
    google: {
      configured: gConfigured, credentialSource: { environment: 'environment variables', file: 'downloaded client secret file (server only, git-ignored)', missing: 'missing' }[g.credentialSource],
      clientId: g.clientId ? `${g.clientId.slice(0, 12)}…` : null, client: gClient, redirect: gRedirect,
      apis: { gmail: gmailApi, drive: driveApi }, scopes: ['openid email profile (sign-in)', 'gmail.readonly', 'drive.readonly'],
      // "Partly ready": the client works, but one of its APIs refused as disabled, so that service cannot connect yet.
      readiness: ((r) => r === 'ready' && [gmailApi, driveApi].some(x => x.state === 'disabled') ? 'partial' : r)(ready(gConfigured, gClient, gRedirect)), requirements: googleReq
    },
    microsoft: {
      configured: mConfigured, tenant: m.tenant, clientId: m.clientId ? `${m.clientId.slice(0, 8)}…` : null, client: mClient, redirect: mRedirect,
      graph, scopes: ['openid email profile User.Read (sign-in)', 'Mail.Read', 'Files.Read', 'Sites.Read.All (work accounts)', 'Chat.Read (Teams, work accounts)', 'offline_access'],
      readiness: ready(mConfigured, mClient, mRedirect), requirements: microsoftReq
    },
    connections: db.all("SELECT type, COUNT(*) AS sources, COUNT(DISTINCT owner_user_id) AS people FROM sources WHERE tenant_id = ? AND type IN ('gmail','gdrive','outlook','onedrive','sharepoint','teams') AND status != 'disconnected' GROUP BY type", user.tenantId).map(x => ({ ...x })),
    errors
  };
}


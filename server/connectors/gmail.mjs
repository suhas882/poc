// @ts-check
/**
 * Gmail connector (Google OAuth 2.0 authorization-code flow with PKCE).
 * Scope: gmail.readonly only. We never see or store the user's password.
 * Tokens are encrypted at rest. Sync is incremental via the History API,
 * with a full re-list (and deletion propagation) when needed.
 */
import crypto from 'node:crypto';
import { HttpError } from '../http.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { randomToken, sha256 } from '../security.mjs';
import { deleteRecord, upsertRecord } from '../ingest/pipeline.mjs';
import { extractFile, SUPPORTED } from '../ingest/extract.mjs';
import { explainOAuthError, initialSharing } from './registry.mjs';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** Each Google source asks only for its own read-only scope. */
export const GOOGLE_SCOPES = Object.freeze({ gmail: GMAIL_SCOPE, gdrive: DRIVE_SCOPE });
const GOOGLE_LABEL = { gmail: 'Gmail', gdrive: 'Google Drive' };
const STATE_TTL_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Google API method name for a Gmail path, for diagnostics ("users.messages.get"). IDs and queries are dropped. */
export function gmailEndpoint(pathAndQuery) {
  const p = String(pathAndQuery).split('?')[0].replace(/^\/users\/me/, '');
  if (p === '/profile') return 'users.getProfile';
  if (p === '/history') return 'users.history.list';
  if (p === '/messages') return 'users.messages.list';
  if (/^\/messages\/[^/]+\/attachments\/[^/]+$/.test(p)) return 'users.messages.attachments.get';
  if (/^\/messages\/[^/]+$/.test(p)) return 'users.messages.get';
  return `users${p.replace(/\/[^/]*\d[^/]*/g, '/{id}').replace(/\//g, '.')}`;
}

/** A failed Google call, with what Google actually said. Never carries tokens. */
export class GmailApiError extends HttpError {
  /** @param {number} status @param {string} code @param {string} message @param {{endpoint: string, httpStatus: number, reason: string | null, providerMessage: string | null}} diag */
  constructor(status, code, message, diag) {
    super(status, code, message, diag);
    this.diag = diag;
  }
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED', 'quotaExceeded']);

/**
 * Read Google's error body ({error: {code, message, errors[].reason, details[].reason/metadata}}) and decide what it means.
 * @param {number} status @param {any} body @param {string} endpoint
 */
export function classifyGoogleError(status, body, endpoint) {
  const err = body?.error && typeof body.error === 'object' ? body.error : {};
  const info = (Array.isArray(err.details) ? err.details : []).find(d => String(d?.['@type'] || '').endsWith('ErrorInfo')) || {};
  const legacy = Array.isArray(err.errors) && err.errors[0]?.reason ? String(err.errors[0].reason) : null;
  const reason = legacy || (info.reason ? String(info.reason) : null) || (typeof body?.error === 'string' ? body.error : null);
  const googleMessage = err.message ? String(err.message).slice(0, 400) : typeof body?.error_description === 'string' ? body.error_description.slice(0, 400) : null;
  const meta = info.metadata || {};
  const project = String(meta.consumer || '').replace(/^projects\//, '') || (/project[_ ](?:number:)?(\d+)/.exec(googleMessage || '')?.[1] ?? '');
  const diag = { endpoint, httpStatus: status, reason, providerMessage: googleMessage };
  // The same Google errors come from Gmail and Drive; name the service the call went to.
  const drive = endpoint.startsWith('drive.');
  const service = drive ? 'Google Drive' : 'Gmail', apiName = drive ? 'Google Drive API' : 'Gmail API', apiId = drive ? 'drive.googleapis.com' : 'gmail.googleapis.com';
  const at = `(${endpoint}, HTTP ${status}${reason ? `, ${reason}` : ''})`;
  /** @type {{kind: string, retryable: boolean, waitMs: number | null, error: GmailApiError}} */
  const out = (kind, httpStatus, code, message, retryable = false, waitMs = null) => ({ kind, retryable, waitMs, error: new GmailApiError(httpStatus, code, `${message} ${at}`, diag) });

  if (status === 401) return out('token_rejected', 409, 'reconnect_required', 'Gmail rejected the access token. Reconnect the account.');
  if (reason === 'dailyLimitExceeded' || /per day/i.test(meta.quota_limit || '') || /per day/i.test(googleMessage || '')) {
    return out('daily_quota', 429, 'gmail_daily_quota', `The ${apiName} daily quota for Google Cloud project ${project || '(unknown)'} is used up. Sync again tomorrow, or request a higher quota in Google Cloud Console.`);
  }
  if (status === 429 || (reason && RATE_REASONS.has(reason))) {
    // Per-minute quota. Google reports a window start, but the limit behaves like a rolling minute, so always wait at least a full one.
    const windowStart = Number(meta.window_start_time);
    const waitMs = Math.max(61_000, Number.isFinite(windowStart) && windowStart > 0 ? windowStart * 1000 + 61_000 - Date.now() : 0);
    return out('rate_limited', 429, 'gmail_rate_limited', `${service} paused this sync because it hit Google's per-minute request limit${meta.quota_limit_value ? ` (${meta.quota_limit_value} units per minute per user)` : ''}. What was fetched so far is kept; sync again in a minute to continue.`, true, waitMs);
  }
  if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') {
    const link = `https://console.cloud.google.com/apis/library/${apiId}${project ? `?project=${project}` : ''}`;
    return out('api_disabled', 403, 'gmail_api_disabled', `The ${apiName} is not enabled in Google Cloud project ${project || '(the project of this OAuth client)'}. Enable it at ${link}, wait a few minutes, then sync again.`);
  }
  if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return out('scope_insufficient', 403, 'gmail_scope_missing', 'The stored Gmail access does not include read permission. Reconnect Gmail and allow "Read your email messages".');
  }
  if (reason === 'domainPolicy' || reason === 'failedPrecondition' || /mail service not enabled|domain administrator/i.test(googleMessage || '')) {
    return out('account_policy', 403, 'gmail_account_policy', 'This Google account does not allow Gmail API access. For a Google Workspace account, the administrator must allow it.');
  }
  if (status >= 500) return out('google_unavailable', 502, 'gmail_unavailable', `${service} is temporarily unavailable. Sync again in a few minutes.`, true);
  if (status === 403) return out('forbidden', 403, 'gmail_forbidden', `${service} refused the request: ${googleMessage || 'no reason given'}.`);
  return out('error', 502, 'gmail_error', `${service} returned an error${googleMessage ? `: ${googleMessage}` : ''}.`);
}

export class GmailConnector {
  /**
   * @param {{db: import('../db.mjs').Database, config: import('../config.mjs').AppConfig, vault: import('../security.mjs').Vault | null, fetch?: typeof fetch}} deps
   */
  constructor({ db, config, vault, fetch: f }) {
    this.db = db;
    this.config = config;
    this.vault = vault;
    this.fetch = f ?? fetch;
  }

  get configured() { return Boolean(this.config.google.clientId && this.config.google.clientSecret); }

  assertReady() {
    if (!this.configured) throw new HttpError(503, 'gmail_not_configured', 'Gmail is not set up on this server yet. An administrator needs to add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see docs/SETUP.md).');
    if (!this.vault) throw new HttpError(503, 'encryption_not_configured', 'Credential encryption is not configured. Set CREDENTIAL_ENCRYPTION_KEY before connecting accounts.');
  }

  /** Step 1: build Google's consent URL and remember the one-time state + PKCE verifier. */
  authorize(user, { kind = 'gmail', query = this.config.gmail.defaultQuery, shareWithRoles = [], visibility = 'owner', qrAttemptId = null } = {}) {
    this.assertReady();
    if (!(kind in GOOGLE_SCOPES)) throw new HttpError(400, 'invalid_kind', 'Choose Gmail or Google Drive.');
    const vault = /** @type {import('../security.mjs').Vault} */ (this.vault);
    const state = randomToken(24);
    const verifier = randomToken(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    this.db.run('DELETE FROM oauth_states WHERE expires_at < ?', nowIso());
    this.db.run('INSERT INTO oauth_states (state_hash, tenant_id, user_id, provider, verifier_ciphertext, options, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha256(state), user.tenantId, user.id, 'google', vault.seal(verifier), JSON.stringify({ kind, query, shareWithRoles, visibility, ...(qrAttemptId ? { qrAttemptId } : {}) }), new Date(Date.now() + STATE_TTL_MS).toISOString());
    const g = this.config.google;
    const url = new URL(g.authUrl);
    url.search = new URLSearchParams({
      client_id: g.clientId, redirect_uri: g.redirectUri, response_type: 'code', scope: GOOGLE_SCOPES[kind],
      // Google issues a refresh token only on a consent screen. Connecting (or reconnecting after a revoke) shows it once;
      // after that the stored refresh token keeps the source working without asking again.
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', login_hint: user.email || '', state, code_challenge: challenge, code_challenge_method: 'S256'
    }).toString();
    // stateHash lets a QR-assisted connection bind this exact OAuth state to its attempt.
    return { url: url.toString(), scopes: [GOOGLE_SCOPES[kind]], stateHash: sha256(state) };
  }

  /** Step 2: Google redirects back with ?code&state. Exchange the code and create (or refresh) the source. */
  async handleCallback(user, { code, state, error, error_description: errorDescription }) {
    this.assertReady();
    const vault = /** @type {import('../security.mjs').Vault} */ (this.vault);
    if (error) throw new HttpError(400, error === 'access_denied' ? 'consent_declined' : `oauth_${String(error).slice(0, 40)}`, explainOAuthError('google', String(error), String(errorDescription || '')));
    if (!code || !state) throw new HttpError(400, 'invalid_callback', 'The sign-in response from Google is incomplete. Start the connection again.');
    const row = this.db.get('SELECT * FROM oauth_states WHERE state_hash = ?', sha256(String(state)));
    this.db.run('DELETE FROM oauth_states WHERE state_hash = ?', sha256(String(state)));
    if (!row || row.expires_at < nowIso()) throw new HttpError(400, 'invalid_state', 'This connection link has expired or was already used. Start the connection again.');
    if (row.user_id !== user.id || row.tenant_id !== user.tenantId) throw new HttpError(403, 'state_mismatch', 'This connection was started by a different user.');
    const options = parseJson(row.options, {});
    const kind = options.kind === 'gdrive' ? 'gdrive' : 'gmail';
    const g = this.config.google;
    const tokenRes = await this.fetch(g.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(code), client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: g.redirectUri, grant_type: 'authorization_code', code_verifier: vault.open(row.verifier_ciphertext) }),
      signal: AbortSignal.timeout(20000)
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokens.access_token) {
      const why = [tokens.error, tokens.error_description].filter(x => typeof x === 'string').join(': ').slice(0, 200);
      throw new HttpError(502, 'token_exchange_failed', `Google did not accept the sign-in code${why ? ` (${why})` : ''}. Start the connection again.`);
    }
    const granted = String(tokens.scope || '').split(/\s+/);
    if (!granted.includes(GOOGLE_SCOPES[kind])) {
      await this.revoke(tokens.refresh_token || tokens.access_token).catch(() => {});
      throw new HttpError(400, 'scope_not_granted', `Read access to ${GOOGLE_LABEL[kind]} was not granted on Google’s consent screen, so the account was not connected.`);
    }
    // The consent itself succeeded. If the API cannot be reached yet (for example the Drive API is not enabled in the
    // Cloud project), keep the authorization: the first sync records Google's exact reason, and once fixed, Sync now
    // works without asking for consent again.
    let email = '';
    try {
      email = String(kind === 'gmail'
        ? (await this.api(tokens.access_token, '/users/me/profile')).emailAddress || ''
        : (await this.driveAbout(tokens.access_token)).user?.emailAddress || '').toLowerCase();
    } catch (err) {
      if (!(err instanceof GmailApiError) || err.code === 'reconnect_required') throw err;
      email = String(user.email || '').toLowerCase();
    }
    const creds = { refreshToken: tokens.refresh_token || null, accessToken: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 };
    const existing = this.db.get('SELECT id, sync_cursor FROM sources WHERE tenant_id = ? AND type = ? AND owner_user_id = ? AND account_label = ?', user.tenantId, kind, user.id, email);
    const sharing = initialSharing(options);
    const id = existing?.id ?? crypto.randomUUID();
    this.db.tx(() => {
      if (existing) {
        if (!creds.refreshToken) { const old = this.loadCredentials(id); creds.refreshToken = old?.refreshToken ?? null; }
        this.db.run("UPDATE sources SET status = CASE WHEN status = 'pending_approval' THEN status ELSE 'connected' END, last_error = NULL, scopes = ?, updated_at = ? WHERE id = ?", JSON.stringify(granted), nowIso(), id);
      } else {
        this.db.run(`INSERT INTO sources (id, tenant_id, type, name, status, owner_user_id, visibility, allowed_roles, config, scopes, account_label)
          VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?)`,
        id, user.tenantId, kind, `${GOOGLE_LABEL[kind]}: ${email}`, user.id, sharing.visibility, JSON.stringify(sharing.allowedRoles),
        JSON.stringify(kind === 'gmail' ? { query: options.query ?? this.config.gmail.defaultQuery, indexAttachments: this.config.gmail.indexAttachments } : {}), JSON.stringify(granted), email);
      }
      this.saveCredentials(id, creds);
    });
    return { sourceId: id, email, kind, reconnected: Boolean(existing) };
  }

  /** The signed-in Drive user (drive.readonly allows reading it), to label a Drive source. */
  async driveAbout(token) {
    const res = await this.fetch(`${this.config.google.driveApiBase}/about?fields=user(emailAddress)`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw classifyGoogleError(res.status, await res.json().catch(() => ({})), 'drive.about.get').error;
    return res.json();
  }

  saveCredentials(sourceId, creds) {
    const vault = /** @type {import('../security.mjs').Vault} */ (this.vault);
    this.db.run(`INSERT INTO source_credentials (source_id, ciphertext, key_id) VALUES (?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET ciphertext = excluded.ciphertext, key_id = excluded.key_id, updated_at = ?`, sourceId, vault.seal(creds), vault.keyId, nowIso());
  }

  loadCredentials(sourceId) {
    const row = this.db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', sourceId);
    return row && this.vault ? this.vault.open(row.ciphertext) : null;
  }

  async accessToken(source) {
    const creds = this.loadCredentials(source.id);
    if (!creds) throw new HttpError(409, 'no_credentials', 'This Gmail account has no stored access. Reconnect it.');
    if (creds.accessToken && creds.expiresAt - 60_000 > Date.now()) return creds.accessToken;
    if (!creds.refreshToken) throw new HttpError(409, 'reconnect_required', 'Gmail access has expired. Reconnect the account.');
    const g = this.config.google;
    const res = await this.fetch(g.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: creds.refreshToken, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(20000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      const reason = typeof json.error === 'string' ? json.error : null;
      const diag = { endpoint: 'oauth2.token (refresh)', httpStatus: res.status, reason, providerMessage: typeof json.error_description === 'string' ? json.error_description.slice(0, 400) : null };
      const message = `Google no longer accepts the stored access for this account${reason === 'invalid_grant' ? ' (it was revoked, or expired: refresh tokens of OAuth apps in "Testing" status last 7 days)' : ''}. Reconnect Gmail.`;
      this.db.run("UPDATE sources SET status = 'needs_attention', last_error = ? WHERE id = ?", message, source.id);
      throw new GmailApiError(409, 'reconnect_required', message, diag);
    }
    this.saveCredentials(source.id, { ...creds, accessToken: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 });
    return json.access_token;
  }

  /**
   * One Gmail API call. Rate limits (Google sends these as 403 or 429) wait for the quota window and retry;
   * every other failure is classified from Google's error body.
   * @param {{allow404?: boolean, diag?: any}} [opts] diag collects call counts for Sync History
   */
  async api(token, pathAndQuery, { allow404 = false, diag } = {}) {
    const endpoint = gmailEndpoint(pathAndQuery);
    const g = this.config.gmail;
    for (let attempt = 1; ; attempt++) {
      if (diag) diag.apiCalls = (diag.apiCalls || 0) + 1;
      const res = await this.fetch(`${this.config.google.gmailApiBase}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
      if (res.ok) return res.json();
      if (allow404 && res.status === 404) return null;
      const body = await res.json().catch(() => ({}));
      const c = classifyGoogleError(res.status, body, endpoint);
      if (c.retryable && attempt <= g.rateLimitRetries) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        const backoff = c.waitMs ?? (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1000 * 2 ** attempt);
        const wait = Math.min(Math.max(backoff, 250), g.rateLimitMaxWaitMs);
        if (diag && c.kind === 'rate_limited') { diag.rateLimitWaits = (diag.rateLimitWaits || 0) + 1; diag.waitedMs = (diag.waitedMs || 0) + wait; }
        await sleep(wait);
        continue;
      }
      throw c.error;
    }
  }

  /**
   * Incremental sync. Returns counts. Deletions in Gmail remove the matching records here.
   * @param {any} source a sources row
   */
  async sync(source, { full = false, diag = {} } = {}) {
    this.assertReady();
    const token = await this.accessToken(source);
    const cfg = parseJson(source.config, {});
    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: 'gmail' };
    const counts = { added: 0, updated: 0, deleted: 0, skipped: 0, truncated: false };
    // The caller keeps `diag`, so a failed sync still reports how far it got.
    Object.assign(diag, { counts, listed: 0, attempted: 0, fetched: 0, apiCalls: 0, rateLimitWaits: 0, waitedMs: 0 });
    const api = (p, o = {}) => this.api(token, p, { ...o, diag });
    // Gmail message IDs and content never change, so messages indexed by an earlier (possibly failed) run are not fetched again.
    const known = new Set(this.db.all('SELECT source_record_id FROM records WHERE source_id = ? AND parent_record_id IS NULL', source.id).map(r => r.source_record_id));
    const profile = await api('/users/me/profile');
    /** @type {Set<string>} */ const toFetch = new Set();
    /** @type {Set<string>} */ const toDelete = new Set();
    let listedAll = null;
    let listTruncated = false;

    let incremental = !full && Boolean(source.sync_cursor);
    if (incremental) {
      let pageToken = '';
      do {
        const q = new URLSearchParams({ startHistoryId: source.sync_cursor, maxResults: '500' });
        q.append('historyTypes', 'messageAdded'); q.append('historyTypes', 'messageDeleted'); q.append('historyTypes', 'labelAdded');
        if (pageToken) q.set('pageToken', pageToken);
        const h = await api(`/users/me/history?${q}`, { allow404: true });
        if (!h) { incremental = false; break; } // history too old: fall back to a full re-list
        for (const item of h.history || []) {
          for (const m of item.messagesAdded || []) toFetch.add(m.message.id);
          for (const m of item.messagesDeleted || []) { toDelete.add(m.message.id); toFetch.delete(m.message.id); }
          for (const m of item.labelsAdded || []) if ((m.labelIds || []).some(l => l === 'TRASH' || l === 'SPAM')) { toDelete.add(m.message.id); toFetch.delete(m.message.id); }
        }
        pageToken = h.nextPageToken || '';
      } while (pageToken && toFetch.size < this.config.gmail.maxMessagesPerSync);
      listTruncated = incremental && Boolean(pageToken);
    }
    if (!incremental) {
      listedAll = new Set();
      let pageToken = '';
      do {
        const q = new URLSearchParams({ maxResults: '100' });
        if (cfg.query) q.set('q', cfg.query);
        if (pageToken) q.set('pageToken', pageToken);
        const list = await api(`/users/me/messages?${q}`);
        for (const m of list.messages || []) { listedAll.add(m.id); toFetch.add(m.id); }
        pageToken = list.nextPageToken || '';
        // Listing is cheap; the per-sync limit below applies to messages actually fetched.
        if (listedAll.size >= this.config.gmail.maxListedPerSync) { listTruncated = Boolean(pageToken); break; }
      } while (pageToken);
      diag.listed = listedAll.size;
    } else {
      diag.listed = toFetch.size;
    }

    for (const id of toFetch) {
      if (known.has(id)) { counts.skipped++; continue; }
      if (diag.attempted >= this.config.gmail.maxMessagesPerSync) { counts.truncated = true; break; }
      diag.attempted++;
      const msg = await api(`/users/me/messages/${encodeURIComponent(id)}?format=full`, { allow404: true });
      if (msg) diag.fetched++;
      if (!msg) { toDelete.add(id); continue; }
      if ((msg.labelIds || []).some(l => l === 'TRASH' || l === 'SPAM')) { toDelete.add(id); continue; }
      const parsed = parseGmailMessage(msg);
      const rec = {
        sourceRecordId: msg.id, title: parsed.subject || '(no subject)', content: parsed.body, sender: parsed.from, recipients: parsed.to,
        createdAt: parsed.date, modifiedAt: parsed.date, documentType: 'Email', threadKey: `gmail:${msg.threadId}`,
        sourceUrl: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(source.account_label || '')}#all/${msg.id}`,
        keywords: undefined, accessPermissions: {}
      };
      const r = upsertRecord(this.db, ctx, rec);
      counts[r.status === 'unchanged' ? 'skipped' : r.status]++;
      if (cfg.indexAttachments !== false) {
        for (const att of parsed.attachments) {
          const ext = att.filename.split('.').pop()?.toLowerCase() || '';
          if (!(ext in SUPPORTED) || att.size > this.config.gmail.maxAttachmentBytes) continue;
          const attId = `${msg.id}/att/${att.partId}`;
          if (this.db.get('SELECT 1 FROM records WHERE source_id = ? AND source_record_id = ?', source.id, attId)) continue; // attachments are immutable
          try {
            const data = await api(`/users/me/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(att.attachmentId)}`);
            const buf = Buffer.from(String(data.data || ''), 'base64url');
            const ex = await extractFile(att.filename, buf, { ocr: this.config.ocr });
            if (!ex.text.trim()) continue;
            upsertRecord(this.db, ctx, {
              sourceRecordId: attId, title: `${att.filename} (attachment: ${rec.title})`, content: ex.text, sender: parsed.from, recipients: parsed.to,
              createdAt: parsed.date, documentType: ex.documentType, parentRecordId: r.id, threadKey: rec.threadKey, sourceUrl: rec.sourceUrl
            });
            counts.added++;
          } catch (err) {
            // A quota or access failure stops the sync; a single unreadable attachment does not.
            if (err instanceof GmailApiError) throw err;
            counts.skipped++;
          }
        }
      }
    }

    // Deletion propagation.
    for (const id of toDelete) counts.deleted += this.deleteMessage(source.id, id);
    if (listedAll && !listTruncated) {
      for (const row of this.db.all('SELECT source_record_id FROM records WHERE source_id = ? AND parent_record_id IS NULL', source.id)) {
        if (!listedAll.has(row.source_record_id)) counts.deleted += this.deleteMessage(source.id, row.source_record_id);
      }
    }
    counts.truncated ||= listTruncated;
    // Only move the history cursor forward once everything up to it is indexed; otherwise the next run lists again.
    if (!counts.truncated) this.db.run('UPDATE sources SET sync_cursor = ? WHERE id = ?', String(profile.historyId || source.sync_cursor || ''), source.id);
    return counts;
  }

  deleteMessage(sourceId, messageId) {
    const rows = this.db.all('SELECT id FROM records WHERE source_id = ? AND (source_record_id = ? OR source_record_id LIKE ?)', sourceId, messageId, `${messageId}/att/%`);
    for (const r of rows) deleteRecord(this.db, r.id);
    return rows.length;
  }

  async revoke(token) {
    if (!token) return false;
    const res = await this.fetch(this.config.google.revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(15000) });
    return res.ok;
  }

  /** Revoke at Google, then the caller deletes credentials and indexed content. */
  async disconnect(source) {
    let revoked = false;
    try {
      const creds = this.loadCredentials(source.id);
      revoked = await this.revoke(creds?.refreshToken || creds?.accessToken);
    } catch { revoked = false; }
    return { revoked };
  }
}

/* ---------------- message parsing ---------------- */

const b64 = (s) => Buffer.from(String(s || ''), 'base64url').toString('utf8');

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** Pull subject, people, date, readable body and attachment list out of a Gmail API message (format=full). */
export function parseGmailMessage(msg) {
  const headers = new Map((msg.payload?.headers || []).map(h => [String(h.name).toLowerCase(), String(h.value)]));
  const plain = [], html = [], attachments = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) attachments.push({ filename: part.filename, attachmentId: part.body.attachmentId, size: Number(part.body.size || 0), mimeType: part.mimeType, partId: part.partId || String(attachments.length) });
    else if (part.mimeType === 'text/plain' && part.body?.data) plain.push(b64(part.body.data));
    else if (part.mimeType === 'text/html' && part.body?.data) html.push(b64(part.body.data));
    for (const p of part.parts || []) walk(p);
  };
  walk(msg.payload);
  const splitAddrs = (v) => (v ? v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => s.trim()).filter(Boolean) : []);
  const dateHeader = headers.get('date');
  const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : dateHeader && !Number.isNaN(Date.parse(dateHeader)) ? new Date(dateHeader).toISOString() : null;
  return {
    subject: headers.get('subject') || '',
    from: headers.get('from') || null,
    to: [...splitAddrs(headers.get('to')), ...splitAddrs(headers.get('cc'))],
    date,
    body: (plain.join('\n').trim() || htmlToText(html.join('\n')) || String(msg.snippet || '')).slice(0, 500000),
    attachments
  };
}

// @ts-check
/**
 * Microsoft Graph connector: Outlook mail (Mail.Read) and OneDrive files (Files.Read), one source each.
 * OAuth 2.0 authorization-code flow with PKCE against the Microsoft identity platform. Read-only scopes only;
 * we never see or store the user's password. Tokens are encrypted at rest.
 * Works with personal accounts (Outlook.com, Hotmail) and work or school accounts. SharePoint (Sites.Read.All) and
 * Teams chats (Chat.Read) exist only for work or school (Microsoft 365) accounts.
 */
import crypto from 'node:crypto';
import { HttpError } from '../http.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { randomToken, sha256 } from '../security.mjs';
import { deleteRecord, upsertRecord } from '../ingest/pipeline.mjs';
import { extractFile, SUPPORTED } from '../ingest/extract.mjs';
import { htmlToText } from './gmail.mjs';
import { explainOAuthError, initialSharing } from './registry.mjs';

const STATE_TTL_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Least privilege: each source asks only for what it reads. offline_access gives a refresh token. */
export const MICROSOFT_SCOPES = Object.freeze({
  outlook: ['offline_access', 'User.Read', 'Mail.Read'],
  onedrive: ['offline_access', 'User.Read', 'Files.Read'],
  // Work or school accounts only. Delegated: reads only sites the signed-in person can already open.
  sharepoint: ['offline_access', 'User.Read', 'Sites.Read.All'],
  // Work or school accounts only. Delegated: the person's own 1:1, group and meeting chats. Not channel posts.
  teams: ['offline_access', 'User.Read', 'Chat.Read']
});
const NEEDED = { outlook: 'mail.read', onedrive: 'files.read', sharepoint: 'sites.read.all', teams: 'chat.read' };
const LABEL = { outlook: 'Outlook mail', onedrive: 'OneDrive', sharepoint: 'SharePoint', teams: 'Microsoft Teams' };
// Immutable IDs survive moving a message between folders; plain-text bodies avoid HTML clean-up.
const MAIL_PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';

/** Graph method name for diagnostics ("me.messages.list"). IDs and queries are dropped. */
export function graphEndpoint(pathOrUrl) {
  const p = String(pathOrUrl).replace(/^https?:\/\/[^/]+\/(v1\.0|beta)/, '').split('?')[0];
  const parts = p.split('/').filter(Boolean).map(x => (/^[a-z]+$/i.test(x) ? x : '{id}'));
  const name = parts.filter(x => x !== '{id}').join('.');
  if (/(messages|attachments|mailFolders|children)$/.test(name) && parts.at(-1) !== '{id}') return `${name}.list`;
  return parts.at(-1) === '{id}' ? `${name}.get` : name;
}

/** A failed Microsoft call, with what Microsoft actually said. Never carries tokens. */
export class MicrosoftApiError extends HttpError {
  /** @param {number} status @param {string} code @param {string} message @param {{endpoint: string, httpStatus: number, reason: string | null, providerMessage: string | null}} diag */
  constructor(status, code, message, diag) {
    super(status, code, message, diag);
    this.diag = diag;
  }
}

/** Read Graph's error body ({error: {code, message}}) or the identity platform's ({error, error_description}). */
export function classifyGraphError(status, body, endpoint, retryAfterMs = null) {
  const err = body?.error && typeof body.error === 'object' ? body.error : null;
  const reason = err?.code ? String(err.code) : typeof body?.error === 'string' ? body.error : null;
  const providerMessage = (err?.message ? String(err.message) : typeof body?.error_description === 'string' ? body.error_description : '').split(/\r?\n/)[0].slice(0, 400) || null;
  const diag = { endpoint, httpStatus: status, reason, providerMessage };
  const at = `(${endpoint}, HTTP ${status}${reason ? `, ${reason}` : ''})`;
  const out = (kind, httpStatus, code, message, retryable = false, waitMs = null) => ({ kind, retryable, waitMs, error: new MicrosoftApiError(httpStatus, code, `${message} ${at}`, diag) });

  if (status === 401 || reason === 'InvalidAuthenticationToken' || reason === 'invalid_grant') {
    return out('token_rejected', 409, 'reconnect_required', 'Microsoft no longer accepts the stored access for this account. Reconnect it.');
  }
  if (status === 429 || reason === 'TooManyRequests' || reason === 'activityLimitReached') {
    return out('rate_limited', 429, 'microsoft_throttled', 'Microsoft paused this sync because of its request limits. What was fetched so far is kept; sync again in a minute to continue.', true, Math.max(retryAfterMs ?? 0, 10_000));
  }
  if (reason === 'MailboxNotEnabledForRESTAPI' || reason === 'MailboxNotSupportedForRESTAPI') {
    return out('no_mailbox', 403, 'microsoft_no_mailbox', 'This Microsoft account has no Outlook mailbox that Microsoft Graph can read.');
  }
  if (status === 403 || reason === 'ErrorAccessDenied' || reason === 'accessDenied' || reason === 'Authorization_RequestDenied') {
    return out('access_denied', 403, 'microsoft_access_denied', `Microsoft refused the request: ${providerMessage || 'access denied'}. Reconnect and allow read access; a work account may need administrator consent.`);
  }
  if (status >= 500) return out('unavailable', 502, 'microsoft_unavailable', 'Microsoft is temporarily unavailable. Sync again in a few minutes.', true, retryAfterMs);
  return out('error', 502, 'microsoft_error', `Microsoft returned an error${providerMessage ? `: ${providerMessage}` : ''}.`);
}

/** "https://contoso.sharepoint.com/sites/Records" → host and site path. Only SharePoint Online addresses are accepted. */
export function parseSiteUrl(siteUrl) {
  let u;
  try { u = new URL(String(siteUrl)); } catch { throw new HttpError(400, 'invalid_site_url', 'Enter the SharePoint site address, for example https://contoso.sharepoint.com/sites/Records.'); }
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(u.hostname)) throw new HttpError(400, 'invalid_site_url', 'The site address must be an https://….sharepoint.com address.');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return { host: u.hostname.toLowerCase(), path };
}

export class MicrosoftConnector {
  /** @param {{db: import('../db.mjs').Database, config: import('../config.mjs').AppConfig, vault: import('../security.mjs').Vault | null, fetch?: typeof fetch}} deps */
  constructor({ db, config, vault, fetch: f }) {
    this.db = db;
    this.config = config;
    this.vault = vault;
    this.fetch = f ?? fetch;
  }

  get configured() { return Boolean(this.config.microsoft.clientId && this.config.microsoft.clientSecret); }
  get endpoints() {
    const m = this.config.microsoft;
    return { auth: `${m.authBase}/${m.tenant}/oauth2/v2.0/authorize`, token: `${m.authBase}/${m.tenant}/oauth2/v2.0/token` };
  }

  assertReady() {
    if (!this.configured) throw new HttpError(503, 'microsoft_not_configured', 'Microsoft sign-in is not set up on this server yet. An administrator needs to add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET (see docs/SETUP.md).');
    if (!this.vault) throw new HttpError(503, 'encryption_not_configured', 'Credential encryption is not configured. Set CREDENTIAL_ENCRYPTION_KEY before connecting accounts.');
  }

  /** Step 1: Microsoft's sign-in URL, with a one-time state and PKCE verifier remembered here. */
  authorize(user, { kind, shareWithRoles = [], siteUrl = '', visibility = 'owner', qrAttemptId = null }) {
    this.assertReady();
    if (!(kind in MICROSOFT_SCOPES)) throw new HttpError(400, 'invalid_kind', 'Choose Outlook mail, OneDrive, SharePoint or Teams.');
    if (kind === 'sharepoint') parseSiteUrl(siteUrl);
    const vault = /** @type {import('../security.mjs').Vault} */ (this.vault);
    const state = randomToken(24);
    const verifier = randomToken(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    this.db.run('DELETE FROM oauth_states WHERE expires_at < ?', nowIso());
    this.db.run('INSERT INTO oauth_states (state_hash, tenant_id, user_id, provider, verifier_ciphertext, options, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha256(state), user.tenantId, user.id, 'microsoft', vault.seal(verifier), JSON.stringify({ kind, shareWithRoles, siteUrl, visibility, ...(qrAttemptId ? { qrAttemptId } : {}) }), new Date(Date.now() + STATE_TTL_MS).toISOString());
    const m = this.config.microsoft;
    const url = new URL(this.endpoints.auth);
    url.search = new URLSearchParams({
      client_id: m.clientId, response_type: 'code', redirect_uri: m.redirectUri, response_mode: 'query',
      scope: MICROSOFT_SCOPES[kind].join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account', login_hint: user.email || ''
    }).toString();
    return { url: url.toString(), scopes: MICROSOFT_SCOPES[kind], stateHash: sha256(state) };
  }

  async tokenRequest(params, endpoint) {
    const m = this.config.microsoft;
    const res = await this.fetch(this.endpoints.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: m.clientId, client_secret: m.clientSecret, ...params }), signal: AbortSignal.timeout(20000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw classifyGraphError(res.status, json, endpoint).error;
    return json;
  }

  /** Step 2: Microsoft redirects back with ?code&state. Exchange the code and create (or refresh) the source. */
  async handleCallback(user, { code, state, error, error_description: errorDescription }) {
    this.assertReady();
    const vault = /** @type {import('../security.mjs').Vault} */ (this.vault);
    if (error) throw new HttpError(400, error === 'access_denied' ? 'consent_declined' : `oauth_${String(error).slice(0, 40)}`, explainOAuthError('microsoft', String(error), String(errorDescription || '')));
    if (!code || !state) throw new HttpError(400, 'invalid_callback', 'The sign-in response from Microsoft is incomplete. Start the connection again.');
    const row = this.db.get('SELECT * FROM oauth_states WHERE state_hash = ? AND provider = ?', sha256(String(state)), 'microsoft');
    this.db.run('DELETE FROM oauth_states WHERE state_hash = ?', sha256(String(state)));
    if (!row || row.expires_at < nowIso()) throw new HttpError(400, 'invalid_state', 'This connection link has expired or was already used. Start the connection again.');
    if (row.user_id !== user.id || row.tenant_id !== user.tenantId) throw new HttpError(403, 'state_mismatch', 'This connection was started by a different user.');
    const options = parseJson(row.options, {});
    const kind = options.kind in MICROSOFT_SCOPES ? options.kind : 'outlook';
    const m = this.config.microsoft;
    const tokens = await this.tokenRequest({ code: String(code), redirect_uri: m.redirectUri, grant_type: 'authorization_code', code_verifier: vault.open(row.verifier_ciphertext), scope: MICROSOFT_SCOPES[kind].join(' ') }, 'oauth2.token');
    // Granted scopes come back as "Mail.Read User.Read" or as full URIs; compare by the last part.
    const granted = String(tokens.scope || '').split(/\s+/).filter(Boolean);
    if (!granted.some(s => s.split('/').pop()?.toLowerCase() === NEEDED[kind])) {
      throw new HttpError(400, 'scope_not_granted', `Read access to ${LABEL[kind]} was not granted on Microsoft’s sign-in page, so the account was not connected.`);
    }
    const me = await this.api(tokens.access_token, '/me?$select=mail,userPrincipalName,displayName');
    const email = String(me.mail || me.userPrincipalName || '').toLowerCase();
    // A SharePoint source is one site's document library; its label is the site address.
    const site = kind === 'sharepoint' ? await this.resolveSite(tokens.access_token, options.siteUrl) : null;
    const label = site ? site.webUrl : email;
    const creds = { refreshToken: tokens.refresh_token || null, accessToken: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 };
    const existing = this.db.get('SELECT id FROM sources WHERE tenant_id = ? AND type = ? AND owner_user_id = ? AND account_label = ?', user.tenantId, kind, user.id, label);
    const sharing = initialSharing(options);
    const id = existing?.id ?? crypto.randomUUID();
    this.db.tx(() => {
      if (existing) {
        if (!creds.refreshToken) creds.refreshToken = this.loadCredentials(id)?.refreshToken ?? null;
        this.db.run("UPDATE sources SET status = CASE WHEN status = 'pending_approval' THEN status ELSE 'connected' END, last_error = NULL, scopes = ?, updated_at = ? WHERE id = ?", JSON.stringify(granted), nowIso(), id);
      } else {
        this.db.run(`INSERT INTO sources (id, tenant_id, type, name, status, owner_user_id, visibility, allowed_roles, config, scopes, account_label)
          VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?)`,
        id, user.tenantId, kind, site ? `SharePoint: ${site.name}` : `${LABEL[kind]}: ${email}`, user.id, sharing.visibility, JSON.stringify(sharing.allowedRoles),
        JSON.stringify(kind === 'outlook' || kind === 'teams' ? { days: m.mailDays } : site ? { siteId: site.id, driveId: site.driveId, siteUrl: site.webUrl, connectedAs: email } : {}), JSON.stringify(granted), label);
      }
      this.saveCredentials(id, creds);
    });
    return { sourceId: id, email, kind, reconnected: Boolean(existing) };
  }

  /** Find a SharePoint site by its address and its default document library. Personal accounts have no SharePoint. */
  async resolveSite(token, siteUrl) {
    const { host, path } = parseSiteUrl(siteUrl);
    const site = await this.api(token, `/sites/${host}:${path}?$select=id,displayName,webUrl`, { allow404: true });
    if (!site) throw new HttpError(404, 'sharepoint_site_not_found', `No SharePoint site was found at ${siteUrl}, or this account cannot open it.`);
    const drive = await this.api(token, `/sites/${encodeURIComponent(site.id)}/drive?$select=id,name`);
    return { id: site.id, name: site.displayName || path, webUrl: site.webUrl || siteUrl, driveId: drive.id };
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
    if (!creds) throw new HttpError(409, 'no_credentials', 'This Microsoft account has no stored access. Reconnect it.');
    if (creds.accessToken && creds.expiresAt - 60_000 > Date.now()) return creds.accessToken;
    if (!creds.refreshToken) throw new HttpError(409, 'reconnect_required', 'Microsoft access has expired. Reconnect the account.');
    const kind = source.type in MICROSOFT_SCOPES ? source.type : 'outlook';
    try {
      const json = await this.tokenRequest({ refresh_token: creds.refreshToken, grant_type: 'refresh_token', scope: MICROSOFT_SCOPES[kind].join(' ') }, 'oauth2.token (refresh)');
      // Microsoft may rotate the refresh token; keep the newest one.
      this.saveCredentials(source.id, { refreshToken: json.refresh_token || creds.refreshToken, accessToken: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 });
      return json.access_token;
    } catch (err) {
      if (err instanceof MicrosoftApiError) this.db.run("UPDATE sources SET status = 'needs_attention', last_error = ? WHERE id = ?", err.message, source.id);
      throw err;
    }
  }

  /**
   * One Graph call. Throttling (429, or 503 with Retry-After) waits and retries; other failures are classified.
   * `pathOrUrl` may be an @odata.nextLink, which must point at the configured Graph host.
   * @param {{diag?: any, prefer?: string, allow404?: boolean}} [opts]
   */
  async api(token, pathOrUrl, { diag, prefer, allow404 = false } = {}) {
    const base = this.config.microsoft.graphBase;
    const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : `${base}${pathOrUrl}`;
    if (new URL(url).origin !== new URL(base).origin) throw new HttpError(502, 'microsoft_bad_link', 'Microsoft returned a link to another host; the sync stopped instead of sending the token there.');
    const endpoint = graphEndpoint(url);
    const m = this.config.microsoft;
    for (let attempt = 1; ; attempt++) {
      if (diag) diag.apiCalls = (diag.apiCalls || 0) + 1;
      const headers = { authorization: `Bearer ${token}`, ...(prefer ? { prefer } : {}) };
      const res = await this.fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (res.ok) return res.json();
      if (allow404 && res.status === 404) return null;
      const body = await res.json().catch(() => ({}));
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      const c = classifyGraphError(res.status, body, endpoint, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
      if (c.retryable && attempt <= m.throttleRetries) {
        const wait = Math.min(Math.max(c.waitMs ?? 1000 * 2 ** attempt, 250), m.throttleMaxWaitMs);
        if (diag && c.kind === 'rate_limited') { diag.rateLimitWaits = (diag.rateLimitWaits || 0) + 1; diag.waitedMs = (diag.waitedMs || 0) + wait; }
        await sleep(wait);
        continue;
      }
      throw c.error;
    }
  }

  /** Download a OneDrive file. Graph answers /content with a redirect to a pre-signed URL, which is fetched without the token. */
  async download(token, itemId, diag, driveBase = '/me/drive') {
    const url = `${this.config.microsoft.graphBase}${driveBase}/items/${encodeURIComponent(itemId)}/content`;
    if (diag) diag.apiCalls = (diag.apiCalls || 0) + 1;
    let res = await this.fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) res = await this.fetch(String(res.headers.get('location')), { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw classifyGraphError(res.status, await res.json().catch(() => ({})), 'drive.items.content').error;
    return Buffer.from(await res.arrayBuffer());
  }

  /** @param {any} source a sources row */
  async sync(source, { full = false, diag = {} } = {}) {
    this.assertReady();
    const token = await this.accessToken(source);
    const counts = { added: 0, updated: 0, deleted: 0, skipped: 0, truncated: false };
    Object.assign(diag, { counts, listed: 0, attempted: 0, fetched: 0, apiCalls: 0, rateLimitWaits: 0, waitedMs: 0 });
    if (source.type === 'sharepoint') {
      const cfg = parseJson(source.config, {});
      if (!cfg.driveId) throw new HttpError(409, 'reconnect_required', 'This SharePoint source has no document library recorded. Reconnect it.');
      return this.syncDrive(source, token, counts, diag, full, `/drives/${encodeURIComponent(cfg.driveId)}`);
    }
    if (source.type === 'teams') return this.syncTeams(source, token, counts, diag, full);
    return source.type === 'onedrive' ? this.syncDrive(source, token, counts, diag, full) : this.syncMail(source, token, counts, diag);
  }

  /** Outlook: list message IDs received in the window (all folders except Deleted Items and Junk), fetch only new ones. */
  async syncMail(source, token, counts, diag) {
    const cfg = parseJson(source.config, {});
    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: 'outlook' };
    const api = (p, o = {}) => this.api(token, p, { ...o, diag, prefer: MAIL_PREFER });
    const max = this.config.microsoft.maxItemsPerSync;
    const skipFolders = new Set();
    for (const wk of ['deleteditems', 'junkemail']) {
      const f = await api(`/me/mailFolders/${wk}?$select=id`, { allow404: true });
      if (f?.id) skipFolders.add(f.id);
    }
    const since = new Date(Date.now() - (Number(cfg.days) || this.config.microsoft.mailDays) * 86400_000).toISOString();
    const known = new Set(this.db.all('SELECT source_record_id FROM records WHERE source_id = ? AND parent_record_id IS NULL', source.id).map(r => r.source_record_id));
    /** @type {Set<string>} */ const listed = new Set();
    /** @type {{id: string, hasAttachments: boolean}[]} */ const toFetch = [];
    let next = `/me/messages?${new URLSearchParams({ $select: 'id,parentFolderId,hasAttachments', $filter: `receivedDateTime ge ${since}`, $orderby: 'receivedDateTime desc', $top: '100' })}`;
    let listTruncated = false;
    while (next) {
      const page = await api(next);
      for (const m of page.value || []) {
        if (skipFolders.has(m.parentFolderId)) continue;
        listed.add(m.id);
        if (known.has(m.id)) counts.skipped++; else toFetch.push(m);
      }
      next = page['@odata.nextLink'] || '';
      if (next && listed.size >= 20000) { listTruncated = true; break; }
    }
    diag.listed = listed.size;

    for (const m of toFetch) {
      if (diag.attempted >= max) { counts.truncated = true; break; }
      diag.attempted++;
      const msg = await api(`/me/messages/${encodeURIComponent(m.id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,webLink,conversationId,body`, { allow404: true });
      if (!msg) continue;
      diag.fetched++;
      const addr = (r) => r?.emailAddress ? (r.emailAddress.name && r.emailAddress.name !== r.emailAddress.address ? `${r.emailAddress.name} <${r.emailAddress.address}>` : String(r.emailAddress.address || '')) : null;
      const body = msg.body?.contentType === 'html' ? htmlToText(msg.body.content || '') : String(msg.body?.content || '');
      const rec = {
        sourceRecordId: msg.id, title: msg.subject || '(no subject)', content: body.trim().slice(0, 500000), sender: addr(msg.from),
        recipients: [...(msg.toRecipients || []), ...(msg.ccRecipients || [])].map(addr).filter(Boolean), createdAt: msg.receivedDateTime, modifiedAt: msg.receivedDateTime,
        documentType: 'Email', threadKey: msg.conversationId ? `outlook:${msg.conversationId}` : undefined, sourceUrl: msg.webLink, keywords: undefined, accessPermissions: {}
      };
      const r = upsertRecord(this.db, ctx, rec);
      counts[r.status === 'unchanged' ? 'skipped' : r.status]++;
      if (!m.hasAttachments) continue;
      const atts = await api(`/me/messages/${encodeURIComponent(msg.id)}/attachments`);
      for (const att of atts.value || []) {
        const name = String(att.name || '');
        const ext = name.split('.').pop()?.toLowerCase() || '';
        if (att['@odata.type'] !== '#microsoft.graph.fileAttachment' || !(ext in SUPPORTED) || Number(att.size) > this.config.microsoft.maxFileBytes || !att.contentBytes) continue;
        try {
          const ex = await extractFile(name, Buffer.from(String(att.contentBytes), 'base64'), { ocr: this.config.ocr });
          if (!ex.text.trim()) continue;
          upsertRecord(this.db, ctx, { sourceRecordId: `${msg.id}/att/${att.id}`, title: `${name} (attachment: ${rec.title})`, content: ex.text, sender: rec.sender, recipients: rec.recipients,
            createdAt: rec.createdAt, documentType: ex.documentType, parentRecordId: r.id, threadKey: rec.threadKey, sourceUrl: rec.sourceUrl });
          counts.added++;
        } catch { counts.skipped++; }
      }
    }
    // Deletion propagation: messages that left the window, were deleted, or moved to Deleted Items / Junk.
    if (!listTruncated) {
      for (const row of this.db.all('SELECT source_record_id FROM records WHERE source_id = ? AND parent_record_id IS NULL', source.id)) {
        if (!listed.has(row.source_record_id)) counts.deleted += this.deleteItem(source.id, row.source_record_id);
      }
    }
    counts.truncated ||= listTruncated;
    return counts;
  }

  /** OneDrive: the delta API lists every change since the last run, including deletions. Supported files are downloaded and extracted. */
  async syncDrive(source, token, counts, diag, full, driveBase = '/me/drive') {
    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: source.type };
    const api = (p) => this.api(token, p, { diag });
    const max = this.config.microsoft.maxItemsPerSync;
    const fromScratch = full || !source.sync_cursor;
    const known = new Map(this.db.all('SELECT source_record_id, modified_at FROM records WHERE source_id = ?', source.id).map(r => [r.source_record_id, r.modified_at]));
    /** @type {Set<string>} */ const seen = new Set();
    /** @type {Map<string, any>} the latest version of each file */ const files = new Map();
    /** @type {Set<string>} */ const toDelete = new Set();
    let next = fromScratch ? `${driveBase}/root/delta?${new URLSearchParams({ $select: 'id,name,file,folder,deleted,size,webUrl,createdDateTime,lastModifiedDateTime' })}` : String(source.sync_cursor);
    let deltaLink = '';
    while (next) {
      const page = await api(next);
      for (const it of page.value || []) {
        if (it.deleted) { toDelete.add(it.id); files.delete(it.id); seen.delete(it.id); continue; }
        if (!it.file) continue;
        seen.add(it.id);
        files.set(it.id, it);
      }
      next = page['@odata.nextLink'] || '';
      deltaLink = page['@odata.deltaLink'] || deltaLink;
    }
    diag.listed = files.size;

    for (const it of files.values()) {
      const ext = String(it.name || '').split('.').pop()?.toLowerCase() || '';
      if (!(ext in SUPPORTED) || Number(it.size) > this.config.microsoft.maxFileBytes) { counts.skipped++; continue; }
      const modified = it.lastModifiedDateTime ? new Date(it.lastModifiedDateTime).toISOString() : null;
      if (known.has(it.id) && known.get(it.id) === modified) { counts.skipped++; continue; }
      if (diag.attempted >= max) { counts.truncated = true; break; }
      diag.attempted++;
      const buf = await this.download(token, it.id, diag, driveBase);
      diag.fetched++;
      try {
        const ex = await extractFile(it.name, buf, { ocr: this.config.ocr });
        if (!ex.text.trim()) { counts.skipped++; continue; }
        const r = upsertRecord(this.db, ctx, { sourceRecordId: it.id, title: it.name, content: ex.text, createdAt: it.createdDateTime, modifiedAt: modified,
          documentType: ex.documentType, sourceUrl: it.webUrl, keywords: undefined, accessPermissions: {} });
        counts[r.status === 'unchanged' ? 'skipped' : r.status]++;
      } catch { counts.skipped++; }
    }
    for (const id of toDelete) counts.deleted += this.deleteItem(source.id, id);
    // A first (full) delta lists every file, so anything indexed that it did not list is gone.
    if (fromScratch && !counts.truncated) {
      for (const row of this.db.all('SELECT source_record_id FROM records WHERE source_id = ?', source.id)) if (!seen.has(row.source_record_id)) counts.deleted += this.deleteItem(source.id, row.source_record_id);
    }
    // Keep the old cursor when cut short, so the next run sees the same changes again (indexed files are skipped).
    if (!counts.truncated && deltaLink) this.db.run('UPDATE sources SET sync_cursor = ? WHERE id = ?', deltaLink, source.id);
    return counts;
  }

  /**
   * Teams: the signed-in person's chats (1:1, group and meeting chats), one record per message. Incremental: per chat,
   * only messages modified after the last sync are listed (Graph allows $filter on lastModifiedDateTime with
   * $orderby desc). Deleted messages are removed from the index. Channel posts are not read (they need
   * ChannelMessage.Read.All, which always needs administrator consent).
   */
  async syncTeams(source, token, counts, diag, full) {
    const cfg = parseJson(source.config, {});
    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: 'teams' };
    const api = (p) => this.api(token, p, { diag });
    const max = this.config.microsoft.maxItemsPerSync;
    const now = new Date().toISOString();
    const since = new Date(Date.now() - (Number(cfg.days) || this.config.microsoft.mailDays) * 86400_000).toISOString();
    /** @type {Record<string, string>} chat id -> newest lastModifiedDateTime already indexed */
    const marks = full ? {} : parseJson(source.sync_cursor, {});
    const me = await api('/me?$select=id');

    /** @type {any[]} */ const chats = [];
    let next = `/me/chats?${new URLSearchParams({ $expand: 'members', $top: '50' })}`;
    while (next) {
      const page = await api(next);
      chats.push(...(page.value || []));
      next = page['@odata.nextLink'] || '';
    }
    diag.listed = chats.length;

    for (const chat of chats) {
      const mark = marks[chat.id] || since;
      if (chat.lastUpdatedDateTime && new Date(chat.lastUpdatedDateTime).toISOString() <= mark) continue;
      const others = (chat.members || []).filter(m => m.userId !== me.id).map(m => m.displayName).filter(Boolean);
      const label = chat.topic || others.join(', ') || (chat.chatType === 'oneOnOne' ? 'Chat' : 'Group chat');
      const members = (chat.members || []).map(m => m.displayName).filter(Boolean);
      let newest = mark, done = true;
      let page = `/me/chats/${encodeURIComponent(chat.id)}/messages?${new URLSearchParams({
        $top: '50', $orderby: 'lastModifiedDateTime desc', $filter: `lastModifiedDateTime gt ${mark} and lastModifiedDateTime lt ${now}`
      })}`;
      while (page) {
        const res = await api(page);
        for (const msg of res.value || []) {
          const id = `${chat.id}|${msg.id}`;
          const modified = msg.lastModifiedDateTime ? new Date(msg.lastModifiedDateTime).toISOString() : null;
          if (modified && modified > newest) newest = modified;
          if (msg.deletedDateTime) { counts.deleted += this.deleteItem(source.id, id); continue; }
          if (msg.messageType !== 'message') { counts.skipped++; continue; }
          if (diag.attempted >= max) { counts.truncated = true; done = false; break; }
          diag.attempted++; diag.fetched++;
          const text = (msg.body?.contentType === 'html' ? htmlToText(msg.body.content || '') : String(msg.body?.content || '')).trim();
          const files = (msg.attachments || []).map(a => a.name).filter(Boolean);
          if (!text && !files.length) { counts.skipped++; continue; }
          const from = msg.from?.user?.displayName || msg.from?.application?.displayName || 'Unknown';
          const when = msg.createdDateTime ? new Date(msg.createdDateTime).toISOString() : null;
          const r = upsertRecord(this.db, ctx, {
            sourceRecordId: id, title: `Teams: ${label}${when ? `, ${when.slice(0, 16).replace('T', ' ')}` : ''}`,
            content: `${from}: ${text}${files.length ? `\n[Attached: ${files.join(', ')}]` : ''}`.slice(0, 200000),
            sender: from, recipients: members.filter(n => n !== from), createdAt: when, modifiedAt: modified,
            documentType: 'Teams message', threadKey: `teams:${chat.id}`, sourceUrl: chat.webUrl || undefined, keywords: undefined, accessPermissions: {}
          });
          counts[r.status === 'unchanged' ? 'skipped' : r.status]++;
        }
        if (!done) break;
        page = res['@odata.nextLink'] || '';
      }
      // Only move a chat's mark forward when all its changes were read, so a cut-short sync resumes correctly.
      if (done) marks[chat.id] = newest;
      if (counts.truncated) break;
    }
    this.db.run('UPDATE sources SET sync_cursor = ? WHERE id = ?', JSON.stringify(marks), source.id);
    return counts;
  }

  deleteItem(sourceId, itemId) {
    const rows = this.db.all('SELECT id FROM records WHERE source_id = ? AND (source_record_id = ? OR source_record_id LIKE ?)', sourceId, itemId, `${itemId}/att/%`);
    for (const r of rows) deleteRecord(this.db, r.id);
    return rows.length;
  }

  /**
   * Microsoft has no token-revocation endpoint for this flow; deleting our stored tokens is what disconnects.
   * The user can also remove the app's access at https://account.live.com/consent/Manage (personal) or https://myapps.microsoft.com (work).
   */
  async disconnect() { return { revoked: false }; }
}

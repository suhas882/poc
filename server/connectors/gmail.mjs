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

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const STATE_TTL_MS = 10 * 60 * 1000;

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
  authorize(user, { query = this.config.gmail.defaultQuery, shareWithRoles = [] } = {}) {
    this.assertReady();
    const vault = /** @type {import('../security.mjs').Vault} */ (this.vault);
    const state = randomToken(24);
    const verifier = randomToken(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    this.db.run('DELETE FROM oauth_states WHERE expires_at < ?', nowIso());
    this.db.run('INSERT INTO oauth_states (state_hash, tenant_id, user_id, provider, verifier_ciphertext, options, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha256(state), user.tenantId, user.id, 'google', vault.seal(verifier), JSON.stringify({ query, shareWithRoles }), new Date(Date.now() + STATE_TTL_MS).toISOString());
    const g = this.config.google;
    const url = new URL(g.authUrl);
    url.search = new URLSearchParams({
      client_id: g.clientId, redirect_uri: g.redirectUri, response_type: 'code', scope: GMAIL_SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state, code_challenge: challenge, code_challenge_method: 'S256'
    }).toString();
    return { url: url.toString(), scopes: [GMAIL_SCOPE] };
  }

  /** Step 2: Google redirects back with ?code&state. Exchange the code and create (or refresh) the source. */
  async handleCallback(user, { code, state, error }) {
    this.assertReady();
    const vault = /** @type {import('../security.mjs').Vault} */ (this.vault);
    if (error) throw new HttpError(400, 'consent_declined', error === 'access_denied' ? 'Gmail access was not granted, so nothing was connected.' : `Google returned an error: ${String(error).slice(0, 100)}.`);
    if (!code || !state) throw new HttpError(400, 'invalid_callback', 'The sign-in response from Google is incomplete. Start the connection again.');
    const row = this.db.get('SELECT * FROM oauth_states WHERE state_hash = ?', sha256(String(state)));
    this.db.run('DELETE FROM oauth_states WHERE state_hash = ?', sha256(String(state)));
    if (!row || row.expires_at < nowIso()) throw new HttpError(400, 'invalid_state', 'This connection link has expired or was already used. Start the connection again.');
    if (row.user_id !== user.id || row.tenant_id !== user.tenantId) throw new HttpError(403, 'state_mismatch', 'This connection was started by a different user.');
    const options = parseJson(row.options, {});
    const g = this.config.google;
    const tokenRes = await this.fetch(g.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(code), client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: g.redirectUri, grant_type: 'authorization_code', code_verifier: vault.open(row.verifier_ciphertext) }),
      signal: AbortSignal.timeout(20000)
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokens.access_token) throw new HttpError(502, 'token_exchange_failed', 'Google did not accept the sign-in code. Start the connection again.');
    const granted = String(tokens.scope || '').split(/\s+/);
    if (!granted.includes(GMAIL_SCOPE)) {
      await this.revoke(tokens.refresh_token || tokens.access_token).catch(() => {});
      throw new HttpError(400, 'scope_not_granted', 'Read access to Gmail was not granted on Google’s consent screen, so the account was not connected.');
    }
    const profile = await this.api(tokens.access_token, '/users/me/profile');
    const email = String(profile.emailAddress || '').toLowerCase();
    const creds = { refreshToken: tokens.refresh_token || null, accessToken: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 };
    const existing = this.db.get("SELECT id, sync_cursor FROM sources WHERE tenant_id = ? AND type = 'gmail' AND owner_user_id = ? AND account_label = ?", user.tenantId, user.id, email);
    const shareWithRoles = Array.isArray(options.shareWithRoles) ? options.shareWithRoles : [];
    const id = existing?.id ?? crypto.randomUUID();
    this.db.tx(() => {
      if (existing) {
        if (!creds.refreshToken) { const old = this.loadCredentials(id); creds.refreshToken = old?.refreshToken ?? null; }
        this.db.run("UPDATE sources SET status = 'connected', last_error = NULL, scopes = ?, updated_at = ? WHERE id = ?", JSON.stringify(granted), nowIso(), id);
      } else {
        this.db.run(`INSERT INTO sources (id, tenant_id, type, name, status, owner_user_id, visibility, allowed_roles, config, scopes, account_label)
          VALUES (?, ?, 'gmail', ?, 'connected', ?, ?, ?, ?, ?, ?)`,
        id, user.tenantId, `Gmail: ${email}`, user.id, shareWithRoles.length ? 'roles' : 'owner', JSON.stringify(shareWithRoles),
        JSON.stringify({ query: options.query ?? this.config.gmail.defaultQuery, indexAttachments: this.config.gmail.indexAttachments }), JSON.stringify(granted), email);
      }
      this.saveCredentials(id, creds);
    });
    return { sourceId: id, email, reconnected: Boolean(existing) };
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
      this.db.run("UPDATE sources SET status = 'needs_attention', last_error = ? WHERE id = ?", 'Google no longer accepts the stored access (it may have been revoked). Reconnect Gmail.', source.id);
      throw new HttpError(409, 'reconnect_required', 'Google no longer accepts the stored access for this account. Reconnect Gmail.');
    }
    this.saveCredentials(source.id, { ...creds, accessToken: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 });
    return json.access_token;
  }

  async api(token, pathAndQuery, { allow404 = false } = {}) {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetch(`${this.config.google.gmailApiBase}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
      if (res.ok) return res.json();
      if (allow404 && res.status === 404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise(r => setTimeout(r, 400 * 2 ** attempt)); continue; }
      if (res.status === 401) throw new HttpError(409, 'reconnect_required', 'Gmail rejected the access token. Reconnect the account.');
      if (res.status === 403) throw new HttpError(403, 'gmail_forbidden', 'Gmail refused the request. The account may not allow API access (check Google Workspace admin settings).');
      throw new HttpError(502, 'gmail_error', `Gmail returned HTTP ${res.status}.`);
    }
  }

  /**
   * Incremental sync. Returns counts. Deletions in Gmail remove the matching records here.
   * @param {any} source a sources row
   */
  async sync(source, { full = false } = {}) {
    this.assertReady();
    const token = await this.accessToken(source);
    const cfg = parseJson(source.config, {});
    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: 'gmail' };
    const counts = { added: 0, updated: 0, deleted: 0, skipped: 0, truncated: false };
    const profile = await this.api(token, '/users/me/profile');
    /** @type {Set<string>} */ const toFetch = new Set();
    /** @type {Set<string>} */ const toDelete = new Set();
    let listedAll = null;

    let incremental = !full && Boolean(source.sync_cursor);
    if (incremental) {
      let pageToken = '';
      do {
        const q = new URLSearchParams({ startHistoryId: source.sync_cursor, maxResults: '500' });
        q.append('historyTypes', 'messageAdded'); q.append('historyTypes', 'messageDeleted'); q.append('historyTypes', 'labelAdded');
        if (pageToken) q.set('pageToken', pageToken);
        const h = await this.api(token, `/users/me/history?${q}`, { allow404: true });
        if (!h) { incremental = false; break; } // history too old: fall back to a full re-list
        for (const item of h.history || []) {
          for (const m of item.messagesAdded || []) toFetch.add(m.message.id);
          for (const m of item.messagesDeleted || []) { toDelete.add(m.message.id); toFetch.delete(m.message.id); }
          for (const m of item.labelsAdded || []) if ((m.labelIds || []).some(l => l === 'TRASH' || l === 'SPAM')) { toDelete.add(m.message.id); toFetch.delete(m.message.id); }
        }
        pageToken = h.nextPageToken || '';
      } while (pageToken && toFetch.size < this.config.gmail.maxMessagesPerSync);
    }
    if (!incremental) {
      listedAll = new Set();
      let pageToken = '';
      do {
        const q = new URLSearchParams({ maxResults: '100' });
        if (cfg.query) q.set('q', cfg.query);
        if (pageToken) q.set('pageToken', pageToken);
        const list = await this.api(token, `/users/me/messages?${q}`);
        for (const m of list.messages || []) { listedAll.add(m.id); toFetch.add(m.id); }
        pageToken = list.nextPageToken || '';
        if (toFetch.size >= this.config.gmail.maxMessagesPerSync) { counts.truncated = Boolean(pageToken); break; }
      } while (pageToken);
    }

    for (const id of toFetch) {
      if (counts.added + counts.updated + counts.skipped >= this.config.gmail.maxMessagesPerSync) { counts.truncated = true; break; }
      const msg = await this.api(token, `/users/me/messages/${encodeURIComponent(id)}?format=full`, { allow404: true });
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
            const data = await this.api(token, `/users/me/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(att.attachmentId)}`);
            const buf = Buffer.from(String(data.data || ''), 'base64url');
            const ex = await extractFile(att.filename, buf, { ocr: this.config.ocr });
            if (!ex.text.trim()) continue;
            upsertRecord(this.db, ctx, {
              sourceRecordId: attId, title: `${att.filename} (attachment: ${rec.title})`, content: ex.text, sender: parsed.from, recipients: parsed.to,
              createdAt: parsed.date, documentType: ex.documentType, parentRecordId: r.id, threadKey: rec.threadKey, sourceUrl: rec.sourceUrl
            });
            counts.added++;
          } catch { counts.skipped++; }
        }
      }
    }

    // Deletion propagation.
    for (const id of toDelete) counts.deleted += this.deleteMessage(source.id, id);
    if (listedAll && !counts.truncated) {
      for (const row of this.db.all('SELECT source_record_id FROM records WHERE source_id = ? AND parent_record_id IS NULL', source.id)) {
        if (!listedAll.has(row.source_record_id)) counts.deleted += this.deleteMessage(source.id, row.source_record_id);
      }
    }
    this.db.run('UPDATE sources SET sync_cursor = ? WHERE id = ?', String(profile.historyId || source.sync_cursor || ''), source.id);
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

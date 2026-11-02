// @ts-check
/**
 * Google Drive connector (drive.readonly). Sign-in, token storage and refresh are shared with Gmail through
 * GmailConnector, which is the server's one Google OAuth client; each Drive source holds its own token.
 *
 * First sync lists every file the user can see in My Drive and files shared with them; later syncs read only
 * the Changes feed from a stored page token, including removals and files moved to the trash.
 * Google Docs, Sheets and Slides are exported as text or CSV; other files are downloaded when their format is
 * one the app can extract (PDF, Word, Excel, CSV, text, images).
 */
import { upsertRecord, deleteRecord } from '../ingest/pipeline.mjs';
import { extractFile, SUPPORTED } from '../ingest/extract.mjs';
import { classifyGoogleError, GmailApiError } from './gmail.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** Problems with the account or the quota stop the sync; anything else that goes wrong with one file only skips that file. */
const STOPS_SYNC = new Set(['reconnect_required', 'gmail_daily_quota', 'gmail_rate_limited', 'gmail_api_disabled', 'gmail_scope_missing', 'gmail_account_policy']);
const FIELDS = 'id,name,mimeType,modifiedTime,createdTime,size,webViewLink,trashed,owners(emailAddress)';
/** Google's own formats have no file to download; they are exported. */
const EXPORT = Object.freeze({
  'application/vnd.google-apps.document': { mime: 'text/plain', ext: 'txt', type: 'Google Doc' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: 'csv', type: 'Google Sheet' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', ext: 'txt', type: 'Google Slides' }
});

/** Drive method name for diagnostics. */
export function driveEndpoint(path) {
  const p = String(path).split('?')[0];
  if (p === '/changes/startPageToken') return 'drive.changes.getStartPageToken';
  if (p === '/changes') return 'drive.changes.list';
  if (p === '/files') return 'drive.files.list';
  if (/^\/files\/[^/]+\/export$/.test(p)) return 'drive.files.export';
  if (/^\/files\/[^/]+$/.test(p)) return 'drive.files.get';
  return `drive${p.replace(/\/[^/]*\d[^/]*/g, '/{id}').replace(/\//g, '.')}`;
}

export class GoogleDriveConnector {
  /** @param {{db: import('../db.mjs').Database, config: import('../config.mjs').AppConfig, google: import('./gmail.mjs').GmailConnector, fetch?: typeof fetch}} deps */
  constructor({ db, config, google, fetch: f }) {
    this.db = db;
    this.config = config;
    this.google = google;
    this.fetch = f ?? fetch;
  }

  get configured() { return this.google.configured; }

  /** One Drive call; JSON unless `raw`. Rate limits, outages and dropped connections wait and retry like Gmail's. */
  async api(token, path, { diag, raw = false, allow404 = false } = {}) {
    const endpoint = driveEndpoint(path);
    const g = this.config.gmail;
    for (let attempt = 1; ; attempt++) {
      if (diag) diag.apiCalls = (diag.apiCalls || 0) + 1;
      let res;
      try {
        res = await this.fetch(`${this.config.google.driveApiBase}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
        if (res.ok) return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
      } catch (err) {
        // The connection dropped or the download timed out (the timeout covers reading the body too).
        if (attempt <= g.rateLimitRetries) { await sleep(Math.min(1000 * 2 ** attempt, g.rateLimitMaxWaitMs)); continue; }
        const reason = err instanceof Error ? (err.name === 'TimeoutError' ? 'timeout' : String(/** @type {any} */ (err).cause?.code || err.message)) : String(err);
        throw new GmailApiError(502, 'gmail_unavailable', `Google Drive could not be reached: ${reason}. Sync again in a few minutes. (${endpoint})`,
          { endpoint, httpStatus: 0, reason, providerMessage: null });
      }
      if (allow404 && res.status === 404) return null;
      const body = await res.json().catch(() => ({}));
      const c = classifyGoogleError(res.status, body, endpoint);
      if (c.retryable && attempt <= g.rateLimitRetries) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        const wait = Math.min(Math.max(c.waitMs ?? (retryAfter > 0 ? retryAfter : 1000 * 2 ** attempt), 250), g.rateLimitMaxWaitMs);
        if (diag && c.kind === 'rate_limited') { diag.rateLimitWaits = (diag.rateLimitWaits || 0) + 1; diag.waitedMs = (diag.waitedMs || 0) + wait; }
        await sleep(wait);
        continue;
      }
      throw c.error;
    }
  }

  /** @param {any} source a sources row */
  async sync(source, { full = false, diag = {} } = {}) {
    this.google.assertReady();
    const token = await this.google.accessToken(source);
    const counts = { added: 0, updated: 0, deleted: 0, skipped: 0, truncated: false };
    Object.assign(diag, { counts, listed: 0, attempted: 0, fetched: 0, apiCalls: 0, rateLimitWaits: 0, waitedMs: 0 });
    const api = (p, o = {}) => this.api(token, p, { ...o, diag });
    const fromScratch = full || !source.sync_cursor;
    const known = new Map(this.db.all('SELECT source_record_id, modified_at FROM records WHERE source_id = ?', source.id).map(r => [r.source_record_id, r.modified_at]));
    /** @type {Map<string, any>} */ const files = new Map();
    /** @type {Set<string>} */ const removed = new Set();
    let nextCursor = '';

    if (fromScratch) {
      // Take the change token first, so nothing that changes during the listing is missed next time.
      nextCursor = (await api('/changes/startPageToken')).startPageToken;
      let pageToken = '';
      do {
        const q = new URLSearchParams({ q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'", fields: `nextPageToken,files(${FIELDS})`, pageSize: '200', spaces: 'drive' });
        if (pageToken) q.set('pageToken', pageToken);
        const page = await api(`/files?${q}`);
        for (const f of page.files || []) files.set(f.id, f);
        pageToken = page.nextPageToken || '';
      } while (pageToken);
    } else {
      let pageToken = String(source.sync_cursor);
      while (pageToken) {
        const q = new URLSearchParams({ pageToken, fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`, pageSize: '200', spaces: 'drive' });
        const page = await api(`/changes?${q}`);
        for (const ch of page.changes || []) {
          if (ch.removed || ch.file?.trashed) { removed.add(ch.fileId); files.delete(ch.fileId); continue; }
          if (ch.file && ch.file.mimeType !== 'application/vnd.google-apps.folder') files.set(ch.fileId, ch.file);
        }
        if (page.newStartPageToken) nextCursor = page.newStartPageToken;
        pageToken = page.nextPageToken || '';
      }
    }
    diag.listed = files.size;

    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: 'gdrive' };
    const maxBytes = this.config.gdrive.maxFileBytes;
    let retryLater = false;
    for (const f of files.values()) {
      const exp = EXPORT[f.mimeType];
      const ext = exp ? exp.ext : String(f.name || '').split('.').pop()?.toLowerCase() || '';
      if ((!exp && !(ext in SUPPORTED)) || Number(f.size || 0) > maxBytes) { counts.skipped++; continue; }
      const modified = f.modifiedTime ? new Date(f.modifiedTime).toISOString() : null;
      if (known.has(f.id) && known.get(f.id) === modified) { counts.skipped++; continue; }
      if (diag.attempted >= this.config.gdrive.maxItemsPerSync) { counts.truncated = true; break; }
      diag.attempted++;
      let buf;
      try {
        buf = exp
          ? await api(`/files/${encodeURIComponent(f.id)}/export?${new URLSearchParams({ mimeType: exp.mime })}`, { raw: true, allow404: true })
          : await api(`/files/${encodeURIComponent(f.id)}?alt=media`, { raw: true, allow404: true });
      } catch (err) {
        // e.g. a Doc too large to export, a file Google will not let anyone download, or a download that kept dropping.
        if (err instanceof GmailApiError && STOPS_SYNC.has(err.code)) throw err;
        counts.skipped++;
        diag.failedFiles = (diag.failedFiles || 0) + 1;
        // A file that failed for a passing reason is fetched again next time, so the change token stays where it was.
        if (!(err instanceof GmailApiError) || err.code === 'gmail_unavailable') retryLater = true;
        continue;
      }
      if (!buf) { removed.add(f.id); continue; }
      diag.fetched++;
      try {
        const name = exp ? `${f.name}.${exp.ext}` : f.name;
        const ex = await extractFile(name, buf, { ocr: this.config.ocr });
        if (!ex.text.trim()) { counts.skipped++; continue; }
        const r = upsertRecord(this.db, ctx, { sourceRecordId: f.id, title: f.name, content: ex.text, sender: f.owners?.[0]?.emailAddress ?? null, createdAt: f.createdTime, modifiedAt: modified,
          documentType: exp ? exp.type : ex.documentType, sourceUrl: f.webViewLink, keywords: undefined, accessPermissions: {} });
        counts[r.status === 'unchanged' ? 'skipped' : r.status]++;
      } catch { counts.skipped++; }
    }
    for (const id of removed) counts.deleted += this.deleteItem(source.id, id);
    // A full listing shows every file, so anything indexed that it did not list is gone.
    if (fromScratch && !counts.truncated) {
      for (const row of this.db.all('SELECT source_record_id FROM records WHERE source_id = ?', source.id)) if (!files.has(row.source_record_id)) counts.deleted += this.deleteItem(source.id, row.source_record_id);
    }
    // Only move forward once everything up to the token is indexed; otherwise the next run sees the same changes again.
    if (!counts.truncated && !retryLater && nextCursor) this.db.run('UPDATE sources SET sync_cursor = ? WHERE id = ?', nextCursor, source.id);
    return counts;
  }

  deleteItem(sourceId, fileId) {
    const rows = this.db.all('SELECT id FROM records WHERE source_id = ? AND source_record_id = ?', sourceId, fileId);
    for (const r of rows) deleteRecord(this.db, r.id);
    return rows.length;
  }

  /** Revokes the Drive token at Google (the shared Google client does the revoking). */
  disconnect(source) { return this.google.disconnect(source); }
}

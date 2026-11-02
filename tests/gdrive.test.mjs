import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fakeServer, startApp, waitForSync, searchReq } from './helpers.mjs';
import { driveEndpoint } from '../server/connectors/gdrive.mjs';

const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';
const errOf = (r) => new URL(r.headers.get('location'), 'http://x').searchParams.get('error') || '';

async function googleFake() {
  const state = { challenge: null, scope: DRIVE, rateLimitNext: 0, changes: [], revoked: new Set() };
  const files = new Map([
    ['d1', { id: 'd1', name: 'Cedar Avenue closure plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-09-01T10:00:00Z', createdTime: '2026-08-01T10:00:00Z', webViewLink: 'https://docs.google.com/document/d/d1', owners: [{ emailAddress: 'pat@city.gov' }], body: 'Plan: the Cedar Avenue lane closure runs nightly with a Birch Street detour.' }],
    ['s1', { id: 's1', name: 'Permit log', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-09-02T10:00:00Z', webViewLink: 'https://docs.google.com/spreadsheets/d/s1', body: 'permit,street\nP-77,Cedar Avenue\n' }],
    ['t1', { id: 't1', name: 'notes.txt', mimeType: 'text/plain', size: '40', modifiedTime: '2026-09-03T10:00:00Z', webViewLink: 'https://drive.google.com/file/d/t1', body: 'Field notes from the Cedar Avenue site.' }],
    ['v1', { id: 'v1', name: 'site-video.mp4', mimeType: 'video/mp4', size: '900', modifiedTime: '2026-09-03T10:00:00Z', webViewLink: 'https://drive.google.com/file/d/v1', body: 'x' }]
  ]);
  const server = await fakeServer((req, url, body) => {
    const form = new URLSearchParams(body);
    if (url.pathname === '/token') {
      if (form.get('grant_type') === 'authorization_code') {
        if (crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== state.challenge) return { status: 400, json: { error: 'invalid_grant' } };
        return { json: { access_token: 'drive-access-1', refresh_token: 'drive-refresh-1', expires_in: 3600, scope: state.scope } };
      }
      return { json: { access_token: 'drive-access-r', expires_in: 3600 } };
    }
    if (url.pathname === '/revoke') { state.revoked.add(form.get('token')); return { json: {} }; }
    if (!/^Bearer drive-access/.test(req.headers.authorization || '')) return { status: 401, json: { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } } };
    if (state.apiDisabled) return { status: 403, json: { error: { code: 403, message: 'Google Drive API has not been used in project 716431953394 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }],
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { consumer: 'projects/716431953394' } }] } } };
    if (state.rateLimitNext > 0) { state.rateLimitNext--; return { status: 403, json: { error: { code: 403, message: 'User rate limit exceeded.', errors: [{ reason: 'userRateLimitExceeded' }] } } }; }
    const p = url.pathname.replace('/drive/v3', '');
    if (p === '/about') return { json: { user: { emailAddress: 'Clerk@City.gov' } } };
    if (p === '/changes/startPageToken') return { json: { startPageToken: '100' } };
    if (p === '/files') {
      assert.match(url.searchParams.get('q'), /trashed = false/);
      const all = [...files.values()].map(({ body: _b, ...f }) => f);
      if (!url.searchParams.get('pageToken')) return { json: { files: all.slice(0, 2), nextPageToken: 'p2' } };
      return { json: { files: all.slice(2) } };
    }
    if (p === '/changes') { const v = state.changes; state.changes = []; return { json: { changes: v, newStartPageToken: '101' } }; }
    let m = /^\/files\/([^/]+)\/export$/.exec(p);
    if (m) return files.has(m[1]) ? { body: files.get(m[1]).body } : { status: 404, json: {} };
    m = /^\/files\/([^/]+)$/.exec(p);
    if (m && url.searchParams.get('alt') === 'media') return files.has(m[1]) ? { body: files.get(m[1]).body } : { status: 404, json: {} };
    return { status: 404, json: {} };
  });
  return { ...server, state, files };
}

test('Google Drive: drive.readonly sign-in, export of Google formats, paging, changes feed, trash and removal, disconnect', async (t) => {
  const g = await googleFake();
  const env = await startApp({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`,
    GOOGLE_DRIVE_API_BASE: `${g.url}/drive/v3`, GMAIL_API_BASE: `${g.url}/gmail/v1`, GMAIL_RATE_LIMIT_MAX_WAIT_MS: '10', PUBLIC_URL: 'http://localhost:9999' });
  t.after(async () => { await env.close(); await g.close(); });
  const c = env.client(); await c.setup();
  const conn = (await c.get('/api/connectors')).data.data.find(x => x.type === 'gdrive');
  assert.equal(conn.status, 'available'); assert.equal(conn.lifecycle, 'authorization_required'); assert.equal(conn.category, 'files');

  let r = await c.post('/api/connectors/gmail/authorize', { kind: 'gdrive' });
  const auth = new URL(r.data.data.url);
  assert.equal(auth.searchParams.get('scope'), DRIVE, 'only drive.readonly is requested');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  g.state.challenge = auth.searchParams.get('code_challenge');
  r = await c.get(`/oauth/google/callback?code=good&state=${auth.searchParams.get('state')}`);
  const id = new URL(r.headers.get('location'), 'http://x').searchParams.get('connected');
  assert(id, r.headers.get('location'));
  assert(!fs.readFileSync(env.config.dbPath).includes(Buffer.from('drive-refresh-1')), 'no plaintext token in the database file');

  let src = await waitForSync(c, id);
  assert.equal(src.status, 'connected', src.lastError);
  assert.equal(src.type, 'gdrive');
  assert.equal(src.accountLabel, 'clerk@city.gov');
  assert.equal(src.recordCount, 3, 'Doc, Sheet and text file; the video is skipped');
  assert.equal(src.lifecycle, 'indexed');
  let job = (await c.get(`/api/sources/${id}/jobs`)).data.data[0];
  assert.equal(job.listed, 4); assert.equal(job.fetched, 3);
  assert(g.calls.some(x => x.path === '/drive/v3/files/d1/export' && x.url.searchParams.get('mimeType') === 'text/plain'));
  assert(g.calls.some(x => x.path === '/drive/v3/files/s1/export' && x.url.searchParams.get('mimeType') === 'text/csv'));

  const sr = await searchReq(c, 'Cedar Avenue lane closure detour', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  const hit = sr.results.find(x => x.record.title === 'Cedar Avenue closure plan');
  assert(hit, JSON.stringify(sr.results.map(x => x.record.title)));
  assert.equal(hit.record.sourceType, 'gdrive');
  assert.equal(hit.record.sourceUrl, 'https://docs.google.com/document/d/d1');
  assert.equal(hit.record.documentType, 'Google Doc');

  // Changes feed: one file edited, one trashed, one removed. Unchanged files are not downloaded again.
  g.files.get('t1').body = 'Updated field notes: Cedar Avenue reopened.';
  g.state.changes = [
    { fileId: 't1', file: { ...g.files.get('t1'), body: undefined, modifiedTime: '2026-10-01T10:00:00Z' } },
    { fileId: 'd1', file: { ...g.files.get('d1'), body: undefined, trashed: true } },
    { fileId: 's1', removed: true }
  ];
  const exportsBefore = g.calls.filter(x => x.path.endsWith('/export')).length;
  g.state.rateLimitNext = 1; // the changes call hits Drive's rate limit once and is retried
  await c.post(`/api/sources/${id}/sync`);
  src = await waitForSync(c, id);
  job = (await c.get(`/api/sources/${id}/jobs`)).data.data[0];
  assert.equal(job.status, 'succeeded', job.error);
  assert.equal(job.updated, 1); assert.equal(job.deleted, 2);
  assert.equal(job.rateLimitWaits, 1);
  assert.equal(src.recordCount, 1);
  assert.equal(g.calls.filter(x => x.path.endsWith('/export')).length, exportsBefore, 'no Google Doc was exported again');
  assert.equal(g.calls.filter(x => x.path === '/drive/v3/changes').at(-1).url.searchParams.get('pageToken'), '100', 'the stored page token is used');
  assert.equal(env.app.db.get('SELECT sync_cursor FROM sources WHERE id = ?', id).sync_cursor, '101');

  // Declined scope connects nothing.
  r = await c.post('/api/connectors/gmail/authorize', { kind: 'gdrive' });
  const a2 = new URL(r.data.data.url);
  g.state.challenge = a2.searchParams.get('code_challenge'); g.state.scope = 'openid';
  r = await c.get(`/oauth/google/callback?code=good&state=${a2.searchParams.get('state')}`);
  assert.match(errOf(r), /Read access to Google Drive was not granted/);

  // Disconnect revokes at Google and deletes everything stored.
  r = await c.del(`/api/sources/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.data.revokedAtProvider, true);
  assert(g.state.revoked.has('drive-refresh-1'));
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM records WHERE source_id = ?', id).n, 0);
});

test('Drive API not enabled: the authorization is kept, Drive shows Permission denied with Google’s reason, Gmail is unaffected', async (t) => {
  const g = await googleFake();
  const env = await startApp({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`,
    GOOGLE_DRIVE_API_BASE: `${g.url}/drive/v3`, GMAIL_API_BASE: `${g.url}/gmail/v1`, GMAIL_RATE_LIMIT_RETRIES: '0', SYNC_RETRIES: '0' });
  t.after(async () => { await env.close(); await g.close(); });
  const c = env.client(); await c.setup();
  g.state.apiDisabled = true;
  const auth = new URL((await c.post('/api/connectors/gmail/authorize', { kind: 'gdrive' })).data.data.url);
  g.state.challenge = auth.searchParams.get('code_challenge');
  const r = await c.get(`/oauth/google/callback?code=good&state=${auth.searchParams.get('state')}`);
  const id = new URL(r.headers.get('location'), 'http://x').searchParams.get('connected');
  assert(id, 'the consent is kept even though the API is off: ' + r.headers.get('location'));
  let src = await waitForSync(c, id);
  assert.equal(src.lifecycle, 'permission_denied');
  assert.match(src.lastError, /Google Drive API is not enabled in Google Cloud project 716431953394/);
  const job = (await c.get(`/api/sources/${id}/jobs`)).data.data[0];
  assert.equal(job.errorReason, 'accessNotConfigured'); assert.equal(job.apiStatus, 403);
  // Gmail is a separate service; its card does not inherit Drive's problem.
  const cat = (await c.get('/api/connectors')).data.data;
  assert.equal(cat.find(x => x.type === 'gdrive').lifecycle, 'permission_denied');
  assert.equal(cat.find(x => x.type === 'gmail').lifecycle, 'authorization_required');
  // Once the API is enabled, Sync now works without asking for consent again.
  g.state.apiDisabled = false;
  await c.post(`/api/sources/${id}/sync`);
  src = await waitForSync(c, id);
  assert.equal(src.lifecycle, 'indexed', src.lastError);
  assert.equal(src.recordCount, 3);
});

test('Drive: a dropped download is retried, and a file Google will not hand over is skipped instead of failing the sync', async (t) => {
  const g = await googleFake();
  g.files.set('big', { id: 'big', name: 'Huge minutes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-09-04T10:00:00Z', body: 'x' });
  g.files.set('flaky', { id: 'flaky', name: 'flaky.txt', mimeType: 'text/plain', size: '20', modifiedTime: '2026-09-04T10:00:00Z', body: 'Flaky but readable notes.' });
  g.files.set('dead', { id: 'dead', name: 'dead.txt', mimeType: 'text/plain', size: '20', modifiedTime: '2026-09-04T10:00:00Z', body: 'Never arrives.' });
  let flakyDrops = 2;
  const realFetch = fetch;
  /** @type {typeof fetch} */
  const doFetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/files/flaky?') && flakyDrops-- > 0) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    if (u.includes('/files/dead?')) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    if (u.includes('/files/big/export')) return new Response(JSON.stringify({ error: { code: 403, message: 'This file is too large to be exported.', errors: [{ reason: 'exportSizeLimitExceeded' }] } }), { status: 403 });
    return realFetch(url, init);
  };
  const env = await startApp({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`,
    GOOGLE_DRIVE_API_BASE: `${g.url}/drive/v3`, GMAIL_API_BASE: `${g.url}/gmail/v1`, GMAIL_RATE_LIMIT_RETRIES: '2', GMAIL_RATE_LIMIT_MAX_WAIT_MS: '10' }, { fetch: doFetch });
  t.after(async () => { await env.close(); await g.close(); });
  const c = env.client(); await c.setup();
  const auth = new URL((await c.post('/api/connectors/gmail/authorize', { kind: 'gdrive' })).data.data.url);
  g.state.challenge = auth.searchParams.get('code_challenge');
  const r = await c.get(`/oauth/google/callback?code=good&state=${auth.searchParams.get('state')}`);
  const id = new URL(r.headers.get('location'), 'http://x').searchParams.get('connected');
  const src = await waitForSync(c, id);
  assert.equal(src.status, 'connected', src.lastError);
  assert.equal(src.recordCount, 4, 'Doc, Sheet, notes.txt and flaky.txt; the video, the oversized Doc and the dead download are skipped');
  const job = (await c.get(`/api/sources/${id}/jobs`)).data.data[0];
  assert.equal(job.status, 'succeeded', job.error);
  assert.equal(job.skipped, 3);
  assert.equal(env.app.db.get('SELECT sync_cursor FROM sources WHERE id = ?', id).sync_cursor, null, 'the dead download is tried again next sync');
});

test('driveEndpoint names Drive methods for Sync History', () => {
  assert.equal(driveEndpoint('/files?q=x'), 'drive.files.list');
  assert.equal(driveEndpoint('/files/abc123/export?mimeType=text/plain'), 'drive.files.export');
  assert.equal(driveEndpoint('/files/abc123?alt=media'), 'drive.files.get');
  assert.equal(driveEndpoint('/changes?pageToken=5'), 'drive.changes.list');
});

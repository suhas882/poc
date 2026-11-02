import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fakeServer, startApp, waitForSync, searchReq } from './helpers.mjs';

const table = { name: 'permits', idColumn: 'id', titleColumn: 'title', contentColumns: ['description'], dateColumn: 'issued_on' };

function permitsFile(env) {
  const dir = path.join(env.dir, 'connectors'); fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'city.sqlite'));
  db.exec("CREATE TABLE permits (id INTEGER PRIMARY KEY, title TEXT, description TEXT, issued_on TEXT); INSERT INTO permits VALUES (1, 'Street use permit P-1', 'Lane closure on Cedar Avenue for utility work', '2025-01-10');");
  db.close();
}

test('source approval: a Clerk’s new source waits for a Supervisor, is never synced or searched while waiting, and is audited', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  permitsFile(env);
  const admin = env.client(); await admin.setup();
  await admin.post('/api/users', { email: 'clerk@x.org', name: 'Casey Clerk', role: 'records_officer', password: 'clerk password 12' });
  await admin.post('/api/users', { email: 'rev@x.org', name: 'Robin Reviewer', role: 'reviewer', password: 'reviewer password 1' });
  const clerk = env.client(); await clerk.login('clerk@x.org', 'clerk password 12');
  const reviewer = env.client(); await reviewer.login('rev@x.org', 'reviewer password 1');

  // Off by default: connecting starts a sync straight away.
  let cat = (await clerk.get('/api/connectors')).data.data;
  assert.equal(cat.find(c => c.driver === 'sqlite').lifecycle, 'available');
  assert.equal(cat.find(c => c.type === 'gmail').lifecycle, 'needs_setup', 'Gmail is not configured on this test server');
  assert.equal(cat.find(c => c.type === 'gdrive').category, 'files');

  // Only a Supervisor can switch approval on.
  assert.equal((await clerk.put('/api/settings/switches', { sourceApproval: true })).status, 403);
  assert.equal((await admin.put('/api/settings/switches', { sourceApproval: true })).status, 200);
  cat = (await clerk.get('/api/connectors')).data.data;
  assert.equal(cat.find(c => c.driver === 'sqlite').approvalRequired, true);
  assert.equal(cat.find(c => c.type === 'uploads').approvalRequired, false, 'uploads are explicit imports and need no approval');

  let r = await clerk.post('/api/sources/database', { name: 'Permits', driver: 'sqlite', file: 'city.sqlite', visibility: 'roles', tables: [table] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.data.sourceId;
  assert.equal(r.data.data.jobId, null, 'no sync is started while waiting');
  let src = (await clerk.get('/api/sources')).data.data.find(x => x.id === id);
  assert.equal(src.lifecycle, 'pending_approval');
  assert.equal(src.recordCount, 0);
  assert.equal((await clerk.get('/api/connectors')).data.data.find(c => c.driver === 'sqlite').lifecycle, 'pending_approval');
  assert.equal((await clerk.post(`/api/sources/${id}/sync`)).status, 409, 'the owner cannot sync it before approval');
  assert(!(await reviewer.get('/api/sources')).data.data.some(x => x.id === id), 'other roles do not see a waiting source');
  assert.equal((await clerk.post(`/api/sources/${id}/approve`)).status, 403, 'a Clerk cannot approve');
  const before = await searchReq(clerk, 'Cedar Avenue lane closure permit', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(!(before.created?.current.sourceIds || []).includes(id), 'a waiting source is not offered to the plan');
  assert(!(before.results || []).some(x => x.record.title === 'Street use permit P-1'), 'a waiting source is never searched');

  // The Supervisor sees it with an approve action, approves it, and the first sync runs.
  src = (await admin.get('/api/sources')).data.data.find(x => x.id === id);
  assert.equal(src.canApprove, true);
  r = await admin.post(`/api/sources/${id}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  src = await waitForSync(clerk, id);
  assert.equal(src.lifecycle, 'indexed');
  assert.equal(src.lastSyncStatus, 'succeeded');
  assert(src.lastSuccessAt);
  const after = await searchReq(clerk, 'Cedar Avenue lane closure permit', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(after.results.some(x => x.record.title === 'Street use permit P-1'));
  assert.equal((await admin.post(`/api/sources/${id}/approve`)).status, 409, 'approving twice is refused');

  // A second request is rejected: the source and everything stored for it are removed.
  r = await clerk.post('/api/sources/database', { name: 'Permits again', driver: 'sqlite', file: 'city.sqlite', tables: [table] });
  const id2 = r.data.data.sourceId;
  assert.equal((await admin.post(`/api/sources/${id2}/reject`)).status, 200);
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM sources WHERE id = ?', id2).n, 0);
  const actions = (await admin.get('/api/audit?pageSize=200')).data.data.map(a => a.action);
  for (const a of ['source.approval_requested', 'source.approved', 'source.rejected']) assert(actions.includes(a), a);

  // "Only me" when connecting keeps a source private to its owner.
  r = await clerk.post('/api/sources/database', { name: 'Private permits', driver: 'sqlite', file: 'city.sqlite', visibility: 'owner', tables: [table] });
  await admin.post(`/api/sources/${r.data.data.sourceId}/approve`);
  assert.equal((await clerk.get('/api/sources')).data.data.find(x => x.id === r.data.data.sourceId).visibility, 'owner');
  assert(!(await reviewer.get('/api/sources')).data.data.some(x => x.id === r.data.data.sourceId));

  // A Supervisor's own sources never wait.
  r = await admin.post('/api/sources/database', { name: 'Admin permits', driver: 'sqlite', file: 'city.sqlite', tables: [table] });
  assert.notEqual(r.data.data.jobId, null);
  await waitForSync(admin, r.data.data.sourceId);
});

test('lifecycle: a revoked sign-in shows as reauthorization required, a temporary failure retries on its own', async (t) => {
  let failures = 2;
  const g = await fakeServer((req, url) => {
    if (url.pathname === '/token') return { json: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' } };
    const p = url.pathname.replace('/gmail/v1/users/me', '');
    if (p === '/profile') return { json: { emailAddress: 'clerk@city.gov', historyId: '5' } };
    // Gmail is down for the first two listings: the sign-in works, the first syncs do not.
    if (p === '/messages') return failures-- > 0 ? { status: 503, json: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } } } : { json: { messages: [] } };
    return { status: 404, json: {} };
  });
  const env = await startApp({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`, GMAIL_API_BASE: `${g.url}/gmail/v1`,
    GMAIL_RATE_LIMIT_RETRIES: '0', SYNC_RETRIES: '3', SYNC_RETRY_DELAY_MS: '20' });
  t.after(async () => { await env.close(); await g.close(); });
  const c = env.client(); await c.setup();
  assert.equal((await c.get('/api/connectors')).data.data.find(x => x.type === 'gmail').lifecycle, 'authorization_required');

  // Connect through the real callback (this fake token endpoint accepts any PKCE verifier; gmail.test.mjs checks PKCE).
  const auth = new URL((await c.post('/api/connectors/gmail/authorize', { query: '' })).data.data.url);
  const r = await c.get(`/oauth/google/callback?code=x&state=${auth.searchParams.get('state')}`);
  const id = new URL(r.headers.get('location'), 'http://x').searchParams.get('connected');
  assert(id, r.headers.get('location'));
  const end = Date.now() + 5000;
  let jobs = [];
  while (Date.now() < end) {
    jobs = (await c.get(`/api/sources/${id}/jobs`)).data.data;
    if (jobs.some(j => j.status === 'succeeded')) break;
    await new Promise(res => setTimeout(res, 50));
  }
  assert(jobs.some(j => j.status === 'failed' && j.errorCode === 'gmail_unavailable'), JSON.stringify(jobs));
  assert(jobs.some(j => j.status === 'succeeded' && j.trigger === 'retry'), 'a later automatic retry succeeded');
  const src = (await c.get('/api/sources')).data.data.find(x => x.id === id);
  assert.equal(src.lifecycle, 'connected', 'synced, but an empty mailbox has nothing indexed');
  assert.equal(src.credentials, 'stored_encrypted');
  assert(!JSON.stringify(src).includes('refresh-1') && !JSON.stringify(src).includes('access-1'), 'no secret reaches the browser');

  // Revoked at Google: reauthorization required.
  env.app.db.run("UPDATE sources SET status = 'needs_attention' WHERE id = ?", id);
  env.app.db.run("INSERT INTO sync_jobs (id, tenant_id, source_id, trigger, status, started_at, error_code) VALUES ('j-x', ?, ?, 'manual', 'failed', '2999-01-01T00:00:00Z', 'reconnect_required')", env.app.db.get('SELECT tenant_id FROM sources WHERE id = ?', id).tenant_id, id);
  const after = (await c.get('/api/sources')).data.data.find(x => x.id === id);
  assert.equal(after.lifecycle, 'reauthorization_required');
  assert.equal((await c.get('/api/connectors')).data.data.find(x => x.type === 'gmail').lifecycle, 'reauthorization_required');
});

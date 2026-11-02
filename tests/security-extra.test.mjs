import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeServer, startApp, waitForSync, searchReq } from './helpers.mjs';
import { hashPassword } from '../server/security.mjs';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const b64 = (s) => Buffer.from(s).toString('base64url');
const SECRETS = ['tok-access-SECRET', 'tok-refresh-SECRET', 'tok-access-r'];

/** Fake Google whose message listing can be slowed down or made to fail, to test sync controls and error paths. */
async function google() {
  const state = { slowMs: 0, failList: false, failRefresh: false, refreshed: 0 };
  const msg = { id: 'm1', threadId: 't1', internalDate: String(Date.parse('2026-09-01T10:00:00Z')), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Cedar Avenue closure memo' }], body: { data: b64('Cedar Avenue closes nightly for water main work.') } } };
  const server = await fakeServer(async (req, url, body) => {
    const form = new URLSearchParams(body);
    if (url.pathname === '/token') {
      if (form.get('grant_type') === 'refresh_token') {
        if (state.failRefresh) return { status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
        state.refreshed++; return { json: { access_token: `tok-access-r${state.refreshed}`, expires_in: 3600 } };
      }
      return { json: { access_token: 'tok-access-SECRET', refresh_token: 'tok-refresh-SECRET', expires_in: 3600, scope: SCOPE } };
    }
    if (url.pathname === '/revoke') return { json: {} };
    const p = url.pathname.replace('/gmail/v1/users/me', '');
    if (p === '/profile') return { json: { emailAddress: 'clerk@city.gov', historyId: '10' } };
    if (p === '/messages') {
      if (state.slowMs) await new Promise(r => setTimeout(r, state.slowMs));
      if (state.failList) return { status: 500, json: { error: { code: 500, message: 'Backend Error', errors: [{ reason: 'backendError' }] } } };
      return { json: { messages: [{ id: 'm1', threadId: 't1' }] } };
    }
    if (p === '/messages/m1') return { json: msg };
    return { status: 404, json: {} };
  });
  return { ...server, state };
}

async function connectGmail(c) {
  const auth = new URL((await c.post('/api/connectors/gmail/authorize', { query: '' })).data.data.url);
  const r = await c.get(`/oauth/google/callback?code=x&state=${auth.searchParams.get('state')}`);
  return new URL(r.headers.get('location'), 'http://x').searchParams.get('connected');
}

test('revocation, tokens and sync controls', { timeout: 60_000 }, async (t) => {
  const g = await google();
  const env = await startApp({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`,
    GMAIL_API_BASE: `${g.url}/gmail/v1`, GMAIL_RATE_LIMIT_RETRIES: '0', SYNC_RETRIES: '0' });
  t.after(async () => { await env.close(); await g.close(); });
  const db = env.app.db;
  const owner = env.client(); await owner.setup();
  await owner.post('/api/users', { email: 'b@x.org', name: 'Ben B', role: 'records_officer', password: 'password for ben 1' });
  const B = env.client(); await B.login('b@x.org', 'password for ben 1');

  const id = await connectGmail(owner);
  assert(id);
  await waitForSync(owner, id);

  // ---- Sync controls ----
  g.state.slowMs = 600;
  assert.equal((await owner.post(`/api/sources/${id}/sync`)).status, 202);
  assert.equal((await owner.post(`/api/sources/${id}/sync`)).status, 409, 'no second sync of the same source while one runs');
  assert.equal((await owner.del(`/api/sources/${id}`)).status, 409, 'no disconnect in the middle of a sync');
  await waitForSync(owner, id);
  g.state.slowMs = 0;
  assert.equal((await B.post(`/api/sources/${id}/sync`)).status, 403, 'a shared source can be searched by others, not synced by them');
  assert.equal((await B.patch(`/api/sources/${id}`, { visibility: 'owner' })).status, 403, 'nor can they change its sharing');
  db.run("INSERT INTO tenants (id, name) VALUES ('t2', 'Other City')");
  db.run("INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES ('u2', 't2', 'z@other.org', 'Zed', 'admin', ?)", hashPassword('other tenant password'));
  const Z = env.client(); await Z.login('z@other.org', 'other tenant password');
  assert.equal((await Z.post(`/api/sources/${id}/sync`)).status, 404, 'another organization cannot even see that it exists');
  assert.equal((await Z.get(`/api/sources/${id}/jobs`)).status, 404);

  // ---- Error paths never leak tokens ----
  g.state.failList = true;
  await owner.post(`/api/sources/${id}/sync`);
  await waitForSync(owner, id);
  g.state.failList = false;
  const v = env.app.services.vault;
  const creds = v.open(db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', id).ciphertext);
  db.run('UPDATE source_credentials SET ciphertext = ? WHERE source_id = ?', v.seal({ ...creds, expiresAt: 0 }), id);
  g.state.failRefresh = true;
  await owner.post(`/api/sources/${id}/sync`);
  let src = await waitForSync(owner, id);
  assert.equal(src.lifecycle, 'reauthorization_required');
  g.state.failRefresh = false;
  const responses = await Promise.all(['/api/sources', `/api/sources/${id}/jobs`, '/api/connectors', '/api/system/status', '/api/audit?pageSize=200', `/api/audit?targetId=${id}`].map(u => owner.get(u)));
  const everything = [
    ...responses.map(r => JSON.stringify(r.data)),
    env.logs.join('\n'),
    JSON.stringify(db.all('SELECT * FROM sync_jobs')), JSON.stringify(db.all('SELECT * FROM audit_events')), JSON.stringify(db.all('SELECT * FROM sources')),
    JSON.stringify(db.all('SELECT * FROM oauth_states')),
    fs.readFileSync(env.config.dbPath).toString('latin1')
  ].join('\n');
  for (const s of SECRETS) assert(!everything.includes(s), `token ${s} appears in an API response, log, table or the database file`);
  assert(!everything.includes('client_secret') && !everything.includes('"cs"'), 'the OAuth client secret never appears');

  // ---- Revocation ----
  db.run('UPDATE source_credentials SET ciphertext = ? WHERE source_id = ?', v.seal({ ...creds, expiresAt: Date.now() + 3600_000 }), id);
  await owner.post(`/api/sources/${id}/sync`);
  await waitForSync(owner, id);
  // Private by default: B cannot find the owner's mail until the owner explicitly shares it.
  const s0 = await searchReq(B, 'Cedar Avenue closure memo', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(!(s0.results || []).some(x => x.record.title === 'Cedar Avenue closure memo'), 'private by default');
  await owner.patch(`/api/sources/${id}`, { visibility: 'roles', allowedRoles: [] });
  const s1 = await searchReq(B, 'Cedar Avenue closure memo', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  const hit = s1.results.find(x => x.record.title === 'Cedar Avenue closure memo');
  assert(hit, 'after explicit sharing, B finds the owner’s mail');
  // The owner makes it private: B's existing result list and direct links stop working at once.
  await owner.patch(`/api/sources/${id}`, { visibility: 'owner' });
  assert(!(await B.get(`/api/requests/${s1.id}/results`)).data.data.some(x => x.record.id === hit.record.id));
  assert.equal((await B.get(`/api/records/${hit.record.id}`)).status, 404);
  // Shared again, then disconnected: credentials and every record are gone for everyone, and Google is asked to revoke.
  await owner.patch(`/api/sources/${id}`, { visibility: 'roles', allowedRoles: [] });
  const r = await owner.del(`/api/sources/${id}`);
  assert.equal(r.status, 200); assert.equal(r.data.data.revokedAtProvider, true);
  assert(g.calls.some(x => x.path === '/revoke'));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM records WHERE source_id = ?', id).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM source_credentials WHERE source_id = ?', id).n, 0);
  assert.equal((await B.get(`/api/records/${hit.record.id}`)).status, 404);
  assert(!(await B.get(`/api/requests/${s1.id}/results`)).data.data.some(x => x.record.id === hit.record.id));
  assert.equal((await owner.post(`/api/sources/${id}/sync`)).status, 404, 'a removed source cannot be synced');
  // A disabled user is signed out at once and can no longer read anything.
  const bId = db.get("SELECT id FROM users WHERE email = 'b@x.org'").id;
  await owner.patch(`/api/users/${bId}`, { disabled: true });
  assert.equal((await B.get('/api/sources')).status, 401);
});

test('real and synthetic records stay apart in search, listings and counts', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  await c.upload('real-memo.txt', Buffer.from('Real memo: Cedar Avenue lane closure and detour, right-of-way permit.'));
  const real = await searchReq(c, 'Cedar Avenue lane closure detour right-of-way', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(real.results.length > 0 && real.results.every(x => !x.record.isSynthetic && x.record.sourceType !== 'synthetic'), 'Real data mode: no synthetic record');
  const demo = await searchReq(c, 'Cedar Avenue lane closure detour right-of-way', { mode: 'demo', edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(demo.results.length > 0 && demo.results.every(x => x.record.isSynthetic), 'Demo mode: only synthetic records');
  assert(!demo.results.some(x => /Real memo/.test(x.record.title)));
  const db = env.app.db;
  assert.equal(db.get("SELECT COUNT(*) AS n FROM records r JOIN sources s ON s.id = r.source_id WHERE s.type = 'synthetic' AND r.is_synthetic = 0").n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM records r JOIN sources s ON s.id = r.source_id WHERE s.type != 'synthetic' AND COALESCE(json_extract(s.config, '$.publicDocs'), 0) = 0 AND r.is_synthetic = 1").n, 0);
});

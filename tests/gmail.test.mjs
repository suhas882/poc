import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fakeServer, startApp, waitForSync, searchReq } from './helpers.mjs';
import { parseGmailMessage } from '../server/connectors/gmail.mjs';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const b64 = (s) => Buffer.from(s).toString('base64url');
const errOf = (r) => new URL(r.headers.get('location'), 'http://x').searchParams.get('error') || '';

function mailbox() {
  const messages = new Map([
    ['m1', { id: 'm1', threadId: 't1', internalDate: String(Date.parse('2025-01-15T17:00:00Z')), labelIds: ['INBOX'], payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'Cedar Avenue lane closure schedule' }, { name: 'From', value: 'Pat Engineer <pat@city.gov>' }, { name: 'To', value: 'records@city.gov, "Lee, Sam" <sam@city.gov>' }], parts: [
      { mimeType: 'text/plain', body: { data: b64('Crews will close one lane on Cedar Avenue nightly for the water main work.') } },
      { partId: '2', filename: 'detour.txt', mimeType: 'text/plain', body: { attachmentId: 'a1', size: 60 } }
    ] } }],
    ['m2', { id: 'm2', threadId: 't1', internalDate: String(Date.parse('2025-01-16T09:00:00Z')), labelIds: ['INBOX'], payload: { mimeType: 'text/html', headers: [{ name: 'Subject', value: 'Re: Cedar Avenue lane closure schedule' }, { name: 'From', value: 'sam@city.gov' }], body: { data: b64('<p>Approved.<br>Detour signs go up <b>Monday</b>.</p><script>x()</script>') } } }],
    ['m3', { id: 'm3', threadId: 't3', internalDate: String(Date.parse('2025-02-01T09:00:00Z')), labelIds: ['SPAM'], payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'You won' }], body: { data: b64('Cedar Avenue prize') } } }]
  ]);
  return { messages, historyId: 100, history: [] };
}

async function googleFake() {
  const box = mailbox();
  const state = { challenge: null, revoked: new Set(), refreshCount: 0, failRefresh: false, accessExpires: 3600 };
  const server = await fakeServer((req, url, body) => {
    const form = new URLSearchParams(body);
    if (url.pathname === '/token') {
      if (form.get('grant_type') === 'authorization_code') {
        const verifier = form.get('code_verifier');
        if (crypto.createHash('sha256').update(verifier).digest('base64url') !== state.challenge) return { status: 400, json: { error: 'invalid_grant' } };
        if (form.get('code') !== 'good-code') return { status: 400, json: { error: 'invalid_grant' } };
        return { json: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: state.accessExpires, scope: form.get('code') === 'good-code' ? SCOPE : '', token_type: 'Bearer' } };
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (state.failRefresh || state.revoked.has(form.get('refresh_token'))) return { status: 400, json: { error: 'invalid_grant' } };
        state.refreshCount++;
        return { json: { access_token: `access-r${state.refreshCount}`, expires_in: 3600 } };
      }
    }
    if (url.pathname === '/revoke') { state.revoked.add(form.get('token')); return { json: {} }; }
    const auth = req.headers.authorization || '';
    if (url.pathname.startsWith('/gmail/v1/') && !/^Bearer access-/.test(auth)) return { status: 401, json: {} };
    const p = url.pathname.replace('/gmail/v1/users/me', '');
    if (p === '/profile') return { json: { emailAddress: 'Clerk@City.gov', historyId: String(box.historyId) } };
    if (p === '/messages') return { json: { messages: [...box.messages.values()].map(m => ({ id: m.id, threadId: m.threadId })) } };
    let m = /^\/messages\/([^/]+)$/.exec(p);
    if (m) return box.messages.has(m[1]) ? { json: box.messages.get(m[1]) } : { status: 404, json: {} };
    m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(p);
    if (m) return { json: { data: b64('Detour route: use Birch Street while Cedar Avenue is closed.') } };
    if (p === '/history') {
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start < 50) return { status: 404, json: {} };
      return { json: { history: box.history.filter(h => h.id > start), historyId: String(box.historyId) } };
    }
    return { status: 404, json: {} };
  });
  return { ...server, box, state };
}

test('Gmail: OAuth with PKCE, encrypted tokens, sync, attachments, incremental history, refresh, disconnect', async (t) => {
  const g = await googleFake();
  const env = await startApp({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`, GMAIL_API_BASE: `${g.url}/gmail/v1`, PUBLIC_URL: 'http://localhost:9999' });
  t.after(async () => { await env.close(); await g.close(); });
  const c = env.client();
  await c.setup();
  assert.equal((await c.get('/api/connectors')).data.data.find(x => x.type === 'gmail').status, 'available');

  // 1. Authorize URL: least-privilege scope, offline access, PKCE S256, one-time state.
  let r = await c.post('/api/connectors/gmail/authorize', { query: '' });
  assert.equal(r.status, 200);
  const auth = new URL(r.data.data.url);
  assert.equal(auth.searchParams.get('scope'), SCOPE);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:9999/oauth/google/callback');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  g.state.challenge = auth.searchParams.get('code_challenge');
  const st = auth.searchParams.get('state');

  // Another user can't complete someone else's flow.
  await c.post('/api/users', { email: 'o@x.org', name: 'Other Officer', role: 'records_officer', password: 'officer password 1' });
  const other = env.client(); await other.login('o@x.org', 'officer password 1');
  r = await other.get(`/oauth/google/callback?code=good-code&state=${st}`);
  assert.equal(r.status, 302);
  assert.match(errOf(r), /different user/);

  // That attempt consumed the state, so start again.
  r = await c.post('/api/connectors/gmail/authorize', { query: '' });
  const auth2 = new URL(r.data.data.url);
  g.state.challenge = auth2.searchParams.get('code_challenge');
  r = await c.get(`/oauth/google/callback?error=access_denied&state=${auth2.searchParams.get('state')}`);
  assert.match(errOf(r), /not granted/);

  r = await c.post('/api/connectors/gmail/authorize', { query: '' });
  const auth3 = new URL(r.data.data.url);
  g.state.challenge = auth3.searchParams.get('code_challenge');
  r = await c.get(`/oauth/google/callback?code=good-code&state=${auth3.searchParams.get('state')}`);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'), 'http://x');
  const sourceId = loc.searchParams.get('connected');
  assert(sourceId, r.headers.get('location'));
  // Replay of the same state fails.
  r = await c.get(`/oauth/google/callback?code=good-code&state=${auth3.searchParams.get('state')}`);
  assert.match(errOf(r), /expired or was already used/);

  // 2. Tokens are encrypted at rest.
  const cred = env.app.db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', sourceId);
  assert(cred && !cred.ciphertext.includes('refresh-1') && !cred.ciphertext.includes('access-1'));
  assert(!fs.readFileSync(env.config.dbPath).includes(Buffer.from('refresh-1')), 'no plaintext token in the database file');

  // 3. Initial sync: two messages + one attachment; spam skipped.
  let src = await waitForSync(c, sourceId);
  assert.equal(src.status, 'connected', src.lastError);
  assert.equal(src.accountLabel, 'clerk@city.gov');
  assert.equal(src.visibility, 'owner');
  assert.deepEqual(src.scopes, [SCOPE]);
  assert.equal(src.recordCount, 3);
  let jobs = (await c.get(`/api/sources/${sourceId}/jobs`)).data.data;
  assert.equal(jobs[0].status, 'succeeded');

  const sr = await searchReq(c, 'emails about the Cedar Avenue lane closure', { edits: { recordTypes: [] } });
  const sid = sr.id;
  let res = { data: sr.results, meta: sr.meta };
  const email = res.data.find(x => x.record.title === 'Cedar Avenue lane closure schedule');
  assert(email, JSON.stringify(res.data.map(x => x.record.title)));
  assert.equal(email.record.sourceType, 'gmail');
  assert.equal(email.record.sender, 'Pat Engineer <pat@city.gov>');
  assert.deepEqual(email.record.recipients, ['records@city.gov', '"Lee, Sam" <sam@city.gov>']);
  assert.match(email.record.sourceUrl, /mail\.google\.com\/mail\/u\/\?authuser=clerk%40city\.gov#all\/m1/);
  assert.equal(email.record.createdAt, '2025-01-15T17:00:00.000Z');
  assert(res.data.some(x => /detour\.txt \(attachment/.test(x.record.title)));
  assert(!res.data.some(x => x.record.title === 'You won'), 'spam is not indexed');
  const keys = res.data.map(x => x.groupKey).filter(Boolean);
  assert(keys.length > new Set(keys).size, 'messages in one thread are grouped');
  const full = (await c.get(`/api/records/${email.record.id}`)).data.data;
  assert.match(full.content, /water main/);
  assert(full.related.length >= 1, 'thread members are linked');
  const html = (await c.get(`/api/records/${res.data.find(x => x.record.title.startsWith('Re:')).record.id}`)).data.data;
  assert.equal(html.content.includes('<p>'), false); assert.equal(html.content.includes('x()'), false);

  // 4. Incremental sync via history: one new message, one deletion.
  g.box.messages.set('m4', { id: 'm4', threadId: 't4', internalDate: String(Date.parse('2025-03-02T10:00:00Z')), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Cedar Avenue reopened' }], body: { data: b64('All lanes on Cedar Avenue reopened.') } } });
  g.box.messages.delete('m2');
  g.box.history.push({ id: 101, messagesAdded: [{ message: { id: 'm4' } }] }, { id: 102, messagesDeleted: [{ message: { id: 'm2' } }] });
  g.box.historyId = 102;
  r = await c.post(`/api/sources/${sourceId}/sync`);
  assert.equal(r.status, 202);
  src = await waitForSync(c, sourceId);
  jobs = (await c.get(`/api/sources/${sourceId}/jobs`)).data.data;
  assert.equal(jobs[0].added, 1); assert.equal(jobs[0].deleted, 1);
  assert.equal(src.recordCount, 3);
  const listCall = g.calls.filter(x => x.path.endsWith('/history')).at(-1);
  assert.equal(listCall.url.searchParams.get('startHistoryId'), '100');

  // 5. Expired access token is refreshed with the refresh token.
  const v = env.app.services.vault;
  const creds = v.open(env.app.db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', sourceId).ciphertext);
  env.app.db.run('UPDATE source_credentials SET ciphertext = ? WHERE source_id = ?', v.seal({ ...creds, expiresAt: 0 }), sourceId);
  await c.post(`/api/sources/${sourceId}/sync`);
  await waitForSync(c, sourceId);
  assert.equal(g.state.refreshCount, 1);

  // 6. Revoked at Google: the source is flagged, not silently broken.
  env.app.db.run('UPDATE source_credentials SET ciphertext = ? WHERE source_id = ?', v.seal({ ...creds, expiresAt: 0 }), sourceId);
  g.state.failRefresh = true;
  await c.post(`/api/sources/${sourceId}/sync`);
  src = await waitForSync(c, sourceId);
  assert.equal(src.status, 'needs_attention');
  assert.match(src.lastError, /Reconnect Gmail/);
  g.state.failRefresh = false;

  // 7. Other users can't see the mailbox; the owner can share it with roles.
  assert(!(await other.get('/api/sources')).data.data.some(x => x.id === sourceId));
  assert.equal((await other.del(`/api/sources/${sourceId}`)).status, 403);

  // 8. Disconnect: revoke at Google, delete credentials and every indexed record.
  r = await c.del(`/api/sources/${sourceId}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.data.revokedAtProvider, true);
  assert(g.state.revoked.has('refresh-1'));
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM records WHERE source_id = ?', sourceId).n, 0);
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM source_credentials').n, 0);
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM chunk_fts WHERE rowid NOT IN (SELECT id FROM chunks)').n, 0, 'no orphaned index rows');
  res = (await c.get(`/api/requests/${sid}/results`)).data;
  assert.equal(res.meta.total, 0, 'past result lists no longer expose deleted records');
  const actions = (await c.get('/api/audit?pageSize=200')).data.data.map(a => a.action);
  for (const a of ['source.oauth_started', 'source.connected', 'source.synced', 'source.disconnected']) assert(actions.includes(a), a);
  assert(!JSON.stringify((await c.get('/api/audit?pageSize=200')).data).includes('access-1'), 'no tokens in audit');
});

test('Gmail not configured: the connector says what is missing', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  const gmail = (await c.get('/api/connectors')).data.data.find(x => x.type === 'gmail');
  assert.equal(gmail.status, 'needs_configuration');
  const r = await c.post('/api/connectors/gmail/authorize', {});
  assert.equal(r.status, 503); assert.match(r.data.error.message, /GOOGLE_CLIENT_ID/);
});

test('parseGmailMessage handles nested multipart and missing parts', () => {
  const p = parseGmailMessage({ id: 'x', snippet: 'snip', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Date', value: 'Tue, 14 Jan 2025 10:00:00 +0000' }], parts: [{ mimeType: 'multipart/related', parts: [{ mimeType: 'text/html', body: { data: b64('<div>Hello&nbsp;there</div>') } }] }] } });
  assert.equal(p.body, 'Hello there');
  assert.equal(p.date, '2025-01-14T10:00:00.000Z');
  assert.equal(parseGmailMessage({ id: 'y', snippet: 'only snippet', payload: {} }).body, 'only snippet');
});

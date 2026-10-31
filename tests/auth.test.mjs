import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

test('first administrator, sign-in, CSRF, roles and lockout', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const anon = env.client();

  let r = await anon.get('/api/auth/status');
  assert.equal(r.data.data.setupRequired, true);

  r = await anon.post('/api/auth/setup', { orgName: 'X', name: 'A', email: 'a@x.org', password: 'short' });
  assert.equal(r.status, 400, 'weak passwords are rejected');

  const admin = env.client();
  r = await admin.setup();
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);

  r = await env.client().setup('second@x.org');
  assert.equal(r.status, 409, 'setup works only once');

  // CSRF: a signed-in state-changing request without the token is refused.
  const token = admin.csrf; admin.csrf = '';
  r = await admin.post('/api/users', { email: 'r@x.org', name: 'R', role: 'reviewer', password: 'reviewer password 1' });
  assert.equal(r.status, 403); assert.equal(r.data.error.code, 'csrf_failed');
  admin.csrf = token;
  r = await admin.post('/api/users', { email: 'r@x.org', name: 'Rae Reviewer', role: 'reviewer', password: 'reviewer password 1' });
  assert.equal(r.status, 201);
  r = await admin.post('/api/users', { email: 'aud@x.org', name: 'Aud Itor', role: 'auditor', password: 'auditor password 1' });
  assert.equal(r.status, 201);

  // Cross-site origin is refused even with a token.
  r = await admin.req('POST', '/api/settings/retention/apply', undefined, { origin: 'https://evil.example' });
  assert.equal(r.status, 403); assert.equal(r.data.error.code, 'bad_origin');

  const reviewer = env.client();
  r = await reviewer.login('r@x.org', 'wrong password!!');
  assert.equal(r.status, 401);
  r = await reviewer.login('R@X.org', 'reviewer password 1');
  assert.equal(r.status, 200, 'email is case-insensitive');
  assert.equal((await reviewer.post('/api/connectors/gmail/authorize', {})).status, 403, 'reviewers cannot connect sources');
  assert.equal((await reviewer.get('/api/audit')).status, 403, 'reviewers cannot read the audit log');
  assert.equal((await reviewer.get('/api/users')).status, 403);

  const auditor = env.client();
  await auditor.login('aud@x.org', 'auditor password 1');
  assert.equal((await auditor.get('/api/audit')).status, 200);
  assert.equal((await auditor.post('/api/requests', { text: 'road closure records', receivedAt: '2026-10-30', mode: 'demo' })).status, 403, 'auditors cannot search');

  // Disabling a user ends their sessions immediately.
  const users = (await admin.get('/api/users')).data.data;
  const rid = users.find(u => u.email === 'r@x.org').id;
  assert.equal((await admin.patch(`/api/users/${rid}`, { disabled: true })).status, 200);
  assert.equal((await reviewer.get('/api/sources')).status, 401);
  assert.equal((await admin.patch(`/api/users/${users.find(u => u.role === 'admin').id}`, { role: 'reviewer' })).status, 400, 'admins cannot demote themselves');

  // Lockout after repeated failures.
  const brute = env.client();
  for (let i = 0; i < 8; i++) await brute.login('aud@x.org', `nope nope nope ${i}`);
  r = await brute.login('aud@x.org', 'auditor password 1');
  assert.equal(r.status, 401); assert.match(r.data.error.message, /locked/);

  // Audit trail recorded the above without secrets.
  const log = (await admin.get('/api/audit?pageSize=200')).data;
  const actions = log.data.map(e => e.action);
  for (const a of ['auth.setup', 'user.created', 'auth.login_failed', 'user.updated', 'access.denied']) assert(actions.includes(a), `audit has ${a}`);
  assert(!JSON.stringify(log).includes('auditor password 1'), 'passwords never reach the audit log');

  // Logout.
  assert.equal((await admin.post('/api/auth/logout')).status, 200);
  assert.equal((await admin.get('/api/sources')).status, 401);
});

test('setup is refused from a non-local address without the setup token', async (t) => {
  const env = await startApp({ TRUST_PROXY: 'true', SETUP_TOKEN: 's3cret-token' });
  t.after(() => env.close());
  const c = env.client();
  let r = await c.req('POST', '/api/auth/setup', { orgName: 'X', name: 'A', email: 'a@x.org', password: 'a long enough password' }, { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(r.status, 403);
  r = await c.req('POST', '/api/auth/setup', { orgName: 'X', name: 'A', email: 'a@x.org', password: 'a long enough password', setupToken: 's3cret-token' }, { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(r.status, 201);
});

test('static files: only allowlisted files are served, with security headers', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  let r = await c.get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  for (const p of ['/server/app.mjs', '/package.json', '/data/records.db', '/.env', '/client/../server/app.mjs']) assert.equal((await c.get(p)).status, 404, p);
});

test('A1: with real sources off (the hosted demo), nothing real can be connected and the UI cannot turn it on', async (t) => {
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const c = env.client();
  const st = (await c.get('/api/auth/status')).data.data;
  assert.equal(st.realSources, false); assert.equal(st.demoAccounts, true); assert.equal(st.setupRequired, false);
  assert.equal((await c.post('/api/auth/setup', { orgName: 'X', name: 'A', email: 'a@x.org', password: 'correct horse battery' })).status, 403, 'no real accounts on the demo server');
  const d = await c.post('/api/auth/demo', { role: 'admin' });
  assert.equal(d.status, 200); c.csrf = d.data.data.csrfToken;
  const me = (await c.get('/api/auth/status')).data.data.user;
  assert.equal(me.isDemo, true); assert.equal(me.name, 'Supervisor A');
  // Real connectors are refused, real mode is never used, and the switch cannot be flipped from the UI.
  assert.equal((await c.post('/api/connectors/gmail/authorize', { query: '' })).status, 403);
  assert.equal((await c.post('/api/connectors/database/inspect', { driver: 'sqlite', file: 'x.db' })).status, 403);
  assert.equal((await c.upload('staff-file.txt', Buffer.from('real staff file'))).status, 403);
  assert.equal((await c.upload('chat.txt', Buffer.from('x'), '?kind=messages')).status, 403);
  assert.equal((await c.post('/api/agent-tokens', { name: 'PC', acknowledged: true })).status, 403);
  assert.equal((await c.put('/api/settings/switches', { realSources: true })).status, 403);
  assert.equal((await c.put('/api/settings/switches', { phoneLink: true })).status, 403);
  const req = await c.post('/api/requests', { text: 'road closure records', receivedAt: '2026-10-30', mode: 'real' });
  assert.equal(req.data.data.mode, 'demo', 'requests on the demo server are always Tier 0');
  const cat = (await c.get('/api/connectors')).data.data;
  assert.deepEqual(cat.map(x => x.type).sort(), ['public', 'stub', 'stub', 'stub', 'stub']);
  // Public documents need provenance.
  assert.equal((await c.upload('notice.txt', Buffer.from('Public notice about a lane closure.'), '?kind=public')).status, 400);
  const ok = await c.req('POST', '/api/uploads?kind=public', Buffer.from('Public notice about a lane closure on Main Street.'), { 'x-file-name': 'notice.txt', 'content-type': 'text/plain', 'x-source-url': 'https://example.org/notice', 'x-retrieved-at': '2026-10-29', 'x-terms-checked': 'yes' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const rec = (await c.get(`/api/records/${ok.data.data.recordId}`)).data.data;
  assert.equal(rec.entities.provenance.url, 'https://example.org/notice');
  assert.equal(rec.entities.provenance.retrievedAt, '2026-10-29');
  // Two visitors get separate demo workspaces.
  const other = env.client();
  const d2 = await other.post('/api/auth/demo', { role: 'records_officer' });
  assert.equal(d2.status, 200);
  assert.equal((await other.get(`/api/requests/${req.data.data.id}`)).status, 404);
});

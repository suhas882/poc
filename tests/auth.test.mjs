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
  assert.equal((await auditor.post('/api/searches/plan', { requestText: 'road closure records', mode: 'demo' })).status, 403, 'auditors cannot search');

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

test('DEMO_ONLY switches off every real-data endpoint', async (t) => {
  const env = await startApp({ DEMO_ONLY: 'true' });
  t.after(() => env.close());
  const c = env.client();
  assert.equal((await c.get('/api/auth/status')).data.data.demoOnly, true);
  assert.equal((await c.post('/api/auth/login', { email: 'a@b.c', password: 'x' })).status, 404);
});

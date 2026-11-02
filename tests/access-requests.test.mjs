// MOCKED: a local stand-in for Google's sign-in server. These tests prove the onboarding rules; they are not a real
// Google sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeServer, startApp, searchReq } from './helpers.mjs';
import { hashPassword } from '../server/security.mjs';

const jwt = (claims) => ['{"alg":"none"}', JSON.stringify(claims), 'sig'].map(x => Buffer.from(x).toString('base64url')).join('.');

async function google() {
  const state = { claims: {}, challenge: null, nonce: null };
  const server = await fakeServer((req, url, body) => {
    const form = new URLSearchParams(body);
    if (url.pathname !== '/token') return { status: 404, json: {} };
    if (crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== state.challenge) return { status: 400, json: { error: 'invalid_grant' } };
    return { json: { access_token: 'x', id_token: jwt({ iss: 'https://accounts.google.com', aud: 'gcid', nonce: state.nonce, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...state.claims }) } };
  });
  return { ...server, state };
}

/** Sign in with the fake Google as {sub, email, name}; returns where the app sent the browser. */
async function googleSignIn(c, g, claims) {
  const r = await c.get('/oauth/signin/google');
  const to = new URL(r.headers.get('location'));
  g.state.challenge = to.searchParams.get('code_challenge'); g.state.nonce = to.searchParams.get('nonce'); g.state.claims = claims;
  const back = await c.get(`/oauth/google/callback?code=c&state=${to.searchParams.get('state')}`);
  return new URL(back.headers.get('location'), 'http://x');
}

test('onboarding: request, duplicates, approval, rejection, approved sign-in, and isolation', async (t) => {
  const g = await google();
  const env = await startApp({ GOOGLE_CLIENT_ID: 'gcid', GOOGLE_CLIENT_SECRET: 'gs', GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, PUBLIC_URL: 'http://localhost:9999' });
  t.after(async () => { await env.close(); await g.close(); });
  const db = env.app.db;
  const admin = env.client(); await admin.setup();
  db.run("UPDATE tenants SET name = 'Example City'");
  await admin.post('/api/users', { email: 'clerk@city.gov', name: 'Casey Clerk', role: 'records_officer', password: 'clerk password 12' });
  const users = () => db.get('SELECT COUNT(*) AS n FROM users').n;

  // 1. Existing user: Google sign-in works as before.
  const casey = env.client();
  let at = await googleSignIn(casey, g, { sub: 'g-casey', email: 'clerk@city.gov', name: 'Casey' });
  assert.equal(at.pathname, '/sources.html');
  assert.equal((await casey.get('/api/auth/status')).data.data.user.email, 'clerk@city.gov');

  // 2. First-time user: the Access Request page, with the verified identity; nothing is created.
  const before = users();
  const newbie = env.client();
  at = await googleSignIn(newbie, g, { sub: 'g-nora', email: 'nora@gmail.com', name: 'Nora New' });
  assert.equal(at.pathname, '/request-access.html');
  assert.equal(users(), before, 'no account is created by signing in');
  assert.equal((await newbie.get('/api/auth/status')).data.data.user, null, 'and nobody is signed in');
  assert.equal((await newbie.get('/api/sources')).status, 401, 'an applicant reaches no data');
  let me = (await newbie.get('/api/access-requests/me')).data.data;
  assert.deepEqual(me.identity, { name: 'Nora New', email: 'nora@gmail.com', provider: 'google' });
  assert.equal(me.request, null);
  let r = await newbie.post('/api/access-requests/me', { organization: 'Example City', reason: 'Clerk team, need to search permits.' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.data.request.status, 'pending');
  assert.equal(db.get("SELECT target_tenant_id AS t FROM access_requests WHERE email = 'nora@gmail.com'").t, db.get('SELECT id FROM tenants').id, 'addressed to the named organization');

  // 3. Duplicates: the same account, the same email from another account, and signing in again all find the open request.
  r = await newbie.post('/api/access-requests/me', { organization: 'Example City', reason: 'Asking a second time, please.' });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'request_pending');
  const twin = env.client();
  at = await googleSignIn(twin, g, { sub: 'g-nora-2', email: 'nora@gmail.com', name: 'Nora Again' });
  assert.equal(at.pathname, '/request-access.html');
  r = await twin.post('/api/access-requests/me', { organization: 'Example City', reason: 'Another account, same email.' });
  assert.equal(r.status, 409, 'one open request per email');
  at = await googleSignIn(newbie, g, { sub: 'g-nora', email: 'nora@gmail.com', name: 'Nora New' });
  assert.equal((await newbie.get('/api/access-requests/me')).data.data.request.status, 'pending');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'").n, 1);
  // An existing user's email cannot be requested again.
  const dup = env.client();
  // Without a verified sign-in there is nothing to submit; the identity cannot be typed in.
  assert.equal((await dup.post('/api/access-requests/me', { organization: 'X', reason: 'I am totally Casey, trust me.' })).status, 403);

  // 4. Only Supervisors review; Clerks cannot.
  assert.equal((await casey.get('/api/access-requests')).status, 403);
  let list = (await admin.get('/api/access-requests')).data.data;
  assert.equal(list.length, 1);
  const noraReq = list[0];
  assert.equal(noraReq.name, 'Nora New'); assert.equal(noraReq.reason, 'Clerk team, need to search permits.');
  assert.equal((await casey.post(`/api/access-requests/${noraReq.id}/approve`, { role: 'admin' })).status, 403, 'a Clerk cannot approve, least of all themselves into admin');

  // Another organization's Supervisor neither sees nor decides it.
  db.run("INSERT INTO tenants (id, name) VALUES ('t2', 'Other City')");
  db.run("INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES ('u2', 't2', 'boss@other.gov', 'Other Boss', 'admin', ?)", hashPassword('other boss password'));
  const other = env.client(); await other.login('boss@other.gov', 'other boss password');
  assert.equal((await other.get('/api/access-requests')).data.data.length, 0);
  assert.equal((await other.post(`/api/access-requests/${noraReq.id}/approve`, { role: 'admin' })).status, 404);

  // 5. Approval: the account is created in this organization with the chosen role and linked to the exact Google account.
  r = await admin.post(`/api/access-requests/${noraReq.id}/approve`, { role: 'reviewer' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const nora = db.get("SELECT * FROM users WHERE email = 'nora@gmail.com'");
  assert.equal(nora.role, 'reviewer'); assert.equal(nora.tenant_id, db.get("SELECT id FROM tenants WHERE name = 'Example City'").id);
  assert.deepEqual(db.all("SELECT provider, subject FROM user_identities WHERE user_id = ?", nora.id).map(x => ({ ...x })), [{ provider: 'google', subject: 'g-nora' }]);
  assert.equal((await admin.post(`/api/access-requests/${noraReq.id}/approve`, { role: 'reviewer' })).status, 404, 'decided once');
  // No usable password was set: password sign-in does not work for an approved applicant.
  assert.equal((await env.client().login('nora@gmail.com', 'anything at all 1')).status, 401);

  // 6. Approved user signs in with the same Google account and lands on Connected Sources.
  const noraC = env.client();
  at = await googleSignIn(noraC, g, { sub: 'g-nora', email: 'nora@gmail.com', name: 'Nora New' });
  assert.equal(at.pathname, '/sources.html'); assert.equal(at.searchParams.get('welcome'), 'google');
  assert.equal((await noraC.get('/api/auth/status')).data.data.user.role, 'reviewer');
  // The other Google account that showed the same email is not let in: Nora's Google link is to g-nora only.
  const impostor = env.client();
  at = await googleSignIn(impostor, g, { sub: 'g-nora-2', email: 'nora@gmail.com', name: 'Nora Again' });
  assert.match(at.searchParams.get('error') || '', /not the one linked/);
  assert.equal((await impostor.get('/api/auth/status')).data.data.user, null);

  // 7. Rejection: no account, the decision is recorded, and the person may ask again later.
  const rex = env.client();
  await googleSignIn(rex, g, { sub: 'g-rex', email: 'rex@gmail.com', name: 'Rex' });
  await rex.post('/api/access-requests/me', { organization: 'Somewhere Else', reason: 'I would like to look around.' });
  const rexReq = (await admin.get('/api/access-requests')).data.data.find(x => x.email === 'rex@gmail.com');
  assert(rexReq, 'a request naming no known organization is shown to Supervisors');
  assert.equal((await other.get('/api/access-requests')).data.data.length, 1, 'unaddressed requests are visible to every Supervisor on this server');
  assert.equal((await admin.post(`/api/access-requests/${rexReq.id}/reject`, { note: 'Not staff.' })).status, 200);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM users WHERE email = 'rex@gmail.com'").n, 0);
  assert.equal((await other.get('/api/access-requests')).data.data.length, 0, 'once decided by Example City it is no longer shown to Other City');
  at = await googleSignIn(rex, g, { sub: 'g-rex', email: 'rex@gmail.com', name: 'Rex' });
  assert.equal(at.pathname, '/request-access.html');
  me = (await rex.get('/api/access-requests/me')).data.data;
  assert.equal(me.request.status, 'rejected'); assert.equal(me.request.note, 'Not staff.');
  assert.equal((await rex.get('/api/sources')).status, 401);

  // 8. Isolation: the new reviewer sees only what is shared with them; another organization sees nothing.
  // Clients signed in through Google pick up their CSRF token and give search permission like any user.
  for (const c of [casey, noraC]) { c.csrf = (await c.get('/api/auth/status')).data.data.csrfToken; await c.put('/api/consent', { scope: 'all', sourceIds: [], acknowledged: true }); }
  const up = await casey.upload('private-notes.txt', Buffer.from('Private Cedar Avenue settlement notes.'));
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const secret = up.data.data.recordId;
  const s = await searchReq(noraC, 'Cedar Avenue settlement', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(!(s.results || []).some(x => x.record.id === secret), 'a new user does not see another user’s private upload');
  assert.equal((await noraC.get(`/api/records/${secret}`)).status, 404);
  assert.equal((await other.get(`/api/records/${secret}`)).status, 404);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM source_credentials sc JOIN sources so ON so.id = sc.source_id WHERE so.owner_user_id = ?", nora.id).n, 0, 'no credentials were created for the new user');

  // Audit trail of the whole flow.
  const acts = db.all("SELECT action FROM audit_events WHERE action LIKE 'access.%'").map(x => x.action);
  for (const a of ['access.requested', 'access.approved', 'access.rejected']) assert(acts.includes(a), a);
});

test('approving cannot create a duplicate account', async (t) => {
  const g = await google();
  const env = await startApp({ GOOGLE_CLIENT_ID: 'gcid', GOOGLE_CLIENT_SECRET: 'gs', GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token` });
  t.after(async () => { await env.close(); await g.close(); });
  const admin = env.client(); await admin.setup();
  const p = env.client();
  await googleSignIn(p, g, { sub: 'g-p', email: 'pat@gmail.com', name: 'Pat' });
  await p.post('/api/access-requests/me', { organization: 'Example City', reason: 'Need access for permits.' });
  // Meanwhile a Supervisor adds pat@gmail.com by hand.
  await admin.post('/api/users', { email: 'pat@gmail.com', name: 'Pat', role: 'reviewer', password: 'pat password 1234' });
  const req = (await admin.get('/api/access-requests')).data.data[0];
  const r = await admin.post(`/api/access-requests/${req.id}/approve`, { role: 'admin' });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'email_taken');
  assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM users WHERE email = 'pat@gmail.com'").n, 1);
});

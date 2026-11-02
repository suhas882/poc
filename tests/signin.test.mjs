// MOCKED: these tests use local stand-ins for Google's and Microsoft's sign-in servers. They prove the app follows
// the OpenID Connect flow and refuses bad answers; they are not proof that real Google or Microsoft sign-in works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fakeServer, startApp } from './helpers.mjs';

const jwt = (claims) => ['{"alg":"none"}', JSON.stringify(claims), 'sig'].map(x => Buffer.from(x).toString('base64url')).join('.');
const MSA = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** Fake identity providers. `next` decides the claims of the next id_token; PKCE is really checked. */
async function idp() {
  const state = { google: {}, microsoft: {}, challenge: null, nonce: null, upn: 'pat@city.gov', tokens: 0 };
  const server = await fakeServer((req, url, body) => {
    const form = new URLSearchParams(body);
    const pkceOk = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') === state.challenge;
    if (url.pathname === '/google/token') {
      if (!pkceOk) return { status: 400, json: { error: 'invalid_grant', error_description: 'Bad code verifier.' } };
      state.tokens++;
      return { json: { access_token: 'signin-access-SECRET', id_token: jwt({ iss: 'https://accounts.google.com', aud: 'gcid', nonce: state.nonce, exp: Math.floor(Date.now() / 1000) + 600, sub: 'g-123', email_verified: true, ...state.google }) } };
    }
    if (url.pathname === '/common/oauth2/v2.0/token') {
      if (!pkceOk) return { status: 400, json: { error: 'invalid_grant' } };
      const tid = state.microsoft.tid ?? MSA;
      return { json: { access_token: 'signin-ms-access-SECRET', id_token: jwt({ iss: `${server.url}/${tid}/v2.0`, aud: 'mcid', nonce: state.nonce, exp: Math.floor(Date.now() / 1000) + 600, oid: 'o-1', tid, ...state.microsoft }) } };
    }
    if (url.pathname === '/v1.0/me') return { json: { userPrincipalName: state.upn } };
    return { status: 404, json: {} };
  });
  return { ...server, state };
}

async function begin(c, g, provider, next = '') {
  const r = await c.get(`/oauth/signin/${provider}${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  assert.equal(r.status, 302, JSON.stringify(r.data));
  const to = new URL(r.headers.get('location'));
  g.state.challenge = to.searchParams.get('code_challenge');
  g.state.nonce = to.searchParams.get('nonce');
  return to;
}
const finish = (c, provider, st, extra = '') => c.get(`/oauth/${provider}/callback?code=c1&state=${st}${extra}`);
const where = (r) => new URL(r.headers.get('location'), 'http://x');

test('Continue with Google: only existing users, verified email, nonce, audience and PKCE checked; identity linked; no tokens kept', async (t) => {
  const g = await idp();
  const env = await startApp({ GOOGLE_CLIENT_ID: 'gcid', GOOGLE_CLIENT_SECRET: 'gsecret', GOOGLE_AUTH_URL: `${g.url}/google/auth`, GOOGLE_TOKEN_URL: `${g.url}/google/token`, PUBLIC_URL: 'http://localhost:9999' });
  t.after(async () => { await env.close(); await g.close(); });
  const admin = env.client(); await admin.setup();
  await admin.post('/api/users', { email: 'pat@city.gov', name: 'Pat Clerk', role: 'records_officer', password: 'pat password 123' });
  const users = () => env.app.db.get('SELECT COUNT(*) AS n FROM users').n;
  const before = users();
  const anon = env.client();
  assert.deepEqual((await anon.get('/api/auth/status')).data.data.signIn, { google: true, microsoft: false });

  // The authorization request: identity scopes only, PKCE S256, a nonce, the registered redirect URI.
  let to = await begin(anon, g, 'google');
  assert.equal(to.searchParams.get('scope'), 'openid email profile', 'sign-in asks for identity only, never mail or files');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('redirect_uri'), 'http://localhost:9999/oauth/google/callback');
  assert(to.searchParams.get('nonce'));

  // Unknown person: refused, nothing created.
  g.state.google = { email: 'stranger@gmail.com', sub: 'g-stranger' };
  let r = await finish(anon, 'google', to.searchParams.get('state'));
  assert.equal(where(r).pathname, '/request-access.html', 'a stranger may ask for access, nothing more');
  assert.equal((await anon.get('/api/access-requests/me')).data.data.identity.email, 'stranger@gmail.com');
  assert.equal(users(), before, 'no account is created by signing in');
  assert.equal((await anon.get('/api/auth/status')).data.data.user, null);

  // Unverified email, wrong nonce, wrong audience: refused.
  for (const [claims, why] of [[{ email: 'pat@city.gov', email_verified: false }, /no verified email/], [{ email: 'pat@city.gov', nonce: 'other' }, /could not be verified/], [{ email: 'pat@city.gov', aud: 'someone-else' }, /could not be verified/]]) {
    to = await begin(anon, g, 'google');
    g.state.google = claims;
    r = await finish(anon, 'google', to.searchParams.get('state'));
    assert.match(where(r).searchParams.get('error') || '', why, JSON.stringify(claims));
  }
  // PKCE: a code exchanged with the wrong verifier is refused by the provider, so no session.
  to = await begin(anon, g, 'google');
  g.state.google = { email: 'pat@city.gov' };
  g.state.challenge = 'tampered';
  r = await finish(anon, 'google', to.searchParams.get('state'));
  assert.match(where(r).searchParams.get('error') || '', /did not accept/);
  // A state that does not match the sign-in cookie is not a sign-in: no session.
  to = await begin(anon, g, 'google');
  r = await finish(anon, 'google', 'forged-state');
  assert.equal((await anon.get('/api/auth/status')).data.data.user, null);

  // The real thing: an existing user signs in and lands on the provider's sources.
  to = await begin(anon, g, 'google');
  g.state.google = { email: 'Pat@City.gov', sub: 'g-123' };
  r = await finish(anon, 'google', to.searchParams.get('state'));
  assert.equal(where(r).pathname, '/sources.html'); assert.equal(where(r).searchParams.get('welcome'), 'google');
  const me = (await anon.get('/api/auth/status')).data.data.user;
  assert.equal(me.email, 'pat@city.gov'); assert.equal(me.role, 'records_officer');
  assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'google' AND subject = 'g-123'").n, 1);
  // The state is single-use: replaying the same callback signs nobody in.
  const replay = env.client();
  await finish(replay, 'google', to.searchParams.get('state'));
  assert.equal((await replay.get('/api/auth/status')).data.data.user, null);

  // Later the Google account's email changes: the stable ID still finds Pat.
  const again = env.client();
  to = await begin(again, g, 'google', '/history.html');
  g.state.google = { email: 'pat.new@gmail.com', sub: 'g-123' };
  r = await finish(again, 'google', to.searchParams.get('state'));
  assert.equal(where(r).pathname, '/history.html', 'returns to the page the person started from');
  assert.equal((await again.get('/api/auth/status')).data.data.user.email, 'pat@city.gov');
  // An open redirect is refused: a "next" that leaves the site is replaced by the app's own landing page.
  const odd = env.client();
  to = await begin(odd, g, 'google', '//evil.example/steal');
  g.state.google = { email: 'pat.new@gmail.com', sub: 'g-123' };
  r = await finish(odd, 'google', to.searchParams.get('state'));
  assert.equal(where(r).host, 'x', 'stays on this site'); assert.equal(where(r).pathname, '/sources.html');

  // Disabled: refused even with a linked identity.
  const patId = env.app.db.get("SELECT id FROM users WHERE email = 'pat@city.gov'").id;
  await admin.patch(`/api/users/${patId}`, { disabled: true });
  const late = env.client();
  to = await begin(late, g, 'google');
  r = await finish(late, 'google', to.searchParams.get('state'));
  assert.match(where(r).searchParams.get('error') || '', /disabled/);

  // Sign-in tokens are used once and dropped; they are never stored or logged.
  const all = [fs.readFileSync(env.config.dbPath).toString('latin1'), env.logs.join('\n'), JSON.stringify((await admin.get('/api/audit?pageSize=200')).data)].join('\n');
  assert(!all.includes('signin-access-SECRET'));
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM source_credentials').n, 0);
  const actions = (await admin.get('/api/audit?pageSize=200')).data.data;
  assert(actions.some(a => a.action === 'auth.login' && a.details.method === 'google'));
  // A stranger belongs to no organization, so (like an unknown email at the password form) the refusal is logged server-wide.
  assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'auth.login_failed' AND tenant_id IS NULL AND json_extract(details, '$.reason') = 'no_account'").n, 1);
});

test('Continue with Microsoft: personal accounts use the account address; work accounts use the verified UPN, not the editable email claim', async (t) => {
  const g = await idp();
  const env = await startApp({ MICROSOFT_CLIENT_ID: 'mcid', MICROSOFT_CLIENT_SECRET: 'msecret', MICROSOFT_AUTH_BASE: g.url, MICROSOFT_GRAPH_BASE: `${g.url}/v1.0`, PUBLIC_URL: 'http://localhost:9999' });
  t.after(async () => { await env.close(); await g.close(); });
  const admin = env.client(); await admin.setup();
  await admin.post('/api/users', { email: 'prs.kh@outlook.com', name: 'PRS', role: 'records_officer', password: 'prs password 1234' });
  await admin.post('/api/users', { email: 'boss@city.gov', name: 'Boss', role: 'admin', password: 'boss password 123' });

  const p = env.client();
  let to = await begin(p, g, 'microsoft');
  assert.equal(to.searchParams.get('scope'), 'openid email profile User.Read');
  g.state.microsoft = { tid: MSA, preferred_username: 'PRS.KH@outlook.com' };
  let r = await finish(p, 'microsoft', to.searchParams.get('state'));
  assert.equal(where(r).searchParams.get('welcome'), 'microsoft', where(r).searchParams.get('error'));
  assert.equal((await p.get('/api/auth/status')).data.data.user.email, 'prs.kh@outlook.com');

  // Work tenant: the id_token claims to be the boss, but the account's user principal name is someone else's.
  const w = env.client();
  to = await begin(w, g, 'microsoft');
  g.state.microsoft = { tid: 'tenant-x', oid: 'o-attacker', email: 'boss@city.gov', preferred_username: 'boss@city.gov' };
  g.state.upn = 'mallory@tenant-x.example';
  r = await finish(w, 'microsoft', to.searchParams.get('state'));
  assert.equal(where(r).pathname, '/request-access.html');
  assert.equal((await w.get('/api/access-requests/me')).data.data.identity.email, 'mallory@tenant-x.example', 'the editable email claim is ignored; the verified UPN is used');
  assert.equal((await w.get('/api/auth/status')).data.data.user, null);
});

test('Link Microsoft account: only from a signed-in session, CSRF-protected, bound to that session, never by email, one user per Microsoft account', async (t) => {
  const g = await idp();
  const env = await startApp({ GOOGLE_CLIENT_ID: 'gcid', GOOGLE_CLIENT_SECRET: 'gsecret', GOOGLE_AUTH_URL: `${g.url}/google/auth`, GOOGLE_TOKEN_URL: `${g.url}/google/token`,
    MICROSOFT_CLIENT_ID: 'mcid', MICROSOFT_CLIENT_SECRET: 'msecret', MICROSOFT_AUTH_BASE: g.url, MICROSOFT_GRAPH_BASE: `${g.url}/v1.0`, PUBLIC_URL: 'http://localhost:9999' });
  t.after(async () => { await env.close(); await g.close(); });
  const admin = env.client(); await admin.setup();
  await admin.post('/api/users', { email: 'pat@city.gov', name: 'Pat', role: 'records_officer', password: 'pat password 123' });
  await admin.post('/api/users', { email: 'sam@city.gov', name: 'Sam', role: 'records_officer', password: 'sam password 123' });
  const db = env.app.db;
  const ms = () => db.all("SELECT u.email AS user, i.email FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = 'microsoft'").map(x => ({ ...x }));
  const msSources = () => db.get("SELECT COUNT(*) AS n FROM sources WHERE type IN ('outlook', 'onedrive', 'sharepoint')").n;

  // Pat signs in with Google first.
  const pat = env.client();
  let to = await begin(pat, g, 'google');
  g.state.google = { email: 'pat@city.gov', sub: 'g-pat' };
  let r = await finish(pat, 'google', to.searchParams.get('state'));
  assert.equal(where(r).searchParams.get('welcome'), 'google');
  pat.csrf = (await pat.get('/api/auth/status')).data.data.csrfToken;
  assert.deepEqual((await pat.get('/api/auth/status')).data.data.identities.map(i => i.provider), ['google']);

  // Not signed in, or no CSRF token: refused.
  assert.equal((await env.client().post('/api/signin/link/microsoft')).status, 401);
  const noCsrf = await fetch(`${env.base}/api/signin/link/microsoft`, { method: 'POST', headers: { cookie: pat.cookie, origin: env.base } });
  assert.equal(noCsrf.status, 403, 'another site cannot start a link');

  const startLink = async (c) => {
    const res = await c.post('/api/signin/link/microsoft');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const u = new URL(res.data.data.url);
    g.state.challenge = u.searchParams.get('code_challenge'); g.state.nonce = u.searchParams.get('nonce');
    return u;
  };

  // Cancelled at Microsoft: nothing linked, still signed in with Google.
  let ms1 = await startLink(pat);
  assert.equal(ms1.searchParams.get('scope'), 'openid email profile User.Read', 'linking asks for identity only; no mail or file permission');
  r = await pat.get(`/oauth/microsoft/callback?error=access_denied&error_description=user+cancelled&state=${ms1.searchParams.get('state')}`);
  assert.match(where(r).searchParams.get('link_error'), /cancelled/);
  assert.equal(ms().length, 0);
  assert.equal((await pat.get('/api/auth/status')).data.data.user.email, 'pat@city.gov', 'the Google session survives a failed link');

  // Started by Pat, finished in Sam's browser session: refused (no cross-session linking).
  const sam = env.client(); await sam.login('sam@city.gov', 'sam password 123');
  ms1 = await startLink(pat);
  const linkCookie = pat.cookie.split('; ').find(c => c.startsWith('prs_signin='));
  sam.cookie = `${sam.cookie}; ${linkCookie}`;
  g.state.microsoft = { tid: MSA, oid: 'o-pat', preferred_username: 'pat.personal@outlook.com' };
  r = await sam.get(`/oauth/microsoft/callback?code=c1&state=${ms1.searchParams.get('state')}`);
  assert.match(where(r).searchParams.get('link_error') || '', /different session/);
  assert.equal(ms().length, 0, 'nothing linked to Sam or Pat');

  // The real thing: Pat finishes in Pat's own session. The Microsoft address differs from Pat's, and that is fine:
  // Pat proved both identities in one session. Email is never used to link.
  ms1 = await startLink(pat);
  r = await pat.get(`/oauth/microsoft/callback?code=c1&state=${ms1.searchParams.get('state')}`);
  assert.equal(where(r).searchParams.get('linked'), 'microsoft', where(r).searchParams.get('link_error'));
  assert.deepEqual(ms(), [{ user: 'pat@city.gov', email: 'pat.personal@outlook.com' }]);
  assert.equal((await pat.get('/api/auth/status')).data.data.user.email, 'pat@city.gov', 'still the same app user');
  assert.equal(msSources(), 0, 'linking connects no Microsoft service by itself');

  // That Microsoft account now signs Pat in, although its address is not Pat's.
  const later = env.client();
  to = await begin(later, g, 'microsoft');
  r = await finish(later, 'microsoft', to.searchParams.get('state'));
  assert.equal((await later.get('/api/auth/status')).data.data.user.email, 'pat@city.gov');

  // Sam cannot take Pat's Microsoft account.
  sam.cookie = sam.cookie.split('; ').filter(c => !c.startsWith('prs_signin=')).join('; ');
  sam.csrf = (await sam.get('/api/auth/status')).data.data.csrfToken;
  ms1 = await startLink(sam);
  r = await sam.get(`/oauth/microsoft/callback?code=c1&state=${ms1.searchParams.get('state')}`);
  assert.match(where(r).searchParams.get('link_error') || '', /already linked to another user/);
  assert.deepEqual(ms(), [{ user: 'pat@city.gov', email: 'pat.personal@outlook.com' }]);

  // Unlinking is the person's own choice and is audited.
  assert.equal((await pat.del('/api/signin/identities/microsoft')).data.data.unlinked, true);
  assert.equal(ms().length, 0);
  const acts = (await admin.get('/api/audit?pageSize=200')).data.data.map(a => a.action);
  for (const a of ['auth.identity_linked', 'auth.identity_unlinked']) assert(acts.includes(a), a);
});

test('OAuth errors from the provider are explained, not generic', async () => {
  const { explainOAuthError } = await import('../server/connectors/registry.mjs');
  assert.match(explainOAuthError('google', 'invalid_scope'), /Data access on the OAuth consent screen/);
  assert.match(explainOAuthError('google', 'access_denied'), /test-user list/);
  assert.match(explainOAuthError('microsoft', 'invalid_request', 'AADSTS50011: The redirect URI does not match'), /redirect URI does not match/);
  assert.match(explainOAuthError('microsoft', 'access_denied', 'AADSTS65001: The user or administrator has not consented'), /administrator may have to grant/);
  assert.match(explainOAuthError('microsoft', 'invalid_client', 'AADSTS7000215: Invalid client secret provided'), /client secret/i);
});

test('no sign-in buttons on the demo server or without credentials', async (t) => {
  const demo = await startApp({ REAL_SOURCES: 'false', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' });
  t.after(() => demo.close());
  const c = demo.client();
  assert.deepEqual((await c.get('/api/auth/status')).data.data.signIn, { google: false, microsoft: false });
  assert.equal((await c.get('/oauth/signin/google')).status, 404);
  const bare = await startApp();
  t.after(() => bare.close());
  assert.deepEqual((await bare.client().get('/api/auth/status')).data.data.signIn, { google: false, microsoft: false });
});

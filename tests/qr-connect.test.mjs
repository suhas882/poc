import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fakeServer, startApp, waitForSync } from './helpers.mjs';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Google and Microsoft stand-ins: PKCE-checking token endpoints, a mailbox, and Teams chats. */
async function providers() {
  const st = { googleChallenge: null, msChallenge: null, teamsFilters: [] };
  let base = '';
  const chats = [{ id: 'chat-1', topic: null, chatType: 'oneOnOne', lastUpdatedDateTime: '2026-11-01T10:00:00Z', webUrl: 'https://teams.microsoft.com/l/chat/chat-1',
    members: [{ userId: 'me-1', displayName: 'Ada Admin' }, { userId: 'u-2', displayName: 'Pat Engineer' }] }];
  const messages = {
    'chat-1': [
      { id: 'm1', messageType: 'message', createdDateTime: '2026-11-01T09:00:00Z', lastModifiedDateTime: '2026-11-01T09:00:00Z', from: { user: { displayName: 'Pat Engineer' } }, body: { contentType: 'html', content: '<p>Cedar Avenue closure <b>approved</b></p>' } },
      { id: 'm2', messageType: 'systemEventMessage', createdDateTime: '2026-11-01T09:01:00Z', lastModifiedDateTime: '2026-11-01T09:01:00Z', body: { content: '' } }
    ]
  };
  const server = await fakeServer((req, url, body) => {
    const form = new URLSearchParams(body);
    const pkce = (v) => crypto.createHash('sha256').update(v || '').digest('base64url');
    // Google
    if (url.pathname === '/g/token' && form.get('grant_type') === 'authorization_code') {
      if (pkce(form.get('code_verifier')) !== st.googleChallenge || form.get('code') !== 'good-code') return { status: 400, json: { error: 'invalid_grant' } };
      return { json: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: GMAIL_SCOPE, token_type: 'Bearer' } };
    }
    if (url.pathname === '/g/token') return { json: { access_token: 'access-2', expires_in: 3600 } };
    if (url.pathname === '/g/revoke') return { json: {} };
    if (url.pathname.startsWith('/gmail/v1/users/me/profile')) return { json: { emailAddress: 'clerk@city.gov', historyId: '1' } };
    if (url.pathname.startsWith('/gmail/v1/users/me/messages')) return { json: { messages: [] } };
    if (url.pathname.startsWith('/gmail/')) return { json: {} };
    // Microsoft
    if (url.pathname === '/common/oauth2/v2.0/token' && form.get('grant_type') === 'authorization_code') {
      if (pkce(form.get('code_verifier')) !== st.msChallenge || form.get('code') !== 'good-code') return { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS: bad code' } };
      return { json: { access_token: 'ms-access-1', refresh_token: 'rt-1', expires_in: 3600, scope: String(form.get('scope')).replace('offline_access ', ''), token_type: 'Bearer' } };
    }
    if (url.pathname === '/common/oauth2/v2.0/token') return { json: { access_token: 'ms-access-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'Chat.Read User.Read' } };
    if (!/^Bearer ms-access-/.test(req.headers.authorization || '')) return { status: 401, json: { error: { code: 'InvalidAuthenticationToken', message: 'No token.' } } };
    const p = url.pathname.replace('/v1.0', '');
    if (p === '/me') return { json: url.searchParams.get('$select') === 'id' ? { id: 'me-1' } : { mail: 'ada@city.gov', userPrincipalName: 'ada@city.gov', displayName: 'Ada' } };
    if (p === '/me/chats') return { json: { value: url.searchParams.get('$top') === '1' ? chats.slice(0, 1).map(c => ({ id: c.id })) : chats } };
    const m = /^\/me\/chats\/([^/]+)\/messages$/.exec(p);
    if (m) {
      const filter = url.searchParams.get('$filter') || '';
      st.teamsFilters.push(filter);
      const gt = /lastModifiedDateTime gt (\S+)/.exec(filter)?.[1];
      const list = (messages[decodeURIComponent(m[1])] || []).filter(x => !gt || x.lastModifiedDateTime > gt).sort((a, b) => b.lastModifiedDateTime.localeCompare(a.lastModifiedDateTime));
      return { json: { value: list } };
    }
    return { status: 404, json: { error: { code: 'itemNotFound', message: 'Not found.' } } };
  });
  base = server.url;
  return { ...server, st, chats, messages, base };
}

async function setup(t) {
  const p = await providers();
  const env = await startApp({
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_AUTH_URL: `${p.url}/g/auth`, GOOGLE_TOKEN_URL: `${p.url}/g/token`, GOOGLE_REVOKE_URL: `${p.url}/g/revoke`,
    GOOGLE_TOKENINFO_URL: `${p.url}/g/tokeninfo`, GMAIL_API_BASE: `${p.url}/gmail/v1`,
    MICROSOFT_CLIENT_ID: 'ms-cid', MICROSOFT_CLIENT_SECRET: 'ms-secret', MICROSOFT_AUTH_BASE: p.url, MICROSOFT_GRAPH_BASE: `${p.url}/v1.0`, PUBLIC_URL: 'http://localhost:9999'
  });
  t.after(async () => { await env.close(); await p.close(); });
  const c = env.client();
  await c.setup();
  return { p, env, c, phone: env.client() };
}

/** What the phone does: open the code, tap Continue, and follow the redirect to the provider's consent page. */
async function phoneContinue(env, phone, qrPath) {
  const r = await phone.req('POST', `${qrPath}/continue`, '', { origin: env.base, 'content-type': 'application/x-www-form-urlencoded' });
  return { r, auth: r.status === 303 ? new URL(r.headers.get('location')) : null };
}

test('QR connect, Google: phone finishes OAuth, computer sees the source, single use and replay safe', async (t) => {
  const { p, env, c, phone } = await setup(t);

  let r = await c.post('/api/connections/qr/start', { app: 'gmail' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const a = r.data.data;
  assert.equal(a.status, 'pending');
  assert.match(a.qrPath, /^\/qr\/[A-Za-z0-9_-]{40,}$/, 'the QR code holds only an unguessable reference');
  assert.match(a.matchCode, /^\d{2}$/);
  assert.ok(Date.parse(a.expiresAt) - Date.now() <= 3 * 60_000 + 1000, 'expires within minutes');
  assert.ok(!JSON.stringify(env.app.db.all('SELECT * FROM qr_connect_attempts')).includes(a.qrPath.slice(4)), 'only the hash of the reference is stored');

  // Opening the code shows who it connects for and the match number, and changes nothing (link previews are harmless).
  for (let i = 0; i < 2; i++) {
    r = await phone.get(a.qrPath);
    assert.equal(r.status, 200);
    assert.match(r.data, new RegExp(`computer shows the number ${a.matchCode}`));
    assert.match(r.data, /Ada Admin/);
    assert.ok(!r.data.includes('admin@example.org'), 'the website account email is masked');
    // Browsers apply form-action to the redirect after "Continue": exactly this provider's sign-in origin is allowed.
    assert.match(r.headers.get('content-security-policy'), new RegExp(`form-action 'self' ${p.url.replace(/[.]/g, '\.')};`));
  }
  assert.equal((await c.get(`/api/connections/qr/status/${a.attemptId}`)).data.data.status, 'pending');

  // A post from another site is refused.
  r = await phone.req('POST', `${a.qrPath}/continue`, '', { origin: 'https://evil.example' });
  assert.equal(r.status, 403);

  const { r: cont, auth } = await phoneContinue(env, phone, a.qrPath);
  assert.equal(cont.status, 303);
  assert.equal(auth.origin + auth.pathname, `${p.url}/g/auth`);
  assert.equal(auth.searchParams.get('scope'), GMAIL_SCOPE, 'read-only Gmail scope only');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:9999/oauth/google/callback', 'the usual registered redirect URI');
  p.st.googleChallenge = auth.searchParams.get('code_challenge');
  assert.equal((await phoneContinue(env, phone, a.qrPath)).r.status, 410, 'the code works once');
  assert.equal((await c.get(`/api/connections/qr/status/${a.attemptId}`)).data.data.status, 'authorizing', 'a scan is not success');

  // The provider sends the phone back. The phone has no session on this site.
  r = await phone.get(`/oauth/google/callback?code=good-code&state=${auth.searchParams.get('state')}`);
  assert.equal(r.status, 200, String(r.data).slice(0, 300));
  assert.match(r.data, /Gmail is connected/);
  assert.ok(!r.headers.get('set-cookie'), 'the phone is not signed in to the website');

  const done = (await c.get(`/api/connections/qr/status/${a.attemptId}`)).data.data;
  assert.equal(done.status, 'connected');
  assert.equal(done.account, 'clerk@city.gov');
  const src = (await c.get('/api/sources')).data.data.find(x => x.id === done.sourceId);
  assert.equal(src.type, 'gmail');
  assert.ok(src.isOwner, 'linked to the website user who started it');
  assert.deepEqual(src.scopes, [GMAIL_SCOPE]);
  await waitForSync(c, done.sourceId);
  assert.ok(!fs.readFileSync(env.config.dbPath).includes(Buffer.from('refresh-1')), 'no plaintext token stored');

  // Replaying the callback does nothing.
  r = await phone.get(`/oauth/google/callback?code=good-code&state=${auth.searchParams.get('state')}`);
  assert.equal(r.status, 410);
  assert.equal((await c.get('/api/sources')).data.data.filter(x => x.type === 'gmail').length, 1);

  const actions = (await c.get('/api/audit?pageSize=100')).data.data.map(e => `${e.action}:${e.outcome}`);
  for (const x of ['qr_connect.started:success', 'qr_connect.opened:success', 'source.connected:success']) assert.ok(actions.includes(x), x);
});

test('QR connect: expiry, cancel, declined consent, other sessions and users, limits', async (t) => {
  const { p, env, c, phone } = await setup(t);

  // Expired before it was opened.
  let a = (await c.post('/api/connections/qr/start', { app: 'gdrive' })).data.data;
  env.app.db.run("UPDATE qr_connect_attempts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", a.attemptId);
  assert.equal((await phone.get(a.qrPath)).status, 410);
  assert.equal((await phoneContinue(env, phone, a.qrPath)).r.status, 410);
  assert.equal((await c.get(`/api/connections/qr/status/${a.attemptId}`)).data.data.status, 'expired');

  // Cancelled on the computer while the phone is on the provider's page: the callback cannot connect anything.
  a = (await c.post('/api/connections/qr/start', { app: 'gmail' })).data.data;
  let { auth } = await phoneContinue(env, phone, a.qrPath);
  p.st.googleChallenge = auth.searchParams.get('code_challenge');
  assert.equal((await c.post('/api/connections/qr/cancel', { attemptId: a.attemptId })).data.data.status, 'cancelled');
  let r = await phone.get(`/oauth/google/callback?code=good-code&state=${auth.searchParams.get('state')}`);
  assert.equal(r.status, 410);
  assert.equal((await c.get('/api/sources')).data.data.filter(x => x.type === 'gmail').length, 0);

  // Declined on the consent page.
  a = (await c.post('/api/connections/qr/start', { app: 'gmail' })).data.data;
  ({ auth } = await phoneContinue(env, phone, a.qrPath));
  r = await phone.get(`/oauth/google/callback?error=access_denied&state=${auth.searchParams.get('state')}`);
  assert.equal(r.status, 400);
  let s = (await c.get(`/api/connections/qr/status/${a.attemptId}`)).data.data;
  assert.equal(s.status, 'failed');
  assert.ok(s.error);

  // A wrong authorization code fails; nothing is connected.
  a = (await c.post('/api/connections/qr/start', { app: 'gmail' })).data.data;
  ({ auth } = await phoneContinue(env, phone, a.qrPath));
  p.st.googleChallenge = auth.searchParams.get('code_challenge');
  r = await phone.get(`/oauth/google/callback?code=forged&state=${auth.searchParams.get('state')}`);
  assert.equal(r.status, 400);
  assert.equal((await c.get(`/api/connections/qr/status/${a.attemptId}`)).data.data.status, 'failed');

  // A Google attempt's state sent to the Microsoft callback is refused.
  a = (await c.post('/api/connections/qr/start', { app: 'gmail' })).data.data;
  ({ auth } = await phoneContinue(env, phone, a.qrPath));
  r = await phone.get(`/oauth/microsoft/callback?code=good-code&state=${auth.searchParams.get('state')}`);
  assert.equal(r.status, 400);
  await c.post('/api/connections/qr/cancel', { attemptId: a.attemptId });

  // Only the browser session that started an attempt can watch or cancel it.
  a = (await c.post('/api/connections/qr/start', { app: 'outlook' })).data.data;
  const sameUserOtherBrowser = env.client();
  await sameUserOtherBrowser.login('admin@example.org', 'correct horse battery');
  assert.equal((await sameUserOtherBrowser.get(`/api/connections/qr/status/${a.attemptId}`)).status, 404);
  assert.equal((await sameUserOtherBrowser.post('/api/connections/qr/cancel', { attemptId: a.attemptId })).status, 404);
  assert.equal((await phone.get(`/api/connections/qr/status/${a.attemptId}`)).status, 401);

  // Unknown references and unsupported apps.
  assert.equal((await phone.get('/qr/not-a-real-reference-but-long-enough-xxxxxxxxx')).status, 404);
  assert.equal((await c.post('/api/connections/qr/start', { app: 'database' })).status, 400, 'databases keep their normal connection');
  assert.equal((await c.post('/api/connections/qr/start', { app: 'sharepoint', siteUrl: 'https://evil.example/' })).status, 400);

  // At most five open attempts per person.
  let last;
  for (let i = 0; i < 6; i++) last = await c.post('/api/connections/qr/start', { app: 'onedrive' });
  assert.equal(last.status, 429);
});

test('QR connect, Microsoft Teams: connects, syncs chat messages, and syncs incrementally', async (t) => {
  const { p, env, c, phone } = await setup(t);
  const card = (await c.get('/api/connectors')).data.data.find(x => x.type === 'teams');
  assert.equal(card.status, 'available');
  assert.ok(!(await c.get('/api/connectors')).data.data.some(x => x.type === 'stub' && x.key === 'teams'), 'the Teams placeholder is replaced by the real connector');

  const a = (await c.post('/api/connections/qr/start', { app: 'teams' })).data.data;
  const { auth } = await phoneContinue(env, phone, a.qrPath);
  assert.equal(auth.searchParams.get('scope'), 'offline_access User.Read Chat.Read', 'least privilege: Chat.Read only');
  p.st.msChallenge = auth.searchParams.get('code_challenge');
  const r = await phone.get(`/oauth/microsoft/callback?code=good-code&state=${auth.searchParams.get('state')}`);
  assert.equal(r.status, 200, String(r.data).slice(0, 300));
  const done = (await c.get(`/api/connections/qr/status/${a.attemptId}`)).data.data;
  assert.equal(done.status, 'connected');
  assert.equal(done.account, 'ada@city.gov');

  let src = await waitForSync(c, done.sourceId);
  assert.equal(src.type, 'teams');
  let recs = (await c.get(`/api/sources/${done.sourceId}/records`)).data.data;
  assert.equal(recs.length, 1, 'system messages are skipped');
  const rec = (await c.get(`/api/records/${recs[0].id}`)).data.data;
  assert.match(rec.content, /Pat Engineer: Cedar Avenue closure approved/);
  assert.match(rec.title, /Teams: Pat Engineer/);

  // A new message and a deleted one arrive; the next sync asks only for changes after the last mark.
  p.messages['chat-1'].push({ id: 'm3', messageType: 'message', createdDateTime: '2026-11-02T08:00:00Z', lastModifiedDateTime: '2026-11-02T08:00:00Z', from: { user: { displayName: 'Ada Admin' } }, body: { contentType: 'text', content: 'Permit P-77 is ready' } });
  p.messages['chat-1'][0] = { ...p.messages['chat-1'][0], lastModifiedDateTime: '2026-11-02T09:00:00Z', deletedDateTime: '2026-11-02T09:00:00Z' };
  p.chats[0].lastUpdatedDateTime = '2026-11-02T09:00:00Z';
  await c.post(`/api/sources/${done.sourceId}/sync`, {});
  src = await waitForSync(c, done.sourceId);
  assert.match(p.st.teamsFilters.at(-1), /lastModifiedDateTime gt 2026-11-01T09:01:00\.000Z/);
  recs = (await c.get(`/api/sources/${done.sourceId}/records`)).data.data;
  assert.equal(recs.length, 1);
  assert.match((await c.get(`/api/records/${recs[0].id}`)).data.data.content, /Permit P-77/);

  // Check access works for Teams, and the normal (non-QR) Microsoft flow still works for Teams too.
  const v = await c.post(`/api/sources/${done.sourceId}/verify`, {});
  assert.ok(v.data.data.checks.some(x => x.label === 'Teams chats answer' && x.ok), JSON.stringify(v.data.data.checks));
  const normal = await c.post('/api/connectors/microsoft/authorize', { kind: 'teams' });
  assert.equal(normal.status, 200);
});

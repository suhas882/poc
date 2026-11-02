// MOCKED: local stand-ins for Google's and Microsoft's token and API servers. These prove the configuration check
// and per-user token isolation; they are not real provider tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeServer, startApp, waitForSync } from './helpers.mjs';

const b64 = (s) => Buffer.from(s).toString('base64url');

/** Fake Google: each authorization code belongs to a different person and yields that person's own tokens. */
async function google({ clientOk = true } = {}) {
  const state = { challenge: null, revoked: new Set(), people: { 'code-ana': 'ana', 'code-ben': 'ben' } };
  const server = await fakeServer((req, url, body) => {
    const form = new URLSearchParams(body);
    if (url.pathname === '/token') {
      if (!clientOk || form.get('client_secret') !== 'gs') return { status: 401, json: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } };
      if (form.get('grant_type') === 'refresh_token') return { json: { access_token: `access-${form.get('refresh_token').split('-')[1]}-r`, expires_in: 3600 } };
      const who = state.people[form.get('code')];
      if (!who) return { status: 400, json: { error: 'invalid_grant', error_description: 'Malformed auth code.' } };
      if (crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== state.challenge) return { status: 400, json: { error: 'invalid_grant' } };
      return { json: { access_token: `access-${who}`, refresh_token: `refresh-${who}`, expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' } };
    }
    if (url.pathname === '/revoke') { state.revoked.add(form.get('token')); return { json: {} }; }
    const who = /^Bearer access-(\w+)/.exec(req.headers.authorization || '')?.[1];
    if (!who || state.revoked.has(`refresh-${who}`)) return { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } };
    const p = url.pathname.replace('/gmail/v1/users/me', '');
    if (p === '/profile') return { json: { emailAddress: `${who}@gmail.com`, historyId: '1' } };
    if (p === '/messages') return { json: { messages: [{ id: `${who}-m1`, threadId: 't' }] } };
    if (p === `/messages/${who}-m1`) return { json: { id: `${who}-m1`, threadId: 't', internalDate: String(Date.now()), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: `${who}'s private memo` }], body: { data: b64(`Only ${who} wrote this.`) } } } };
    return { status: 404, json: {} };
  });
  return { ...server, state };
}

async function connectGmail(c, g, code) {
  const auth = new URL((await c.post('/api/connectors/gmail/authorize', { query: '', visibility: 'owner' })).data.data.url);
  g.state.challenge = auth.searchParams.get('code_challenge');
  const r = await c.get(`/oauth/google/callback?code=${code}&state=${auth.searchParams.get('state')}`);
  return new URL(r.headers.get('location'), 'http://x').searchParams.get('connected');
}

test('two people connect their own Google accounts: separate tokens, separate records, separate revocation', async (t) => {
  const g = await google();
  const env = await startApp({ GOOGLE_CLIENT_ID: 'gcid-1234567890', GOOGLE_CLIENT_SECRET: 'gs', GOOGLE_AUTH_URL: `${g.url}/auth`, GOOGLE_TOKEN_URL: `${g.url}/token`, GOOGLE_REVOKE_URL: `${g.url}/revoke`, GMAIL_API_BASE: `${g.url}/gmail/v1` });
  t.after(async () => { await env.close(); await g.close(); });
  const db = env.app.db, vault = env.app.services.vault;
  const admin = env.client(); await admin.setup();
  await admin.post('/api/users', { email: 'ana@city.gov', name: 'Ana', role: 'records_officer', password: 'ana password 1234' });
  await admin.post('/api/users', { email: 'ben@city.gov', name: 'Ben', role: 'records_officer', password: 'ben password 1234' });
  const ana = env.client(); await ana.login('ana@city.gov', 'ana password 1234');
  const ben = env.client(); await ben.login('ben@city.gov', 'ben password 1234');

  // Neither person configures anything: the app's one Google client serves both; each grants their own consent.
  const anaSrc = await connectGmail(ana, g, 'code-ana');
  const benSrc = await connectGmail(ben, g, 'code-ben');
  assert(anaSrc && benSrc && anaSrc !== benSrc);
  await waitForSync(ana, anaSrc); await waitForSync(ben, benSrc);
  const creds = (id) => vault.open(db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', id).ciphertext);
  assert.equal(creds(anaSrc).refreshToken, 'refresh-ana'); assert.equal(creds(benSrc).refreshToken, 'refresh-ben');
  // Each sync used only its owner's token.
  const usedBy = (who) => g.calls.filter(c => c.path.startsWith('/gmail/') && c.headers.authorization?.startsWith(`Bearer access-${who}`)).map(c => c.path);
  assert(usedBy('ana').every(p => !p.includes('ben-')), 'Ana’s token never fetched Ben’s mail');
  assert(usedBy('ben').every(p => !p.includes('ana-')));
  // Records stay with their owner (both chose "Only me").
  const titles = (c) => c.get('/api/sources').then(r => r.data.data.map(s => s.id));
  assert(!(await titles(ben)).includes(anaSrc)); assert(!(await titles(ana)).includes(benSrc));
  const anaRec = db.get('SELECT id FROM records WHERE source_id = ?', anaSrc).id;
  assert.equal((await ben.get(`/api/records/${anaRec}`)).status, 404);
  // Neither can sync, verify or disconnect the other's source.
  assert.equal((await ben.post(`/api/sources/${anaSrc}/sync`)).status, 403);
  assert.equal((await ben.post(`/api/sources/${anaSrc}/verify`)).status, 403);
  assert.equal((await ben.del(`/api/sources/${anaSrc}`)).status, 403);
  // No token in anything the browser receives.
  const seen = JSON.stringify([(await ana.get('/api/sources')).data, (await ben.get('/api/sources')).data, (await admin.get('/api/admin/integrations')).data]);
  assert(!/access-(ana|ben)|refresh-(ana|ben)/.test(seen));

  // Ana disconnects: only Ana's token is revoked; Ben keeps working.
  assert.equal((await ana.del(`/api/sources/${anaSrc}`)).data.data.revokedAtProvider, true);
  assert(g.state.revoked.has('refresh-ana') && !g.state.revoked.has('refresh-ben'));
  assert.equal((await ben.post(`/api/sources/${benSrc}/sync`)).status, 202);
  const after = await waitForSync(ben, benSrc);
  assert.equal(after.lifecycle, 'indexed', after.lastError);

  // The configuration check sees both connections without reading either person's mail.
  const cfg = (await admin.post('/api/admin/integrations/check')).data.data;
  assert.equal(cfg.google.client.ok, true);
  assert.deepEqual(cfg.connections.map(c => ({ ...c })), [{ type: 'gmail', sources: 1, people: 1 }]);
});

test('Check configuration: accepted and refused clients, missing Microsoft, bad redirect, Supervisors only, no secrets', async (t) => {
  const g = await google({ clientOk: false });
  const ms = await fakeServer((req, url, body) => {
    const form = new URLSearchParams(body);
    if (url.pathname.endsWith('/oauth2/v2.0/token')) {
      if (form.get('client_secret') === 'expired') return { status: 401, json: { error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys are expired.' } };
      if (form.get('client_secret') === 'wrong') return { status: 401, json: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' } };
      // Like the real service: an app token for client_credentials with the right secret; a made-up code is "malformed".
      if (form.get('grant_type') === 'client_credentials') return { json: { access_token: 'app-token-discarded', expires_in: 3600 } };
      return { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS9002313: Invalid request.' } };
    }
    return { status: 404, json: {} };
  });
  t.after(async () => { await g.close(); await ms.close(); });

  // Google refused, Microsoft expired secret, and a non-https public address.
  let env = await startApp({ GOOGLE_CLIENT_ID: 'gcid-bad', GOOGLE_CLIENT_SECRET: 'wrong-secret', GOOGLE_TOKEN_URL: `${g.url}/token`,
    MICROSOFT_CLIENT_ID: 'mcid-xyz', MICROSOFT_CLIENT_SECRET: 'expired', MICROSOFT_TENANT: 'tenant-1', MICROSOFT_AUTH_BASE: ms.url, PUBLIC_URL: 'http://records.example.gov' });
  let admin = env.client(); await admin.setup();
  await admin.post('/api/users', { email: 'c@x.org', name: 'C', role: 'records_officer', password: 'clerk password 12' });
  const clerk = env.client(); await clerk.login('c@x.org', 'clerk password 12');
  assert.equal((await clerk.get('/api/admin/integrations')).status, 403, 'only Supervisors see the configuration');
  assert.equal((await clerk.post('/api/admin/integrations/check')).status, 403);
  let r = (await admin.post('/api/admin/integrations/check')).data.data;
  assert.equal(r.google.client.ok, false); assert.equal(r.google.readiness, 'blocked');
  assert.equal(r.microsoft.client.ok, false); assert.match(r.microsoft.client.detail, /expired/);
  assert.match(r.google.redirect.problem, /https/);
  assert(r.errors.length >= 3);
  assert(!JSON.stringify(r).includes('wrong-secret') && !JSON.stringify(r).includes('"expired"'), 'secrets are never returned');
  assert(r.google.requirements.some(x => /verification/.test(x)), 'Google’s verification requirement is stated');
  assert(r.microsoft.requirements.some(x => /administrator/.test(x)), 'Microsoft’s admin-consent requirement is stated');
  assert((await admin.get('/api/audit?pageSize=50')).data.data.some(a => a.action === 'integrations.checked'));
  await env.close();

  // Microsoft, single directory: right secret accepted, wrong secret refused (client_credentials, token discarded).
  for (const [secret, expected] of [['right', true], ['wrong', false]]) {
    const e = await startApp({ MICROSOFT_CLIENT_ID: 'mcid', MICROSOFT_CLIENT_SECRET: secret, MICROSOFT_TENANT: 'tenant-1', MICROSOFT_AUTH_BASE: ms.url });
    const a = e.client(); await a.setup();
    const res = (await a.post('/api/admin/integrations/check')).data.data;
    assert.equal(res.microsoft.client.ok, expected, `${secret}: ${res.microsoft.client.detail}`);
    assert(!JSON.stringify(res).includes('app-token-discarded'), 'the app token is never returned');
    await e.close();
  }
  // Microsoft with tenant "common": no definitive check exists, so it is never claimed as accepted.
  const c = await startApp({ MICROSOFT_CLIENT_ID: 'mcid', MICROSOFT_CLIENT_SECRET: 'wrong', MICROSOFT_AUTH_BASE: ms.url });
  const ca = c.client(); await ca.setup();
  const cr = (await ca.post('/api/admin/integrations/check')).data.data;
  assert.equal(cr.microsoft.client.ok, null); assert.match(cr.microsoft.client.detail, /first real sign-in/);
  assert.equal(cr.microsoft.readiness, 'unverified');
  await c.close();

  // Microsoft not set at all, Google client accepted (invalid_grant for the made-up code).
  const g2 = await google();
  t.after(() => g2.close());
  env = await startApp({ GOOGLE_CLIENT_ID: 'gcid-ok', GOOGLE_CLIENT_SECRET: 'gs', GOOGLE_TOKEN_URL: `${g2.url}/token` });
  t.after(() => env.close());
  admin = env.client(); await admin.setup();
  r = (await admin.get('/api/admin/integrations')).data.data;
  assert.equal(r.checkedAt, null, 'viewing the status does not call any provider');
  assert.equal(g2.calls.length, 0);
  r = (await admin.post('/api/admin/integrations/check')).data.data;
  assert.equal(r.google.client.ok, true); assert.equal(r.google.readiness, 'ready');
  assert.equal(r.google.apis.drive.state, 'unknown', 'no evidence yet: says so instead of guessing');
  assert.equal(r.microsoft.readiness, 'not_configured');
  assert(r.errors.some(e => /MICROSOFT_CLIENT_ID/.test(e)));
});

test('two people connect their own Microsoft accounts: separate tokens and records', async (t) => {
  const people = { 'code-ana': 'ana', 'code-ben': 'ben' };
  let challenge = null;
  const g = await fakeServer((req, url, body) => {
    const form = new URLSearchParams(body);
    if (url.pathname === '/common/oauth2/v2.0/token') {
      const who = people[form.get('code')];
      if (!who || crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== challenge) return { status: 400, json: { error: 'invalid_grant' } };
      return { json: { access_token: `ms-${who}`, refresh_token: `msr-${who}`, expires_in: 3600, scope: 'Mail.Read User.Read' } };
    }
    const who = /^Bearer ms-(\w+)/.exec(req.headers.authorization || '')?.[1];
    if (!who) return { status: 401, json: { error: { code: 'InvalidAuthenticationToken' } } };
    const p = url.pathname.replace('/v1.0', '');
    if (p === '/me') return { json: { mail: `${who}@outlook.com` } };
    if (p.startsWith('/me/mailFolders/')) return { json: { id: p.endsWith('junkemail') ? 'junk' : 'deleted' } };
    if (p === '/me/messages') return { json: { value: [{ id: `${who}-1`, parentFolderId: 'inbox', hasAttachments: false }] } };
    if (p === `/me/messages/${who}-1`) return { json: { id: `${who}-1`, subject: `${who} outlook memo`, receivedDateTime: new Date().toISOString(), body: { contentType: 'text', content: `Only ${who}.` }, from: { emailAddress: { address: `${who}@outlook.com` } } } };
    return { status: 404, json: { error: { code: 'itemNotFound' } } };
  });
  const env = await startApp({ MICROSOFT_CLIENT_ID: 'mcid', MICROSOFT_CLIENT_SECRET: 'ms', MICROSOFT_AUTH_BASE: g.url, MICROSOFT_GRAPH_BASE: `${g.url}/v1.0` });
  t.after(async () => { await env.close(); await g.close(); });
  const admin = env.client(); await admin.setup();
  await admin.post('/api/users', { email: 'ana@city.gov', name: 'Ana', role: 'records_officer', password: 'ana password 1234' });
  await admin.post('/api/users', { email: 'ben@city.gov', name: 'Ben', role: 'records_officer', password: 'ben password 1234' });
  const ids = {};
  for (const who of ['ana', 'ben']) {
    const c = env.client(); await c.login(`${who}@city.gov`, `${who} password 1234`);
    const auth = new URL((await c.post('/api/connectors/microsoft/authorize', { kind: 'outlook', visibility: 'owner' })).data.data.url);
    challenge = auth.searchParams.get('code_challenge');
    const r = await c.get(`/oauth/microsoft/callback?code=code-${who}&state=${auth.searchParams.get('state')}`);
    ids[who] = { c, src: new URL(r.headers.get('location'), 'http://x').searchParams.get('connected') };
    assert(ids[who].src, r.headers.get('location'));
    const s = await waitForSync(c, ids[who].src);
    assert.equal(s.accountLabel, `${who}@outlook.com`);
  }
  const vault = env.app.services.vault, db = env.app.db;
  assert.equal(vault.open(db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', ids.ana.src).ciphertext).refreshToken, 'msr-ana');
  assert.equal(vault.open(db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', ids.ben.src).ciphertext).refreshToken, 'msr-ben');
  assert(g.calls.filter(x => x.headers.authorization === 'Bearer ms-ana').every(x => !x.path.includes('ben-')));
  const anaRec = db.get('SELECT id FROM records WHERE source_id = ?', ids.ana.src).id;
  assert.equal((await ids.ben.c.get(`/api/records/${anaRec}`)).status, 404);
  assert.equal((await ids.ben.c.post(`/api/sources/${ids.ana.src}/sync`)).status, 403);
});

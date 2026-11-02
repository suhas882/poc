import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fakeServer, startApp, waitForSync, searchReq } from './helpers.mjs';
import { classifyGraphError, graphEndpoint } from '../server/connectors/microsoft.mjs';

const errOf = (r) => new URL(r.headers.get('location'), 'http://x').searchParams.get('error') || '';
const msg = (id, folder, subject, body, extra = {}) => ({ id, parentFolderId: folder, hasAttachments: false, subject, receivedDateTime: '2026-09-15T10:00:00Z', conversationId: `c-${id}`,
  webLink: `https://outlook.live.com/owa/?ItemID=${id}`, from: { emailAddress: { name: 'Pat Engineer', address: 'pat@city.gov' } }, toRecipients: [{ emailAddress: { address: 'records@city.gov' } }],
  body: { contentType: 'text', content: body }, ...extra });

async function microsoftFake() {
  const state = { challenge: null, refreshCount: 0, throttleNext: 0, listCalls: 0, foreignNextLink: false, refreshTokens: ['rt-1'], filters: [], prefers: [] };
  const mail = new Map([
    ['m1', msg('m1', 'inbox', 'Cedar Avenue lane closure schedule', 'Crews will close one lane on Cedar Avenue for the water main work.', { hasAttachments: true })],
    ['m2', msg('m2', 'archive', 'Detour approved', 'The Birch Street detour is approved for Monday.')],
    ['m3', msg('m3', 'junk', 'You won a prize', 'Cedar Avenue prize claim')]
  ]);
  const drive = { items: new Map([
    ['f1', { id: 'f1', name: 'Cedar Avenue closure memo.txt', file: {}, size: 60, webUrl: 'https://onedrive.live.com/f1', createdDateTime: '2026-08-01T09:00:00Z', lastModifiedDateTime: '2026-08-01T09:00:00Z', content: 'Memo: the Cedar Avenue closure runs nightly.' }],
    ['f2', { id: 'f2', name: 'photo.heic', file: {}, size: 10, webUrl: 'https://onedrive.live.com/f2', createdDateTime: '2026-08-01T09:00:00Z', lastModifiedDateTime: '2026-08-01T09:00:00Z', content: 'x' }],
    ['d1', { id: 'd1', name: 'Projects', folder: {} }]
  ]), changes: [] };
  let base = '';
  const server = await fakeServer((req, url, body) => {
    const form = new URLSearchParams(body);
    if (url.pathname === '/common/oauth2/v2.0/token') {
      if (form.get('grant_type') === 'authorization_code') {
        if (crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== state.challenge) return { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS50148: PKCE mismatch.' } };
        const scope = form.get('code') === 'no-mail' ? 'User.Read' : String(form.get('scope')).replace('offline_access ', '');
        return { json: { access_token: 'ms-access-1', refresh_token: 'rt-1', expires_in: 3600, scope, token_type: 'Bearer' } };
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (!state.refreshTokens.includes(form.get('refresh_token'))) return { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired.' } };
        state.refreshCount++;
        const next = `rt-${state.refreshCount + 1}`; state.refreshTokens.push(next);
        return { json: { access_token: `ms-access-r${state.refreshCount}`, refresh_token: next, expires_in: 3600, scope: 'Mail.Read User.Read' } };
      }
    }
    if (url.pathname.startsWith('/dl/')) return { body: drive.items.get(url.pathname.slice(4))?.content ?? '' };
    if (url.pathname === '/dl-sp/sp1') return { body: 'Council minutes: Cedar Avenue closure approved.' };
    if (!url.pathname.startsWith('/v1.0/')) return { status: 404, json: {} };
    if (!/^Bearer ms-access-/.test(req.headers.authorization || '')) return { status: 401, json: { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } } };
    if (state.throttleNext > 0) { state.throttleNext--; return { status: 429, headers: { 'retry-after': '0' }, json: { error: { code: 'TooManyRequests', message: 'Too many requests.' } } }; }
    const p = url.pathname.replace('/v1.0', '');
    if (p === '/me') return { json: { mail: null, userPrincipalName: 'PRS.KH@outlook.com', displayName: 'PRS' } };
    if (p === '/me/mailFolders/deleteditems') return { json: { id: 'deleted' } };
    if (p === '/me/mailFolders/junkemail') return { json: { id: 'junk' } };
    if (p === '/me/messages') {
      state.listCalls++;
      if (url.searchParams.get('page') !== '2') state.filters.push(url.searchParams.get('$filter') || '');
      state.prefers.push(req.headers.prefer || '');
      const all = [...mail.values()].map(m => ({ id: m.id, parentFolderId: m.parentFolderId, hasAttachments: m.hasAttachments }));
      if (url.searchParams.get('page') === '2') return { json: { value: all.slice(1) } };
      return { json: { value: all.slice(0, 1), '@odata.nextLink': state.foreignNextLink ? 'https://evil.example/v1.0/me/messages?page=2' : `${base}/v1.0/me/messages?page=2` } };
    }
    let m = /^\/me\/messages\/([^/]+)$/.exec(p);
    if (m) return mail.has(m[1]) ? { json: mail.get(m[1]) } : { status: 404, json: { error: { code: 'ErrorItemNotFound', message: 'Not found.' } } };
    m = /^\/me\/messages\/([^/]+)\/attachments$/.exec(p);
    if (m) return { json: { value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'detour.txt', size: 50, contentBytes: Buffer.from('Detour route: use Birch Street while Cedar Avenue is closed.').toString('base64') }] } };
    if (p === '/me/drive/root/delta') {
      if (url.searchParams.get('token') === 'later') { const v = drive.changes; drive.changes = []; return { json: { value: v, '@odata.deltaLink': `${base}/v1.0/me/drive/root/delta?token=later` } }; }
      return { json: { value: [...drive.items.values()].map(({ content, ...it }) => it), '@odata.deltaLink': `${base}/v1.0/me/drive/root/delta?token=later` } };
    }
    m = /^\/me\/drive\/items\/([^/]+)\/content$/.exec(p);
    if (m) return { status: 302, headers: { location: `${base}/dl/${m[1]}` }, body: '' };
    // SharePoint: one site, its default document library, and that library's delta feed.
    if (p === '/sites/contoso.sharepoint.com:/sites/Records') return { json: { id: 'site-1', displayName: 'Records', webUrl: 'https://contoso.sharepoint.com/sites/Records' } };
    if (p === '/sites/site-1/drive') return { json: { id: 'lib-1', name: 'Documents' } };
    if (p === '/drives/lib-1/root/delta') return { json: { value: [{ id: 'sp1', name: 'Council minutes.txt', file: {}, size: 40, webUrl: 'https://contoso.sharepoint.com/sites/Records/sp1', lastModifiedDateTime: '2026-08-01T09:00:00Z' }], '@odata.deltaLink': `${base}/v1.0/drives/lib-1/root/delta?token=later` } };
    if (p === '/drives/lib-1/items/sp1/content') return { status: 302, headers: { location: `${base}/dl-sp/sp1` }, body: '' };
    return { status: 404, json: { error: { code: 'itemNotFound', message: 'Not found.' } } };
  });
  base = server.url;
  return { ...server, state, mail, drive };
}

async function connect(c, g, kind, code = 'good-code') {
  const r = await c.post('/api/connectors/microsoft/authorize', { kind });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const auth = new URL(r.data.data.url);
  g.state.challenge = auth.searchParams.get('code_challenge');
  return { auth, res: await c.get(`/oauth/microsoft/callback?code=${code}&state=${auth.searchParams.get('state')}`) };
}

test('Microsoft: Outlook mail and OneDrive connect with PKCE, sync, replace the placeholders, and disconnect', async (t) => {
  const g = await microsoftFake();
  const env = await startApp({ MICROSOFT_CLIENT_ID: 'ms-cid', MICROSOFT_CLIENT_SECRET: 'ms-secret', MICROSOFT_AUTH_BASE: g.url, MICROSOFT_GRAPH_BASE: `${g.url}/v1.0`,
    PUBLIC_URL: 'http://localhost:9999', MICROSOFT_THROTTLE_MAX_WAIT_MS: '10' });
  t.after(async () => { await env.close(); await g.close(); });
  const c = env.client(); await c.setup();
  let cat = (await c.get('/api/connectors')).data.data;
  assert.equal(cat.find(x => x.type === 'outlook').status, 'available');
  assert.equal(cat.find(x => x.type === 'onedrive').status, 'available');
  assert(!cat.some(x => x.type === 'stub' && x.key === 'exchange'), 'no duplicate placeholder card while Outlook is ready to connect');
  const gaps = async () => (await c.get('/api/settings/workflow')).data.data.pack.knownGaps.join(' ');
  assert.match(await gaps(), /Exchange mail/, 'until it is connected, Exchange mail is a known gap (NOT searched)');

  // Sign-in URL: tenant "common", least-privilege scopes, PKCE S256.
  const { auth, res } = await connect(c, g, 'outlook');
  assert.equal(auth.pathname, '/common/oauth2/v2.0/authorize');
  assert.equal(auth.searchParams.get('scope'), 'offline_access User.Read Mail.Read');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:9999/oauth/microsoft/callback');
  const mailId = new URL(res.headers.get('location'), 'http://x').searchParams.get('connected');
  assert(mailId, res.headers.get('location'));
  assert(!fs.readFileSync(env.config.dbPath).includes(Buffer.from('ms-access-1')), 'no plaintext token in the database file');

  let src = await waitForSync(c, mailId);
  assert.equal(src.status, 'connected', src.lastError);
  assert.equal(src.type, 'outlook');
  assert.equal(src.accountLabel, 'prs.kh@outlook.com');
  assert.equal(src.recordCount, 3, 'two messages and one attachment; junk skipped');
  let job = (await c.get(`/api/sources/${mailId}/jobs`)).data.data[0];
  assert.equal(job.listed, 2); assert.equal(job.fetched, 2);
  assert.match(g.state.filters[0], /^receivedDateTime ge \d{4}-/, 'mail is limited to the configured window');
  assert(g.state.prefers.every(p => /ImmutableId/.test(p)), 'immutable IDs are requested');

  // Exchange mail is no longer reported as NOT searched once Outlook is connected.
  cat = (await c.get('/api/connectors')).data.data;
  assert(!cat.some(x => x.type === 'stub' && x.key === 'exchange'));
  const sr = await searchReq(c, 'Cedar Avenue lane closure', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  const hit = sr.results.find(x => x.record.title === 'Cedar Avenue lane closure schedule');
  assert(hit, JSON.stringify(sr.results.map(x => x.record.title)));
  assert.equal(hit.record.sourceType, 'outlook');
  assert.equal(hit.record.sender, 'Pat Engineer <pat@city.gov>');
  assert(!sr.results.some(x => x.record.title === 'You won a prize'), 'junk mail is not indexed');
  const report = (await c.get(`/api/requests/${sr.id}/report`)).data.data;
  // (The custodian checklist still names Exchange mail as a system departments use; that is not a coverage claim.)
  const notSearched = JSON.stringify([report.coverage, report.log, report.knownGaps]);
  assert(!notSearched.includes('Exchange mail'), 'the report no longer lists Exchange mail as not searched');
  assert(notSearched.includes('SharePoint'), 'SharePoint is still listed as not connected');

  // Throttling (429 + Retry-After) waits and retries; a message moved to Junk is removed; known messages are not fetched again.
  g.mail.set('m2', { ...g.mail.get('m2'), parentFolderId: 'junk' });
  g.state.throttleNext = 2;
  const before = g.calls.filter(x => /\/me\/messages\/m1$/.test(x.path)).length;
  await c.post(`/api/sources/${mailId}/sync`);
  src = await waitForSync(c, mailId);
  job = (await c.get(`/api/sources/${mailId}/jobs`)).data.data[0];
  assert.equal(job.status, 'succeeded', job.error);
  assert.equal(job.rateLimitWaits, 2);
  assert.equal(job.deleted, 1);
  assert.equal(g.calls.filter(x => /\/me\/messages\/m1$/.test(x.path)).length, before, 'indexed messages are not fetched again');
  assert.equal(src.recordCount, 2);

  // Expired access token: refreshed, and the rotated refresh token is kept.
  const v = env.app.services.vault;
  const sealed = () => v.open(env.app.db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', mailId).ciphertext);
  env.app.db.run('UPDATE source_credentials SET ciphertext = ? WHERE source_id = ?', v.seal({ ...sealed(), expiresAt: 0 }), mailId);
  await c.post(`/api/sources/${mailId}/sync`); await waitForSync(c, mailId);
  assert.equal(g.state.refreshCount, 1);
  assert.equal(sealed().refreshToken, 'rt-2');

  // A next-page link to another host is refused instead of sending the token there.
  g.state.foreignNextLink = true;
  await c.post(`/api/sources/${mailId}/sync`);
  src = await waitForSync(c, mailId);
  job = (await c.get(`/api/sources/${mailId}/jobs`)).data.data[0];
  assert.equal(job.status, 'failed'); assert.equal(job.errorCode, 'microsoft_bad_link');
  assert(!g.calls.some(x => x.url.host === 'evil.example'));
  g.state.foreignNextLink = false;

  // Revoked refresh token: the source says to reconnect, with Microsoft's reason in Sync History.
  env.app.db.run('UPDATE source_credentials SET ciphertext = ? WHERE source_id = ?', v.seal({ ...sealed(), refreshToken: 'gone', expiresAt: 0 }), mailId);
  await c.post(`/api/sources/${mailId}/sync`);
  src = await waitForSync(c, mailId);
  assert.equal(src.status, 'needs_attention');
  job = (await c.get(`/api/sources/${mailId}/jobs`)).data.data[0];
  assert.equal(job.errorReason, 'invalid_grant'); assert.match(job.providerMessage, /AADSTS70008/);

  // OneDrive: delta listing, download through the redirect without the token, unsupported files skipped, deletions applied.
  const drive = await connect(c, g, 'onedrive');
  assert.equal(drive.auth.searchParams.get('scope'), 'offline_access User.Read Files.Read');
  const driveId = new URL(drive.res.headers.get('location'), 'http://x').searchParams.get('connected');
  src = await waitForSync(c, driveId);
  assert.equal(src.status, 'connected', src.lastError);
  assert.equal(src.recordCount, 1);
  const dl = g.calls.find(x => x.path === '/dl/f1');
  assert(dl && !dl.headers.authorization, 'the pre-signed download URL is fetched without the token');
  g.drive.changes.push({ id: 'f1', deleted: { state: 'deleted' } });
  await c.post(`/api/sources/${driveId}/sync`);
  src = await waitForSync(c, driveId);
  assert.equal(src.recordCount, 0, 'a file deleted in OneDrive is removed here');
  assert.equal(g.calls.filter(x => x.path === '/v1.0/me/drive/root/delta').at(-1).url.searchParams.get('token'), 'later', 'the second sync uses the delta link');

  // Declined consent and a missing Mail.Read grant connect nothing.
  let r = await c.post('/api/connectors/microsoft/authorize', { kind: 'outlook' });
  const st = new URL(r.data.data.url).searchParams.get('state');
  r = await c.get(`/oauth/microsoft/callback?error=access_denied&error_description=user+declined&state=${st}`);
  assert.match(errOf(r), /not granted/);
  r = (await connect(c, g, 'outlook', 'no-mail')).res;
  assert.match(errOf(r), /Read access to Outlook mail was not granted/);

  // Disconnect deletes credentials and every record; Exchange mail goes back to "not connected".
  r = await c.del(`/api/sources/${mailId}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM records WHERE source_id = ?', mailId).n, 0);
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM source_credentials WHERE source_id = ?', mailId).n, 0);
  assert.match(await gaps(), /Exchange mail/, 'after disconnecting, Exchange mail is a known gap again');
  assert(!JSON.stringify((await c.get('/api/audit?pageSize=200')).data).includes('ms-access'), 'no tokens in the audit log');
});

test('SharePoint: a site address is resolved to its document library, synced through its delta feed, and replaces the placeholder', async (t) => {
  const g = await microsoftFake();
  const env = await startApp({ MICROSOFT_CLIENT_ID: 'ms-cid', MICROSOFT_CLIENT_SECRET: 'ms-secret', MICROSOFT_AUTH_BASE: g.url, MICROSOFT_GRAPH_BASE: `${g.url}/v1.0`, PUBLIC_URL: 'http://localhost:9999' });
  t.after(async () => { await env.close(); await g.close(); });
  const c = env.client(); await c.setup();
  assert.equal((await c.post('/api/connectors/microsoft/authorize', { kind: 'sharepoint', siteUrl: 'https://evil.example/sites/x' })).status, 400, 'only SharePoint Online addresses are accepted');
  assert.equal((await c.post('/api/connectors/microsoft/authorize', { kind: 'sharepoint', siteUrl: 'http://contoso.sharepoint.com/sites/x' })).status, 400, 'https only');
  const r = await c.post('/api/connectors/microsoft/authorize', { kind: 'sharepoint', siteUrl: 'https://contoso.sharepoint.com/sites/Records/' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const auth = new URL(r.data.data.url);
  assert.equal(auth.searchParams.get('scope'), 'offline_access User.Read Sites.Read.All');
  g.state.challenge = auth.searchParams.get('code_challenge');
  const cb = await c.get(`/oauth/microsoft/callback?code=good-code&state=${auth.searchParams.get('state')}`);
  const id = new URL(cb.headers.get('location'), 'http://x').searchParams.get('connected');
  assert(id, cb.headers.get('location'));
  const src = await waitForSync(c, id);
  assert.equal(src.status, 'connected', src.lastError);
  assert.equal(src.type, 'sharepoint');
  assert.equal(src.name, 'SharePoint: Records');
  assert.equal(src.accountLabel, 'https://contoso.sharepoint.com/sites/Records');
  assert.equal(src.recordCount, 1);
  assert(!g.calls.find(x => x.path === '/dl-sp/sp1').headers.authorization, 'the pre-signed download is fetched without the token');
  assert(!(await c.get('/api/connectors')).data.data.some(x => x.type === 'stub' && x.key === 'sharepoint'), 'the SharePoint placeholder is gone');
});

test('Microsoft not configured: the connector says what is missing, and the demo server never offers it', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  const o = (await c.get('/api/connectors')).data.data.find(x => x.type === 'outlook');
  assert.equal(o.status, 'needs_configuration'); assert.match(o.reason, /MICROSOFT_CLIENT_ID/);
  assert.equal((await c.post('/api/connectors/microsoft/authorize', { kind: 'outlook' })).status, 503);
  const demo = await startApp({ REAL_SOURCES: 'false', MICROSOFT_CLIENT_ID: 'x', MICROSOFT_CLIENT_SECRET: 'y' });
  t.after(() => demo.close());
  const d = demo.client(); const dr = await d.post('/api/auth/demo', { role: 'admin' }); d.csrf = dr.data.data.csrfToken;
  assert(!(await d.get('/api/connectors')).data.data.some(x => x.type === 'outlook'));
  assert.equal((await d.post('/api/connectors/microsoft/authorize', { kind: 'outlook' })).status, 403);
});

test('classifyGraphError and graphEndpoint', () => {
  assert.equal(classifyGraphError(429, { error: { code: 'TooManyRequests', message: 'x' } }, 'me.messages.list', 3000).retryable, true);
  assert.equal(classifyGraphError(401, { error: { code: 'InvalidAuthenticationToken' } }, 'me.get').error.code, 'reconnect_required');
  assert.equal(classifyGraphError(404, { error: { code: 'MailboxNotEnabledForRESTAPI', message: 'REST API is not yet supported for this mailbox.' } }, 'me.messages.list').kind, 'no_mailbox');
  assert.equal(classifyGraphError(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 'me.messages.list').kind, 'access_denied');
  assert.equal(graphEndpoint('https://graph.microsoft.com/v1.0/me/messages?$top=100'), 'me.messages.list');
  assert.equal(graphEndpoint('/me/messages/AAMkAGI2THVSAAA='), 'me.messages.get');
  assert.equal(graphEndpoint('/me/messages/AAMkAGI2THVSAAA=/attachments'), 'me.messages.attachments.list');
  assert.equal(graphEndpoint('/me/drive/root/delta?token=x'), 'me.drive.root.delta');
});

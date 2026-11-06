import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';
import { conversationKey } from '../server/routes/phone.mjs';

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const sms = (id, date, body, extra = {}) => ({ id, date: Date.parse(date), body, address: '+91 98765 43210', contact: 'Ravi Kumar', sent: false, ...extra });

async function paired(env, c, name = 'Pixel test') {
  const r = await c.post('/api/phone-pairings', { name, acknowledged: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const phone = env.client();
  const p = await phone.post('/api/phone/pair', { code: r.data.data.code, device: { model: 'Pixel 8', androidVersion: '15', appVersion: '1.0.0' } });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  return { phone, pairing: r.data.data, ...p.data.data };
}

test('conversation keys ignore phone number formatting', () => {
  assert.equal(conversationKey('+91 98765-43210'), conversationKey('+919876543210'));
  assert.equal(conversationKey('VK-HDFCBK'), 'vk-hdfcbk');
  assert.equal(conversationKey(''), 'unknown');
});

test('Android phone: pairing with a one-time code', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  await c.setup();
  const anon = env.client();

  assert.equal((await anon.post('/api/phone-pairings', { acknowledged: true })).status, 401, 'only signed-in people make codes');
  assert.equal((await c.post('/api/phone-pairings', {})).status, 400, 'confirmation required');
  let r = await c.post('/api/phone-pairings', { name: 'Work phone', acknowledged: true });
  assert.equal(r.status, 201);
  const { id, code, pairUri, server } = r.data.data;
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(pairUri, `prsphone://pair?s=${encodeURIComponent(server)}&c=${code.replace('-', '')}`);
  assert.ok(!JSON.stringify(env.app.db.all('SELECT * FROM phone_pairings')).includes(code.replace('-', '')), 'only a hash of the code is stored');
  assert.equal((await c.get(`/api/phone-pairings/${id}`)).data.data.status, 'pending');

  assert.equal((await anon.post('/api/phone/pair', { code: 'ZZZZ-ZZZZ' })).status, 404);
  r = await anon.post('/api/phone/pair', { code: code.toLowerCase().replace('-', ' '), device: { model: 'Pixel 8', androidVersion: '15', appVersion: '1.0.0' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const { token, sourceId, deviceName } = r.data.data;
  assert.match(token, /^prs_phone_/);
  assert.equal(deviceName, 'Work phone');
  assert.ok(!JSON.stringify(env.app.db.all('SELECT * FROM agent_tokens')).includes(token), 'only a hash of the key is stored');
  assert.equal((await anon.post('/api/phone/pair', { code })).status, 404, 'a code works once');
  r = await c.get(`/api/phone-pairings/${id}`);
  assert.equal(r.data.data.status, 'claimed');
  assert.equal(r.data.data.device.name, 'Work phone');

  // The phone key only works on phone endpoints, and PC helper keys do not work here.
  assert.equal((await anon.get('/api/phone/status', bearer(token))).status, 200);
  assert.equal((await anon.get('/api/sources', bearer(token))).status, 401);
  assert.equal((await anon.get('/api/agent/whoami', bearer(token))).status, 401);
  const pc = await c.post('/api/agent-tokens', { name: 'PC', acknowledged: true });
  assert.equal((await anon.get('/api/phone/status', bearer(pc.data.data.token))).status, 401);
  assert.equal((await c.get('/api/agent-tokens')).data.data.length, 1, 'phones are not listed as PC helper keys');

  // The new source shows in Connected Sources and the catalog says it is connected.
  const src = (await c.get('/api/sources')).data.data.find(x => x.id === sourceId);
  assert.equal(src.provider, 'android-app');
  assert.equal(src.type, 'messages');
  const card = (await c.get('/api/connectors')).data.data.find(x => x.type === 'android');
  assert.equal(card.lifecycle, 'connected');

  // Expired codes are refused.
  r = await c.post('/api/phone-pairings', { acknowledged: true });
  env.app.db.run("UPDATE phone_pairings SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", r.data.data.id);
  assert.equal((await anon.post('/api/phone/pair', { code: r.data.data.code })).status, 404);
  assert.equal((await c.get(`/api/phone-pairings/${r.data.data.id}`)).data.data.status, 'expired');

  // Wrong codes are throttled per address.
  let last;
  for (let i = 0; i < 11; i++) last = await anon.post('/api/phone/pair', { code: 'ZZZZ-ZZZ' + 'ABCDEFGHJKM'[i] });
  assert.equal(last.status, 429);

  const actions = (await c.get('/api/audit?pageSize=100')).data.data.map(e => e.action);
  for (const a of ['phone.pairing_started', 'phone.paired']) assert.ok(actions.includes(a), a);
});

test('Android phone: incremental sync, duplicates, records and dashboard', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  await c.setup();
  const { phone, token, sourceId } = await paired(env, c);
  const h = bearer(token);

  // Initial history: two texts on one day in one conversation, one on another day, one sent by the owner.
  let r = await phone.req('POST', '/api/phone/messages', { messages: [
    sms(101, '2026-10-20T03:30:00Z', 'Cedar Avenue closure starts Monday'),
    sms(102, '2026-10-20T03:40:00Z', 'Thanks, noted', { sent: true, address: '+919876543210' }),
    sms(103, '2026-10-21T09:00:00Z', 'Budget meeting moved', { address: '+15550002222', contact: '' })
  ], status: { permission: 'granted', pending: 0, appVersion: '1.0.0' } }, h);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.data.inserted, 3);
  assert.equal(r.data.data.added, 2, 'one record per conversation per day; number formats are merged');
  assert.deepEqual(r.data.data.cursor, { lastId: 103, lastDate: Date.parse('2026-10-21T09:00:00Z') });

  let recs = (await c.get(`/api/sources/${sourceId}/records`)).data.data;
  assert.equal(recs.length, 2);
  const ravi = recs.find(x => /Ravi/.test(x.title));
  let rec = (await c.get(`/api/records/${ravi.id}`)).data.data;
  assert.match(rec.content, /\[03:30\] Ravi Kumar \(\+91 98765 43210\): Cedar Avenue closure starts Monday/);
  assert.match(rec.content, /\[03:40\] Ada Admin: Thanks, noted/);

  // Re-sending is harmless: the same ids, or the same texts under new ids (for example after a reinstall).
  r = await phone.req('POST', '/api/phone/messages', { messages: [sms(101, '2026-10-20T03:30:00Z', 'Cedar Avenue closure starts Monday'), sms(9001, '2026-10-20T03:30:00Z', 'Cedar Avenue closure starts Monday')] }, h);
  assert.equal(r.data.data.inserted, 0);
  assert.equal(r.data.data.duplicates, 2);

  // A new text on an existing day is merged into that day, not replacing it.
  r = await phone.req('POST', '/api/phone/messages', { messages: [sms(104, '2026-10-20T05:00:00Z', 'Permit P-77 approved')] }, h);
  assert.equal(r.data.data.updated, 1);
  rec = (await c.get(`/api/records/${ravi.id}`)).data.data;
  assert.match(rec.content, /Cedar Avenue[\s\S]*Thanks, noted[\s\S]*Permit P-77 approved/);

  // Empty and malformed texts are skipped, not stored.
  r = await phone.req('POST', '/api/phone/messages', { messages: [sms(105, '2026-10-22T05:00:00Z', '   ')] }, h);
  assert.equal(r.data.data.skipped, 1);
  assert.equal((await phone.req('POST', '/api/phone/messages', { messages: [{ id: 'x', date: 1, body: 'a' }] }, h)).status, 400);

  // The phone can resume from the server's cursor.
  r = await phone.get('/api/phone/status', h);
  assert.equal(r.data.data.cursor.lastId, 104);
  assert.equal(r.data.data.messages, 4);

  // Status reports and the website dashboard.
  await phone.req('POST', '/api/phone/heartbeat', { status: { permission: 'denied', lastError: 'SMS permission was turned off' } }, h);
  let dev = (await c.get('/api/phone-devices')).data.data[0];
  assert.equal(dev.connection, 'connected');
  assert.equal(dev.sync, 'needs_permission');
  assert.equal(dev.lastError, 'SMS permission was turned off');
  assert.equal(dev.messages, 4);
  assert.equal(dev.records, 2);
  assert.equal(dev.device.model, 'Pixel 8');
  assert.ok(dev.lastSyncAt);
  await phone.req('POST', '/api/phone/heartbeat', { status: { permission: 'granted', pending: 120, lastError: '' } }, h);
  dev = (await c.get('/api/phone-devices')).data.data[0];
  assert.equal(dev.sync, 'syncing');
  await phone.req('POST', '/api/phone/heartbeat', { status: { pending: 0 } }, h);
  assert.equal((await c.get('/api/phone-devices')).data.data[0].sync, 'up_to_date');

  // Searchable like any other source, and uploads into it are refused.
  r = await c.upload('chat.txt', Buffer.from('x'), `?kind=messages&sourceId=${sourceId}`);
  assert.equal(r.status, 400);

  // Message content never reaches the audit log.
  const audit = JSON.stringify((await c.get('/api/audit?pageSize=100')).data.data);
  assert.ok(audit.includes('phone.texts_received'));
  assert.ok(!/Cedar|Permit P-77|Budget meeting/.test(audit), 'no message text in the audit log');
});

test('Android phone: disconnect, revoke and delete synced data', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  await c.setup();

  // Revoke only: the phone stops, the texts stay.
  const a = await paired(env, c, 'Phone A');
  await a.phone.req('POST', '/api/phone/messages', { messages: [sms(1, '2026-10-20T03:30:00Z', 'Keep me')] }, bearer(a.token));
  const devA = (await c.get('/api/phone-devices')).data.data.find(d => d.name === 'Phone A');
  let r = await c.del(`/api/phone-devices/${devA.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.data.dataDeleted, false);
  assert.equal((await a.phone.get('/api/phone/status', bearer(a.token))).status, 401);
  assert.equal((await c.get(`/api/sources/${a.sourceId}/records`)).data.data.length, 1);
  assert.equal((await c.get('/api/phone-devices')).data.data.find(d => d.name === 'Phone A').connection, 'revoked');

  // Revoke and delete: the source, records and stored texts are gone.
  const b = await paired(env, c, 'Phone B');
  await b.phone.req('POST', '/api/phone/messages', { messages: [sms(1, '2026-10-20T03:30:00Z', 'Delete me')] }, bearer(b.token));
  const devB = (await c.get('/api/phone-devices')).data.data.find(d => d.name === 'Phone B');
  r = await c.del(`/api/phone-devices/${devB.id}?deleteData=true`);
  assert.equal(r.data.data.dataDeleted, true);
  assert.equal(r.data.data.recordsDeleted, 1);
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM phone_messages WHERE source_id = ?', b.sourceId).n, 0);
  assert.ok(!(await c.get('/api/sources')).data.data.some(s => s.id === b.sourceId));

  // The phone can disconnect itself and delete what it sent.
  const p = await paired(env, c, 'Phone C');
  await p.phone.req('POST', '/api/phone/messages', { messages: [sms(1, '2026-10-20T03:30:00Z', 'Bye')] }, bearer(p.token));
  r = await p.phone.req('POST', '/api/phone/disconnect', { deleteData: true }, bearer(p.token));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.data.dataDeleted, true);
  assert.equal((await p.phone.get('/api/phone/status', bearer(p.token))).status, 401);

  // Removing the source from Connected Sources also cuts off the phone.
  const d = await paired(env, c, 'Phone D');
  assert.equal((await c.del(`/api/sources/${d.sourceId}`)).status, 200);
  assert.equal((await d.phone.get('/api/phone/status', bearer(d.token))).status, 401);
});

test('Android phone: refused when real sources are off', async (t) => {
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const anon = env.client();
  assert.equal((await anon.post('/api/phone/pair', { code: 'ABCD-2345' })).status, 403);
});

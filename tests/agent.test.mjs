import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { searchReq, startApp } from './helpers.mjs';

const run = promisify(execFile);
const filetime = (iso) => (BigInt(Date.parse(iso)) + 11644473600000n) * 10000n;

test('PC sync helper: keys, sending texts to a hosted server, revocation', async (t) => {
  const env = await startApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-'));
  t.after(async () => { await env.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const c = env.client();
  await c.setup();

  let r = await c.post('/api/agent-tokens', { name: 'Office PC' });
  assert.equal(r.status, 400, 'confirmation required');
  r = await c.post('/api/agent-tokens', { name: 'Office PC', acknowledged: true });
  assert.equal(r.status, 201);
  const { token, sourceId, id } = r.data.data;
  assert.match(token, /^prs_agent_/);
  assert.ok(!JSON.stringify(env.app.db.all('SELECT * FROM agent_tokens')).includes(token), 'only a hash is stored');

  const anon = env.client();
  r = await anon.get('/api/agent/whoami');
  assert.equal(r.status, 401);
  r = await anon.req('GET', '/api/agent/whoami', undefined, { authorization: `Bearer ${token}` });
  assert.equal(r.status, 200); assert.equal(r.data.data.userName, 'Ada Admin');
  // The key cannot be used for anything else.
  r = await anon.req('GET', '/api/sources', undefined, { authorization: `Bearer ${token}` });
  assert.equal(r.status, 401);

  // Run the real helper program once against a stand-in Phone Link file.
  const phone = path.join(dir, 'phone.db');
  const db = new DatabaseSync(phone);
  db.exec(`CREATE TABLE contact (contact_id INTEGER PRIMARY KEY, display_name TEXT); CREATE TABLE address (address_id INTEGER PRIMARY KEY, contact_id INT, address TEXT);
    CREATE TABLE message (message_id INTEGER PRIMARY KEY, thread_id INT, from_address TEXT, recipient_list TEXT, body TEXT, timestamp INT, type INT);
    INSERT INTO contact VALUES (1, 'Ravi Kumar'); INSERT INTO address VALUES (1, 1, '+919876543210');`);
  const add = db.prepare('INSERT INTO message (thread_id, from_address, recipient_list, body, timestamp, type) VALUES (?, ?, ?, ?, ?, ?)');
  add.run(7, '+919876543210', '', 'Cedar Avenue closure starts Monday', filetime('2026-10-20T03:30:00Z'), 1);
  add.run(7, '', '+919876543210', 'Thanks, noted', filetime('2026-10-20T03:40:00Z'), 2);
  fs.writeFileSync(path.join(dir, 'phonelink-sync.json'), JSON.stringify({ url: env.base, key: token, intervalMinutes: 3 }));
  const helper = (extra = []) => run(process.execPath, ['agent/phonelink-sync.mjs', '--once', ...extra], { env: { ...process.env, PHONELINK_DB_PATH: phone, PHONELINK_SYNC_DIR: dir } });

  let out = await helper();
  assert.match(out.stdout, /Sent 2 texts: 1 new/);
  let recs = await c.get(`/api/sources/${sourceId}/records`);
  assert.equal(recs.data.data.length, 1);
  const rec = await c.get(`/api/records/${recs.data.data[0].id}`);
  assert.match(rec.data.data.content, /Ravi Kumar \(\+919876543210\): Cedar Avenue closure/);
  assert.match(rec.data.data.content, /Ada Admin: Thanks, noted/);

  out = await helper();
  assert.match(out.stdout, /No new texts/, 'nothing is resent');

  add.run(7, '+919876543210', '', 'Permit P-77 approved', filetime('2026-10-20T05:00:00Z'), 1);
  add.run(9, '+15550001111', '', 'Water main inspection Friday', filetime('2026-10-29T10:00:00Z'), 1);
  db.close();
  out = await helper();
  assert.match(out.stdout, /1 new and 1 updated/, out.stdout);
  recs = await c.get(`/api/sources/${sourceId}/records`);
  assert.equal(recs.data.data.length, 2);

  // Searchable like any other source.
  await c.put('/api/settings/switches', { phoneLink: true });
  const s = await searchReq(c, 'permit P-77', { edits: { keywords: ['permit'], phrases: [], alternateTerms: [] }, sourceIds: [sourceId] });
  assert.equal(s.runStatus, 200, JSON.stringify(s.runError || s.confirm?.data));
  assert.equal(s.meta.coverage.searched[0].status, 'partial', 'phone texts are a partial source: only items the employee sends');
  assert(s.created.choices.sources.some(x => x.id === sourceId && x.experimental), 'the helper source is offered when the switch is on');

  // Uploading exports into the helper's source is refused.
  r = await c.upload('chat.txt', Buffer.from('x'), `?kind=messages&sourceId=${sourceId}`);
  assert.equal(r.status, 400);

  // Revoke: the helper is refused and stops.
  assert.equal((await c.del(`/api/agent-tokens/${id}`)).status, 200);
  await assert.rejects(helper(), (err) => /key is not valid/.test(err.stderr));
  const list = await c.get('/api/agent-tokens');
  assert.ok(list.data.data[0].revokedAt);
  const actions = (await c.get('/api/audit?pageSize=100')).data.data.map(e => e.action);
  for (const a of ['agent.key_created', 'agent.texts_received', 'agent.key_revoked']) assert.ok(actions.includes(a), a);
});

test('PC sync helper refuses plain http to a remote site', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-'));
  fs.writeFileSync(path.join(dir, 'phonelink-sync.json'), JSON.stringify({ url: 'http://example.com', key: 'prs_agent_' + 'a'.repeat(43), intervalMinutes: 3 }));
  await assert.rejects(run(process.execPath, ['agent/phonelink-sync.mjs', '--once'], { env: { ...process.env, PHONELINK_SYNC_DIR: dir } }), (err) => /Refusing to send texts over plain http/.test(err.stderr));
  fs.rmSync(dir, { recursive: true, force: true });
});

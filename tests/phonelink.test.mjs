import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp, waitForSync } from './helpers.mjs';
import { detectSchema, toIsoTime } from '../server/connectors/phonelink.mjs';

const filetime = (iso) => (BigInt(Date.parse(iso)) + 11644473600000n) * 10000n;

function makePhoneDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE contact (contact_id INTEGER PRIMARY KEY, display_name TEXT);
    CREATE TABLE address (address_id INTEGER PRIMARY KEY, contact_id INTEGER, address TEXT);
    CREATE TABLE message (message_id INTEGER PRIMARY KEY, thread_id INTEGER, from_address TEXT, recipient_list TEXT, body TEXT, timestamp INTEGER, type INTEGER, status INTEGER);
    CREATE TABLE mms_part (id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO contact VALUES (1, 'Ravi Kumar');
    INSERT INTO address VALUES (1, 1, '+91 98765 43210');`);
  const add = db.prepare('INSERT INTO message (thread_id, from_address, recipient_list, body, timestamp, type, status) VALUES (?, ?, ?, ?, ?, ?, 0)');
  add.run(7, '+919876543210', '', 'Cedar Avenue closure starts Monday, crews arrive 7am', filetime('2026-10-20T03:30:00Z'), 1);
  add.run(7, '', '+919876543210', 'Thanks, I will notify the residents', filetime('2026-10-20T03:45:00Z'), 2);
  return { db, add };
}

test('Phone Link: detects schema, syncs texts without exports, refreshes before search', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phonelink-'));
  const file = path.join(dir, 'phone.db');
  const phone = makePhoneDb(file);
  const env = await startApp({ PHONELINK_DB_PATH: file, PHONELINK_SYNC_MINUTES: '0' });
  t.after(async () => { phone.db.close(); await env.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const c = env.client();
  await c.setup();

  assert.equal(toIsoTime(filetime('2026-10-20T03:30:00Z')), '2026-10-20T03:30:00.000Z');
  assert.equal(toIsoTime(1760931000000), new Date(1760931000000).toISOString());

  const cat = await c.get('/api/connectors');
  assert.equal(cat.data.data.find(x => x.type === 'phonelink').status, 'available');

  let r = await c.get('/api/connectors/phonelink/check');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.data.recognized, true);
  assert.equal(r.data.data.table, 'message');
  assert.equal(r.data.data.messages, 2);
  assert.equal(r.data.data.conversations, 1);
  assert.equal(r.data.data.contactNames, true);
  assert.ok(!JSON.stringify(r.data).includes('Cedar'), 'the check never returns message text');
  assert.equal(fs.readdirSync(path.join(env.dir, 'tmp')).length, 0, 'the temporary copy is deleted');

  r = await c.post('/api/connectors/phonelink/connect', {});
  assert.equal(r.status, 400, 'confirmation is required');
  r = await c.post('/api/connectors/phonelink/connect', { acknowledged: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const sourceId = r.data.data.sourceId;
  await waitForSync(c, sourceId);
  r = await c.post('/api/connectors/phonelink/connect', { acknowledged: true });
  assert.equal(r.status, 409, 'only one Phone Link source per person');

  const recs = await c.get(`/api/sources/${sourceId}/records`);
  assert.equal(recs.data.data.length, 1, 'one conversation-day');
  const rec = await c.get(`/api/records/${recs.data.data[0].id}`);
  const content = rec.data.data.content;
  assert.match(content, /Ravi Kumar \(\+919876543210\): Cedar Avenue closure/);
  assert.match(content, /Ada Admin: Thanks, I will notify/);
  assert.match(rec.data.data.title, /SMS: Ravi Kumar/);

  // Uploading exports into the Phone Link source is refused.
  r = await c.upload('chat.txt', Buffer.from('x'), `?kind=messages&sourceId=${sourceId}`);
  assert.equal(r.status, 400);

  // A new text arrives on the phone; the next search picks it up with no export and no manual sync.
  await new Promise(res => setTimeout(res, 20));
  phone.add.run(9, '+15550001111', '', 'Water main permit P-77 approved for Cedar Avenue', filetime('2026-10-29T10:00:00Z'), 1);
  const p = await c.post('/api/searches/plan', { requestText: 'water main permit', mode: 'real' });
  const run = await c.post(`/api/searches/${p.data.data.searchId}/run`, { plan: { ...p.data.data.plan, keywords: ['permit'], phrases: [], alternateTerms: [] }, confirmed: true });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const res = await c.get(`/api/searches/${p.data.data.searchId}/results?pageSize=50`);
  assert.ok(res.data.data.some(x => x.record.sourceId === sourceId && /P-77/.test(x.snippet + x.record.title)), JSON.stringify(res.data.data.map(x => x.snippet)));
});

test('Phone Link: unknown layouts are reported, not guessed', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE things (a TEXT); CREATE TABLE stuff (b TEXT)');
  const s = detectSchema(db);
  assert.equal(s.table, null);
  assert.deepEqual(s.tables.sort(), ['stuff', 'things']);
});

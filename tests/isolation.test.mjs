import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, searchReq } from './helpers.mjs';
import { hashPassword } from '../server/security.mjs';

// Meaning-only matching: "legal dispute talks" sits next to "settlement negotiation" without sharing a word.
const concepts = ['settlement negotiation legal dispute talks claim', 'notice detour lane closure', 'budget invoice payment'];
const embed = (text) => concepts.map(c => c.split(' ').reduce((n, w) => n + (text.toLowerCase().includes(w) ? 1 : 0), 0) + 0.01);
const SECRET = 'Confidential settlement negotiation notes for the Cedar Avenue claim. Offer: 40,000.';

test('isolation: User B never reaches User A’s private records through keyword, vector or hybrid search, expansion, preview, export or listings; nor does another organization', async (t) => {
  const env = await startApp({}, { embedder: { model: 'fake-1', provider: 'test', embed: async (texts) => texts.map(embed) } });
  t.after(() => env.close());
  const db = env.app.db;
  const admin = env.client(); await admin.setup();
  await admin.post('/api/users', { email: 'a@x.org', name: 'Ana A', role: 'records_officer', password: 'password for ana 1' });
  await admin.post('/api/users', { email: 'b@x.org', name: 'Ben B', role: 'records_officer', password: 'password for ben 1' });
  const A = env.client(); await A.login('a@x.org', 'password for ana 1');
  const B = env.client(); await B.login('b@x.org', 'password for ben 1');
  const aId = db.get("SELECT id FROM users WHERE email = 'a@x.org'").id;

  let r = await A.upload('settlement-notes.txt', Buffer.from(SECRET));
  const secretId = r.data.data.recordId, aSource = r.data.data.sourceId;
  r = await B.upload('public-notice.txt', Buffer.from('Public notice: Cedar Avenue lane closure and detour for the claim area.'));
  const bRecord = r.data.data.recordId;
  // Only A's record contains these (B's own request text does mention "settlement").
  const leaks = (x) => ['Confidential', '40,000', 'settlement-notes', 'negotiation', secretId].some(w => JSON.stringify(x).includes(w));

  // Keyword (BM25) on shared words, vector-only on meaning, and the hybrid list.
  const kw = await searchReq(B, 'Cedar Avenue claim settlement', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(kw.results.length >= 1, 'B still finds B’s own record');
  assert(!kw.results.some(x => x.record.id === secretId), 'keyword search');
  const vec = await searchReq(B, 'legal dispute talks', { edits: { keywords: ['legal dispute talks'], alternateTerms: [], phrases: [], recordTypes: [], dateFrom: null, dateTo: null } });
  assert(!vec.results.some(x => x.record.id === secretId), 'vector-only search');
  // Control: A's own identical search does find it by meaning, so the vector path really is exercised.
  const own = await searchReq(A, 'legal dispute talks', { edits: { keywords: ['legal dispute talks'], alternateTerms: [], phrases: [], recordTypes: [], dateFrom: null, dateTo: null } });
  assert(own.results.some(x => x.record.id === secretId && x.matchType === 'semantic'), JSON.stringify(own.results.map(x => [x.record.title, x.matchType])));

  // Everything else B can call about that request.
  assert(!leaks((await B.get(`/api/requests/${kw.id}/preview`)).data));
  await B.put(`/api/requests/${kw.id}/marks/${bRecord}`, { mark: 'relevant' });
  assert(!leaks((await B.get(`/api/requests/${kw.id}/expansion`)).data), 'suggested terms only come from records B may read');
  const csv = await B.get(`/api/requests/${kw.id}/export/candidates.csv`);
  assert.equal(csv.status, 200); assert(!leaks(csv.data), 'CSV export');
  assert(!leaks((await B.get(`/api/requests/${kw.id}/report`)).data), 'search record');
  assert.equal((await B.get(`/api/records/${secretId}`)).status, 404, 'direct record fetch');
  assert.equal((await B.get(`/api/records/${secretId}/original`)).status, 404, 'stored original');
  assert.equal((await B.put(`/api/requests/${kw.id}/marks/${secretId}`, { mark: 'relevant' })).status, 404, 'marking by guessed ID');
  const list = await B.get(`/api/sources/${aSource}/records`);
  assert(list.status === 404 || (list.data.data || []).length === 0, 'per-source listing');
  assert(!(await B.get('/api/sources')).data.data.some(x => x.id === aSource));

  // Record-level permissions (ABAC) hold even inside a shared source.
  await A.patch(`/api/sources/${aSource}`, { visibility: 'roles', allowedRoles: [] });
  db.run('UPDATE records SET access_permissions = ? WHERE id = ?', JSON.stringify({ users: [aId] }), secretId);
  const shared = await searchReq(B, 'Cedar Avenue claim settlement', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(!shared.results.some(x => x.record.id === secretId), 'a record limited to A stays hidden in a source shared with everyone');
  assert.equal((await B.get(`/api/records/${secretId}`)).status, 404);
  db.run("UPDATE records SET access_permissions = '{}' WHERE id = ?", secretId);
  const open = await searchReq(B, 'Cedar Avenue claim settlement', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(open.results.some(x => x.record.id === secretId), 'control: once shared, B does see it');

  // Another organization: same words, same meaning, nothing found, nothing openable.
  db.run("INSERT INTO tenants (id, name) VALUES ('t2', 'Other City')");
  db.run("INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES ('u2', 't2', 'z@other.org', 'Zed', 'admin', ?)", hashPassword('other tenant password'));
  const Z = env.client(); await Z.login('z@other.org', 'other tenant password');
  await Z.put('/api/consent', { scope: 'all', sourceIds: [], acknowledged: true });
  await Z.upload('z-notes.txt', Buffer.from('Other City note about a road.'));
  for (const q of ['Cedar Avenue claim settlement', 'legal dispute talks']) {
    const z = await searchReq(Z, q, { edits: { keywords: [q], recordTypes: [], dateFrom: null, dateTo: null } });
    assert(!(z.results || []).some(x => x.record.id === secretId), `other organization: ${q}`);
  }
  assert.equal((await Z.get(`/api/records/${secretId}`)).status, 404);
  assert.equal((await Z.get(`/api/requests/${kw.id}/results`)).status, 404);
  assert.equal((await Z.get(`/api/sources/${aSource}/records`)).status === 200 ? (await Z.get(`/api/sources/${aSource}/records`)).data.data.length : 0, 0);
});

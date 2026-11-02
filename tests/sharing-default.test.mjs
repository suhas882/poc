import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp, waitForSync, searchReq } from './helpers.mjs';
import { initialSharing } from '../server/connectors/registry.mjs';
import { createApp } from '../server/app.mjs';
import { hashPassword } from '../server/security.mjs';

const table = { name: 'permits', idColumn: 'id', titleColumn: 'title', contentColumns: ['description'] };
const plan = { edits: { recordTypes: [], dateFrom: null, dateTo: null } };

function permits(env) {
  const dir = path.join(env.dir, 'connectors'); fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'city.sqlite'));
  db.exec("CREATE TABLE permits (id INTEGER PRIMARY KEY, title TEXT, description TEXT); INSERT INTO permits VALUES (1, 'Permit P-9 Cedar Avenue', 'Private permit notes for the Cedar Avenue closure');");
  db.close();
}

test('initialSharing: Only me unless sharing is chosen explicitly', () => {
  assert.deepEqual(initialSharing({}), { visibility: 'owner', allowedRoles: [] });
  assert.deepEqual(initialSharing({ visibility: 'owner' }), { visibility: 'owner', allowedRoles: [] });
  assert.deepEqual(initialSharing({ visibility: 'org' }), { visibility: 'roles', allowedRoles: [] });
  assert.deepEqual(initialSharing({ visibility: 'roles', shareWithRoles: ['reviewer'] }), { visibility: 'roles', allowedRoles: ['reviewer'] });
  assert.deepEqual(initialSharing({ visibility: 'roles', shareWithRoles: [] }), { visibility: 'owner', allowedRoles: [] }, '"roles" with no roles picked stays private');
  assert.deepEqual(initialSharing({ shareWithRoles: ['auditor'] }), { visibility: 'roles', allowedRoles: ['auditor'] }, 'older clients that send only roles');
});

test('private by default: no other user reaches the source or its records through any API; explicit sharing opens search only', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  permits(env);
  const db = env.app.db;
  const admin = env.client(); await admin.setup();
  for (const [email, role] of [['ana@x.org', 'records_officer'], ['ben@x.org', 'records_officer'], ['rev@x.org', 'reviewer']]) await admin.post('/api/users', { email, name: email.split('@')[0], role, password: 'a long password 123' });
  const ana = env.client(); await ana.login('ana@x.org', 'a long password 123');
  const ben = env.client(); await ben.login('ben@x.org', 'a long password 123');
  const rev = env.client(); await rev.login('rev@x.org', 'a long password 123');

  // Ana connects without choosing anything: Only me.
  let r = await ana.post('/api/sources/database', { name: 'Ana permits', driver: 'sqlite', file: 'city.sqlite', tables: [table] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.data.sourceId;
  let src = await waitForSync(ana, id);
  assert.equal(src.visibility, 'owner');
  const rec = db.get('SELECT id FROM records WHERE source_id = ?', id).id;
  assert((await searchReq(ana, 'Cedar Avenue permit', plan)).results.some(x => x.record.id === rec), 'the owner finds their own records');

  // Ben, the Reviewer and even the Supervisor's searches cannot reach it.
  for (const [who, c] of [['Ben', ben], ['Reviewer', rev], ['Supervisor', admin]]) {
    const s = await searchReq(c, 'Cedar Avenue permit', plan);
    assert(!(s.created?.current.sourceIds || []).includes(id), `${who}: not offered to the plan`);
    assert(!(s.results || []).some(x => x.record.id === rec), `${who}: not in search results`);
    assert.equal((await c.get(`/api/records/${rec}`)).status, 404, `${who}: record fetch`);
    const list = await c.get(`/api/sources/${id}/records`);
    assert(list.status === 404 || list.data.data.length === 0, `${who}: per-source record list`);
  }
  // Other users cannot see, sync, check, preview, read the history of, reshare or remove it.
  assert(!(await ben.get('/api/sources')).data.data.some(x => x.id === id));
  for (const [method, url, body] of [['post', `/api/sources/${id}/sync`], ['post', `/api/sources/${id}/verify`], ['post', `/api/sources/${id}/preview`, { table: 'permits' }],
    ['patch', `/api/sources/${id}`, { visibility: 'roles', allowedRoles: [] }], ['del', `/api/sources/${id}`]]) {
    const res = await ben[method](url, body);
    assert([403, 404].includes(res.status), `${method} ${url}: ${res.status}`);
  }
  assert.equal((await ben.get(`/api/sources/${id}/jobs`)).status, 404);
  assert.equal((await rev.get(`/api/sources/${id}/jobs`)).status, 404);

  // Explicit sharing with the Reviewer role only: the Reviewer can search and open records; Ben (Clerk) still cannot.
  assert.equal((await ana.patch(`/api/sources/${id}`, { visibility: 'roles', allowedRoles: ['reviewer'] })).status, 200);
  assert((await searchReq(rev, 'Cedar Avenue permit', plan)).results.some(x => x.record.id === rec));
  assert.equal((await rev.get(`/api/records/${rec}`)).status, 200);
  assert(!((await searchReq(ben, 'Cedar Avenue permit', plan)).results || []).some(x => x.record.id === rec));
  // Sharing is for searching, never for managing: the Reviewer cannot sync or remove it.
  assert.equal((await rev.post(`/api/sources/${id}/sync`)).status, 403);
  assert.equal((await rev.del(`/api/sources/${id}`)).status, 403);

  // Back to Only me: the Reviewer's existing result lists lose it at once.
  const shared = await searchReq(rev, 'Cedar Avenue permit', plan);
  await ana.patch(`/api/sources/${id}`, { visibility: 'owner' });
  assert(!(await rev.get(`/api/requests/${shared.id}/results`)).data.data.some(x => x.record.id === rec));
  assert.equal((await rev.get(`/api/records/${rec}`)).status, 404);

  // Organization-wide sharing chosen at connect time.
  r = await ben.post('/api/sources/database', { name: 'Ben permits (shared)', driver: 'sqlite', file: 'city.sqlite', visibility: 'org', tables: [table] });
  const benId = r.data.data.sourceId;
  src = await waitForSync(ben, benId);
  assert.equal(src.visibility, 'roles'); assert.deepEqual(src.allowedRoles, []);
  const benRec = db.get('SELECT id FROM records WHERE source_id = ?', benId).id;
  assert((await searchReq(ana, 'Cedar Avenue permit', plan)).results.some(x => x.record.id === benRec), 'organization-wide: Ana finds Ben’s shared record');
  assert.equal((await ana.get(`/api/records/${benRec}`)).status, 200);

  // Organization boundary: another organization's Supervisor never sees even the organization-wide source.
  db.run("INSERT INTO tenants (id, name) VALUES ('t2', 'Other City')");
  db.run("INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES ('u2', 't2', 'z@other.org', 'Zed', 'admin', ?)", hashPassword('other tenant password'));
  const zed = env.client(); await zed.login('z@other.org', 'other tenant password');
  await zed.put('/api/consent', { scope: 'all', sourceIds: [], acknowledged: true });
  assert(!(await zed.get('/api/sources')).data.data.some(x => x.id === benId || x.id === id));
  assert.equal((await zed.get(`/api/records/${benRec}`)).status, 404);
  assert.equal((await zed.get(`/api/sources/${benId}/jobs`)).status, 404);
  assert.equal((await zed.post(`/api/sources/${benId}/sync`)).status, 404);
  const z = await searchReq(zed, 'Cedar Avenue permit', plan);
  assert(!(z.results || []).some(x => x.record.id === benRec || x.record.id === rec));
});

test('existing sources keep their sharing: the new default never rewrites them', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  permits(env);
  const admin = env.client(); await admin.setup();
  const r = await admin.post('/api/sources/database', { name: 'Shared before', driver: 'sqlite', file: 'city.sqlite', visibility: 'org', tables: [table] });
  const id = r.data.data.sourceId;
  await waitForSync(admin, id);
  const before = env.app.db.get('SELECT visibility, allowed_roles FROM sources WHERE id = ?', id);
  // Start the app again on the same database (as a restart would): migrations run, nothing is rewritten.
  const again = createApp(env.config, { log: () => {} });
  const after = again.services.db.get('SELECT visibility, allowed_roles FROM sources WHERE id = ?', id);
  await again.close?.();
  assert.deepEqual({ ...after }, { ...before });
  assert.equal(after.visibility, 'roles');
});

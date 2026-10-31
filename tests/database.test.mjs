import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, waitForSync, searchReq } from './helpers.mjs';
import { buildSelect, makeMysqlSession, makePgSession, quoteIdent } from '../server/connectors/database.mjs';

const { DatabaseSync } = await import('node:sqlite');

const permitsTable = { name: 'permits', idColumn: 'id', titleColumn: 'title', contentColumns: ['description', 'street'], dateColumn: 'issued_on', departmentColumn: 'dept', urlTemplate: 'https://permits.example.gov/p/{id}' };

test('query builder: parameterised, quoted, SELECT-only; identifiers are validated', () => {
  const q = buildSelect({ dialect: 'postgres', table: 'permits', columns: ['id', 'title'], idColumn: 'id', dateColumn: 'issued_on', since: '2025-01-01', keyword: "closure'; DROP TABLE x;--", keywordColumns: ['title'], tenantColumn: 'org', tenantValue: 'bellevue', limit: 50, offset: 100 });
  assert.equal(q.text, `SELECT "id", "title" FROM "permits" WHERE "org" = $1 AND "issued_on" >= $2 AND (CAST("title" AS TEXT) ILIKE $3 ESCAPE '\\') ORDER BY "id" LIMIT $4 OFFSET $5`);
  assert.deepEqual(q.params, ['bellevue', '2025-01-01', "%closure'; DROP TABLE x;--%", 50, 100]);
  const m = buildSelect({ dialect: 'mysql', table: 'permits', columns: ['id'], idColumn: 'id', keyword: '50%_off', keywordColumns: ['id'], limit: 5000, offset: -3 });
  assert.equal(m.text, 'SELECT `id` FROM `permits` WHERE (`id` LIKE ?) ORDER BY `id` LIMIT ? OFFSET ?');
  assert.deepEqual(m.params, ['%50\\%\\_off%', 1000, 0], 'wildcards escaped, limit capped, negative offset clamped');
  for (const bad of ['users; DROP TABLE x', 'a"b', '1abc', 'x'.repeat(64), 'a b']) assert.throws(() => quoteIdent('postgres', bad), /not an allowed/);
});

test('SQLite connector: read-only sync, schema checks, tenant column, deletion propagation, preview', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const dir = path.join(env.dir, 'connectors');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'city.sqlite');
  const ext = new DatabaseSync(file);
  ext.exec(`CREATE TABLE permits (id INTEGER PRIMARY KEY, title TEXT, description TEXT, street TEXT, issued_on TEXT, dept TEXT, org TEXT, secret_notes TEXT);
    INSERT INTO permits VALUES (1, 'Street use permit P-1', 'Lane closure for utility work', 'Cedar Avenue', '2025-01-10', 'Transportation', 'bellevue', 'do not index'),
                               (2, 'Excavation permit P-2', 'Water main replacement', 'Cedar Avenue', '2025-02-01', 'Utilities', 'bellevue', 'secret'),
                               (3, 'Other city permit', 'Cedar Avenue closure elsewhere', 'Cedar Avenue', '2025-02-02', 'Transportation', 'othercity', 'x');`);
  ext.close();
  const c = env.client(); await c.setup();

  // Inspect lists tables/columns.
  let r = await c.post('/api/connectors/database/inspect', { driver: 'sqlite', file: 'city.sqlite' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert(r.data.data.some(x => x.table === 'permits' && x.column === 'issued_on'));
  assert.equal((await c.post('/api/connectors/database/inspect', { driver: 'sqlite', file: '../records.db' })).status, 400, 'files outside the connector folder are refused');

  // Bad mappings are refused with specific messages.
  r = await c.post('/api/sources/database', { name: 'Permits', driver: 'sqlite', file: 'city.sqlite', tables: [{ ...permitsTable, contentColumns: ['nope'] }] });
  assert.equal(r.status, 400); assert.match(r.data.error.message, /Column "nope" was not found/);
  r = await c.post('/api/sources/database', { name: 'Permits', driver: 'sqlite', file: 'city.sqlite', tables: [{ ...permitsTable, name: 'permits; DROP TABLE permits' }] });
  assert.equal(r.status, 400);

  r = await c.post('/api/sources/database', { name: 'Permit system', driver: 'sqlite', file: 'city.sqlite', tenantColumn: 'org', tenantValue: 'bellevue', tables: [permitsTable] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const sourceId = r.data.data.sourceId;
  let src = await waitForSync(c, sourceId);
  assert.equal(src.status, 'connected', src.lastError);
  assert.equal(src.recordCount, 2, 'rows for another tenant value are never copied');

  const res = (await searchReq(c, 'permits for the Cedar Avenue lane closure')).results;
  const permit = res.find(x => x.record.title === 'Street use permit P-1');
  assert(permit);
  assert.equal(permit.record.department, 'Transportation');
  assert.equal(permit.record.sourceUrl, 'https://permits.example.gov/p/1');
  const full = (await c.get(`/api/records/${permit.record.id}`)).data.data;
  assert(!full.content.includes('do not index'), 'only allowlisted columns are copied');

  // Preview with keyword filter.
  r = await c.post(`/api/sources/${sourceId}/preview`, { table: 'permits', keyword: 'water' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.data.map(x => x.id), ['2']);
  assert.equal((await c.post(`/api/sources/${sourceId}/preview`, { table: 'users' })).status, 400);

  // The connection is read-only even if something tried to write.
  const ro = new DatabaseSync(file, { readOnly: true });
  assert.throws(() => ro.exec("DELETE FROM permits"), /readonly/i);
  ro.close();

  // Deleting a row at the source removes it on the next sync.
  const w = new DatabaseSync(file); w.exec('DELETE FROM permits WHERE id = 2'); w.close();
  await c.post(`/api/sources/${sourceId}/sync`);
  src = await waitForSync(c, sourceId);
  assert.equal(src.recordCount, 1);

  // Schema drift is reported, not ignored.
  const d = new DatabaseSync(file); d.exec('ALTER TABLE permits RENAME COLUMN street TO street_name'); d.close();
  await c.post(`/api/sources/${sourceId}/sync`);
  src = await waitForSync(c, sourceId);
  assert.equal(src.status, 'needs_attention');
  assert.match(src.lastError, /Column "street" was not found/);
});

test('PostgreSQL connector against real Postgres (PGlite): read-only transaction, sync and search', async (t) => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE permits (id serial PRIMARY KEY, title text, description text, street text, issued_on date, dept text);
    INSERT INTO permits (title, description, street, issued_on, dept) VALUES
      ('Right-of-way permit 88', 'Temporary lane closure and detour', 'Cedar Avenue', '2025-01-20', 'Transportation'),
      ('Sidewalk repair 12', 'Panel replacement', 'Pine Street', '2024-06-01', 'Public Works');`);
  const statements = [];
  const client = { async query(text, params) { statements.push(text); return pg.query(text, params); } };
  const env = await startApp({}, { connectDatabase: async (cfg) => { assert.equal(cfg.driver, 'postgres'); return makePgSession(client, 5000, async () => {}); } });
  t.after(async () => { await env.close(); await pg.close(); });
  const c = env.client(); await c.setup();
  let r = await c.post('/api/sources/database', { name: 'Permits (Postgres)', driver: 'postgres', host: 'db.internal', database: 'permits', user: 'reader', password: 'pw-not-stored-in-clear', tables: [permitsTable] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const src = await waitForSync(c, r.data.data.sourceId);
  assert.equal(src.status, 'connected', src.lastError);
  assert.equal(src.recordCount, 2);
  assert(statements.includes('BEGIN TRANSACTION READ ONLY'));
  assert(statements.some(x => /^SET LOCAL statement_timeout/.test(x)));
  assert(statements.filter(x => /^SELECT "id"/.test(x)).every(x => /LIMIT \$\d+ OFFSET \$\d+$/.test(x)));
  // The read-only transaction really blocks writes.
  const session = await makePgSession({ query: (t2, p) => pg.query(t2, p) }, 5000, async () => {});
  await assert.rejects(session.query('DELETE FROM permits', []), /read-only/);
  await session.close();
  // The password is stored encrypted only.
  const cred = env.app.db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', r.data.data.sourceId);
  assert(cred && !cred.ciphertext.includes('pw-not-stored'));
  assert.equal(env.app.services.vault.open(cred.ciphertext).password, 'pw-not-stored-in-clear');

  const res = (await searchReq(c, 'Cedar Avenue lane closure permits')).results;
  assert.equal(res[0].record.title, 'Right-of-way permit 88');
  assert.equal(res[0].record.createdAt.slice(0, 10), '2025-01-20');
});

test('MySQL session: read-only session settings and bound parameters', async () => {
  const sent = [];
  const conn = { async query(q, params) { sent.push({ q, params }); return typeof q === 'object' ? [[{ id: 1, title: 'Permit' }]] : [[]]; } };
  const s = await makeMysqlSession(conn, 4000, async () => {});
  const q = buildSelect({ dialect: 'mysql', table: 'permits', columns: ['id', 'title'], idColumn: 'id', limit: 10, offset: 0 });
  const rows = await s.query(q.text, q.params);
  await s.close();
  assert.deepEqual(sent.slice(0, 2).map(x => x.q), ['SET SESSION TRANSACTION READ ONLY', 'START TRANSACTION READ ONLY']);
  assert.equal(sent[2].q.timeout, 4000);
  assert.deepEqual(sent[2].params, [10, 0]);
  assert.equal(sent.at(-1).q, 'ROLLBACK');
  assert.equal(rows[0].title, 'Permit');
});

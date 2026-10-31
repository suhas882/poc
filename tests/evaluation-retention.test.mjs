import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchReq, startApp } from './helpers.mjs';

test('evaluation metrics come only from staff decisions; history and preview work', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  await c.upload('a.txt', Buffer.from('Cedar Avenue lane closure notice for utility work.'));
  await c.upload('b.txt', Buffer.from('Cedar Avenue tree planting schedule.'));
  await c.upload('c.txt', Buffer.from('Detour map for the Cedar Avenue closure.'));
  const s = await searchReq(c, 'Cedar Avenue closure');
  assert.equal(s.runStatus, 200);
  const id = s.id;
  const byTitle = (x) => s.results.find(r => r.record.title === x).record.id;
  assert.equal((await c.put(`/api/requests/${id}/marks/${byTitle('a.txt')}`, { mark: 'relevant' })).status, 200);
  assert.equal((await c.put(`/api/requests/${id}/marks/${byTitle('b.txt')}`, { mark: 'not_relevant', note: 'Trees, not closures' })).status, 200);
  assert.equal((await c.put(`/api/requests/${id}/marks/${byTitle('c.txt')}`, { mark: 'bogus' })).status, 400);
  // Changing a mark updates it rather than adding another.
  const again = await c.put(`/api/requests/${id}/marks/${byTitle('a.txt')}`, { mark: 'relevant', note: 'Core record' });
  assert.equal(again.data.data.review.marked, 2);
  assert.equal(again.data.data.mark.by, 'Ada Admin', 'marks carry who and when');
  assert.ok(again.data.data.mark.at);

  // Marks show on results and filter by mark.
  const judged = (await c.get(`/api/requests/${id}/results?marks=relevant`)).data;
  assert.equal(judged.data.length, 1); assert.equal(judged.data[0].mark.note, 'Core record');
  assert.equal(judged.meta.all, s.results.length, 'the screen always knows how many are hidden by filters');
  const unreviewed = (await c.get(`/api/requests/${id}/results?marks=none`)).data.data;
  assert(unreviewed.every(r => !r.mark));

  // Routing to a coordinator is stored and appears in the export.
  assert.equal((await c.put(`/api/requests/${id}/routes/${byTitle('c.txt')}`, { to: 'Records Coordinator A (Records Coordinator)' })).status, 200);
  const csv = (await c.get(`/api/requests/${id}/export/candidates.csv`)).data;
  assert.match(csv, /Records Coordinator A/);
  assert.match(csv, /Core record/);

  // History lists the request with review progress; marks are in the audit log with before and after.
  const hist = (await c.get('/api/requests')).data;
  assert.equal(hist.data[0].id, id); assert.equal(hist.data[0].review.marked, 2);
  const marks = (await c.get('/api/audit?action=mark.saved')).data.data;
  assert.ok(marks.some(m => m.before === 'relevant' && m.after === 'relevant'));
  const rec = (await c.get(`/api/records/${byTitle('a.txt')}`)).data.data;
  assert.match(rec.content, /lane closure/);
  assert((await c.get('/api/audit?action=record.viewed')).data.data.length >= 1);

  // A plan with nothing to search for cannot be confirmed.
  const empty = await searchReq(c, 'anything at all', { edits: { keywords: [], alternateTerms: [], phrases: [], people: [], locations: [], organizations: [] } });
  assert.equal(empty.confirmStatus, 400);
  assert.equal(empty.confirm.data.error.code, 'empty_plan');
});

test('retention removes old history, audit events and usage; settings are admin-only', async (t) => {
  const env = await startApp({ RETENTION_SEARCH_HISTORY_DAYS: '30', RETENTION_AUDIT_DAYS: '30' });
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  const p = await c.post('/api/requests', { text: 'old search about permits', receivedAt: '2026-10-30', mode: 'demo' });
  const old = new Date(Date.now() - 40 * 86400_000).toISOString();
  env.app.db.run('UPDATE search_requests SET created_at = ? WHERE id = ?', old, p.data.data.id);
  env.app.db.run('UPDATE audit_events SET created_at = ? WHERE action = ?', old, 'auth.setup');
  const r = await c.post('/api/settings/retention/apply');
  assert.equal(r.status, 200);
  assert.equal(r.data.data.searches, 1);
  assert(r.data.data.auditEvents >= 1);
  assert.equal((await c.get(`/api/requests/${p.data.data.id}`)).status, 404);

  assert.equal((await c.patch('/api/settings', { defaultMode: 'real', resultsPerPage: 50 })).status, 200);
  assert.equal((await c.get('/api/settings')).data.data.defaultMode, 'real');
  assert.equal((await c.patch('/api/settings', { defaultMode: 'everything' })).status, 400);
  await c.post('/api/users', { email: 'r@x.org', name: 'R', role: 'reviewer', password: 'reviewer password 1' });
  const rv = env.client(); await rv.login('r@x.org', 'reviewer password 1');
  assert.equal((await rv.patch('/api/settings', { defaultMode: 'demo' })).status, 403);
  assert.equal((await rv.post('/api/settings/retention/apply')).status, 403);
});

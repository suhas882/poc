import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

test('evaluation metrics come only from staff decisions; history and preview work', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  await c.upload('a.txt', Buffer.from('Cedar Avenue lane closure notice for utility work.'));
  await c.upload('b.txt', Buffer.from('Cedar Avenue tree planting schedule.'));
  await c.upload('c.txt', Buffer.from('Detour map for the Cedar Avenue closure.'));
  let s = (await c.get('/api/evaluations/summary')).data.data;
  assert.equal(s.judgments.total, 0);
  assert.equal(s.precisionAt10, null, 'no fabricated metrics before any decision');

  const p = await c.post('/api/searches/plan', { requestText: 'Cedar Avenue closure', mode: 'real' });
  const id = p.data.data.searchId;
  await c.post(`/api/searches/${id}/run`, { plan: p.data.data.plan, confirmed: true });
  const results = (await c.get(`/api/searches/${id}/results`)).data.data;
  const byTitle = (x) => results.find(r => r.record.title === x).record.id;
  assert.equal((await c.put(`/api/searches/${id}/evaluations/${byTitle('a.txt')}`, { judgment: 'relevant' })).status, 200);
  assert.equal((await c.put(`/api/searches/${id}/evaluations/${byTitle('b.txt')}`, { judgment: 'not_relevant', note: 'Trees, not closures' })).status, 200);
  assert.equal((await c.put(`/api/searches/${id}/evaluations/${byTitle('c.txt')}`, { judgment: 'bogus' })).status, 400);
  // Changing a decision updates it rather than adding another.
  await c.put(`/api/searches/${id}/evaluations/${byTitle('a.txt')}`, { judgment: 'relevant', note: 'Core record' });

  s = (await c.get('/api/evaluations/summary')).data.data;
  assert.equal(s.judgments.total, 2);
  assert.equal(s.precisionAt10, 50);
  assert.equal(s.pooledRecallAt10, 100);
  assert.equal(s.falsePositives.length, 1);
  assert.equal(s.falsePositives[0].note, 'Trees, not closures');
  assert.equal(s.execution.plansByRules, 1);

  // Decisions show on results and filter by decision.
  const judged = (await c.get(`/api/searches/${id}/results?judgment=relevant`)).data.data;
  assert.equal(judged.length, 1); assert.equal(judged[0].note, 'Core record');
  const unreviewed = (await c.get(`/api/searches/${id}/results?judgment=none`)).data.data;
  assert(unreviewed.every(r => !r.judgment));

  // History lists the search; preview returns content and logs the view.
  const hist = (await c.get('/api/searches')).data.data;
  assert.equal(hist[0].id, id); assert.equal(hist[0].judged, 2);
  const rec = (await c.get(`/api/records/${byTitle('a.txt')}`)).data.data;
  assert.match(rec.content, /lane closure/);
  assert((await c.get('/api/audit?action=record.viewed')).data.data.length >= 1);

  // A run with nothing to search for is refused.
  const p2 = await c.post('/api/searches/plan', { requestText: 'anything at all', mode: 'real' });
  const r = await c.post(`/api/searches/${p2.data.data.searchId}/run`, { plan: { ...p2.data.data.plan, keywords: [], alternateTerms: [], phrases: [] }, confirmed: true });
  assert.equal(r.status, 400);
  assert.equal((await c.post(`/api/searches/${p2.data.data.searchId}/run`, { plan: p2.data.data.plan, confirmed: false })).status, 400, 'confirmation is required');
});

test('retention removes old history, audit events and usage; settings are admin-only', async (t) => {
  const env = await startApp({ RETENTION_SEARCH_HISTORY_DAYS: '30', RETENTION_AUDIT_DAYS: '30' });
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  const p = await c.post('/api/searches/plan', { requestText: 'old search', mode: 'demo' });
  const old = new Date(Date.now() - 40 * 86400_000).toISOString();
  env.app.db.run('UPDATE search_requests SET created_at = ? WHERE id = ?', old, p.data.data.searchId);
  env.app.db.run('UPDATE audit_events SET created_at = ? WHERE action = ?', old, 'auth.setup');
  const r = await c.post('/api/settings/retention/apply');
  assert.equal(r.status, 200);
  assert.equal(r.data.data.searches, 1);
  assert(r.data.data.auditEvents >= 1);
  assert.equal((await c.get(`/api/searches/${p.data.data.searchId}`)).status, 404);

  assert.equal((await c.patch('/api/settings', { defaultMode: 'real', resultsPerPage: 50 })).status, 200);
  assert.equal((await c.get('/api/settings')).data.data.defaultMode, 'real');
  assert.equal((await c.patch('/api/settings', { defaultMode: 'everything' })).status, 400);
  await c.post('/api/users', { email: 'r@x.org', name: 'R', role: 'reviewer', password: 'reviewer password 1' });
  const rv = env.client(); await rv.login('r@x.org', 'reviewer password 1');
  assert.equal((await rv.patch('/api/settings', { defaultMode: 'demo' })).status, 403);
  assert.equal((await rv.post('/api/settings/retention/apply')).status, 403);
});

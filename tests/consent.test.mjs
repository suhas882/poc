import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocx, startApp } from './helpers.mjs';

test('search permission: asked after sign-in, limits sources, can be withdrawn', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  c.autoConsent = false;
  await c.setup();

  let r = await c.get('/api/auth/status');
  assert.equal(r.data.data.consentRequired, true, 'permission is asked right after sign-in');

  // Two upload sources: documents and messages.
  r = await c.upload('memo.docx', makeDocx(['Cedar Avenue closure memo'], { title: 'Cedar memo' }));
  assert.equal(r.status, 201);
  r = await c.upload('chat.txt', Buffer.from('2/3/25, 9:15 AM - Ana: Cedar Avenue closure starts Monday\n'), '?kind=messages');
  assert.equal(r.status, 201, JSON.stringify(r.data));

  // Real searches are blocked until the user answers.
  r = await c.post('/api/searches/plan', { requestText: 'Cedar Avenue closure', mode: 'real' });
  assert.equal(r.status, 428); assert.equal(r.data.error.code, 'consent_required');
  // The demo stays available.
  r = await c.post('/api/searches/plan', { requestText: 'Cedar Avenue closure', mode: 'demo' });
  assert.equal(r.status, 201);

  r = await c.put('/api/consent', { scope: 'all', sourceIds: [] });
  assert.equal(r.status, 400, 'the acknowledgement is required');

  r = await c.get('/api/consent');
  const sources = r.data.data.sources;
  assert.ok(sources.length >= 2, JSON.stringify(sources));
  const docs = sources.find(s => s.type === 'uploads');
  assert.ok(docs);

  // Only the documents source.
  r = await c.put('/api/consent', { scope: 'selected', sourceIds: [docs.id], acknowledged: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await c.get('/api/auth/status')).data.data.consentRequired, false);
  let p = await c.post('/api/searches/plan', { requestText: 'Cedar Avenue closure', mode: 'real' });
  assert.equal(p.status, 201);
  let run = await c.post(`/api/searches/${p.data.data.searchId}/run`, { plan: p.data.data.plan, confirmed: true });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  let res = await c.get(`/api/searches/${p.data.data.searchId}/results?pageSize=100`);
  assert.ok(res.data.data.length >= 1);
  assert.ok(res.data.data.every(x => x.record.sourceId === docs.id), 'only the permitted source is searched');

  // Asking for a source outside the permission returns nothing from it.
  const other = sources.find(s => s.id !== docs.id);
  p = await c.post('/api/searches/plan', { requestText: 'Cedar Avenue closure', mode: 'real' });
  run = await c.post(`/api/searches/${p.data.data.searchId}/run`, { plan: { ...p.data.data.plan, sourceIds: [other.id] }, confirmed: true });
  assert.equal(run.status, 200);
  assert.equal(run.data.data.total, 0, 'sources outside the permission are never searched');

  // Everything.
  r = await c.put('/api/consent', { scope: 'all', sourceIds: [], acknowledged: true });
  assert.equal(r.status, 200);
  p = await c.post('/api/searches/plan', { requestText: 'Cedar Avenue closure', mode: 'real' });
  run = await c.post(`/api/searches/${p.data.data.searchId}/run`, { plan: p.data.data.plan, confirmed: true });
  assert.ok(run.data.data.total >= 2, JSON.stringify(run.data.data));

  // Withdraw.
  r = await c.del('/api/consent');
  assert.equal(r.status, 200);
  r = await c.post('/api/searches/plan', { requestText: 'Cedar Avenue closure', mode: 'real' });
  assert.equal(r.status, 428);

  const audit = await c.get('/api/audit?pageSize=100');
  const actions = audit.data.data.map(e => e.action);
  for (const a of ['consent.granted', 'consent.changed', 'consent.withdrawn']) assert.ok(actions.includes(a), a);
});

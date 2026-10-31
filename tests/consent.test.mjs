import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocx, searchReq, startApp } from './helpers.mjs';

test('search permission: asked after sign-in, per-plan sources, G4 refusal is logged, old and new values audited', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  c.autoConsent = false;
  await c.setup();

  let r = await c.get('/api/auth/status');
  assert.equal(r.data.data.consentRequired, true, 'permission is asked right after sign-in');

  r = await c.upload('memo.docx', makeDocx(['Cedar Avenue closure memo'], { title: 'Cedar memo' }));
  assert.equal(r.status, 201);
  r = await c.upload('chat.txt', Buffer.from('2/3/25, 9:15 AM - Ana: Cedar Avenue closure starts Monday\n'), '?kind=messages');
  assert.equal(r.status, 201, JSON.stringify(r.data));

  // Real searches are blocked until the user answers; the demo still works.
  r = await c.post('/api/requests', { text: 'Cedar Avenue closure', receivedAt: '2026-10-30', mode: 'real' });
  assert.equal(r.status, 428); assert.equal(r.data.error.code, 'consent_required');
  r = await c.post('/api/requests', { text: 'Cedar Avenue closure', receivedAt: '2026-10-30', mode: 'demo' });
  assert.equal(r.status, 201);

  r = await c.put('/api/consent', { scope: 'all', sourceIds: [] });
  assert.equal(r.status, 400, 'the acknowledgement is required');

  const sources = (await c.get('/api/consent')).data.data.sources;
  const docs = sources.find(s => s.type === 'uploads');
  const msgs = sources.find(s => s.type === 'messages');
  assert.ok(docs && msgs);

  // Only the documents source.
  r = await c.put('/api/consent', { scope: 'selected', sourceIds: [docs.id], acknowledged: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let s = await searchReq(c, 'Cedar Avenue closure');
  assert.equal(s.runStatus, 200);
  assert.deepEqual(s.created.choices.sources.map(x => x.id), [docs.id], 'only permitted sources are offered');
  assert.deepEqual(s.plan.sourceIds, [docs.id], 'the chosen sources are saved inside the confirmed plan');
  assert.ok(s.results.length >= 1 && s.results.every(x => x.record.sourceId === docs.id));

  // G4: a plan naming a source outside the permission is refused, and the attempt is logged.
  s = await searchReq(c, 'Cedar Avenue closure', { sourceIds: [docs.id, msgs.id] });
  assert.equal(s.confirmStatus, 403);
  assert.equal(s.confirm.data.error.code, 'source_not_permitted');
  const refused = (await c.get('/api/audit?action=search.refused')).data.data;
  assert.equal(refused.length, 1);
  assert.equal(refused[0].outcome, 'denied');

  // Everything.
  r = await c.put('/api/consent', { scope: 'all', sourceIds: [], acknowledged: true });
  assert.equal(r.status, 200);
  s = await searchReq(c, 'Cedar Avenue closure', { sourceIds: [docs.id, msgs.id] });
  assert.equal(s.runStatus, 200);
  assert.ok(s.run.candidates >= 2);

  // A permission narrowed after confirmation is enforced again at search time.
  const req = s.id;
  r = await c.put('/api/consent', { scope: 'selected', sourceIds: [docs.id], acknowledged: true });
  r = await c.post(`/api/requests/${req}/run`, { version: s.version });
  assert.equal(r.status, 403, 'running a confirmed plan with a no-longer-permitted source is refused');

  // Withdraw.
  r = await c.del('/api/consent');
  assert.equal(r.status, 200);
  r = await c.post('/api/requests', { text: 'Cedar Avenue closure', receivedAt: '2026-10-30', mode: 'real' });
  assert.equal(r.status, 428);

  const audit = (await c.get('/api/audit?pageSize=200')).data.data;
  const changed = audit.find(e => e.action === 'consent.changed');
  assert.ok(changed.before && changed.after, 'permission changes record the old and new values');
  assert.equal(changed.user.name, 'Ada Admin');
  for (const a of ['consent.granted', 'consent.changed', 'consent.withdrawn']) assert.ok(audit.some(e => e.action === a), a);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

test('demo workspace is saved in SQLite and survives reloads and restarts', async (t) => {
  const env = await startApp({ DEMO_ONLY: 'true' });
  t.after(() => env.close());
  const a = env.client();
  let r = await a.get('/api/demo-state');
  assert.equal(r.status, 200, 'works even on a demo-only server');
  assert.deepEqual(r.data.data, {});
  assert.match(r.headers.get('set-cookie'), /prs_device=[a-f0-9]{32}; .*HttpOnly/);

  r = await a.put('/api/demo-state/synthetic-review-marks', { value: { 'REC-1': 'relevant' } });
  assert.equal(r.status, 403, 'anonymous writes need the same-site header');
  r = await a.req('PUT', '/api/demo-state/synthetic-review-marks', { value: { 'REC-1': 'relevant' } }, { 'x-requested-with': 'prs' });
  assert.equal(r.status, 200);
  r = await a.req('PUT', '/api/demo-state/synthetic-review-marks', { value: {} }, { 'x-requested-with': 'prs', origin: 'https://evil.example' });
  assert.equal(r.status, 403, 'cross-site writes are blocked');
  r = await a.req('PUT', '/api/demo-state/anything-else', { value: 1 }, { 'x-requested-with': 'prs' });
  assert.equal(r.status, 404, 'only known demo keys are stored');

  r = await a.get('/api/demo-state');
  assert.deepEqual(r.data.data['synthetic-review-marks'].value, { 'REC-1': 'relevant' });
  assert.deepEqual((await env.client().get('/api/demo-state')).data.data, {}, 'another browser has its own workspace');

  // Still there after the app restarts on the same database.
  const row = env.app.db.get("SELECT value FROM demo_state WHERE key = 'synthetic-review-marks'");
  assert.equal(row.value, '{"REC-1":"relevant"}');

  r = await a.req('DELETE', '/api/demo-state/synthetic-review-marks', undefined, { 'x-requested-with': 'prs' });
  assert.equal(r.status, 200);
  assert.deepEqual((await a.get('/api/demo-state')).data.data, {});
});

test('signing in keeps what was done in the demo on this browser', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  await c.get('/api/demo-state');
  await c.req('PUT', '/api/demo-state/synthetic-demo-actor', { value: 'Clerk reviewer B' }, { 'x-requested-with': 'prs' });
  await c.setup();
  const r = await c.get('/api/demo-state');
  assert.equal(r.data.data['synthetic-demo-actor'].value, 'Clerk reviewer B');
  const w = await c.put('/api/demo-state/synthetic-demo-actor', { value: 'Clerk reviewer C' });
  assert.equal(w.status, 200, 'signed-in writes use the session CSRF token');
});

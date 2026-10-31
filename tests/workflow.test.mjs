// Done-when tests from the Round 2 implementation plan (phases B to I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import { searchReq, startApp } from './helpers.mjs';
import { businessDaysLeft, dueDate } from '../server/deadline.mjs';
import { parseFilter } from '../server/nlfilter.mjs';
import { readingGrade } from '../server/ai/clarify.mjs';

const demo = async (env, role = 'records_officer', c = env.client()) => {
  const r = await c.post('/api/auth/demo', { role });
  assert.equal(r.status, 200); c.csrf = r.data.data.csrfToken; return c;
};
const plain = { alternateTerms: [], phrases: [], people: [], organizations: [], locations: [], dateFrom: null, dateTo: null, departments: [], recordTypes: [], exclusions: [] };

test('B3 deadline: five business days, day of receipt not counted, weekends and holidays skipped', async (t) => {
  const none = new Set();
  assert.equal(dueDate('2026-10-30', none), '2026-11-06', 'received Friday, due the next Friday');
  assert.equal(dueDate('2026-10-31', none), '2026-11-06', 'received Saturday: counting starts Monday');
  assert.equal(dueDate('2026-10-30', new Set(['2026-11-03'])), '2026-11-09', 'a holiday moves it');
  assert.equal(businessDaysLeft('2026-10-30', '2026-11-06', none), 5);
  assert.equal(businessDaysLeft('2026-11-06', '2026-11-06', none), 0);
  assert.equal(businessDaysLeft('2026-11-10', '2026-11-06', none), -2);
  assert.equal(dueDate('2026-11-25', new Set(['2026-11-26', '2026-11-27'])), '2026-12-04', 'Thanksgiving and the day after are skipped');

  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const sup = await demo(env, 'admin');
  const r = await sup.post('/api/requests', { text: 'Records about the Main Street lane closure', receivedAt: '2026-10-30' });
  assert.equal(r.data.data.clock.dueDate, '2026-11-06');
  assert.equal((await sup.put('/api/settings/holidays', { add: '2026-11-03' })).status, 200);
  const after = (await sup.get(`/api/requests/${r.data.data.id}`)).data.data;
  assert.equal(after.clock.dueDate, '2026-11-09', 'adding a holiday in Settings moves the due date');
  const audit = (await sup.get('/api/audit?category=settings')).data.data;
  assert.ok(audit.some(e => e.after?.added === '2026-11-03'));
});

test('B1 plan lock and versions; B2/G2 a failing source is listed as NOT searched, never as zero results', async (t) => {
  const env = await startApp({ REAL_SOURCES: 'false' }, { sourceCheck: async (src) => src.name === 'Public documents' ? new Promise(() => {}) : null });
  t.after(() => env.close());
  const c = await demo(env);
  // A public document source that will time out.
  await c.req('POST', '/api/uploads?kind=public', Buffer.from('Main Street lane closure notice.'), { 'x-file-name': 'n.txt', 'content-type': 'text/plain', 'x-source-url': 'https://example.org/n', 'x-retrieved-at': '2026-10-29', 'x-terms-checked': 'yes' });
  const r = await c.post('/api/requests', { text: 'Records about the Cedar Avenue lane closure', receivedAt: '2026-10-30' });
  const id = r.data.data.id;
  assert.equal(r.data.data.current.status, 'draft');
  assert.equal((await c.post(`/api/requests/${id}/run`, {})).status, 400, 'no plan id: refused');
  assert.equal((await c.post(`/api/requests/${id}/run`, { version: 1 })).status, 409, 'draft plan: refused');
  assert.equal((await c.post(`/api/requests/${id}/plan/confirm`, { version: 1, reviewed: false })).status, 400, 'the review box is required');
  const sources = r.data.data.choices.sources.map(s => s.id);
  await c.put(`/api/requests/${id}/plan`, { plan: { ...r.data.data.current.plan, keywords: ['lane closure'] }, sourceIds: sources });
  assert.equal((await c.post(`/api/requests/${id}/plan/confirm`, { version: 1, reviewed: true })).status, 200);
  // Editing a locked plan creates version 2; version 1 stays as it was.
  const v2 = (await c.put(`/api/requests/${id}/plan`, { plan: { ...r.data.data.current.plan, keywords: ['detour'] }, sourceIds: sources })).data.data;
  assert.equal(v2.current.version, 2); assert.equal(v2.current.status, 'draft');
  assert.deepEqual(v2.versions[0].plan.keywords, ['lane closure'], 'version 1 is unchanged');
  assert.equal((await c.post(`/api/requests/${id}/run`, { version: 2 })).status, 409);
  const run = await c.post(`/api/requests/${id}/run`, { version: 1 });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const st = Object.fromEntries(run.data.data.statuses.map(x => [x.name, x.status]));
  assert.equal(st['Synthetic corpus'], 'searched');
  assert.equal(st['Public documents'], 'failed', 'the timed-out source failed');
  assert.equal(st.SharePoint, 'not_connected');
  const res = await c.get(`/api/requests/${id}/results`);
  assert.ok(res.data.meta.coverage.notSearched.some(x => x.name === 'Public documents' && /5 seconds/.test(x.reason)));
  const report = (await c.get(`/api/requests/${id}/report`)).data.data;
  assert.ok(report.coverage.notSearched.some(x => x.name === 'Public documents'), 'the report lists it as NOT searched');
  assert.equal(report.coverageWording, 'Candidates found in the sources searched.');
  // D3: reproducibility fields on every search.
  assert.equal(report.reproducibility.planVersion, 1);
  assert.ok(report.reproducibility.model && report.reproducibility.promptVersion && report.reproducibility.indexTime);
  // D2: CSV log has request, plan version, sources, queries, counts, marks with who and when.
  const rid = res.data.data[0].record.id;
  await c.put(`/api/requests/${id}/marks/${rid}`, { mark: 'relevant', note: 'core' });
  const csv = (await c.get(`/api/requests/${id}/export/log.csv`)).data;
  for (const s of ['Plan version', 'NOT searched', 'Synthetic corpus', 'lane closure', 'Clerk reviewer A', 'relevant', 'Reproducibility']) assert.ok(csv.includes(s), s);
});

test('D1/G3 audit chain: verify passes, then fails at the first edited row', async (t) => {
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const c = await demo(env, 'admin');
  await searchReq(c, 'Cedar Avenue road closure', { mode: 'demo' });
  let v = (await c.get('/api/audit/verify')).data.data;
  assert.equal(v.ok, true); assert.ok(v.checked >= 5);
  assert.match(v.wording, /Tamper-evident/);
  const row = env.app.db.get("SELECT id FROM audit_events WHERE action = 'plan.confirmed'");
  env.app.db.run("UPDATE audit_events SET details = '{\"version\":99}' WHERE id = ?", row.id);
  v = (await c.get('/api/audit/verify')).data.data;
  assert.equal(v.ok, false);
  assert.equal(v.firstBroken.id, row.id, 'the first broken entry is named');
  const csv = (await c.get('/api/audit/export')).data;
  assert.match(csv, /Previous hash/);
});

test('options 2 and 4: preview counts, broad warning, narrowing chips, custodian checklist', async (t) => {
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const sup = await demo(env, 'admin');
  await sup.put('/api/settings/pack', { pack: 'bellevue', threshold: 3 });
  const r = await sup.post('/api/requests', { text: 'All records about road closure and utility work in Transportation', receivedAt: '2026-10-30' });
  const id = r.data.data.id;
  let p = (await sup.get(`/api/requests/${id}/preview`)).data.data;
  assert.equal(p.approximate, true);
  assert.equal(p.broad, true, `total ${p.total} is above the warning level`);
  assert.ok(p.stubs.every(s => s.count === null), 'unconnected sources show no count');
  const chip = p.chips.find(x => x.id === 'departments') || p.chips[0];
  assert.ok(chip);
  const before = p.total;
  await sup.put(`/api/requests/${id}/plan`, { plan: { ...r.data.data.current.plan, ...chip.patch }, sourceIds: r.data.data.current.sourceIds });
  p = (await sup.get(`/api/requests/${id}/preview`)).data.data;
  assert.ok(p.total <= before, 'applying a chip updates the plan and the counts');
  // Source map: marking Confirmed saves name and date and appears in the report.
  const custodians = (await sup.get(`/api/requests/${id}`)).data.data.custodians;
  assert.ok(custodians.length >= 1);
  const dept = custodians[0].department;
  const saved = (await sup.put(`/api/requests/${id}/custodians`, { department: dept, status: 'confirmed' })).data.data;
  const row = saved.find(x => x.department === dept);
  assert.equal(row.status, 'confirmed'); assert.equal(row.confirmedBy, 'Supervisor A'); assert.ok(row.confirmedAt);
  const report = (await sup.get(`/api/requests/${id}/report`)).data.data;
  assert.ok(report.custodians.some(x => x.department === dept && x.status === 'confirmed'));
});

test('option 1: expand from what you found (approve none: unchanged; approve two: version 2 with source IDs; re-search merges)', async (t) => {
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const c = await demo(env);
  const s = await searchReq(c, 'Cedar Avenue road closure', { mode: 'demo', edits: { ...plain, keywords: ['road closure'], phrases: ['Cedar Avenue'] } });
  assert.equal(s.runStatus, 200);
  for (const x of s.results.slice(0, 4)) await c.put(`/api/requests/${s.id}/marks/${x.record.id}`, { mark: 'relevant' });
  const sug = (await c.get(`/api/requests/${s.id}/expansion`)).data.data.suggestions;
  assert.ok(sug.length >= 2, JSON.stringify(sug));
  let r = await c.post(`/api/requests/${s.id}/expansion`, { approve: [], reject: [sug[0].term] });
  assert.equal(r.data.data.changed, false, 'approve none: plan unchanged');
  assert.equal((await c.get(`/api/requests/${s.id}`)).data.data.current.version, 1);
  const two = sug.slice(1, 3).map(x => x.term);
  r = await c.post(`/api/requests/${s.id}/expansion`, { approve: two, reject: [] });
  assert.equal(r.data.data.version, 2);
  const req = (await c.get(`/api/requests/${s.id}`)).data.data;
  assert.equal(req.current.status, 'confirmed');
  const sup = await demo(env, 'admin', env.client());
  void sup;
  await demo(env, 'admin', c);
  const audit = (await c.get('/api/audit?action=plan.terms_added')).data.data[0];
  await demo(env, 'records_officer', c);
  assert.deepEqual(audit.details.terms.map(t => t.term).sort(), [...two].sort());
  assert.ok(audit.details.terms.every(t => t.sourceRecordIds.length >= 1), 'each term is logged with its source record IDs');
  const before = s.results.length;
  const run = await c.post(`/api/requests/${s.id}/run`, { version: 2, addedTermsOnly: true });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const after = (await c.get(`/api/requests/${s.id}/results?pageSize=200`)).data;
  assert.equal(after.meta.all, before + run.data.data.added, 'new candidates are merged; reviewed ones stay');
  assert.equal(after.meta.review.relevant, 4, 'existing marks are kept');
});

test('option 9: plain-language filters become chips; "Showing X of Y" never hides silently', async (t) => {
  const f = parseFilter('emails from Transportation in April', { departments: ['Transportation', 'Utilities'], year: 2024 });
  assert.deepEqual(f.chips.map(c => c.kind), ['type', 'department', 'date']);
  assert.equal(f.chips[2].from, '2024-04-01');
  assert.equal(parseFilter('unmarked items').chips[0].value, 'none');
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const c = await demo(env);
  const s = await searchReq(c, 'Cedar Avenue lane closure detour', { mode: 'demo', edits: { ...plain, keywords: ['Cedar Avenue', 'detour', 'lane closure'] } });
  const chips = (await c.post('/api/filters/parse', { text: 'emails from Transportation', requestId: s.id })).data.data.chips;
  const q = new URLSearchParams({ type: chips.find(x => x.kind === 'type').value, department: chips.find(x => x.kind === 'department').value });
  const filtered = (await c.get(`/api/requests/${s.id}/results?${q}`)).data;
  assert.ok(filtered.meta.total < filtered.meta.all, `${filtered.meta.total} of ${filtered.meta.all}`);
  assert.ok(filtered.data.every(x => x.record.documentType === 'Email' && x.record.department === 'Transportation'));
  const cleared = (await c.get(`/api/requests/${s.id}/results`)).data;
  assert.equal(cleared.meta.total, cleared.meta.all, 'clearing restores all candidates');
});

test('option 5: switching to Sample City changes departments, holidays and wording, is admin-only and logged', async (t) => {
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const clerk = await demo(env);
  assert.equal((await clerk.put('/api/settings/pack', { pack: 'sample-city' })).status, 403);
  const sup = await demo(env, 'admin', clerk);
  const before = (await sup.get('/api/settings/workflow')).data.data.pack;
  await sup.put('/api/settings/pack', { pack: 'sample-city' });
  const after = (await sup.get('/api/settings/workflow')).data.data.pack;
  assert.notDeepEqual(after.departments, before.departments);
  assert.notDeepEqual(after.holidays, before.holidays);
  assert.notEqual(after.wording.clock, before.wording.clock);
  const ev = (await sup.get('/api/audit?action=pack.switched')).data.data[0];
  assert.equal(ev.before, 'bellevue'); assert.equal(ev.after, 'sample-city');
});

test('option 7 / E3: clarification drafts never send; Spanish is marked for human review; reading level is local', async (t) => {
  assert.ok(readingGrade('What dates should we search?') < 8);
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const c = await demo(env);
  const r = await c.post('/api/requests', { text: 'All records about everything', receivedAt: '2026-10-30' });
  const d = (await c.post(`/api/requests/${r.data.data.id}/clarify`)).data.data;
  assert.ok(d.english.questions.length >= 2);
  assert.equal(d.spanish.label, 'Draft translation: needs human review');
  assert.match(d.note, /never sends/);
  assert.equal((await c.post(`/api/requests/${r.data.data.id}/send`)).status, 404, 'there is no send endpoint');
});

test('option 3: replay runs end to end, exports CSV, and every missed record has a reason; evaluation uses labeled data', async (t) => {
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const c = await demo(env);
  const b = (await c.get('/api/evaluation/benchmark')).data.data;
  assert.equal(b.requests, 18);
  assert.ok(b.hybrid.recall10 >= b.keyword.recall10, 'hybrid finds at least as much as keyword-only');
  assert.match(b.banner, /not production performance/);
  const rp = (await c.get('/api/evaluation/replay')).data.data;
  assert.match(rp.banner, /SAMPLE DATA/);
  for (const q of rp.requests) for (const m of q.missed) assert.ok(m.uses.length && Array.isArray(m.lacked), 'missed records explain themselves');
  const csv = await c.get('/api/evaluation/replay?format=csv');
  assert.equal(csv.status, 200); assert.match(csv.data, /Plan terms it lacked/);
  // Two-person labels: differences wait for a Supervisor.
  await c.put('/api/evaluation/labels', { scenarioId: 'syn-1', recordId: 'R-003', role: 'reviewer1', label: 'relevant' });
  await c.put('/api/evaluation/labels', { scenarioId: 'syn-1', recordId: 'R-003', role: 'reviewer2', label: 'not_relevant' });
  assert.equal((await c.put('/api/evaluation/labels', { scenarioId: 'syn-1', recordId: 'R-003', role: 'adjudicator', label: 'relevant' })).status, 403);
  const reviewerView = (await c.get('/api/evaluation/labels?scenario=syn-1&role=reviewer1')).data.data.rows.find(x => x.corpusId === 'R-003');
  assert.equal(reviewerView.reviewer2, null, 'the other reviewer is hidden during entry');
  const sup = await demo(env, 'admin', c);
  const adj = (await sup.get('/api/evaluation/labels?scenario=syn-1&role=adjudicator')).data.data;
  assert.equal(adj.rows.find(x => x.corpusId === 'R-003').status, 'Difference');
});

test('option 6 export checks, second-person approval, handoff releases nothing', async (t) => {
  const env = await startApp({ REAL_SOURCES: 'false' });
  t.after(() => env.close());
  const clerk = await demo(env);
  const s = await searchReq(clerk, 'Cedar Avenue lane closure', { mode: 'demo' });
  let rep = (await clerk.get(`/api/requests/${s.id}/report`)).data.data;
  assert.equal(rep.exportChecks.find(x => x.kind === 'report_pdf').status, 'scan_pending');
  assert.equal((await clerk.put(`/api/requests/${s.id}/export-checks/report_pdf`, { status: 'scanned' })).status, 400, 'a scan needs a reviewer and date');
  await clerk.put(`/api/requests/${s.id}/export-checks/report_pdf`, { status: 'scanned', reviewer: 'Vikram Kamble (SureAccess)', reviewedOn: '2026-11-02' });
  rep = (await clerk.get(`/api/requests/${s.id}/report`)).data.data;
  assert.equal(rep.exportChecks.find(x => x.kind === 'report_pdf').reviewer, 'Vikram Kamble (SureAccess)');
  // Second-person approval.
  const sup = await demo(env, 'admin', env.client());
  // Same demo workspace: switch roles inside the clerk's browser.
  const supSame = await demo(env, 'admin', clerk);
  await supSame.put('/api/settings/switches', { secondApproval: true });
  const back = await demo(env, 'records_officer', supSame);
  assert.equal((await back.post(`/api/requests/${s.id}/handoff`)).status, 409, 'needs approval first');
  const sup2 = await demo(env, 'admin', back);
  assert.equal((await sup2.post(`/api/requests/${s.id}/approve`)).status, 200);
  const clerk2 = await demo(env, 'records_officer', sup2);
  const h = await clerk2.post(`/api/requests/${s.id}/handoff`);
  assert.equal(h.status, 200);
  assert.match(h.data.data.handoffWording, /releases nothing/);
  assert.equal((await clerk2.put(`/api/requests/${s.id}/plan`, { plan: s.plan, sourceIds: [] })).status, 409, 'a handed-off plan cannot change');
  void sup;
});

test('F2 Phone Link: off by default and hidden; employee self-review before anything reaches a clerk', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  const file = path.join(dir, 'phone.db');
  const db = new DatabaseSync(file);
  const ft = (iso) => (BigInt(Date.parse(iso)) + 11644473600000n) * 10000n;
  db.exec('CREATE TABLE message (message_id INTEGER PRIMARY KEY, thread_id INT, from_address TEXT, body TEXT, timestamp INT, type INT)');
  const add = db.prepare('INSERT INTO message (thread_id, from_address, body, timestamp, type) VALUES (?, ?, ?, ?, 1)');
  add.run(1, '+15550001', 'Cedar Avenue detour signs are up for the lane closure', ft('2026-10-20T10:00:00Z'));
  add.run(2, '+15550002', 'Love you, dinner at home tonight? Cedar Avenue traffic is bad', ft('2026-10-21T10:00:00Z'));
  db.close();
  const env = await startApp({ PHONELINK_DB_PATH: file, PHONELINK_SYNC_MINUTES: '0' });
  t.after(async () => { await env.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const admin = env.client(); await admin.setup();
  // Off by default: card hidden and connecting refused.
  assert.ok(!(await admin.get('/api/connectors')).data.data.some(x => x.type === 'phonelink'));
  assert.equal((await admin.post('/api/connectors/phonelink/connect', { acknowledged: true })).status, 403);
  await admin.put('/api/settings/switches', { phoneLink: true });
  const conn = await admin.post('/api/connectors/phonelink/connect', { acknowledged: true });
  assert.equal(conn.status, 201, JSON.stringify(conn.data));
  const phoneId = conn.data.data.sourceId;
  for (let i = 0; i < 50 && (await admin.get('/api/sources')).data.data.find(x => x.id === phoneId)?.status === 'syncing'; i++) await new Promise(r => setTimeout(r, 100));
  // Share the phone source with clerks so it can be chosen; contents stay gated by the employee review.
  await admin.patch(`/api/sources/${phoneId}`, { visibility: 'roles', allowedRoles: [] });
  await admin.post('/api/users', { email: 'clerk@x.org', name: 'Cleo Clerk', role: 'records_officer', password: 'clerk password 12' });
  const clerk = env.client(); await clerk.login('clerk@x.org', 'clerk password 12');
  const s = await searchReq(clerk, 'Cedar Avenue lane closure detour', { edits: { ...plain, keywords: ['Cedar Avenue'] }, sourceIds: [phoneId] });
  assert.equal(s.runStatus, 200, JSON.stringify(s.runError || s.confirm?.data));
  assert.equal(s.results.length, 0, 'the clerk sees nothing before the employee reviews');
  assert.equal(s.meta.coverage.searched[0].status, 'partial');
  // Employee review.
  const q = (await admin.get('/api/phone-review')).data.data;
  const req = q.requests.find(x => x.requestId === s.id);
  assert.equal(req.items.length, 2);
  const personal = req.items.find(i => /dinner/.test(i.preview));
  assert.equal(personal.personalLooking, true, 'personal-looking previews are flagged to stay hidden');
  const city = req.items.find(i => /detour/.test(i.preview));
  await admin.put(`/api/phone-review/${s.id}/${city.recordId}`, { decision: 'city' });
  await admin.put(`/api/phone-review/${s.id}/${personal.recordId}`, { decision: 'personal' });
  assert.equal((await admin.post(`/api/phone-review/${s.id}/send`, { attested: false })).status, 400, 'attestation is required');
  assert.equal((await admin.post(`/api/phone-review/${s.id}/send`, { attested: true })).data.data.sent, 1);
  const again = await clerk.post(`/api/requests/${s.id}/run`, { version: s.version });
  assert.equal(again.status, 200);
  const res = (await clerk.get(`/api/requests/${s.id}/results`)).data.data;
  assert.deepEqual(res.map(x => x.record.id), [city.recordId], 'only City business items reach the clerk');
  assert.equal((await clerk.get(`/api/records/${personal.recordId}`)).status, 404, 'personal items stay private');
  const acts = (await admin.get('/api/audit?category=texts')).data.data.map(e => e.action);
  assert.ok(acts.includes('texts.reviewed') && acts.includes('texts.sent'));
});

test('A3 wording: no exemption, redaction or release actions; no "complete" claims; no em dashes on screen', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [...fs.readdirSync(path.join(root, 'client/pages')).filter(f => f.endsWith('.ts')).map(f => `client/pages/${f}`), 'client/shell.ts', 'client/ui.ts',
    ...fs.readdirSync(root).filter(f => f.endsWith('.html') && f !== 'POC-VIDEO.html'), 'packs/bellevue.json', 'packs/sample-city.json'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!text.includes('—'), `${f} has an em dash`);
    assert.ok(!/['"`](Release|Redact|Mark exempt|Apply exemption|Send to requester|Release records)['"`]/.test(text), `${f} has a release/redaction action`);
    assert.ok(!/search (is|was) complete|complete search|all records found/i.test(text.replace(/never say[^.]*\./gi, '')), `${f} claims completeness`);
    assert.ok(!/\bcompliant\b|\bcertified\b/i.test(text.replace(/not a certification/gi, '')), `${f} claims compliance`);
  }
});

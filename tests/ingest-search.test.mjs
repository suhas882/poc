import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeDocx, makePdf, makeXlsx, searchReq, startApp } from './helpers.mjs';
import { chunkText, extractEntities } from '../server/ingest/pipeline.mjs';
import { parseWhatsAppTxt } from '../server/ingest/messages.mjs';
import { ftsQuery } from '../server/search/hybrid.mjs';
import { parseDateRange, rulesPlan } from '../server/ai/planner.mjs';

const plan = (p) => ({ keywords: [], alternateTerms: [], phrases: [], people: [], organizations: [], locations: [], dateFrom: null, dateTo: null, departments: [], recordTypes: [], sourceIds: [], exclusions: [], ...p });

async function search(c, requestText, edits = {}, mode = 'real') {
  const s = await searchReq(c, requestText, { edits, mode });
  assert.equal(s.runStatus, 200, JSON.stringify(s.runError || s.confirm?.data || s.create?.data));
  return s;
}

test('uploads: PDF, DOCX, XLSX, CSV, TXT are extracted and searchable; bad files are rejected', async (t) => {
  const env = await startApp({ UPLOAD_MAX_BYTES: String(200 * 1024) });
  t.after(() => env.close());
  const c = env.client();
  await c.setup();

  let r = await c.upload('closure-memo.pdf', makePdf(['Memo: Cedar Avenue road closure', 'Crews from Utilities replaced the water main.'], { title: 'Cedar Avenue closure memo' }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.data.extraction, 'ok');
  const pdfId = r.data.data.recordId;

  r = await c.upload('detour-plan.docx', makeDocx(['Detour plan for Cedar Avenue', 'Traffic control was in place from January to March 2025.'], { title: 'Detour plan' }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await c.upload('permits.xlsx', makeXlsx([['Permit', 'Street', 'Work'], ['P-77', 'Cedar Avenue', 'Excavation permit for utility work']]));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await c.upload('complaints.csv', Buffer.from('date,street,complaint\n2025-02-02,Cedar Avenue,"Noise from night work, ""loud"""\n'));
  assert.equal(r.status, 201);
  r = await c.upload('notes.txt', Buffer.from('Unrelated note about park benches on Pine Street.'));
  assert.equal(r.status, 201);

  // Same file again is recognised, not duplicated.
  r = await c.upload('notes-copy.txt', Buffer.from('Unrelated note about park benches on Pine Street.'));
  assert.equal(r.data.data.result, 'unchanged');

  assert.equal((await c.upload('evil.pdf', Buffer.from('not really a pdf'))).status, 415, 'extension must match the contents');
  assert.equal((await c.upload('tool.exe', Buffer.from('MZ\x90\x00'))).status, 415);
  assert.equal((await c.upload('big.txt', Buffer.alloc(300 * 1024, 97))).status, 413);
  assert.equal((await c.upload('../../etc/passwd.txt', Buffer.from('root:x:0:0'))).status, 201, 'path parts are stripped from names');

  // Original file can be downloaded through the API only.
  r = await c.get(`/api/records/${pdfId}/original`);
  assert.equal(r.status, 200);
  assert(String(r.data).startsWith('%PDF-'));

  const s = await search(c, 'Records about the road closure on Cedar Avenue');
  const titles = s.results.map(x => x.record.title);
  assert(titles.some(t => /closure memo/i.test(t)), titles.join(' | '));
  assert(titles.some(t => /Detour plan/i.test(t)));
  assert(!titles.some(t => /notes/i.test(t)), 'unrelated records are not returned');
  const memo = s.results.find(x => /closure memo/i.test(x.record.title));
  assert.equal(memo.matchType, 'exact');
  assert(memo.reasons.length > 0 && memo.snippet.includes('Cedar Avenue'));
  assert.equal(memo.record.isSynthetic, false);
  assert.equal(memo.record.sourceType, 'uploads');
  assert.equal(memo.record.createdAt?.slice(0, 10), '2025-03-05', 'PDF creation date is used');

  // Exclusions and date filters.
  const s2 = await search(c, 'Cedar Avenue closure', { exclusions: ['detour'] });
  assert(!s2.results.some(x => /Detour plan/.test(x.record.title)));
  const s3 = await search(c, 'Cedar Avenue', { dateFrom: '2025-03-01', dateTo: '2025-03-31' });
  assert(s3.results.every(x => x.record.createdAt >= '2025-03-01'), 'date filter is strict');

  // Delete propagates to search.
  assert.equal((await c.del(`/api/records/${pdfId}`)).status, 200);
  const s4 = await search(c, 'Records about the road closure on Cedar Avenue');
  assert(!s4.results.some(x => x.record.id === pdfId));
  assert.equal((await c.get(`/api/records/${pdfId}`)).status, 404);
});

test('message exports: SMS Backup XML, WhatsApp text and CSV', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  await c.setup();
  const xml = `<?xml version='1.0'?><smses count="2"><sms address="+15550100" date="${Date.parse('2025-01-20T15:00:00Z')}" type="1" body="Crews closed a Cedar Avenue lane again, detour posted" contact_name="Sam Lee" /><sms address="+15550100" date="${Date.parse('2025-01-20T15:05:00Z')}" type="2" body="Thanks, logging it" contact_name="Sam Lee" /></smses>`;
  let r = await c.upload('sms-2025.xml', Buffer.from(xml), '?kind=messages');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.data.messages, 2); assert.equal(r.data.data.conversationDays, 1);
  r = await c.upload('WhatsApp Chat with Field Team.txt', Buffer.from('20/01/2025, 09:15 - Jo: Detour signs are up on Cedar Avenue\n20/01/2025, 09:16 - Ana: ok\nsecond line\n'), '?kind=messages');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await c.upload('messages.csv', Buffer.from('date,from,to,body\n2025-02-01T10:00:00Z,Dispatch,Crew 4,Water main valve replaced\n'), '?kind=messages');
  assert.equal(r.status, 201);
  r = await c.upload('random.txt', Buffer.from('hello'), '?kind=messages');
  assert.equal(r.status, 415);
  const s = await search(c, 'messages about Cedar Avenue detour');
  assert(s.results.some(x => x.record.documentType === 'Message conversation' && /WhatsApp/.test(x.record.title)));
  assert(s.results.some(x => /SMS/.test(x.record.title)));
  const wa = parseWhatsAppTxt('[20/01/2025, 9:15:02 PM] Jo: hi');
  assert.equal(wa[0].at, '2025-01-20T21:15:02.000Z', 'iOS 12-hour format');
});

test('access control: owner-only sources, role sharing, tenant isolation, synthetic separation', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const admin = env.client();
  await admin.setup();
  await admin.post('/api/users', { email: 'o@x.org', name: 'Olu Officer', role: 'records_officer', password: 'officer password 1' });
  await admin.post('/api/users', { email: 'r@x.org', name: 'Rae Reviewer', role: 'reviewer', password: 'reviewer password 1' });
  const officer = env.client(); await officer.login('o@x.org', 'officer password 1');
  const reviewer = env.client(); await reviewer.login('r@x.org', 'reviewer password 1');

  let r = await officer.upload('private.txt', Buffer.from('Confidential: Cedar Avenue settlement negotiation notes.'));
  const recId = r.data.data.recordId, srcId = r.data.data.sourceId;

  // Not shared: reviewer and admin cannot find or open it.
  // With nothing shared, there is no source to search: confirming says so instead of silently returning nothing.
  let s = await searchReq(reviewer, 'Cedar Avenue settlement');
  assert.equal(s.confirmStatus, 400);
  assert.equal(s.confirm.data.error.code, 'no_sources');
  assert.equal((await reviewer.get(`/api/records/${recId}`)).status, 404);
  s = await searchReq(admin, 'Cedar Avenue settlement');
  assert(s.confirmStatus === 400 || !s.results.some(x => x.record.id === recId), 'even supervisors only see what is shared with them');
  assert.equal((await reviewer.patch(`/api/sources/${srcId}`, { visibility: 'roles' })).status, 403, 'only the owner or an admin can change sharing');

  // Shared with reviewers.
  assert.equal((await officer.patch(`/api/sources/${srcId}`, { visibility: 'roles', allowedRoles: ['reviewer'] })).status, 200);
  s = await search(reviewer, 'Cedar Avenue settlement');
  const hit = s.results.find(x => x.record.id === recId);
  assert(hit, 'shared record is found');
  assert.equal((await reviewer.get(`/api/records/${recId}`)).status, 200);

  // Un-sharing applies to existing result lists immediately.
  await officer.patch(`/api/sources/${srcId}`, { visibility: 'owner' });
  const again = await reviewer.get(`/api/requests/${s.id}/results`);
  assert(!again.data.data.some(x => x.record.id === recId));
  assert.equal((await reviewer.put(`/api/requests/${s.id}/marks/${recId}`, { mark: 'relevant' })).status, 404);

  // Another tenant can never see it, even with sharing to all roles.
  await officer.patch(`/api/sources/${srcId}`, { visibility: 'roles', allowedRoles: [] });
  const db = env.app.db;
  db.run("INSERT INTO tenants (id, name) VALUES ('t2', 'Other City')");
  const { hashPassword } = await import('../server/security.mjs');
  db.run("INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES ('u2', 't2', 'z@other.org', 'Zed', 'admin', ?)", hashPassword('other tenant password'));
  const other = env.client(); await other.login('z@other.org', 'other tenant password');
  assert.equal((await other.get(`/api/records/${recId}`)).status, 404);
  assert.equal((await other.get(`/api/requests/${s.id}`)).status, 404);
  assert(!(await other.get('/api/sources')).data.data.some(x => x.id === srcId));
  assert.equal((await other.del(`/api/sources/${srcId}`)).status, 404);

  // Synthetic records never appear in Real Data Mode, and real records never appear in Demo Mode.
  s = await search(officer, 'road closure Cedar Avenue right-of-way');
  assert(s.results.every(x => !x.record.isSynthetic));
  const demo = await search(officer, 'road closure Cedar Avenue right-of-way', {}, 'demo');
  assert(demo.results.length > 0 && demo.results.every(x => x.record.isSynthetic));
  assert(!demo.results.some(x => x.record.id === recId));

  // Requests are team work inside one organization, never across organizations.
  assert((await reviewer.get('/api/requests')).data.data.length >= 1);
  assert.equal((await other.get('/api/requests')).data.data.length, 0);
});

test('demo mode on the server reproduces the synthetic benchmark behaviour', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  await c.setup();
  const s = await search(c, 'Please send records about the road closure on Cedar Avenue while utility crews did their work.', {}, 'demo');
  assert.equal(s.origin, 'rules', 'without an API key the local planner is used');
  assert(s.plan.alternateTerms.includes('lane closure'));
  const relevant = new Set(['R-001', 'R-002', 'R-005', 'R-008', 'R-009', 'R-011', 'R-018']);
  const top10 = s.results.slice(0, 10).map(x => x.record.sourceRecordId);
  assert(top10.filter(id => relevant.has(id)).length >= 5, top10.join(','));
  assert(s.results.some(x => ['alternate', 'meaning'].includes(x.matchType)), 'some records match only through related wording');
  assert(s.results.filter(x => x.groupKey === 'thread:synthetic:cedar-detour-thread').length === 3, 'the email thread is grouped');
  assert(s.results.every(x => x.why && x.snippet), 'every result has a reason and a passage');
});

test('semantic search with an embedding provider labels meaning-only matches', async (t) => {
  // Deterministic fake embedder: a vector per concept so "pothole" and "road surface damage" are close.
  const concepts = ['pothole road surface damage asphalt', 'budget finance invoice payment', 'tree park bench'];
  const embed = (text) => concepts.map(c => c.split(' ').reduce((n, w) => n + (text.toLowerCase().includes(w) ? 1 : 0), 0) + 0.01);
  const env = await startApp({}, { embedder: { model: 'fake-1', provider: 'test', embed: async (texts) => texts.map(embed) } });
  t.after(() => env.close());
  const c = env.client();
  await c.setup();
  await c.upload('crew-report.txt', Buffer.from('Crew report: asphalt patching where the road surface damage was worst.'));
  await c.upload('budget.txt', Buffer.from('Quarterly invoice payment summary.'));
  const s = await search(c, 'pothole complaints', { keywords: ['pothole'], alternateTerms: [] });
  const hit = s.results.find(x => /Crew report/.test(x.record.title) || /crew-report/.test(x.record.title));
  assert(hit, JSON.stringify(s.results.map(x => x.record.title)));
  assert.equal(hit.matchType, 'semantic');
  assert(hit.similarity > 0.5);
});

test('export: CSV is audited and spreadsheet formulas are neutralised', async (t) => {
  const env = await startApp();
  t.after(() => env.close());
  const c = env.client();
  await c.setup();
  await c.upload('order.docx', makeDocx(['Cedar Avenue closure order number 7'], { title: '=HYPERLINK(evil)' }));
  const s = await search(c, 'Cedar Avenue closure order');
  const r = await c.get(`/api/requests/${s.id}/export/candidates.csv`);
  assert.equal(r.status, 200);
  assert(!/,"=HYPERLINK/.test(r.data), 'formula cells are prefixed');
  assert(/"'=HYPERLINK/.test(r.data));
  const audit = (await c.get('/api/audit?action=export.created')).data.data;
  assert.equal(audit.length, 1);
});

test('unit: chunking, entities, FTS query safety, date parsing, rules planner', () => {
  const text = 'A'.repeat(1000) + '. ' + 'B'.repeat(1500);
  const chunks = chunkText(text, 1200, 200);
  assert(chunks.length >= 2 && chunks.every(c => c.text.length <= 1200));
  assert.equal(chunks[0].start, 0);
  const e = extractEntities('Email pat@city.gov on January 5, 2025 about $1,200 for Cedar Avenue.');
  assert.deepEqual(e.emails, ['pat@city.gov']);
  assert(e.dates.includes('January 5, 2025'));
  assert.equal(ftsQuery(['road "closure"', 'NEAR(x)', '*', 'a']), '"road closure" OR "near x"');
  assert.deepEqual(parseDateRange('between January and March 2025'), { from: '2025-01-01', to: '2025-03-31' });
  assert.deepEqual(parseDateRange('emails from Nov 2024 to Feb 2025'), { from: '2024-11-01', to: '2025-02-28' });
  assert.deepEqual(parseDateRange('since 2023'), { from: '2023-01-01', to: null });
  const p = rulesPlan('Please provide all emails related to the road closure on Cedar Avenue between January and March 2025.', { sourceIds: [] });
  assert(p.phrases.includes('Cedar Avenue'));
  assert(p.keywords.includes('road closure'));
  assert(p.recordTypes.includes('Email'));
  assert.equal(p.dateFrom, '2025-01-01');
  assert(!p.keywords.some(k => /january|2025/.test(k)));
  void crypto; void plan;
});

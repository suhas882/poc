// @ts-check
/**
 * Evaluation on the labeled test set (invented requests over the synthetic corpus): keyword-only versus hybrid,
 * the "replay closed requests" view, and two-person labeling. Results are demo results on invented data, not
 * production performance. Targets are outcomes to be validated during discovery [est.].
 */
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, ok, readJson, SECURITY_HEADERS, validate } from '../http.mjs';
import { can, requirePermission } from '../auth.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { ROOT } from '../config.mjs';
import { hybridSearch, termsIn } from '../search/hybrid.mjs';
import { keywordsOf } from '../ingest/pipeline.mjs';
import { activePack } from '../packs.mjs';

const list = (s) => String(s || '').split(/[,;]+/).map(x => x.trim()).filter(Boolean);
const mean = (xs) => xs.length ? Math.round(1000 * xs.reduce((a, b) => a + b, 0) / xs.length) / 1000 : null;

export function loadTestSet() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-requests.json'), 'utf8')).scenarios;
}

/** @param {import('../http.mjs').Router} router */
export function registerEvaluationRoutes(router, s) {
  const { db, audit } = s;

  /** Map the corpus IDs (R-001) to this organization's synthetic record IDs. */
  function corpus(user) {
    const rows = db.all("SELECT r.id, r.source_record_id, r.title, r.content, r.department, r.document_type, r.created_at FROM records r JOIN sources s ON s.id = r.source_id WHERE r.tenant_id = ? AND s.type = 'synthetic'", user.tenantId);
    return { rows, byCorpusId: new Map(rows.map(r => [r.source_record_id, r])), byId: new Map(rows.map(r => [r.id, r])) };
  }

  /** Adjudicated labels win over the provisional labels shipped with the test set. */
  function relevantFor(user, sc) {
    const adj = db.all("SELECT record_id, label FROM eval_labels WHERE tenant_id = ? AND scenario_id = ? AND role = 'adjudicator'", user.tenantId, sc.id);
    if (adj.length) return { ids: new Set(adj.filter(a => a.label === 'relevant').map(a => a.record_id)), source: 'adjudicated' };
    return { ids: new Set(sc.relevant), source: 'provisional' };
  }

  async function runScenario(user, sc, pack, keywordOnly) {
    const plan = { keywords: list(sc.topics), alternateTerms: keywordOnly ? [] : list(sc.alternate), phrases: [], people: [], organizations: [], locations: [], dateFrom: null, dateTo: null, departments: [], recordTypes: [], sourceIds: [], exclusions: [] };
    const t0 = performance.now();
    const found = await hybridSearch(db, { user, mode: 'demo', plan, concepts: pack.concepts, keywordOnly, arguablyBelow: pack.reviewRules.arguablyBelow, limit: 100 });
    return { plan, ms: performance.now() - t0, ranked: found.results.map(r => r.recordId) };
  }

  function metrics(ranked, relevant, ms) {
    const rel = [...relevant];
    if (!rel.length) return null;
    const hit = (k) => ranked.slice(0, k).filter(id => relevant.has(id)).length;
    const first = ranked.findIndex(id => relevant.has(id));
    return { recall10: hit(10) / rel.length, recall50: hit(50) / rel.length, precision10: Math.min(10, ranked.length) ? hit(10) / Math.min(10, ranked.length) : 0, firstRank: first < 0 ? null : first + 1, ms };
  }

  async function evaluate(user) {
    const pack = activePack(db, user.tenantId);
    const c = corpus(user);
    if (!c.rows.length) throw new HttpError(409, 'no_corpus', 'The synthetic corpus is not loaded for this organization.');
    const out = [];
    for (const sc of loadTestSet()) {
      const relCorpus = relevantFor(user, sc);
      const relevant = new Set([...relCorpus.ids].map(id => c.byCorpusId.get(id)?.id).filter(Boolean));
      const kw = await runScenario(user, sc, pack, true);
      const hy = await runScenario(user, sc, pack, false);
      out.push({ sc, relevant, labels: relCorpus.source, keyword: { ...kw, m: metrics(kw.ranked, relevant, kw.ms) }, hybrid: { ...hy, m: metrics(hy.ranked, relevant, hy.ms) } });
    }
    return { pack, corpus: c, out };
  }

  router.on('GET', '/api/evaluation/benchmark', async ({ res, user }) => {
    if (!can(user, 'records.read') && !can(user, 'history.read_all')) throw new HttpError(403, 'forbidden', 'Your role cannot see the evaluation.');
    const { out } = await evaluate(user);
    const agg = (k) => {
      const ms = out.map(o => o[k].m).filter(Boolean);
      return { recall10: mean(ms.map(m => m.recall10)), recall50: mean(ms.map(m => m.recall50)), precision10: mean(ms.map(m => m.precision10)),
        meanFirstRank: mean(ms.map(m => m.firstRank ?? 51)), medianMs: (() => { const v = ms.map(m => m.ms).sort((a, b) => a - b); return v.length ? Math.round(v[Math.floor(v.length / 2)] * 10) / 10 : null; })() };
    };
    const kinds = {};
    for (const o of out) kinds[o.sc.type] = (kinds[o.sc.type] || 0) + 1;
    ok(res, {
      banner: 'Demo results on public and invented data, not production performance. Targets are outcomes to be validated during discovery [est.].',
      requests: out.length, kinds, labels: { adjudicated: out.filter(o => o.labels === 'adjudicated').length, provisional: out.filter(o => o.labels === 'provisional').length },
      keyword: agg('keyword'), hybrid: agg('hybrid'),
      perRequest: out.map(o => ({ id: o.sc.id, label: o.sc.label, type: o.sc.type, labels: o.labels, relevant: o.relevant.size, keyword: o.keyword.m, hybrid: o.hybrid.m }))
    });
  });

  function missedReason(rec, plan, pack) {
    const planTerms = [...plan.keywords, ...plan.alternateTerms];
    const uses = keywordsOf(`${rec.title} ${rec.content}`, 6);
    const lacked = planTerms.filter(t => !termsIn(`${rec.title}\n${rec.content}`, [t]).length);
    const concepts = pack.concepts.flat().filter(c => termsIn(`${rec.title}\n${rec.content}`, [c]).length && !planTerms.some(p => p.toLowerCase() === c));
    const suggested = concepts[0] || uses.find(w => !planTerms.some(p => p.toLowerCase().includes(w))) || null;
    return { uses, lacked, suggested };
  }

  async function replay(user) {
    const { pack, corpus: c, out } = await evaluate(user);
    return out.map(o => {
      const top50 = new Set(o.hybrid.ranked.slice(0, 50));
      const kw50 = new Set(o.keyword.ranked.slice(0, 50));
      const missed = [...o.relevant].filter(id => !top50.has(id)).map(id => { const r = c.byId.get(id); return { recordId: id, corpusId: r.source_record_id, title: r.title, ...missedReason(r, o.hybrid.plan, pack) }; });
      return {
        id: o.sc.id, label: o.sc.label, type: o.sc.type, request: o.sc.request, labels: o.labels,
        released: o.relevant.size, inTop50: [...o.relevant].filter(id => top50.has(id)).length,
        recall: o.relevant.size ? Math.round(1000 * [...o.relevant].filter(id => top50.has(id)).length / o.relevant.size) / 1000 : null,
        keywordRecall: o.relevant.size ? Math.round(1000 * [...o.relevant].filter(id => kw50.has(id)).length / o.relevant.size) / 1000 : null,
        missed
      };
    });
  }

  router.on('GET', '/api/evaluation/replay', async ({ res, user, url, ipHash }) => {
    if (!can(user, 'records.read') && !can(user, 'history.read_all')) throw new HttpError(403, 'forbidden', 'Your role cannot see the evaluation.');
    const rows = await replay(user);
    if (url.searchParams.get('format') === 'csv') {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [['Request', 'Kind', 'Labels', 'Records released (sample)', 'In top 50', 'Recall', 'Keyword-only recall', 'Missed record', 'Words it uses', 'Plan terms it lacked', 'Suggested term'].map(q).join(',')];
      for (const r of rows) {
        if (!r.missed.length) lines.push([r.label, r.type, r.labels, r.released, r.inTop50, r.recall, r.keywordRecall, '', '', '', ''].map(q).join(','));
        for (const m of r.missed) lines.push([r.label, r.type, r.labels, r.released, r.inTop50, r.recall, r.keywordRecall, `${m.corpusId} ${m.title}`, m.uses.join('; '), m.lacked.join('; '), m.suggested ?? ''].map(q).join(','));
      }
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'export.created', targetType: 'evaluation', targetId: 'replay', ipHash, details: { format: 'csv', file: 'replay' } });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="replay-sample-data.csv"', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end('﻿' + lines.join('\r\n'));
    }
    ok(res, { banner: 'SAMPLE DATA. Invented closed requests and invented released records. Tier 1 uses Bellevue closed requests only after Bellevue approves.', requests: rows });
  });

  router.on('GET', '/api/samples', ({ res, user }) => {
    if (!user) throw new HttpError(401, 'not_signed_in', 'Sign in to continue.');
    ok(res, loadTestSet().map(x => ({ id: x.id, label: x.label, type: x.type, request: x.request })));
  });

  /* ---- two-person labeling ---- */

  router.on('GET', '/api/evaluation/labels', ({ res, user, url }) => {
    requirePermission(user, 'evaluate.write');
    const scenarios = loadTestSet();
    const sc = scenarios.find(x => x.id === url.searchParams.get('scenario')) || scenarios[0];
    const role = ['reviewer1', 'reviewer2', 'adjudicator'].includes(url.searchParams.get('role') || '') ? url.searchParams.get('role') : 'reviewer1';
    const c = corpus(user);
    const labels = db.all('SELECT record_id, role, label FROM eval_labels WHERE tenant_id = ? AND scenario_id = ?', user.tenantId, sc.id);
    const get = (rid, r) => labels.find(l => l.record_id === rid && l.role === r)?.label ?? null;
    const isAdj = role === 'adjudicator';
    const rows = c.rows.sort((a, b) => a.source_record_id.localeCompare(b.source_record_id)).map(r => {
      const r1 = get(r.source_record_id, 'reviewer1'), r2 = get(r.source_record_id, 'reviewer2');
      return {
        corpusId: r.source_record_id, title: r.title, department: r.department, type: r.document_type, date: r.created_at?.slice(0, 10),
        mine: get(r.source_record_id, role),
        // Reviewers label independently: the other reviewer's label and the reference are hidden until adjudication.
        reviewer1: isAdj ? r1 : null, reviewer2: isAdj ? r2 : null,
        status: isAdj ? (r1 && r2 ? (r1 === r2 ? 'Agreement' : 'Difference') : 'Pending') : 'Hidden during reviewer entry',
        reference: isAdj ? (sc.relevant.includes(r.source_record_id) ? 'relevant' : 'not relevant') : null
      };
    });
    ok(res, { scenarios: scenarios.map(x => ({ id: x.id, label: x.label, type: x.type, request: x.request })), scenario: sc.id, role, rows,
      differences: rows.filter(r => r.status === 'Difference').length, labeled: rows.filter(r => r.mine).length });
  });

  router.on('PUT', '/api/evaluation/labels', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'evaluate.write');
    const body = validate({ scenarioId: { type: 'string', required: true, max: 40 }, recordId: { type: 'string', required: true, max: 40 },
      role: { type: 'string', required: true, values: ['reviewer1', 'reviewer2', 'adjudicator'] }, label: { type: 'string', required: true, values: ['relevant', 'not_relevant', 'unsure'] } }, await readJson(req));
    if (body.role === 'adjudicator' && user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only a Supervisor settles differences.');
    if (!loadTestSet().some(x => x.id === body.scenarioId)) throw new HttpError(404, 'not_found', 'Unknown test request.');
    const before = db.get('SELECT label FROM eval_labels WHERE tenant_id = ? AND scenario_id = ? AND record_id = ? AND role = ?', user.tenantId, body.scenarioId, body.recordId, body.role)?.label ?? null;
    db.run(`INSERT INTO eval_labels (tenant_id, scenario_id, record_id, role, label, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, scenario_id, record_id, role) DO UPDATE SET label = excluded.label, user_id = excluded.user_id, updated_at = excluded.updated_at`,
    user.tenantId, body.scenarioId, body.recordId, body.role, body.label, user.id, nowIso());
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'evaluation.label_saved', targetType: 'evaluation', targetId: `${body.scenarioId}/${body.recordId}`, ipHash, details: { role: body.role }, before, after: body.label });
    ok(res, { saved: true });
  });

  void parseJson;
}

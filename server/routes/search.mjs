// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, ok, pageParams, readJson, SECURITY_HEADERS, validate } from '../http.mjs';
import { can, requirePermission } from '../auth.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { cleanPlan, draftPlan, KNOWN_DEPARTMENTS, planHasTerms } from '../ai/planner.mjs';
import { summarize } from '../ai/summarizer.mjs';
import { AiError } from '../ai/provider.mjs';
import { accessFilter, hybridSearch, snippetAround } from '../search/hybrid.mjs';
import { recordView } from '../ingest/pipeline.mjs';
import { isPhoneLink } from '../connectors/phonelink.mjs';
import { startSync } from './sources.mjs';
import { applyConsent, consentRequired, getConsent } from '../consent.mjs';

const MIME = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp' };

/** Sources this user can search in a mode (used to scope plans). */
function searchableSources(db, user, mode) {
  const rows = db.all(`SELECT s.id, s.name, s.type FROM sources s WHERE s.tenant_id = ? AND s.status != 'disconnected' AND (s.type = 'synthetic') = ?
    AND ((s.visibility = 'owner' AND s.owner_user_id = ?) OR (s.visibility = 'roles' AND (s.allowed_roles = '[]' OR EXISTS (SELECT 1 FROM json_each(s.allowed_roles) WHERE value = ?))))
    ORDER BY s.name`, user.tenantId, mode === 'demo' ? 1 : 0, user.id, user.role);
  return mode === 'real' ? applyConsent(db, user, rows) : rows;
}

function requireConsent(db, user, mode) {
  if (mode === 'real' && consentRequired(db, user)) throw new HttpError(428, 'consent_required', 'Before searching real records, choose what this app may search for you on the permission screen.');
}

function loadSearch(db, user, id, { needResults = false } = {}) {
  const row = db.get('SELECT q.*, u.name AS user_name FROM search_requests q LEFT JOIN users u ON u.id = q.user_id WHERE q.id = ? AND q.tenant_id = ?', id, user.tenantId);
  if (!row) throw new HttpError(404, 'not_found', 'That search does not exist (it may have been removed by the retention policy).');
  const own = row.user_id === user.id;
  if (!own && !can(user, 'history.read_all')) throw new HttpError(403, 'forbidden', 'You can only open your own searches.');
  if (needResults && !can(user, 'records.read')) throw new HttpError(403, 'forbidden', 'Your role can see search history but not the records themselves.');
  return { row, own };
}

/** @param {import('../http.mjs').Router} router */
export function registerSearchRoutes(router, s) {
  const { db, audit } = s;

  router.on('POST', '/api/searches/plan', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'search.run');
    const limit = s.limits.search.take(user.id);
    if (!limit.allowed) throw new HttpError(429, 'rate_limited', `You’ve run a lot of searches in the last minute. Try again in ${limit.retryAfter} seconds.`);
    const body = validate({ requestText: { type: 'string', required: true, min: 3, max: 6000 }, mode: { type: 'string', values: ['real', 'demo'], default: 'real' } }, await readJson(req));
    requireConsent(db, user, body.mode);
    const sources = searchableSources(db, user, body.mode);
    const acl = accessFilter(user, body.mode);
    const departments = [...new Set([...db.all(`SELECT DISTINCT r.department FROM records r JOIN sources s ON s.id = r.source_id WHERE ${acl.sql} AND r.department IS NOT NULL LIMIT 40`, ...acl.params).map(r => r.department), ...KNOWN_DEPARTMENTS])];
    const drafted = await draftPlan({ provider: s.ai, requestText: body.requestText, sources, departments, tenantId: user.tenantId, userId: user.id });
    const id = crypto.randomUUID();
    db.tx(() => {
      db.run("INSERT INTO search_requests (id, tenant_id, user_id, mode, request_text, status, created_at) VALUES (?, ?, ?, ?, ?, 'planned', ?)", id, user.tenantId, user.id, body.mode, body.requestText, nowIso());
      db.run('INSERT INTO search_plans (search_id, origin, model, plan) VALUES (?, ?, ?, ?)', id, drafted.origin, drafted.model, JSON.stringify(drafted.plan));
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'search.planned', targetType: 'search', targetId: id, ipHash, details: { mode: body.mode, origin: drafted.origin, fallback: drafted.fallbackReason ?? null, requestChars: body.requestText.length } });
    ok(res, { searchId: id, mode: body.mode, plan: drafted.plan, origin: drafted.origin, model: drafted.model, fallbackReason: drafted.fallbackReason ?? null, sources, departments: departments.slice(0, 40) }, undefined, 201);
  });

  router.on('POST', '/api/searches/:id/run', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const { row, own } = loadSearch(db, user, params.id);
    if (!own) throw new HttpError(403, 'forbidden', 'Only the person who planned this search can run it.');
    const body = validate({ plan: { type: 'object', required: true }, confirmed: { type: 'bool', required: true } }, await readJson(req));
    if (body.confirmed !== true) throw new HttpError(400, 'not_confirmed', 'Confirm that you reviewed the search plan before searching.');
    requireConsent(db, user, row.mode);
    const sources = searchableSources(db, user, row.mode);
    const plan = cleanPlan(body.plan, { sourceIds: sources.map(x => x.id) });
    // With "only the sources I choose", an empty selection means the permitted sources, never everything.
    const askedFor = Array.isArray(body.plan.sourceIds) ? body.plan.sourceIds.length : 0;
    if (row.mode === 'real' && !plan.sourceIds.length && (askedFor || getConsent(db, user.id)?.scope === 'selected')) plan.sourceIds = askedFor || !sources.length ? ['__none__'] : sources.map(x => x.id);
    if (!planHasTerms(plan)) throw new HttpError(400, 'empty_plan', 'Add at least one keyword, phrase, name or alternate term to search for.');
    // Check Phone Link directly: if new texts arrived since the last sync, index them before searching (up to 20 seconds).
    if (row.mode === 'real') {
      const searched = new Set(plan.sourceIds.length ? plan.sourceIds : sources.map(x => x.id));
      const waits = [];
      for (const src of db.all("SELECT * FROM sources WHERE tenant_id = ? AND type = 'messages' AND status != 'disconnected'", user.tenantId)) {
        if (!searched.has(src.id) || !isPhoneLink(src)) continue;
        try { if (!s.running.has(src.id) && s.phonelink.isStale(src)) startSync(s, src, user, 'before_search'); } catch { /* search what is already indexed */ }
        if (s.running.has(src.id)) waits.push(s.running.get(src.id));
      }
      if (waits.length) await Promise.race([Promise.allSettled(waits), new Promise(r => setTimeout(r, 20_000).unref())]);
    }
    const started = performance.now();
    let found;
    try {
      found = await hybridSearch(db, { user, mode: row.mode, plan, embedder: s.embedder, requestText: row.request_text });
    } catch (err) {
      db.run("UPDATE search_requests SET status = 'failed', error = ? WHERE id = ?", 'Search failed', row.id);
      throw err;
    }
    db.tx(() => {
      db.run('DELETE FROM search_results WHERE search_id = ?', row.id);
      db.run('DELETE FROM search_summaries WHERE search_id = ?', row.id);
      for (const r of found.results) db.run('INSERT INTO search_results (search_id, record_id, rank, score, match, group_key) VALUES (?, ?, ?, ?, ?, ?)', row.id, r.recordId, r.rank, r.score, JSON.stringify(r.match), r.groupKey);
      db.run("UPDATE search_requests SET status = 'completed', completed_at = ?, duration_ms = ?, result_count = ?, error = NULL WHERE id = ?", nowIso(), Math.round(performance.now() - started), found.results.length, row.id);
      db.run('UPDATE search_plans SET confirmed_plan = ?, confirmed_at = ? WHERE search_id = ?', JSON.stringify(plan), nowIso(), row.id);
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'search.run', targetType: 'search', targetId: row.id, ipHash, details: { mode: row.mode, results: found.results.length, ...found.stats, sources: plan.sourceIds.length || 'all' } });
    ok(res, { searchId: row.id, total: found.results.length, stats: { ...found.stats, sourcesSearched: plan.sourceIds.length || sources.length } });
  });

  router.on('GET', '/api/searches/:id', ({ res, user, params }) => {
    const { row } = loadSearch(db, user, params.id);
    const plan = db.get('SELECT * FROM search_plans WHERE search_id = ?', row.id);
    const summary = db.get('SELECT * FROM search_summaries WHERE search_id = ?', row.id);
    ok(res, {
      id: row.id, mode: row.mode, requestText: row.request_text, status: row.status, createdAt: row.created_at, completedAt: row.completed_at,
      durationMs: row.duration_ms, resultCount: row.result_count, user: { id: row.user_id, name: row.user_name }, isOwn: row.user_id === user.id,
      plan: parseJson(plan?.confirmed_plan || plan?.plan, null), planOrigin: plan?.origin, planModel: plan?.model, confirmedAt: plan?.confirmed_at,
      summary: summary ? { ...parseJson(summary.summary, {}), model: summary.model, createdAt: summary.created_at } : null,
      aiConfigured: Boolean(s.ai), semanticSearch: Boolean(s.embedder), sourcesAvailable: searchableSources(db, user, row.mode).length
    });
  });

  router.on('GET', '/api/searches/:id/results', ({ res, user, params, url }) => {
    requirePermission(user, 'records.read');
    const { row } = loadSearch(db, user, params.id, { needResults: true });
    const { page, size, offset } = pageParams(url, 20, 100);
    // Re-apply the viewer's access rules on every read, so revoked sharing takes effect immediately.
    const acl = accessFilter(user, row.mode);
    const filters = [], fp = [];
    const f = (k) => url.searchParams.get(k);
    if (f('sourceType')) { filters.push('r.source_type = ?'); fp.push(f('sourceType')); }
    if (f('matchType')) { filters.push("json_extract(sr.match, '$.matchType') = ?"); fp.push(f('matchType')); }
    if (f('band')) { filters.push("json_extract(sr.match, '$.band') = ?"); fp.push(f('band')); }
    if (f('department')) { filters.push('r.department = ?'); fp.push(f('department')); }
    if (f('judgment')) { filters.push(f('judgment') === 'none' ? 'e.judgment IS NULL' : 'e.judgment = ?'); if (f('judgment') !== 'none') fp.push(f('judgment')); }
    const sort = { newest: 'r.created_at DESC NULLS LAST, sr.rank', oldest: 'r.created_at ASC NULLS LAST, sr.rank', title: 'r.title COLLATE NOCASE, sr.rank' }[f('sort') || ''] || 'sr.rank';
    const collapse = f('group') === '1';
    const base = `FROM search_results sr JOIN records r ON r.id = sr.record_id JOIN sources s ON s.id = r.source_id
      LEFT JOIN evaluations e ON e.search_id = sr.search_id AND e.record_id = sr.record_id AND e.user_id = ?
      WHERE sr.search_id = ? AND ${acl.sql}${filters.length ? ' AND ' + filters.join(' AND ') : ''}`;
    const baseParams = [user.id, row.id, ...acl.params, ...fp];
    const groupSql = collapse ? ` AND (sr.group_key IS NULL OR sr.rank = (SELECT MIN(x.rank) FROM search_results x WHERE x.search_id = sr.search_id AND x.group_key = sr.group_key))` : '';
    const total = db.get(`SELECT COUNT(*) AS n ${base}${groupSql}`, ...baseParams).n;
    const rows = db.all(`SELECT sr.rank, sr.score, sr.match, sr.group_key, r.*, s.name AS source_name, e.judgment, e.note,
        (SELECT COUNT(*) FROM search_results g WHERE g.search_id = sr.search_id AND g.group_key = sr.group_key) AS group_size
      ${base}${groupSql} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...baseParams, size, offset);
    const summary = parseJson(db.get('SELECT summary FROM search_summaries WHERE search_id = ?', row.id)?.summary, null);
    const assessments = new Map((summary?.assessments || []).map(a => [a.recordId, a]));
    const facets = {
      sourceType: db.all(`SELECT r.source_type AS value, COUNT(*) AS n ${base} GROUP BY 1 ORDER BY 2 DESC`, ...baseParams),
      matchType: db.all(`SELECT json_extract(sr.match, '$.matchType') AS value, COUNT(*) AS n ${base} GROUP BY 1 ORDER BY 2 DESC`, ...baseParams),
      band: db.all(`SELECT json_extract(sr.match, '$.band') AS value, COUNT(*) AS n ${base} GROUP BY 1 ORDER BY 2 DESC`, ...baseParams),
      department: db.all(`SELECT r.department AS value, COUNT(*) AS n ${base} AND r.department IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, ...baseParams)
    };
    ok(res, rows.map(r => ({
      rank: r.rank, ...parseJson(r.match, {}), groupKey: r.group_key, groupSize: r.group_key ? r.group_size : 1,
      judgment: r.judgment ?? null, note: r.note ?? null, aiAssessment: assessments.get(r.id) ?? null,
      record: { ...recordView(r), sourceName: r.source_name }
    })), { page, pageSize: size, total, facets, mode: row.mode });
  });

  router.on('POST', '/api/searches/:id/summary', async ({ res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const { row } = loadSearch(db, user, params.id, { needResults: true });
    if (!s.ai) throw new HttpError(503, 'ai_not_configured', 'Claude is not configured on this server, so summaries are unavailable. An administrator can set ANTHROPIC_API_KEY.');
    const limit = s.limits.search.take(user.id);
    if (!limit.allowed) throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${limit.retryAfter} seconds.`);
    const acl = accessFilter(user, row.mode);
    const top = db.all(`SELECT r.id, r.title, r.content, r.created_at, s.name AS source_name, sr.match FROM search_results sr JOIN records r ON r.id = sr.record_id JOIN sources s ON s.id = r.source_id
      WHERE sr.search_id = ? AND ${acl.sql} ORDER BY sr.rank LIMIT ?`, row.id, ...acl.params, s.config.anthropic.summarizeTopK);
    if (!top.length) throw new HttpError(409, 'no_results', 'There are no results to summarise.');
    let result;
    try {
      result = await summarize({
        provider: s.ai, requestText: row.request_text, tenantId: user.tenantId, userId: user.id,
        records: top.map(r => { const m = parseJson(r.match, {}); return { id: r.id, title: r.title, date: r.created_at?.slice(0, 10), source: r.source_name, excerpt: snippetAround(r.content, [...(m.exactTerms || []), ...(m.alternateTerms || [])], 1500) }; })
      });
    } catch (err) {
      if (err instanceof AiError) throw new HttpError(err.code === 'rate_limited' || err.code === 'overloaded' ? 503 : 502, `ai_${err.code}`, `${err.message} The search results are unaffected.`);
      throw err;
    }
    const model = s.ai.model;
    db.run('INSERT OR REPLACE INTO search_summaries (search_id, model, summary, created_at) VALUES (?, ?, ?, ?)', row.id, model, JSON.stringify(result), nowIso());
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'search.summarized', targetType: 'search', targetId: row.id, ipHash, details: { model, records: top.length, findings: result.findings.length, removedCitations: result.verification.removedCitations } });
    ok(res, { ...result, model });
  });

  router.on('GET', '/api/searches/:id/export', ({ res, user, params, url, ipHash }) => {
    requirePermission(user, 'export.create');
    const { row } = loadSearch(db, user, params.id, { needResults: true });
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
    const acl = accessFilter(user, row.mode);
    const rows = db.all(`SELECT sr.rank, sr.match, r.*, s.name AS source_name, e.judgment, e.note FROM search_results sr JOIN records r ON r.id = sr.record_id JOIN sources s ON s.id = r.source_id
      LEFT JOIN evaluations e ON e.search_id = sr.search_id AND e.record_id = sr.record_id AND e.user_id = ?
      WHERE sr.search_id = ? AND ${acl.sql} ORDER BY sr.rank`, user.id, row.id, ...acl.params);
    const items = rows.map(r => { const m = parseJson(r.match, {}); return {
      rank: r.rank, relevance: m.relevance, band: m.band, matchType: m.matchType, title: r.title, source: r.source_name, sourceType: r.source_type,
      synthetic: Boolean(r.is_synthetic), date: r.created_at, department: r.department, documentType: r.document_type, sender: r.sender,
      sourceUrl: r.source_url, recordId: r.id, sourceRecordId: r.source_record_id, checksum: r.checksum, matchedTerms: [...(m.exactTerms || []), ...(m.alternateTerms || [])].join('; '),
      reasons: (m.reasons || []).join('; '), snippet: m.snippet, staffDecision: r.judgment ?? '', staffNote: r.note ?? '' }; });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'export.created', targetType: 'search', targetId: row.id, ipHash, details: { format, rows: items.length, mode: row.mode } });
    const name = `search-${row.id.slice(0, 8)}-${row.mode}.${format}`;
    const headers = { 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS };
    if (format === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      return res.end(JSON.stringify({ exportedAt: nowIso(), mode: row.mode, notice: row.mode === 'demo' ? 'Synthetic demo records.' : 'Records from connected sources. Staff decide responsiveness.', request: row.request_text, results: items }, null, 2));
    }
    const cols = Object.keys(items[0] ?? { rank: 0, title: '' });
    const q = (v) => { const t = String(v ?? ''); return /^[=+\-@\t\r]/.test(t) ? `"'${t.replace(/"/g, '""')}"` : `"${t.replace(/"/g, '""')}"`; }; // also defuses spreadsheet formulas
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', ...headers });
    res.end([cols.join(','), ...items.map(i => cols.map(c => q(i[c])).join(','))].join('\r\n'));
  });

  router.on('GET', '/api/searches', ({ res, user, url }) => {
    const all = url.searchParams.get('scope') === 'all';
    if (all) requirePermission(user, 'history.read_all'); else requirePermission(user, 'history.read_own');
    const { page, size, offset } = pageParams(url, 20);
    const where = `WHERE q.tenant_id = ?${all ? '' : ' AND q.user_id = ?'}${url.searchParams.get('mode') ? ' AND q.mode = ?' : ''}${url.searchParams.get('q') ? ' AND q.request_text LIKE ?' : ''}`;
    const p = [user.tenantId, ...(all ? [] : [user.id]), ...(url.searchParams.get('mode') ? [url.searchParams.get('mode')] : []), ...(url.searchParams.get('q') ? [`%${url.searchParams.get('q')}%`] : [])];
    const total = db.get(`SELECT COUNT(*) AS n FROM search_requests q ${where}`, ...p).n;
    const rows = db.all(`SELECT q.*, u.name AS user_name, p.origin, (SELECT COUNT(*) FROM evaluations e WHERE e.search_id = q.id) AS judged,
        (SELECT 1 FROM search_summaries ss WHERE ss.search_id = q.id) AS has_summary
      FROM search_requests q LEFT JOIN users u ON u.id = q.user_id LEFT JOIN search_plans p ON p.search_id = q.id ${where} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`, ...p, size, offset);
    ok(res, rows.map(r => ({ id: r.id, mode: r.mode, requestText: r.request_text, status: r.status, createdAt: r.created_at, durationMs: r.duration_ms, resultCount: r.result_count, user: { id: r.user_id, name: r.user_name }, planOrigin: r.origin, judged: r.judged, hasSummary: Boolean(r.has_summary) })), { page, pageSize: size, total });
  });

  /* ---- records ---- */

  function loadReadableRecord(user, id) {
    const rec = db.get('SELECT is_synthetic FROM records WHERE id = ? AND tenant_id = ?', id, user.tenantId);
    if (!rec) throw new HttpError(404, 'not_found', 'That record does not exist or you do not have access to it.');
    const acl = accessFilter(user, rec.is_synthetic ? 'demo' : 'real');
    const row = db.get(`SELECT r.*, s.name AS source_name FROM records r JOIN sources s ON s.id = r.source_id WHERE r.id = ? AND ${acl.sql}`, id, ...acl.params);
    if (!row) throw new HttpError(404, 'not_found', 'That record does not exist or you do not have access to it.');
    return row;
  }

  router.on('GET', '/api/records/:id', ({ res, user, params, ipHash }) => {
    requirePermission(user, 'records.read');
    const row = loadReadableRecord(user, params.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'record.viewed', targetType: 'record', targetId: row.id, ipHash, details: { sourceType: row.source_type } });
    const parent = row.parent_record_id ? db.get('SELECT id, title FROM records WHERE id = ?', row.parent_record_id) : null;
    const related = row.thread_key ? db.all('SELECT id, title, created_at AS createdAt FROM records WHERE tenant_id = ? AND thread_key = ? AND id != ? ORDER BY created_at LIMIT 20', user.tenantId, row.thread_key, row.id) : [];
    ok(res, { ...recordView(row, { includeContent: true }), sourceName: row.source_name, parent, related });
  });

  router.on('GET', '/api/records/:id/original', ({ res, user, params, ipHash }) => {
    requirePermission(user, 'records.read');
    const row = loadReadableRecord(user, params.id);
    if (row.source_type !== 'uploads') throw new HttpError(404, 'no_original', 'Only uploaded files have a stored original. Use the source link instead.');
    const file = parseJson(row.extracted_entities, {}).file || {};
    const p = path.join(s.config.dataDir, 'uploads', row.tenant_id, row.source_id, `${row.source_record_id}${file.ext || ''}`);
    if (!fs.existsSync(p)) throw new HttpError(404, 'missing_original', 'The original file is no longer stored.');
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'record.viewed', targetType: 'record', targetId: row.id, ipHash, details: { original: true } });
    const safeName = String(file.name || 'document').replace(/["\\\r\n]/g, '_');
    res.writeHead(200, { 'Content-Type': MIME[file.ext] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeName}"`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    fs.createReadStream(p).pipe(res);
  });

  /* ---- staff relevance decisions ---- */

  router.on('PUT', '/api/searches/:id/evaluations/:recordId', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'evaluate.write');
    const { row } = loadSearch(db, user, params.id, { needResults: true });
    if (!db.get('SELECT 1 FROM search_results WHERE search_id = ? AND record_id = ?', row.id, params.recordId)) throw new HttpError(404, 'not_found', 'That record is not in this search’s results.');
    loadReadableRecord(user, params.recordId);
    const body = validate({ judgment: { type: 'string', required: true, values: ['relevant', 'not_relevant', 'unsure'] }, note: { type: 'string', max: 1000 } }, await readJson(req));
    const now = nowIso();
    db.run(`INSERT INTO evaluations (id, tenant_id, search_id, record_id, user_id, judgment, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(search_id, record_id, user_id) DO UPDATE SET judgment = excluded.judgment, note = excluded.note, updated_at = excluded.updated_at`,
    crypto.randomUUID(), user.tenantId, row.id, params.recordId, user.id, body.judgment, body.note ?? null, now, now);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'evaluation.saved', targetType: 'record', targetId: params.recordId, ipHash, details: { searchId: row.id, judgment: body.judgment, hasNote: Boolean(body.note) } });
    ok(res, { judgment: body.judgment, note: body.note ?? null });
  });

  router.on('GET', '/api/evaluations/summary', ({ res, user, url }) => {
    const all = url.searchParams.get('scope') === 'all' && can(user, 'history.read_all');
    if (!all) requirePermission(user, 'evaluate.write');
    const mode = url.searchParams.get('mode') === 'demo' ? 'demo' : 'real';
    const scope = all ? '' : ' AND q.user_id = ?';
    const p = [user.tenantId, mode, ...(all ? [] : [user.id])];
    const searches = db.all(`SELECT q.id, q.request_text, q.created_at, q.duration_ms, q.result_count, p.origin FROM search_requests q LEFT JOIN search_plans p ON p.search_id = q.id
      WHERE q.tenant_id = ? AND q.mode = ? AND q.status = 'completed'${scope} ORDER BY q.created_at DESC LIMIT 500`, ...p);
    const judged = db.all(`SELECT e.search_id, e.record_id, e.judgment, e.note, e.updated_at, sr.rank, sr.match, r.title, q.request_text FROM evaluations e
      JOIN search_requests q ON q.id = e.search_id JOIN search_results sr ON sr.search_id = e.search_id AND sr.record_id = e.record_id JOIN records r ON r.id = e.record_id
      WHERE q.tenant_id = ? AND q.mode = ?${scope} ORDER BY e.updated_at DESC`, ...p);
    const bySearch = new Map();
    for (const j of judged) (bySearch.get(j.search_id) ?? bySearch.set(j.search_id, []).get(j.search_id)).push(j);
    const precisionAt = (k) => { const vals = []; for (const js of bySearch.values()) { const top = js.filter(j => j.rank <= k && j.judgment !== 'unsure'); if (top.length) vals.push(top.filter(j => j.judgment === 'relevant').length / top.length); } return vals.length ? Math.round(1000 * vals.reduce((a, b) => a + b, 0) / vals.length) / 10 : null; };
    const pooledRecallAt = (k) => { const vals = []; for (const js of bySearch.values()) { const rel = js.filter(j => j.judgment === 'relevant'); if (rel.length) vals.push(rel.filter(j => j.rank <= k).length / rel.length); } return vals.length ? Math.round(1000 * vals.reduce((a, b) => a + b, 0) / vals.length) / 10 : null; };
    const count = (j) => judged.filter(x => x.judgment === j).length;
    const durations = searches.map(x => x.duration_ms).filter(x => x != null).sort((a, b) => a - b);
    ok(res, {
      mode, scope: all ? 'all' : 'mine',
      notice: 'These figures come only from staff relevance decisions on real searches. They describe the judged results, not overall search quality, until a labeled test set exists.',
      searches: searches.length, searchesWithJudgments: bySearch.size,
      judgments: { total: judged.length, relevant: count('relevant'), notRelevant: count('not_relevant'), unsure: count('unsure') },
      precisionAt10: precisionAt(10), precisionAt50: precisionAt(50), pooledRecallAt10: pooledRecallAt(10),
      execution: {
        medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
        p95Ms: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null,
        zeroResultSearches: searches.filter(x => !x.result_count).length,
        averageResults: searches.length ? Math.round(searches.reduce((a, x) => a + (x.result_count || 0), 0) / searches.length) : null,
        plansByClaude: searches.filter(x => x.origin === 'claude').length, plansByRules: searches.filter(x => x.origin === 'rules').length
      },
      falsePositives: judged.filter(j => j.judgment === 'not_relevant' && j.rank <= 10).slice(0, 25).map(j => { const m = parseJson(j.match, {}); return { searchId: j.search_id, request: j.request_text, recordId: j.record_id, title: j.title, rank: j.rank, band: m.band, matchType: m.matchType, reasons: m.reasons, note: j.note }; }),
      history: judged.slice(0, 50).map(j => ({ searchId: j.search_id, request: j.request_text, recordId: j.record_id, title: j.title, rank: j.rank, judgment: j.judgment, note: j.note, at: j.updated_at }))
    });
  });
}

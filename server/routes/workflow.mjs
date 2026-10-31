// @ts-check
/**
 * The request workflow: Request -> Search plan -> Search -> Review -> Report.
 *
 * Guardrails enforced here (not in the UI):
 *  - No search without a confirmed, locked plan version. Editing a confirmed plan creates a new version.
 *  - Sources are fixed in the confirmed plan; a source the user may not search is refused and logged.
 *  - Every chosen source reports searched, partial, failed or not connected. Nothing fails silently.
 *  - Only the request text and plan go to a model. Record and candidate text never do.
 *  - The model never writes marks. Only signed-in staff can.
 *  - Wording never calls a search complete or a result responsive.
 */
import crypto from 'node:crypto';
import { HttpError, ok, pageParams, readJson, SECURITY_HEADERS, validate } from '../http.mjs';
import { can, requirePermission } from '../auth.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { cleanPlan, draftPlan, planHasTerms, PROMPT_VERSION } from '../ai/planner.mjs';
import { draftClarifications } from '../ai/clarify.mjs';
import { accessFilter, conceptTerms, ftsQuery, hybridSearch } from '../search/hybrid.mjs';
import { recordView } from '../ingest/pipeline.mjs';
import { isPhoneLink } from '../connectors/phonelink.mjs';
import { startSync } from './sources.mjs';
import { requireConsent, searchableSources } from './search.mjs';
import { activePack, switches } from '../packs.mjs';
import { businessDaysLeft, deadlineLabel, dueDate, todayIn } from '../deadline.mjs';
import { parseFilter } from '../nlfilter.mjs';
import { suggestTerms } from '../expand.mjs';

const MARKS = ['relevant', 'not_relevant', 'unsure'];
const csvCell = (v) => { const t = String(v ?? ''); return /^[=+\-@\t\r]/.test(t) ? `"'${t.replace(/"/g, '""')}"` : `"${t.replace(/"/g, '""')}"`; };
const toCsv = (cols, rows) => '﻿' + [cols.map(c => csvCell(c.label)).join(','), ...rows.map(r => cols.map(c => csvCell(r[c.key])).join(','))].join('\r\n');

/** @param {import('../http.mjs').Router} router */
export function registerWorkflowRoutes(router, s) {
  const { db, audit, config } = s;

  /* ---------------- helpers ---------------- */

  const isDemoTenant = (user) => Boolean(db.get('SELECT is_demo FROM tenants WHERE id = ?', user.tenantId)?.is_demo);
  const nameOf = (id) => id ? db.get('SELECT name FROM users WHERE id = ?', id)?.name ?? 'Unknown' : null;

  /** Requests are team work: anyone in the organization who can search or read history may open one. */
  function loadRequest(user, id) {
    if (!can(user, 'search.run') && !can(user, 'history.read_all') && !can(user, 'records.read')) throw new HttpError(403, 'forbidden', 'Your role cannot open requests.');
    const row = db.get('SELECT * FROM search_requests WHERE id = ? AND tenant_id = ?', id, user.tenantId);
    if (!row) throw new HttpError(404, 'not_found', 'That request does not exist (it may have been removed by the retention policy).');
    return row;
  }

  const versions = (id) => db.all('SELECT * FROM plan_versions WHERE search_id = ? ORDER BY version', id);
  const latest = (id) => db.get('SELECT * FROM plan_versions WHERE search_id = ? ORDER BY version DESC LIMIT 1', id);
  const latestConfirmed = (id) => db.get("SELECT * FROM plan_versions WHERE search_id = ? AND status = 'confirmed' ORDER BY version DESC LIMIT 1", id);
  const versionView = (v) => v && ({
    id: v.id, version: v.version, status: v.status, plan: parseJson(v.plan, {}), sourceIds: parseJson(v.source_ids, []), origin: v.origin, model: v.model,
    promptVersion: v.prompt_version, note: v.note, createdBy: nameOf(v.created_by), createdAt: v.created_at, confirmedBy: nameOf(v.confirmed_by), confirmedAt: v.confirmed_at
  });

  function clock(user, row) {
    const pack = activePack(db, user.tenantId);
    const holidays = new Set(pack.holidays);
    const due = row.received_at ? dueDate(row.received_at, holidays, pack.responseDays) : null;
    const left = due ? businessDaysLeft(todayIn(pack.timezone), due, holidays) : null;
    return { receivedAt: row.received_at, dueDate: due, daysLeft: left, label: left === null ? 'No date' : deadlineLabel(left), wording: pack.wording.clock, options: pack.wording.clockOptions };
  }

  /** Current mark per candidate: the latest one by anyone, with who and when. */
  const markSql = `(SELECT e.judgment FROM evaluations e WHERE e.search_id = sr.search_id AND e.record_id = sr.record_id ORDER BY e.updated_at DESC LIMIT 1)`;
  function markOf(searchId, recordId) {
    const m = db.get(`SELECT e.judgment, e.note, e.updated_at, u.name FROM evaluations e LEFT JOIN users u ON u.id = e.user_id WHERE e.search_id = ? AND e.record_id = ? ORDER BY e.updated_at DESC LIMIT 1`, searchId, recordId);
    return m ? { mark: m.judgment, note: m.note, by: m.name, at: m.updated_at } : null;
  }

  function reviewCounts(searchId) {
    const total = db.get('SELECT COUNT(*) AS n FROM search_results WHERE search_id = ?', searchId).n;
    const counts = { relevant: 0, not_relevant: 0, unsure: 0 };
    for (const r of db.all(`SELECT ${markSql} AS mark FROM search_results sr WHERE sr.search_id = ?`, searchId)) if (r.mark) counts[r.mark]++;
    const marked = counts.relevant + counts.not_relevant + counts.unsure;
    return { total, marked, unmarked: total - marked, ...counts };
  }

  function stageOf(row) {
    if (row.handed_off_at) return { key: 'handed_off', label: 'Handed off', step: 5 };
    const confirmed = latestConfirmed(row.id);
    const run = db.get('SELECT 1 FROM search_runs WHERE search_id = ? LIMIT 1', row.id);
    if (!confirmed) return { key: 'draft', label: 'Draft plan', step: 2 };
    if (!run) return { key: 'confirmed', label: 'Plan confirmed', step: 3 };
    const rc = reviewCounts(row.id);
    if (rc.unmarked > 0) return { key: 'review', label: 'In review', step: 4 };
    return { key: 'ready', label: 'Ready for report', step: 5 };
  }

  /** The sources a user may choose for a request in a mode, plus the pack's unconnected sources (never searchable). */
  function sourceChoices(user, mode) {
    const pack = activePack(db, user.tenantId);
    const sw = switches(db, user.tenantId, config);
    const allowed = searchableSources(db, user, mode);
    const rows = allowed.map(x => {
      const src = db.get('SELECT config, last_sync_status, status FROM sources WHERE id = ?', x.id);
      const provider = parseJson(src?.config, {}).provider ?? null;
      const records = db.get('SELECT COUNT(*) AS n FROM records WHERE source_id = ?', x.id).n;
      return { id: x.id, name: x.name, type: x.type, provider, connected: true, records, experimental: String(provider || '').startsWith('phonelink') };
    }).filter(x => !(x.provider || '').startsWith('phonelink') || sw.phoneLink);
    const stubs = pack.sources.map(st => ({ id: `stub:${st.key}`, name: st.name, type: 'stub', connected: false, note: st.note, records: null }));
    return { sources: rows, stubs };
  }

  function requestView(user, row, { full = true } = {}) {
    const all = versions(row.id);
    const cur = all[all.length - 1];
    const conf = [...all].reverse().find(v => v.status === 'confirmed');
    const run = db.get("SELECT * FROM search_runs WHERE search_id = ? ORDER BY started_at DESC LIMIT 1", row.id);
    const base = {
      id: row.id, ref: row.ref, mode: row.mode, text: row.request_text, channel: row.channel, requesterLabel: row.requester_label,
      createdAt: row.created_at, createdBy: nameOf(row.user_id), clock: clock(user, row), stage: stageOf(row),
      review: reviewCounts(row.id), resultCount: row.result_count, handedOffAt: row.handed_off_at, handedOffBy: nameOf(row.handed_off_by),
      approvedAt: row.approved_at, approvedBy: nameOf(row.approved_by), lastRunAt: run?.finished_at ?? null,
      sourcesSearched: run ? db.get("SELECT COUNT(*) AS n FROM source_runs WHERE run_id = ? AND status IN ('searched', 'partial')", run.id).n : 0,
      sourcesNotSearched: run ? db.get("SELECT COUNT(*) AS n FROM source_runs WHERE run_id = ? AND status IN ('failed', 'not_connected')", run.id).n : 0
    };
    if (!full) return base;
    return {
      ...base,
      current: versionView(cur), confirmed: versionView(conf), versions: all.map(versionView),
      choices: sourceChoices(user, row.mode), coverage: coverage(row.id),
      custodians: custodianRows(user, row), switches: switches(db, user.tenantId, config),
      pack: (() => { const p = activePack(db, user.tenantId); return { id: p.id, name: p.name, departments: p.departments, recordTypes: p.recordTypes, threshold: p.broadPlanThreshold, wording: p.wording }; })()
    };
  }

  /** Sources searched and NOT searched in the latest full run (plus any later added-terms runs). */
  function coverage(searchId) {
    const run = db.get("SELECT * FROM search_runs WHERE search_id = ? AND kind = 'full' ORDER BY started_at DESC LIMIT 1", searchId);
    if (!run) return null;
    const rows = db.all('SELECT * FROM source_runs WHERE run_id = ? ORDER BY status, source_name', run.id);
    return {
      runId: run.id, at: run.finished_at, planVersion: run.plan_version,
      searched: rows.filter(r => r.status === 'searched' || r.status === 'partial').map(r => ({ key: r.source_key, name: r.source_name, status: r.status, candidates: r.candidates, note: r.error })),
      notSearched: rows.filter(r => r.status === 'failed' || r.status === 'not_connected').map(r => ({ key: r.source_key, name: r.source_name, status: r.status, reason: r.error }))
    };
  }

  function custodianRows(user, row) {
    const pack = activePack(db, user.tenantId);
    const plan = parseJson((latestConfirmed(row.id) || latest(row.id))?.plan, {});
    const depts = (plan.departments || []).map(d => d.toLowerCase());
    const rows = pack.sourceMap.filter(m => !depts.length || depts.some(d => m.department.toLowerCase().includes(d) || d.includes(m.department.toLowerCase())));
    return rows.map(m => {
      const c = db.get('SELECT * FROM custodian_checks WHERE search_id = ? AND department = ?', row.id, m.department);
      return { department: m.department, systems: m.systems, custodian: m.custodian, status: c?.status ?? 'pending', note: c?.note ?? null, confirmedBy: nameOf(c?.confirmed_by), confirmedAt: c?.confirmed_at ?? null };
    });
  }

  function modeFor(user, requested) {
    if (isDemoTenant(user) || !config.realSources) return 'demo';
    return requested === 'real' ? 'real' : 'demo';
  }

  /* ---------------- intake and plan ---------------- */

  router.on('POST', '/api/requests', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'search.run');
    const body = validate({
      text: { type: 'string', required: true, min: 5, max: 8000 }, receivedAt: { type: 'date', required: true },
      channel: { type: 'string', max: 60, default: 'Portal ticket' }, requesterLabel: { type: 'string', max: 120, default: '' },
      mode: { type: 'string', values: ['demo', 'real'], default: 'demo' }
    }, await readJson(req));
    const mode = modeFor(user, body.mode);
    requireConsent(db, user, mode);
    const limit = s.limits.search.take(user.id);
    if (!limit.allowed) throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${limit.retryAfter} seconds.`);
    const pack = activePack(db, user.tenantId);
    const { sources } = sourceChoices(user, mode);
    // Only the request text, department and record-type lists and source names go to the model. Never record content.
    const drafted = await draftPlan({ provider: s.ai, requestText: body.text, sources: sources.map(x => ({ id: x.id, name: x.name, type: x.type })), departments: pack.departments, tenantId: user.tenantId, userId: user.id });
    const id = crypto.randomUUID();
    const year = body.receivedAt.slice(0, 4);
    const n = db.get("SELECT COUNT(*) AS n FROM search_requests WHERE tenant_id = ? AND ref LIKE ?", user.tenantId, `R-${year}-%`).n + 1;
    const ref = `R-${year}-${String(n).padStart(3, '0')}`;
    const due = dueDate(body.receivedAt, new Set(pack.holidays), pack.responseDays);
    const sourceIds = drafted.plan.sourceIds.length ? drafted.plan.sourceIds : sources.filter(x => !x.experimental).map(x => x.id);
    db.tx(() => {
      db.run(`INSERT INTO search_requests (id, tenant_id, user_id, mode, request_text, status, created_at, ref, received_at, channel, requester_label, due_date, pack)
        VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)`, id, user.tenantId, user.id, mode, body.text, nowIso(), ref, body.receivedAt, body.channel, body.requesterLabel || null, due, pack.id);
      db.run('INSERT INTO search_plans (search_id, origin, model, plan) VALUES (?, ?, ?, ?)', id, drafted.origin, drafted.model, JSON.stringify(drafted.plan));
      db.run(`INSERT INTO plan_versions (id, search_id, version, plan, source_ids, status, origin, model, prompt_version, note, created_by, created_at)
        VALUES (?, ?, 1, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`, crypto.randomUUID(), id, JSON.stringify({ ...drafted.plan, sourceIds }), JSON.stringify(sourceIds),
      drafted.origin, drafted.model, drafted.origin === 'claude' ? PROMPT_VERSION : 'rules-v1', drafted.fallbackReason ?? null, user.id, nowIso());
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'request.created', targetType: 'request', targetId: id, ipHash, details: { ref, mode, receivedAt: body.receivedAt, dueDate: due, channel: body.channel } });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'plan.drafted', targetType: 'request', targetId: id, ipHash, details: { version: 1, origin: drafted.origin, model: drafted.model, promptVersion: drafted.origin === 'claude' ? PROMPT_VERSION : 'rules-v1', fallback: drafted.fallbackReason ?? null } });
    ok(res, requestView(user, db.get('SELECT * FROM search_requests WHERE id = ?', id)), undefined, 201);
  });

  router.on('GET', '/api/requests/:id', ({ res, user, params }) => {
    ok(res, requestView(user, loadRequest(user, params.id)));
  });

  router.on('PATCH', '/api/requests/:id', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const row = loadRequest(user, params.id);
    const body = validate({ receivedAt: { type: 'date' }, channel: { type: 'string', max: 60 }, requesterLabel: { type: 'string', max: 120 } }, await readJson(req));
    const pack = activePack(db, user.tenantId);
    const received = body.receivedAt ?? row.received_at;
    const due = dueDate(received, new Set(pack.holidays), pack.responseDays);
    db.run('UPDATE search_requests SET received_at = ?, channel = COALESCE(?, channel), requester_label = COALESCE(?, requester_label), due_date = ? WHERE id = ?', received, body.channel ?? null, body.requesterLabel ?? null, due, row.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'request.updated', targetType: 'request', targetId: row.id, ipHash, before: { receivedAt: row.received_at, channel: row.channel, dueDate: row.due_date }, after: { receivedAt: received, channel: body.channel ?? row.channel, dueDate: due } });
    ok(res, requestView(user, db.get('SELECT * FROM search_requests WHERE id = ?', row.id)));
  });

  /** Save edits. A confirmed (locked) plan is never changed: editing it starts the next version as a draft. */
  router.on('PUT', '/api/requests/:id/plan', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const row = loadRequest(user, params.id);
    if (row.handed_off_at) throw new HttpError(409, 'handed_off', 'This request was handed to the city process. Its plan can no longer change.');
    const body = validate({ plan: { type: 'object', required: true }, sourceIds: { type: 'array', items: { type: 'string', max: 80 }, max: 60, default: [] } }, await readJson(req));
    const { sources } = sourceChoices(user, row.mode);
    const plan = cleanPlan(body.plan, { sourceIds: sources.map(x => x.id) });
    const sourceIds = body.sourceIds.filter(x => !x.startsWith('stub:'));
    const cur = latest(row.id);
    let version = cur.version;
    if (cur.status === 'confirmed') {
      version = cur.version + 1;
      db.run(`INSERT INTO plan_versions (id, search_id, version, plan, source_ids, status, origin, model, prompt_version, note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, 'draft', 'staff', NULL, ?, ?, ?, ?)`, crypto.randomUUID(), row.id, version, JSON.stringify({ ...plan, sourceIds }), JSON.stringify(sourceIds), cur.prompt_version, `Edited from version ${cur.version}`, user.id, nowIso());
    } else {
      db.run('UPDATE plan_versions SET plan = ?, source_ids = ? WHERE id = ?', JSON.stringify({ ...plan, sourceIds }), JSON.stringify(sourceIds), cur.id);
    }
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'plan.edited', targetType: 'request', targetId: row.id, ipHash, details: { version },
      before: { terms: parseJson(cur.plan, {}).keywords, sources: parseJson(cur.source_ids, []) }, after: { terms: plan.keywords, sources: sourceIds } });
    ok(res, requestView(user, row));
  });

  /** Confirm and lock the latest draft. Sources are checked against what this user may search; refusals are logged. */
  router.on('POST', '/api/requests/:id/plan/confirm', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const row = loadRequest(user, params.id);
    const body = validate({ version: { type: 'int', required: true, min: 1 }, reviewed: { type: 'bool', required: true } }, await readJson(req));
    if (body.reviewed !== true) throw new HttpError(400, 'not_reviewed', 'Tick “I reviewed this plan” before confirming.');
    requireConsent(db, user, row.mode);
    const cur = latest(row.id);
    if (cur.version !== body.version) throw new HttpError(409, 'stale_version', `Version ${body.version} is not the latest plan. Reload and review version ${cur.version}.`);
    if (cur.status === 'confirmed') return ok(res, requestView(user, row));
    const plan = parseJson(cur.plan, {});
    if (!planHasTerms(plan)) throw new HttpError(400, 'empty_plan', 'Add at least one term, phrase or name before confirming.');
    const chosen = parseJson(cur.source_ids, []);
    if (!chosen.length) throw new HttpError(400, 'no_sources', 'Switch on at least one connected source to search.');
    const allowed = new Set(sourceChoices(user, row.mode).sources.map(x => x.id));
    const refused = chosen.filter(id => !allowed.has(id));
    if (refused.length) {
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'search.refused', targetType: 'request', targetId: row.id, outcome: 'denied', ipHash, details: { reason: 'source_not_permitted', sources: refused } });
      throw new HttpError(403, 'source_not_permitted', 'This plan includes a source you have not allowed or cannot access. Remove it, or change your search permission in Settings.');
    }
    db.run("UPDATE plan_versions SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?", user.id, nowIso(), cur.id);
    db.run('UPDATE search_plans SET confirmed_plan = ?, confirmed_at = ? WHERE search_id = ?', cur.plan, nowIso(), row.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'plan.confirmed', targetType: 'request', targetId: row.id, ipHash, details: { version: cur.version, sources: chosen } });
    ok(res, requestView(user, row));
  });

  /* ---------------- search ---------------- */

  /** Health of one chosen source before searching. Never silent: every source ends up with a status. */
  async function checkSource(src) {
    const provider = parseJson(src.config, {}).provider ?? '';
    try {
      if (s.deps?.sourceCheck) {
        const forced = await Promise.race([s.deps.sourceCheck(src), new Promise((_, rej) => setTimeout(() => rej(new Error('The source did not answer within 5 seconds.')), 5000).unref())]);
        if (forced) return forced;
      }
    } catch (err) { return { status: 'failed', error: err instanceof Error ? err.message : 'The source check failed.' }; }
    if (src.status === 'disconnected') return { status: 'failed', error: 'The source was disconnected.' };
    if (provider.startsWith('phonelink')) {
      if (src.last_sync_status === 'failed') return { status: 'failed', error: src.last_error || 'The Phone Link message format was not recognized.' };
      return { status: 'partial', error: 'Only texts the employee marked as city business and sent for this request. Android only, recent texts only, no picture messages.' };
    }
    if (src.last_sync_status === 'failed' || src.status === 'needs_attention') return { status: 'partial', error: `The last update failed, so recent items may be missing: ${src.last_error || 'unknown error'}` };
    return { status: 'searched', error: null };
  }

  async function runSearch(user, row, pv, { addedTerms = null, ipHash = null } = {}) {
    const plan = parseJson(pv.plan, {});
    const chosen = parseJson(pv.source_ids, []);
    const pack = activePack(db, user.tenantId);
    const allowed = new Set(sourceChoices(user, row.mode).sources.map(x => x.id));
    const refused = chosen.filter(id => !allowed.has(id));
    if (refused.length) {
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'search.refused', targetType: 'request', targetId: row.id, outcome: 'denied', ipHash, details: { reason: 'source_not_permitted', sources: refused, version: pv.version } });
      throw new HttpError(403, 'source_not_permitted', 'This plan includes a source you are not allowed to search. The search was refused and logged.');
    }
    // Pick up new Phone Link texts before searching (local connector only).
    const waits = [];
    for (const id of chosen) {
      const src = db.get('SELECT * FROM sources WHERE id = ?', id);
      if (src && isPhoneLink(src)) {
        try { if (!s.running.has(src.id) && s.phonelink.isStale(src)) startSync(s, src, user, 'before_search'); } catch { /* search what is indexed */ }
        if (s.running.has(src.id)) waits.push(s.running.get(src.id));
      }
    }
    if (waits.length) await Promise.race([Promise.allSettled(waits), new Promise(r => setTimeout(r, 20_000).unref())]);

    const runId = crypto.randomUUID();
    const started = nowIso();
    const statuses = [];
    for (const id of chosen) {
      const src = db.get('SELECT * FROM sources WHERE id = ?', id);
      if (!src) { statuses.push({ key: id, name: 'Unknown source', type: 'unknown', status: 'failed', error: 'The source no longer exists.' }); continue; }
      const st = await checkSource(src);
      statuses.push({ key: src.id, name: src.name, type: src.type, ...st });
    }
    for (const st of pack.sources) statuses.push({ key: `stub:${st.key}`, name: st.name, type: 'stub', status: 'not_connected', error: 'Not connected in this proof of concept.' });
    const searchable = statuses.filter(x => x.status === 'searched' || x.status === 'partial').map(x => x.key);

    const runPlan = addedTerms ? { ...plan, keywords: addedTerms, phrases: [], people: [], organizations: [], locations: [], alternateTerms: [] } : plan;
    let found = { results: [], stats: {} };
    if (searchable.length) {
      found = await hybridSearch(db, { user, mode: row.mode, plan: { ...runPlan, sourceIds: searchable, phoneSearchId: row.id }, embedder: s.embedder, requestText: row.request_text, concepts: pack.concepts, arguablyBelow: pack.reviewRules.arguablyBelow, keywordOnly: Boolean(addedTerms) });
    }
    const perSource = new Map();
    for (const r of found.results) { const sid = db.get('SELECT source_id FROM records WHERE id = ?', r.recordId).source_id; perSource.set(sid, (perSource.get(sid) || 0) + 1); }
    const indexTime = searchable.length ? db.get(`SELECT MAX(ingestion_timestamp) AS t FROM records WHERE source_id IN (${searchable.map(() => '?').join(',')})`, ...searchable).t : null;
    const query = ftsQuery([...runPlan.keywords, ...runPlan.phrases, ...runPlan.people, ...runPlan.organizations, ...runPlan.locations]);
    let added = 0;
    db.tx(() => {
      db.run(`INSERT INTO search_runs (id, search_id, plan_version, kind, run_by, started_at, finished_at, model, prompt_version, index_time, candidates, added, terms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, runId, row.id, pv.version, addedTerms ? 'added_terms' : 'full', user.id, started, nowIso(),
      pv.model || 'local rules (no model)', pv.prompt_version || 'rules-v1', indexTime, found.results.length, JSON.stringify(addedTerms || []));
      for (const st of statuses) {
        db.run('INSERT INTO source_runs (id, run_id, search_id, source_key, source_name, source_type, status, error, candidates, query) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(), runId, row.id, st.key, st.name, st.type, st.status, st.error, perSource.get(st.key) || 0, st.status === 'searched' || st.status === 'partial' ? query : null);
      }
      if (!addedTerms) {
        db.run('DELETE FROM search_results WHERE search_id = ?', row.id);
        for (const r of found.results) db.run('INSERT INTO search_results (search_id, record_id, rank, score, match, group_key, found_in_version) VALUES (?, ?, ?, ?, ?, ?, ?)', row.id, r.recordId, r.rank, r.score, JSON.stringify(r.match), r.groupKey, pv.version);
        added = found.results.length;
      } else {
        // Merge: keep everything staff already reviewed, append only new candidates after the existing ones.
        let rank = db.get('SELECT COALESCE(MAX(rank), 0) AS m FROM search_results WHERE search_id = ?', row.id).m;
        for (const r of found.results) {
          if (db.get('SELECT 1 FROM search_results WHERE search_id = ? AND record_id = ?', row.id, r.recordId)) continue;
          db.run('INSERT INTO search_results (search_id, record_id, rank, score, match, group_key, found_in_version) VALUES (?, ?, ?, ?, ?, ?, ?)', row.id, r.recordId, ++rank, r.score, JSON.stringify({ ...r.match, fromAddedTerms: true }), r.groupKey, pv.version);
          added++;
        }
      }
      db.run('UPDATE search_runs SET added = ? WHERE id = ?', added, runId);
      const total = db.get('SELECT COUNT(*) AS n FROM search_results WHERE search_id = ?', row.id).n;
      db.run("UPDATE search_requests SET status = 'completed', completed_at = ?, result_count = ?, duration_ms = ?, error = NULL WHERE id = ?", nowIso(), total, found.stats.durationMs ?? 0, row.id);
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'search.run', targetType: 'request', targetId: row.id, ipHash, details: {
      kind: addedTerms ? 'added_terms' : 'full', planVersion: pv.version, model: pv.model || 'local rules (no model)', promptVersion: pv.prompt_version || 'rules-v1', indexTime,
      candidates: found.results.length, added, sources: statuses.map(x => ({ name: x.name, status: x.status, candidates: perSource.get(x.key) || 0 })) } });
    return { runId, candidates: found.results.length, added, statuses };
  }

  router.on('POST', '/api/requests/:id/run', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const row = loadRequest(user, params.id);
    const body = validate({ version: { type: 'int', min: 1 }, addedTermsOnly: { type: 'bool', default: false } }, await readJson(req));
    if (!body.version) throw new HttpError(400, 'no_plan', 'A search needs a confirmed plan version. Confirm the plan first.');
    const pv = db.get('SELECT * FROM plan_versions WHERE search_id = ? AND version = ?', row.id, body.version);
    if (!pv || pv.status !== 'confirmed') {
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'search.refused', targetType: 'request', targetId: row.id, outcome: 'denied', ipHash, details: { reason: 'plan_not_confirmed', version: body.version } });
      throw new HttpError(409, 'plan_not_confirmed', 'Nothing is searched until this plan version is confirmed.');
    }
    requireConsent(db, user, row.mode);
    const limit = s.limits.search.take(user.id);
    if (!limit.allowed) throw new HttpError(429, 'rate_limited', `Too many searches. Try again in ${limit.retryAfter} seconds.`);
    let addedTerms = null;
    if (body.addedTermsOnly) {
      addedTerms = db.all("SELECT term FROM expansion_terms WHERE search_id = ? AND decision = 'approved' AND plan_version = ?", row.id, pv.version).map(r => r.term);
      if (!addedTerms.length) throw new HttpError(400, 'no_added_terms', 'This plan version has no approved added terms.');
    }
    const out = await runSearch(user, row, pv, { addedTerms, ipHash });
    ok(res, { ...out, request: requestView(user, db.get('SELECT * FROM search_requests WHERE id = ?', row.id)) });
  });

  /* ---------------- results and review ---------------- */

  router.on('POST', '/api/filters/parse', async ({ req, res, user }) => {
    requirePermission(user, 'records.read');
    const body = validate({ text: { type: 'string', required: true, max: 300 }, requestId: { type: 'string', max: 64 } }, await readJson(req));
    const pack = activePack(db, user.tenantId);
    let year = Number(todayIn(pack.timezone).slice(0, 4)), sources = [];
    if (body.requestId) {
      const row = loadRequest(user, body.requestId);
      const plan = parseJson(latestConfirmed(row.id)?.plan, {});
      if (plan.dateFrom) year = Number(plan.dateFrom.slice(0, 4));
      sources = db.all('SELECT DISTINCT source_name AS name, source_key AS id FROM source_runs WHERE search_id = ?', row.id);
    }
    // Parsing sees only the typed filter text, never record content.
    ok(res, parseFilter(body.text, { departments: pack.departments, recordTypes: pack.recordTypes, sources, year }));
  });

  router.on('GET', '/api/requests/:id/results', ({ res, user, params, url }) => {
    requirePermission(user, 'records.read');
    const row = loadRequest(user, params.id);
    const { page, size, offset } = pageParams(url, 25, 200);
    const acl = accessFilter(user, row.mode);
    const f = (k) => url.searchParams.get(k);
    const filters = [], fp = [];
    const marks = (f('marks') || '').split(',').filter(Boolean);
    if (marks.length) {
      const parts = [];
      for (const m of marks) { if (m === 'none') parts.push(`${markSql} IS NULL`); else if (MARKS.includes(m)) { parts.push(`${markSql} = ?`); fp.push(m); } }
      if (parts.length) filters.push(`(${parts.join(' OR ')})`);
    }
    if (f('arguable') === '0') filters.push("COALESCE(json_extract(sr.match, '$.arguable'), 0) = 0");
    if (f('type')) { filters.push('r.document_type LIKE ?'); fp.push(`%${f('type')}%`); }
    if (f('department')) { filters.push('r.department LIKE ?'); fp.push(`%${f('department')}%`); }
    if (f('source')) { filters.push('r.source_id = ?'); fp.push(f('source')); }
    if (f('from')) { filters.push('r.created_at >= ?'); fp.push(`${f('from')}T00:00:00.000Z`); }
    if (f('to')) { filters.push('r.created_at <= ?'); fp.push(`${f('to')}T23:59:59.999Z`); }
    if (f('mark')) { if (f('mark') === 'none') filters.push(`${markSql} IS NULL`); else { filters.push(`${markSql} = ?`); fp.push(f('mark')); } }
    const base = `FROM search_results sr JOIN records r ON r.id = sr.record_id JOIN sources s ON s.id = r.source_id WHERE sr.search_id = ? AND ${acl.sql}`;
    const all = db.get(`SELECT COUNT(*) AS n ${base}`, row.id, ...acl.params).n;
    const where = `${base}${filters.length ? ' AND ' + filters.join(' AND ') : ''}`;
    const shown = db.get(`SELECT COUNT(*) AS n ${where}`, row.id, ...acl.params, ...fp).n;
    const rows = db.all(`SELECT sr.rank, sr.score, sr.match, sr.group_key, sr.found_in_version, r.*, s.name AS source_name,
        (SELECT COUNT(*) FROM search_results g WHERE g.search_id = sr.search_id AND g.group_key = sr.group_key) AS group_size
      ${where} ORDER BY sr.rank LIMIT ? OFFSET ?`, row.id, ...acl.params, ...fp, size, offset);
    ok(res, rows.map(r => {
      const route = db.get('SELECT * FROM candidate_routes WHERE search_id = ? AND record_id = ?', row.id, r.id);
      return {
        rank: r.rank, ...parseJson(r.match, {}), groupKey: r.group_key, groupSize: r.group_key ? r.group_size : 1, foundInVersion: r.found_in_version,
        mark: markOf(row.id, r.id), route: route ? { to: route.routed_to, note: route.note, by: nameOf(route.routed_by), at: route.routed_at } : null,
        record: { ...recordView(r), sourceName: r.source_name, provenance: parseJson(r.extracted_entities, {}).provenance ?? (r.is_synthetic ? { kind: 'synthetic' } : null) }
      };
    }), { page, pageSize: size, total: shown, all, review: reviewCounts(row.id), coverage: coverage(row.id) });
  });

  /** A candidate in this request that this person may read right now (sharing changes apply at once). */
  function readableCandidate(user, row, recordId) {
    const acl = accessFilter(user, row.mode);
    const ok = db.get(`SELECT 1 FROM search_results sr JOIN records r ON r.id = sr.record_id JOIN sources s ON s.id = r.source_id WHERE sr.search_id = ? AND sr.record_id = ? AND ${acl.sql}`, row.id, recordId, ...acl.params);
    if (!ok) throw new HttpError(404, 'not_found', 'That record is not a candidate in this request, or you cannot access it.');
  }

  router.on('PUT', '/api/requests/:id/marks/:recordId', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'evaluate.write');
    const row = loadRequest(user, params.id);
    readableCandidate(user, row, params.recordId);
    const body = validate({ mark: { type: 'string', required: true, values: MARKS }, note: { type: 'string', max: 1000 } }, await readJson(req));
    const before = markOf(row.id, params.recordId);
    const now = nowIso();
    db.run(`INSERT INTO evaluations (id, tenant_id, search_id, record_id, user_id, judgment, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(search_id, record_id, user_id) DO UPDATE SET judgment = excluded.judgment, note = excluded.note, updated_at = excluded.updated_at`,
    crypto.randomUUID(), user.tenantId, row.id, params.recordId, user.id, body.mark, body.note ?? null, now, now);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'mark.saved', targetType: 'record', targetId: params.recordId, ipHash, details: { request: row.ref, hasNote: Boolean(body.note) }, before: before?.mark ?? null, after: body.mark });
    ok(res, { mark: markOf(row.id, params.recordId), review: reviewCounts(row.id) });
  });

  router.on('PUT', '/api/requests/:id/routes/:recordId', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'evaluate.write');
    const row = loadRequest(user, params.id);
    readableCandidate(user, row, params.recordId);
    const body = validate({ to: { type: 'string', required: true, max: 160 }, note: { type: 'string', max: 500 } }, await readJson(req));
    const before = db.get('SELECT routed_to FROM candidate_routes WHERE search_id = ? AND record_id = ?', row.id, params.recordId)?.routed_to ?? null;
    db.run(`INSERT INTO candidate_routes (search_id, record_id, routed_to, note, routed_by, routed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(search_id, record_id) DO UPDATE SET routed_to = excluded.routed_to, note = excluded.note, routed_by = excluded.routed_by, routed_at = excluded.routed_at`,
    row.id, params.recordId, body.to, body.note ?? null, user.id, nowIso());
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'mark.routed', targetType: 'record', targetId: params.recordId, ipHash, details: { request: row.ref }, before, after: body.to });
    ok(res, { routed: true });
  });

  router.on('GET', '/api/requests/:id/coordinators', ({ res, user, params }) => {
    const row = loadRequest(user, params.id);
    const people = db.all("SELECT name FROM users WHERE tenant_id = ? AND role = 'reviewer' AND disabled = 0 ORDER BY name", user.tenantId).map(u => `${u.name} (Records Coordinator)`);
    const fromMap = custodianRows(user, row).map(c => `${c.custodian}, ${c.department}`);
    ok(res, [...new Set([...people, ...fromMap])]);
  });

  /* ---------------- option 2: plan preview counts; option 4: source map ---------------- */

  router.on('GET', '/api/requests/:id/preview', ({ res, user, params }) => {
    const row = loadRequest(user, params.id);
    const pv = latest(row.id);
    const plan = parseJson(pv.plan, {});
    const pack = activePack(db, user.tenantId);
    const chosen = new Set(parseJson(pv.source_ids, []));
    const { sources, stubs } = sourceChoices(user, row.mode);
    const acl = accessFilter(user, row.mode);
    const primary = [...(plan.keywords || []), ...(plan.phrases || []), ...(plan.people || []), ...(plan.organizations || []), ...(plan.locations || [])];
    const related = [...new Set([...(plan.alternateTerms || []), ...conceptTerms([...primary, ...(plan.alternateTerms || [])], pack.concepts).keys()])];
    const q = ftsQuery([...primary, ...related]);
    const parts = [], pp = [];
    if (plan.dateFrom) { parts.push('r.created_at >= ?'); pp.push(`${plan.dateFrom}T00:00:00.000Z`); }
    if (plan.dateTo) { parts.push('r.created_at <= ?'); pp.push(`${plan.dateTo}T23:59:59.999Z`); }
    if (plan.filterDepartments && plan.departments?.length) { parts.push(`(${plan.departments.map(() => 'r.department LIKE ?').join(' OR ')})`); pp.push(...plan.departments.map(d => `%${d}%`)); }
    if (plan.filterRecordTypes && plan.recordTypes?.length) { parts.push(`(${plan.recordTypes.map(() => 'r.document_type LIKE ?').join(' OR ')})`); pp.push(...plan.recordTypes.map(t => `%${t}%`)); }
    const counts = sources.map(src => {
      if (!q) return { id: src.id, name: src.name, count: 0, chosen: chosen.has(src.id) };
      const n = db.get(`SELECT COUNT(DISTINCT c.record_id) AS n FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid JOIN records r ON r.id = c.record_id JOIN sources s ON s.id = r.source_id
        WHERE chunk_fts MATCH ? AND s.id = ? AND ${acl.sql}${parts.length ? ' AND ' + parts.join(' AND ') : ''}`, q, src.id, ...acl.params, ...pp).n;
      return { id: src.id, name: src.name, count: n, chosen: chosen.has(src.id) };
    });
    const total = counts.filter(c => c.chosen).reduce((a, c) => a + c.count, 0);
    const chips = [];
    if (plan.departments?.length && !plan.filterDepartments) chips.push({ id: 'departments', label: `Only ${plan.departments.join(', ')}`, patch: { filterDepartments: true } });
    if (plan.recordTypes?.length && !plan.filterRecordTypes) chips.push({ id: 'types', label: `Only ${plan.recordTypes.join(', ')}`, patch: { filterRecordTypes: true } });
    if (!plan.dateFrom && !plan.dateTo) {
      const t = todayIn(pack.timezone); const from = `${Number(t.slice(0, 4)) - 1}${t.slice(4)}`;
      chips.push({ id: 'dates', label: 'Limit to the last 12 months', patch: { dateFrom: from, dateTo: t } });
    } else if (plan.dateFrom && plan.dateTo && Date.parse(plan.dateTo) - Date.parse(plan.dateFrom) > 400 * 86400_000) {
      chips.push({ id: 'dates', label: `Limit to ${plan.dateTo.slice(0, 4)} only`, patch: { dateFrom: `${plan.dateTo.slice(0, 4)}-01-01` } });
    }
    if ((plan.alternateTerms || []).length > 4) chips.push({ id: 'related', label: `Drop ${plan.alternateTerms.length} related terms`, patch: { alternateTerms: [] } });
    ok(res, {
      version: pv.version, status: pv.status, total, threshold: pack.broadPlanThreshold, broad: total > pack.broadPlanThreshold,
      approximate: true, counts, stubs: stubs.map(x => ({ id: x.id, name: x.name, count: null })), chips,
      note: 'Approximate counts from a fast keyword pass. They are not results, and the warning never blocks a search.'
    });
  });

  router.on('PUT', '/api/requests/:id/custodians', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const row = loadRequest(user, params.id);
    const body = validate({ department: { type: 'string', required: true, max: 120 }, status: { type: 'string', required: true, values: ['pending', 'confirmed'] }, note: { type: 'string', max: 500 } }, await readJson(req));
    const before = db.get('SELECT status FROM custodian_checks WHERE search_id = ? AND department = ?', row.id, body.department)?.status ?? 'pending';
    db.run(`INSERT INTO custodian_checks (search_id, department, status, note, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(search_id, department) DO UPDATE SET status = excluded.status, note = excluded.note, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`,
    row.id, body.department, body.status, body.note ?? null, body.status === 'confirmed' ? user.id : null, body.status === 'confirmed' ? nowIso() : null);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'custodian.updated', targetType: 'request', targetId: row.id, ipHash, details: { department: body.department }, before, after: body.status });
    ok(res, custodianRows(user, row));
  });

  /* ---------------- option 1: expand from what you found ---------------- */

  router.on('GET', '/api/requests/:id/expansion', ({ res, user, params }) => {
    requirePermission(user, 'records.read');
    const row = loadRequest(user, params.id);
    const plan = parseJson(latestConfirmed(row.id)?.plan, {});
    const acl = accessFilter(user, row.mode);
    const relevant = db.all(`SELECT r.id, r.title, r.content FROM search_results sr JOIN records r ON r.id = sr.record_id JOIN sources s ON s.id = r.source_id
      WHERE sr.search_id = ? AND ${markSql} = 'relevant' AND ${acl.sql}`, row.id, ...acl.params);
    // Extraction runs here, on this server. Record text is never sent to a model.
    const suggestions = suggestTerms(relevant, plan, activePack(db, user.tenantId).concepts);
    const decided = new Map(db.all('SELECT * FROM expansion_terms WHERE search_id = ?', row.id).map(d => [d.term.toLowerCase(), d]));
    ok(res, { relevantCount: relevant.length, suggestions: suggestions.map(x => ({ ...x, decision: decided.get(x.term.toLowerCase())?.decision ?? null })) });
  });

  router.on('POST', '/api/requests/:id/expansion', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const row = loadRequest(user, params.id);
    const body = validate({ approve: { type: 'array', items: { type: 'string', max: 120 }, max: 30, default: [] }, reject: { type: 'array', items: { type: 'string', max: 120 }, max: 30, default: [] } }, await readJson(req));
    const conf = latestConfirmed(row.id);
    if (!conf) throw new HttpError(409, 'plan_not_confirmed', 'Confirm and run the plan first.');
    if (latest(row.id).status !== 'confirmed') throw new HttpError(409, 'draft_open', 'Finish or confirm the draft plan version before adding terms.');
    const plan = parseJson(conf.plan, {});
    const acl = accessFilter(user, row.mode);
    const relevant = db.all(`SELECT r.id, r.title, r.content FROM search_results sr JOIN records r ON r.id = sr.record_id JOIN sources s ON s.id = r.source_id
      WHERE sr.search_id = ? AND ${markSql} = 'relevant' AND ${acl.sql}`, row.id, ...acl.params);
    const byTerm = new Map(suggestTerms(relevant, plan, activePack(db, user.tenantId).concepts).map(x => [x.term.toLowerCase(), x]));
    const now = nowIso();
    for (const t of body.reject) {
      const sug = byTerm.get(t.toLowerCase());
      if (!sug) continue;
      db.run(`INSERT INTO expansion_terms (search_id, term, kind, source_record_ids, decision, decided_by, decided_at) VALUES (?, ?, ?, ?, 'rejected', ?, ?)
        ON CONFLICT(search_id, term) DO UPDATE SET decision = 'rejected', decided_by = excluded.decided_by, decided_at = excluded.decided_at`, row.id, sug.term, sug.kind, JSON.stringify(sug.recordIds), user.id, now);
    }
    if (body.reject.length) audit.write({ tenantId: user.tenantId, userId: user.id, action: 'plan.terms_rejected', targetType: 'request', targetId: row.id, ipHash, details: { terms: body.reject } });
    const approved = body.approve.map(t => byTerm.get(t.toLowerCase())).filter(Boolean);
    if (!approved.length) return ok(res, { version: conf.version, changed: false, request: requestView(user, row) });
    // Approving creates the next plan version (confirmed by this person) and logs each term with the records it came from.
    const version = conf.version + 1;
    const next = { ...plan };
    for (const a of approved) {
      if (a.kind === 'Person named') next.people = [...new Set([...(next.people || []), a.term])];
      else if (a.kind === 'Project code') next.keywords = [...new Set([...(next.keywords || []), a.term])];
      else next.alternateTerms = [...new Set([...(next.alternateTerms || []), a.term])];
    }
    db.tx(() => {
      db.run(`INSERT INTO plan_versions (id, search_id, version, plan, source_ids, status, origin, model, prompt_version, note, created_by, created_at, confirmed_by, confirmed_at)
        VALUES (?, ?, ?, ?, ?, 'confirmed', 'staff', ?, ?, ?, ?, ?, ?, ?)`, crypto.randomUUID(), row.id, version, JSON.stringify(next), conf.source_ids, conf.model, conf.prompt_version,
      `Added terms from records marked relevant: ${approved.map(a => a.term).join(', ')}`, user.id, now, user.id, now);
      for (const a of approved) {
        db.run(`INSERT INTO expansion_terms (search_id, term, kind, source_record_ids, decision, decided_by, decided_at, plan_version) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)
          ON CONFLICT(search_id, term) DO UPDATE SET decision = 'approved', decided_by = excluded.decided_by, decided_at = excluded.decided_at, plan_version = excluded.plan_version`,
        row.id, a.term, a.kind, JSON.stringify(a.recordIds), user.id, now, version);
      }
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'plan.terms_added', targetType: 'request', targetId: row.id, ipHash,
      details: { version, terms: approved.map(a => ({ term: a.term, kind: a.kind, sourceRecordIds: a.recordIds })) } });
    ok(res, { version, changed: true, request: requestView(user, row) });
  });

  /* ---------------- option 7: clarification drafts ---------------- */

  router.on('POST', '/api/requests/:id/clarify', async ({ res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const row = loadRequest(user, params.id);
    const plan = parseJson(latest(row.id)?.plan, {});
    // The model sees only the request text.
    const out = await draftClarifications({ provider: s.ai, requestText: row.request_text, plan, tenantId: user.tenantId, userId: user.id });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'clarification.drafted', targetType: 'request', targetId: row.id, ipHash, details: { origin: out.origin, model: out.model, promptVersion: out.promptVersion, questions: out.english.questions.length } });
    ok(res, out);
  });

  /* ---------------- report, exports, handoff ---------------- */

  function reportData(user, row) {
    const pack = activePack(db, user.tenantId);
    const conf = latestConfirmed(row.id);
    const runs = db.all('SELECT * FROM search_runs WHERE search_id = ? ORDER BY started_at', row.id);
    const lastFull = [...runs].reverse().find(r => r.kind === 'full');
    const acl = accessFilter(user, row.mode);
    const marked = db.all(`SELECT r.id, r.title, r.created_at, s.name AS source_name, sr.rank FROM search_results sr JOIN records r ON r.id = sr.record_id JOIN sources s ON s.id = r.source_id
      WHERE sr.search_id = ? AND ${acl.sql} ORDER BY sr.rank`, row.id, ...acl.params).map(r => ({ ...r, mark: markOf(row.id, r.id), route: db.get('SELECT routed_to FROM candidate_routes WHERE search_id = ? AND record_id = ?', row.id, r.id)?.routed_to ?? null }));
    const review = reviewCounts(row.id);
    const cov = coverage(row.id);
    const custodians = custodianRows(user, row);
    const checklist = [];
    if (!conf) checklist.push({ level: 'warn', text: 'No plan has been confirmed yet.' });
    if (!lastFull) checklist.push({ level: 'warn', text: 'The search has not been run.' });
    if (review.unmarked) checklist.push({ level: 'warn', text: `${review.unmarked} items not yet marked.` });
    if (cov?.notSearched.length) checklist.push({ level: 'info', text: `${cov.notSearched.length} sources NOT searched. They are listed in the record.` });
    const pend = custodians.filter(c => c.status !== 'confirmed').length;
    if (pend) checklist.push({ level: 'info', text: `${pend} custodian checks still pending.` });
    if (!checklist.length) checklist.push({ level: 'ok', text: 'Every candidate is marked and every custodian check is confirmed.' });
    return {
      generatedAt: nowIso(), ref: row.ref, mode: row.mode, tier: row.mode === 'demo' ? 'Tier 0: invented records and public documents only' : 'Connected sources',
      request: { text: row.request_text, channel: row.channel, requesterLabel: row.requester_label, createdBy: nameOf(row.user_id), createdAt: row.created_at, clock: clock(user, row) },
      plan: conf ? versionView(conf) : null, versions: versions(row.id).map(v => ({ version: v.version, status: v.status, note: v.note, createdBy: nameOf(v.created_by), createdAt: v.created_at, confirmedBy: nameOf(v.confirmed_by), confirmedAt: v.confirmed_at })),
      coverage: cov, coverageWording: pack.wording.coverage,
      log: runs.map(r => ({ at: r.finished_at, by: nameOf(r.run_by), kind: r.kind === 'full' ? 'Search' : 'Search with added terms', planVersion: r.plan_version, candidates: r.candidates, added: r.added,
        sources: db.all('SELECT source_name, status, candidates, query, error FROM source_runs WHERE run_id = ? ORDER BY source_name', r.id) })),
      review, marked: marked.filter(m => m.mark || m.route).map(m => ({ recordId: m.id, title: m.title, source: m.source_name, date: m.created_at, mark: m.mark?.mark ?? null, by: m.mark?.by ?? null, at: m.mark?.at ?? null, note: m.mark?.note ?? null, routedTo: m.route })),
      custodians, knownGaps: pack.knownGaps, handoffWording: pack.wording.handoff,
      addedTerms: db.all('SELECT term, kind, source_record_ids, decision, decided_at, plan_version FROM expansion_terms WHERE search_id = ? ORDER BY decided_at', row.id).map(t => ({ ...t, source_record_ids: parseJson(t.source_record_ids, []) })),
      reproducibility: lastFull ? { model: lastFull.model, promptVersion: lastFull.prompt_version, planVersion: lastFull.plan_version, indexTime: lastFull.index_time, searchedAt: lastFull.finished_at } : null,
      approval: { required: switches(db, user.tenantId, config).secondApproval, approvedAt: row.approved_at, approvedBy: nameOf(row.approved_by) },
      handoff: { at: row.handed_off_at, by: nameOf(row.handed_off_by) },
      checklist,
      exportChecks: exportChecks(row.id)
    };
  }

  function exportChecks(searchId) {
    const defaults = { report_pdf: 'scan_pending', log_csv: 'plain_table', candidates_csv: 'plain_table' };
    return Object.entries(defaults).map(([kind, status]) => {
      const c = db.get('SELECT * FROM export_checks WHERE search_id = ? AND file_kind = ?', searchId, kind);
      return { kind, status: c?.status ?? status, reviewer: c?.reviewer ?? null, reviewedOn: c?.reviewed_on ?? null, note: c?.note ?? null, recordedBy: nameOf(c?.recorded_by), recordedAt: c?.recorded_at ?? null };
    });
  }

  router.on('GET', '/api/requests/:id/report', ({ res, user, params, ipHash, url }) => {
    const row = loadRequest(user, params.id);
    const data = reportData(user, row);
    if (url.searchParams.get('print') === '1') audit.write({ tenantId: user.tenantId, userId: user.id, action: 'export.created', targetType: 'request', targetId: row.id, ipHash, details: { format: 'pdf (print)', ref: row.ref } });
    ok(res, data);
  });

  function sendCsv(res, name, csv) {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(csv);
  }

  router.on('GET', '/api/requests/:id/export/log.csv', ({ res, user, params, ipHash }) => {
    requirePermission(user, 'export.create');
    const row = loadRequest(user, params.id);
    const d = reportData(user, row);
    const rows = [];
    rows.push({ section: 'Request', when: d.request.createdAt, who: d.request.createdBy, item: d.ref, detail: d.request.text, version: '', status: d.tier, count: '' });
    rows.push({ section: 'Deadline', when: d.request.clock.receivedAt, who: '', item: 'Due', detail: `${d.request.clock.dueDate} (${d.request.clock.label})`, version: '', status: '', count: '' });
    for (const v of d.versions) rows.push({ section: 'Plan version', when: v.confirmedAt || v.createdAt, who: v.confirmedBy || v.createdBy, item: `Version ${v.version}`, detail: v.note || '', version: v.version, status: v.status, count: '' });
    for (const l of d.log) for (const src of l.sources) rows.push({ section: l.kind, when: l.at, who: l.by, item: src.source_name, detail: src.query || src.error || '', version: l.planVersion, status: src.status === 'searched' || src.status === 'partial' ? (src.status === 'partial' ? 'Searched (partial)' : 'Searched') : 'NOT searched', count: src.candidates });
    for (const m of d.marked) rows.push({ section: 'Staff mark', when: m.at, who: m.by, item: m.title, detail: [m.note, m.routedTo ? `Routed to ${m.routedTo}` : ''].filter(Boolean).join('; '), version: '', status: m.mark ? m.mark.replace('_', ' ') : 'not yet marked', count: '' });
    for (const c of d.custodians) rows.push({ section: 'Custodian check', when: c.confirmedAt, who: c.confirmedBy, item: c.department, detail: c.custodian, version: '', status: c.status, count: '' });
    if (d.reproducibility) rows.push({ section: 'Reproducibility', when: d.reproducibility.searchedAt, who: '', item: `Model: ${d.reproducibility.model}`, detail: `Prompt version ${d.reproducibility.promptVersion}; index time ${d.reproducibility.indexTime}`, version: d.reproducibility.planVersion, status: '', count: '' });
    for (const g of d.knownGaps) rows.push({ section: 'Known gap', when: '', who: '', item: '', detail: g, version: '', status: '', count: '' });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'export.created', targetType: 'request', targetId: row.id, ipHash, details: { format: 'csv', file: 'search log', ref: row.ref } });
    sendCsv(res, `${row.ref}-search-log.csv`, toCsv([{ key: 'section', label: 'Section' }, { key: 'when', label: 'When' }, { key: 'who', label: 'Who' }, { key: 'item', label: 'Item' }, { key: 'detail', label: 'Detail' }, { key: 'version', label: 'Plan version' }, { key: 'status', label: 'Status' }, { key: 'count', label: 'Candidates' }], rows));
  });

  router.on('GET', '/api/requests/:id/export/candidates.csv', ({ res, user, params, ipHash }) => {
    requirePermission(user, 'export.create');
    const row = loadRequest(user, params.id);
    const acl = accessFilter(user, row.mode);
    const rows = db.all(`SELECT sr.rank, sr.match, sr.found_in_version, r.*, s.name AS source_name FROM search_results sr JOIN records r ON r.id = sr.record_id JOIN sources s ON s.id = r.source_id
      WHERE sr.search_id = ? AND ${acl.sql} ORDER BY sr.rank`, row.id, ...acl.params).map(r => {
      const m = parseJson(r.match, {}); const mk = markOf(row.id, r.id);
      const route = db.get('SELECT routed_to FROM candidate_routes WHERE search_id = ? AND record_id = ?', row.id, r.id)?.routed_to ?? '';
      return { rank: r.rank, score: m.relevance, band: m.arguable ? 'Arguably responsive' : m.band, title: r.title, source: r.source_name, date: r.created_at?.slice(0, 10) ?? '', department: r.department ?? '',
        type: r.document_type ?? '', why: m.why ?? '', passage: m.snippet ?? '', mark: mk?.mark?.replace('_', ' ') ?? 'not yet marked', by: mk?.by ?? '', at: mk?.at ?? '', note: mk?.note ?? '', routed: route, version: r.found_in_version ?? '', id: r.id };
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'export.created', targetType: 'request', targetId: row.id, ipHash, details: { format: 'csv', file: 'candidates', rows: rows.length, ref: row.ref } });
    sendCsv(res, `${row.ref}-candidates.csv`, toCsv([
      { key: 'rank', label: 'Rank' }, { key: 'score', label: 'Match score' }, { key: 'band', label: 'Band' }, { key: 'title', label: 'Title' }, { key: 'source', label: 'Source' }, { key: 'date', label: 'Date' },
      { key: 'department', label: 'Department' }, { key: 'type', label: 'Record type' }, { key: 'why', label: 'Why it matched' }, { key: 'passage', label: 'Passage' }, { key: 'mark', label: 'Staff mark' },
      { key: 'by', label: 'Marked by' }, { key: 'at', label: 'Marked at' }, { key: 'note', label: 'Note' }, { key: 'routed', label: 'Routed to' }, { key: 'version', label: 'Found in plan version' }, { key: 'id', label: 'Record ID' }], rows));
  });

  router.on('PUT', '/api/requests/:id/export-checks/:kind', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'export.create');
    const row = loadRequest(user, params.id);
    if (!['report_pdf', 'log_csv', 'candidates_csv'].includes(params.kind)) throw new HttpError(404, 'not_found', 'Unknown export.');
    const body = validate({ status: { type: 'string', required: true, values: ['scan_pending', 'scanned', 'plain_table'] }, reviewer: { type: 'string', max: 120 }, reviewedOn: { type: 'date' }, note: { type: 'string', max: 500 } }, await readJson(req));
    if (body.status === 'scanned' && (!body.reviewer || !body.reviewedOn)) throw new HttpError(400, 'missing_reviewer', 'Record who ran the SureAccess scan and on which date.');
    db.run(`INSERT INTO export_checks (search_id, file_kind, status, reviewer, reviewed_on, note, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(search_id, file_kind) DO UPDATE SET status = excluded.status, reviewer = excluded.reviewer, reviewed_on = excluded.reviewed_on, note = excluded.note, recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at`,
    row.id, params.kind, body.status, body.reviewer ?? null, body.reviewedOn ?? null, body.note ?? null, user.id, nowIso());
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'export.check_recorded', targetType: 'request', targetId: row.id, ipHash, details: { file: params.kind, reviewer: body.reviewer ?? null, reviewedOn: body.reviewedOn ?? null }, after: body.status });
    ok(res, exportChecks(row.id));
  });

  router.on('POST', '/api/requests/:id/approve', ({ res, user, params, ipHash }) => {
    const row = loadRequest(user, params.id);
    if (!switches(db, user.tenantId, config).secondApproval) throw new HttpError(400, 'approval_off', 'Second-person approval is switched off in Settings.');
    if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only a Supervisor can approve a search record.');
    const conf = latestConfirmed(row.id);
    if (!conf) throw new HttpError(409, 'plan_not_confirmed', 'There is no confirmed plan to approve.');
    if (conf.confirmed_by === user.id || row.user_id === user.id) throw new HttpError(403, 'same_person', 'A second person must approve: you confirmed or logged this request.');
    db.run('UPDATE search_requests SET approved_at = ?, approved_by = ? WHERE id = ?', nowIso(), user.id, row.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'report.approved', targetType: 'request', targetId: row.id, ipHash, details: { ref: row.ref, planVersion: conf.version } });
    ok(res, reportData(user, db.get('SELECT * FROM search_requests WHERE id = ?', row.id)));
  });

  router.on('POST', '/api/requests/:id/handoff', ({ res, user, params, ipHash }) => {
    requirePermission(user, 'search.run');
    const row = loadRequest(user, params.id);
    if (row.handed_off_at) return ok(res, reportData(user, row));
    if (!db.get('SELECT 1 FROM search_runs WHERE search_id = ?', row.id)) throw new HttpError(409, 'not_searched', 'Run the search before handing off the search record.');
    if (switches(db, user.tenantId, config).secondApproval && !row.approved_at) throw new HttpError(409, 'needs_approval', 'Second-person approval is on. A Supervisor must approve the search record first.');
    const rc = reviewCounts(row.id);
    db.run('UPDATE search_requests SET handed_off_at = ?, handed_off_by = ? WHERE id = ?', nowIso(), user.id, row.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'report.handed_off', targetType: 'request', targetId: row.id, ipHash, details: { ref: row.ref, unmarked: rc.unmarked, note: 'Handing off releases nothing.' } });
    ok(res, reportData(user, db.get('SELECT * FROM search_requests WHERE id = ?', row.id)));
  });

  /* ---------------- history (work queue and archive) ---------------- */

  router.on('GET', '/api/requests', ({ res, user, url }) => {
    if (!can(user, 'history.read_all') && !can(user, 'search.run')) throw new HttpError(403, 'forbidden', 'Your role cannot see requests.');
    const { page, size, offset } = pageParams(url, 25, 100);
    const q = url.searchParams.get('q');
    const rows = db.all(`SELECT * FROM search_requests WHERE tenant_id = ? AND ref IS NOT NULL${q ? ' AND (request_text LIKE ? OR ref LIKE ?)' : ''} ORDER BY created_at DESC`, user.tenantId, ...(q ? [`%${q}%`, `%${q}%`] : []));
    const views = rows.map(r => requestView(user, r, { full: false }));
    const status = url.searchParams.get('status'), due = url.searchParams.get('due');
    const open = (v) => v.stage.key !== 'handed_off';
    const filtered = views.filter(v => (!status || v.stage.key === status) && (!due || (due === 'late' ? open(v) && v.clock.daysLeft < 0 : due === 'soon' ? open(v) && v.clock.daysLeft >= 0 && v.clock.daysLeft <= 2 : due === 'open' ? open(v) : true)));
    const tiles = {
      open: views.filter(open).length,
      dueSoon: views.filter(v => open(v) && v.clock.daysLeft !== null && v.clock.daysLeft >= 1 && v.clock.daysLeft <= 2).length,
      dueToday: views.filter(v => open(v) && v.clock.daysLeft === 0).length,
      late: views.filter(v => open(v) && v.clock.daysLeft !== null && v.clock.daysLeft < 0).length,
      ready: views.filter(v => v.stage.key === 'ready').length
    };
    ok(res, filtered.slice(offset, offset + size), { page, pageSize: size, total: filtered.length, tiles });
  });
}

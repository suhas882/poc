// @ts-check
import crypto from 'node:crypto';
import { HttpError, ok, pageParams, readJson, SECURITY_HEADERS, validate } from '../http.mjs';
import { requirePermission, ROLES } from '../auth.mjs';
import { AUDIT_ACTIONS } from '../audit.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { hashPassword, passwordProblem } from '../security.mjs';
import { applyRetention } from '../retention.mjs';
import { CONSENT_VERSION, getConsent } from '../consent.mjs';
import { activePack, getSetting, listPacks, setSetting, switches } from '../packs.mjs';
import { dueDate, todayIn } from '../deadline.mjs';

const SETTINGS = { defaultMode: { type: 'string', values: ['demo', 'real'] }, summariesEnabled: { type: 'bool' }, resultsPerPage: { type: 'int', min: 10, max: 100 } };
const DEFAULTS = { defaultMode: 'demo', summariesEnabled: true, resultsPerPage: 20 };

export function tenantSettings(db, tenantId) {
  const out = { ...DEFAULTS };
  for (const r of db.all('SELECT key, value FROM settings WHERE tenant_id = ?', tenantId)) if (r.key in DEFAULTS) out[r.key] = parseJson(r.value, out[r.key]);
  return out;
}

/** @param {import('../http.mjs').Router} router */
export function registerAdminRoutes(router, s) {
  const { db, audit, config } = s;

  /* ---- users ---- */
  router.on('GET', '/api/users', ({ res, user }) => {
    requirePermission(user, 'users.manage');
    ok(res, db.all('SELECT id, email, name, role, disabled, created_at AS createdAt, last_login_at AS lastLoginAt FROM users WHERE tenant_id = ? ORDER BY name', user.tenantId).map(u => ({ ...u, disabled: Boolean(u.disabled) })));
  });

  router.on('POST', '/api/users', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'users.manage');
    const body = validate({ email: { type: 'string', required: true, max: 254, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, patternMessage: 'must be an email address' }, name: { type: 'string', required: true, max: 120 }, role: { type: 'string', required: true, values: ROLES }, password: { type: 'string', required: true, trim: false, max: 200 } }, await readJson(req));
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, 'weak_password', problem);
    if (db.get('SELECT 1 FROM users WHERE email = ?', body.email.toLowerCase())) throw new HttpError(409, 'email_taken', 'An account with that email already exists.');
    const id = crypto.randomUUID();
    db.run('INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)', id, user.tenantId, body.email.toLowerCase(), body.name, body.role, hashPassword(body.password));
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'user.created', targetType: 'user', targetId: id, ipHash, details: { role: body.role } });
    ok(res, { id, email: body.email.toLowerCase(), name: body.name, role: body.role, disabled: false }, undefined, 201);
  });

  router.on('PATCH', '/api/users/:id', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'users.manage');
    const target = db.get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', params.id, user.tenantId);
    if (!target) throw new HttpError(404, 'not_found', 'That user does not exist.');
    const body = validate({ name: { type: 'string', max: 120 }, role: { type: 'string', values: ROLES }, disabled: { type: 'bool' }, password: { type: 'string', trim: false, max: 200 } }, await readJson(req));
    if (target.id === user.id && (body.role && body.role !== 'admin' || body.disabled)) throw new HttpError(400, 'self_lockout', 'You can’t remove your own administrator access or disable yourself.');
    if (body.password) { const p = passwordProblem(body.password); if (p) throw new HttpError(400, 'weak_password', p); }
    db.run('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), disabled = COALESCE(?, disabled), password_hash = COALESCE(?, password_hash) WHERE id = ?',
      body.name ?? null, body.role ?? null, body.disabled === undefined ? null : body.disabled ? 1 : 0, body.password ? hashPassword(body.password) : null, target.id);
    if (body.disabled || body.role || body.password) s.sessions.destroyAllFor(target.id); // permission changes take effect at once
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'user.updated', targetType: 'user', targetId: target.id, ipHash, details: { role: body.role, disabled: body.disabled, passwordReset: Boolean(body.password) } });
    const u = db.get('SELECT id, email, name, role, disabled FROM users WHERE id = ?', target.id);
    ok(res, { ...u, disabled: Boolean(u.disabled) });
  });

  /* ---- audit log ---- */
  function auditQuery(user, url) {
    const where = ['a.tenant_id = ?'], p = [user.tenantId];
    const f = (k) => url.searchParams.get(k);
    if (f('action')) { where.push('a.action = ?'); p.push(f('action')); }
    if (f('category')) { where.push('a.action LIKE ?'); p.push(`${f('category')}.%`); }
    if (f('userId')) { where.push('a.user_id = ?'); p.push(f('userId')); }
    if (f('outcome')) { where.push('a.outcome = ?'); p.push(f('outcome')); }
    if (f('from')) { where.push('a.created_at >= ?'); p.push(`${f('from')}T00:00:00.000Z`); }
    if (f('to')) { where.push('a.created_at <= ?'); p.push(`${f('to')}T23:59:59.999Z`); }
    return { sql: `FROM audit_events a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')}`, params: p };
  }
  const auditView = (r) => ({ id: r.id, at: r.created_at, action: r.action, label: AUDIT_ACTIONS[r.action] ?? r.action, outcome: r.outcome, user: r.user_id ? { id: r.user_id, name: r.user_name } : null, targetType: r.target_type, targetId: r.target_id, ipHash: r.ip_hash, details: parseJson(r.details, {}), before: parseJson(r.before_value, null), after: parseJson(r.after_value, null), fingerprint: r.hash ? r.hash.slice(0, 12) : null, hash: r.hash, prevHash: r.prev_hash });

  router.on('GET', '/api/audit', ({ res, user, url }) => {
    requirePermission(user, 'audit.read');
    const { page, size, offset } = pageParams(url, 50, 200);
    const q = auditQuery(user, url);
    const total = db.get(`SELECT COUNT(*) AS n ${q.sql}`, ...q.params).n;
    const rows = db.all(`SELECT a.*, u.name AS user_name ${q.sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...q.params, size, offset);
    ok(res, rows.map(auditView), { page, pageSize: size, total, actions: AUDIT_ACTIONS, users: db.all('SELECT id, name FROM users WHERE tenant_id = ? ORDER BY name', user.tenantId) });
  });

  router.on('GET', '/api/audit/export', ({ res, user, url, ipHash }) => {
    requirePermission(user, 'audit.read');
    const q = auditQuery(user, url);
    const rows = db.all(`SELECT a.*, u.name AS user_name ${q.sql} ORDER BY a.id DESC LIMIT 50000`, ...q.params).map(auditView);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'export.created', targetType: 'audit_log', ipHash, details: { rows: rows.length } });
    const esc = (v) => { const t = String(v ?? ''); return `"${(/^[=+\-@]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`; };
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end('\ufeff' + ['Time,What happened,Outcome,Who,Item type,Item,Before,After,Details,Hash,Previous hash', ...rows.map(r => [r.at, r.label, r.outcome, r.user?.name ?? '', r.targetType ?? '', r.targetId ?? '', r.before == null ? '' : JSON.stringify(r.before), r.after == null ? '' : JSON.stringify(r.after), JSON.stringify(r.details), r.hash ?? '', r.prevHash ?? ''].map(esc).join(','))].join('\r\n'));
  });

  router.on('GET', '/api/audit/verify', ({ res, user }) => {
    requirePermission(user, 'audit.read');
    ok(res, { ...audit.verify(user.tenantId), wording: 'Tamper-evident: each entry is hashed together with the one before it. This shows changes; it does not prevent them.', checkedAt: nowIso() });
  });

  /* ---- search permission (consent) ---- */
  const realSources = (user) => db.all(`SELECT s.id, s.name, s.type, s.owner_user_id = ? AS is_own, (SELECT COUNT(*) FROM records r WHERE r.source_id = s.id) AS records
    FROM sources s WHERE s.tenant_id = ? AND s.type != 'synthetic' AND s.status != 'disconnected'
      AND ((s.visibility = 'owner' AND s.owner_user_id = ?) OR (s.visibility = 'roles' AND (s.allowed_roles = '[]' OR EXISTS (SELECT 1 FROM json_each(s.allowed_roles) WHERE value = ?))))
    ORDER BY s.name`, user.id, user.tenantId, user.id, user.role).map(r => ({ id: r.id, name: r.name, type: r.type, isOwn: Boolean(r.is_own), records: r.records }));

  router.on('GET', '/api/consent', ({ res, user }) => {
    requirePermission(user, 'search.run');
    ok(res, { consent: getConsent(db, user.id), version: CONSENT_VERSION, sources: realSources(user) });
  });

  router.on('PUT', '/api/consent', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'search.run');
    const body = validate({ scope: { type: 'string', required: true, values: ['all', 'selected'] }, sourceIds: { type: 'array', items: { type: 'string', max: 64 }, max: 200, default: [] }, acknowledged: { type: 'bool', required: true } }, await readJson(req));
    if (body.acknowledged !== true) throw new HttpError(400, 'not_acknowledged', 'Tick the box to confirm you understand how searches are logged.');
    const visible = new Set(realSources(user).map(x => x.id));
    const sourceIds = body.scope === 'selected' ? body.sourceIds.filter(id => visible.has(id)) : [];
    const before = getConsent(db, user.id);
    const now = nowIso();
    db.run(`INSERT INTO user_consents (user_id, tenant_id, scope, source_ids, version, granted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET scope = excluded.scope, source_ids = excluded.source_ids, version = excluded.version, updated_at = excluded.updated_at`,
    user.id, user.tenantId, body.scope, JSON.stringify(sourceIds), CONSENT_VERSION, now, now);
    const names = (ids) => ids.map(id => db.get('SELECT name FROM sources WHERE id = ?', id)?.name ?? id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: before ? 'consent.changed' : 'consent.granted', targetType: 'user', targetId: user.id, ipHash, details: { version: CONSENT_VERSION },
      before: before ? { mode: before.scope === 'all' ? 'Everything I can access' : 'Only the sources I choose', sources: names(before.sourceIds) } : null,
      after: { mode: body.scope === 'all' ? 'Everything I can access' : 'Only the sources I choose', sources: names(sourceIds) } });
    ok(res, getConsent(db, user.id));
  });

  router.on('DELETE', '/api/consent', ({ res, user, ipHash }) => {
    requirePermission(user, 'search.run');
    const before = getConsent(db, user.id);
    db.run('DELETE FROM user_consents WHERE user_id = ?', user.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'consent.withdrawn', targetType: 'user', targetId: user.id, ipHash,
      before: before ? { mode: before.scope === 'all' ? 'Everything I can access' : 'Only the sources I choose', sources: before.sourceIds.length } : null, after: null });
    ok(res, { withdrawn: true });
  });

  /* ---- settings, usage, retention ---- */
  router.on('GET', '/api/settings', ({ res, user }) => {
    if (!user) throw new HttpError(401, 'not_signed_in', 'Sign in to continue.');
    ok(res, { ...tenantSettings(db, user.tenantId), retention: config.retention, tenant: db.get('SELECT name FROM tenants WHERE id = ?', user.tenantId)?.name });
  });

  router.on('PATCH', '/api/settings', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'settings.manage');
    const body = validate(SETTINGS, await readJson(req));
    db.tx(() => { for (const [k, v] of Object.entries(body)) db.run('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value', user.tenantId, k, JSON.stringify(v)); });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'settings.updated', ipHash, details: body });
    ok(res, tenantSettings(db, user.tenantId));
  });

  /* ---- workflow settings: city pack, holidays, warning level, admin switches ---- */
  function workflowSettings(user) {
    const pack = activePack(db, user.tenantId);
    const t = todayIn(pack.timezone);
    return {
      pack: { id: pack.id, name: pack.name, label: pack.label, departments: pack.departments, recordTypes: pack.recordTypes, holidays: pack.holidays, holidayNote: pack.holidayNote,
        holidaysAdded: pack.holidaysAdded, holidaysRemoved: pack.holidaysRemoved, wording: pack.wording, reviewRules: pack.reviewRules, threshold: pack.broadPlanThreshold, thresholdNote: pack.broadPlanNote,
        sources: pack.sources, sourceMap: pack.sourceMap, knownGaps: pack.knownGaps, responseDays: pack.responseDays, timezone: pack.timezone },
      packs: listPacks(), switches: switches(db, user.tenantId, config),
      example: { receivedToday: t, dueIfReceivedToday: dueDate(t, new Set(pack.holidays), pack.responseDays) },
      reuseNote: 'Reuse by other agencies is a plan, subject to agency requirements and agreed scope. No other agency uses this tool.'
    };
  }
  router.on('GET', '/api/settings/workflow', ({ res, user }) => {
    if (!user) throw new HttpError(401, 'not_signed_in', 'Sign in to continue.');
    ok(res, workflowSettings(user));
  });
  router.on('PUT', '/api/settings/holidays', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'settings.manage');
    const body = validate({ add: { type: 'date' }, remove: { type: 'date' } }, await readJson(req));
    const added = new Set(getSetting(db, user.tenantId, 'holidays_added', []));
    const removed = new Set(getSetting(db, user.tenantId, 'holidays_removed', []));
    const before = activePack(db, user.tenantId).holidays;
    if (body.add) { added.add(body.add); removed.delete(body.add); }
    if (body.remove) { added.delete(body.remove); removed.add(body.remove); }
    setSetting(db, user.tenantId, 'holidays_added', [...added].sort());
    setSetting(db, user.tenantId, 'holidays_removed', [...removed].sort());
    // Open requests keep their stored due date in sync with the holiday list.
    const pack = activePack(db, user.tenantId);
    for (const r of db.all('SELECT id, received_at FROM search_requests WHERE tenant_id = ? AND received_at IS NOT NULL AND handed_off_at IS NULL', user.tenantId)) {
      db.run('UPDATE search_requests SET due_date = ? WHERE id = ?', dueDate(r.received_at, new Set(pack.holidays), pack.responseDays), r.id);
    }
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'settings.updated', ipHash, details: { setting: 'holidays' }, before: before.length, after: { added: body.add ?? null, removed: body.remove ?? null } });
    ok(res, workflowSettings(user));
  });
  router.on('PUT', '/api/settings/switches', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'settings.manage');
    const body = validate({ phoneLink: { type: 'bool' }, secondApproval: { type: 'bool' }, realSources: { type: 'bool' } }, await readJson(req));
    if (body.realSources !== undefined && body.realSources !== config.realSources) throw new HttpError(403, 'env_only', 'Real sources are set on the server (REAL_SOURCES). They cannot be changed from the web interface.');
    const before = switches(db, user.tenantId, config);
    if (body.phoneLink !== undefined) {
      if (body.phoneLink && !config.realSources) throw new HttpError(403, 'real_sources_off', 'Phone Link texts need real sources, which are off on this server.');
      setSetting(db, user.tenantId, 'switch_phonelink', body.phoneLink);
    }
    if (body.secondApproval !== undefined) setSetting(db, user.tenantId, 'switch_approval', body.secondApproval);
    const after = switches(db, user.tenantId, config);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'settings.updated', ipHash, details: { setting: 'admin switches' }, before, after });
    ok(res, workflowSettings(user));
  });
  router.on('PUT', '/api/settings/pack', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'settings.manage');
    const body = validate({ pack: { type: 'string', required: true, max: 40, pattern: /^[a-z0-9-]+$/ }, threshold: { type: 'int', min: 1, max: 100000 } }, await readJson(req));
    if (!listPacks().some(p => p.id === body.pack)) throw new HttpError(404, 'not_found', 'Unknown city pack.');
    const before = activePack(db, user.tenantId);
    if (before.id !== body.pack) {
      setSetting(db, user.tenantId, 'pack', body.pack);
      db.run("DELETE FROM settings WHERE tenant_id = ? AND key IN ('holidays_added', 'holidays_removed', 'broad_threshold')", user.tenantId);
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'pack.switched', ipHash, before: before.id, after: body.pack });
    }
    if (body.threshold !== undefined) {
      const prev = activePack(db, user.tenantId).broadPlanThreshold;
      setSetting(db, user.tenantId, 'broad_threshold', body.threshold);
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'settings.updated', ipHash, details: { setting: 'broad plan warning level' }, before: prev, after: body.threshold });
    }
    ok(res, workflowSettings(user));
  });

  router.on('GET', '/api/usage', ({ res, user }) => {
    requirePermission(user, 'usage.read');
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const totals = db.get('SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, SUM(cost_usd) AS costUsd, SUM(outcome != \'success\') AS failures FROM ai_usage WHERE tenant_id = ? AND created_at >= ?', user.tenantId, since);
    const byPurpose = db.all('SELECT purpose, model, COUNT(*) AS calls, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(cost_usd) AS costUsd FROM ai_usage WHERE tenant_id = ? AND created_at >= ? GROUP BY purpose, model', user.tenantId, since);
    ok(res, { periodDays: 30, totals, byPurpose, pricingConfigured: config.anthropic.priceInputPerMTok != null && config.anthropic.priceOutputPerMTok != null });
  });

  router.on('POST', '/api/settings/retention/apply', ({ res, user, ipHash }) => {
    requirePermission(user, 'settings.manage');
    const result = applyRetention(db, config, audit);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'retention.applied', ipHash, details: { ...result, manual: true, at: nowIso() } });
    ok(res, result);
  });
}

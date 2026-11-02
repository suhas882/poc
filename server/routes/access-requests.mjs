// @ts-check
/**
 * Access requests: someone signs in with Google or Microsoft, has no account here, and asks for one.
 *
 * - The applicant's identity comes only from the verified sign-in (encrypted cookie), never from the form.
 * - Nothing is created until a Supervisor approves. Approval creates the user in the Supervisor's own organization
 *   with the chosen role, and links the exact provider account that asked (provider + subject). No email matching.
 * - One open request per provider account and per email; an email that already has an account cannot ask again.
 * - Every request and decision is in the audit log.
 */
import crypto from 'node:crypto';
import { HttpError, ok, readJson, validate } from '../http.mjs';
import { requirePermission, ROLES } from '../auth.mjs';
import { nowIso } from '../db.mjs';
import { hashPassword, randomToken } from '../security.mjs';

const view = (r) => ({
  id: r.id, provider: r.provider, email: r.email, name: r.name, organization: r.organization, reason: r.reason, status: r.status,
  createdAt: r.created_at, decidedAt: r.decided_at, decidedBy: r.decided_by_name ?? null, role: r.decided_role, note: r.decision_note, userId: r.user_id
});

/** @param {import('../http.mjs').Router} router */
export function registerAccessRequestRoutes(router, s) {
  const { db, audit, config } = s;
  const pending = (identity) => db.get("SELECT * FROM access_requests WHERE status = 'pending' AND ((provider = ? AND subject = ?) OR email = ?)", identity.provider, identity.subject, identity.email);
  const latest = (identity) => db.get('SELECT * FROM access_requests WHERE provider = ? AND subject = ? ORDER BY created_at DESC LIMIT 1', identity.provider, identity.subject);
  const applicant = (req) => {
    if (!config.realSources) throw new HttpError(403, 'real_sources_off', 'This server only runs the Tier 0 demo; it has no accounts to request.');
    const identity = s.signin.requestIdentity(req);
    if (!identity) throw new HttpError(403, 'no_verified_identity', 'Sign in with Google or Microsoft first. Your verified sign-in is kept for 30 minutes.');
    return identity;
  };

  /** What the Access Request page shows: the verified name and email, and any earlier request. */
  router.on('GET', '/api/access-requests/me', ({ req, res }) => {
    const identity = applicant(req);
    const r = latest(identity);
    ok(res, { identity: { name: identity.name, email: identity.email, provider: identity.provider }, request: r ? view(r) : null });
  });

  router.on('POST', '/api/access-requests/me', async ({ req, res, ip, ipHash }) => {
    const identity = applicant(req);
    const limit = s.limits.login.take(`access|${ip}`);
    if (!limit.allowed) throw new HttpError(429, 'too_many_attempts', `Too many requests. Try again in ${Math.ceil(limit.retryAfter / 60)} minutes.`);
    const body = validate({ organization: { type: 'string', required: true, max: 120 }, reason: { type: 'string', required: true, max: 1000 } }, await readJson(req));
    if (body.organization.trim().length < 2) throw new HttpError(400, 'invalid', 'Enter your organization.');
    if (body.reason.trim().length < 10) throw new HttpError(400, 'invalid', 'Say briefly why you need access (at least 10 characters).');
    if (db.get('SELECT 1 FROM users WHERE email = ?', identity.email) || db.get('SELECT 1 FROM user_identities WHERE provider = ? AND subject = ?', identity.provider, identity.subject)) {
      throw new HttpError(409, 'already_has_account', 'An account already exists for this sign-in. Use Sign in instead, or ask a Supervisor.');
    }
    const open = pending(identity);
    if (open) throw new HttpError(409, 'request_pending', `An access request for ${identity.email} is already waiting for a Supervisor (sent ${open.created_at.slice(0, 10)}).`, { request: view(open) });
    // Only that organization's Supervisors see a request naming an organization on this server; others see unmatched ones.
    const target = db.get('SELECT id FROM tenants WHERE is_demo = 0 AND name = ? COLLATE NOCASE', body.organization.trim());
    const id = crypto.randomUUID();
    db.run('INSERT INTO access_requests (id, provider, subject, email, name, organization, reason, target_tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, identity.provider, identity.subject, identity.email, identity.name, body.organization.trim(), body.reason.trim(), target?.id ?? null);
    audit.write({ tenantId: target?.id, action: 'access.requested', targetType: 'access_request', targetId: id, ipHash, details: { provider: identity.provider, email: identity.email, organization: body.organization.trim() } });
    ok(res, { request: view(db.get('SELECT * FROM access_requests WHERE id = ?', id)) }, undefined, 201);
  });

  /* ---- Supervisors: pending requests addressed to their organization or to none, and their own decisions ---- */

  router.on('GET', '/api/access-requests', ({ res, user }) => {
    requirePermission(user, 'users.manage');
    const rows = db.all(`SELECT r.*, u.name AS decided_by_name FROM access_requests r LEFT JOIN users u ON u.id = r.decided_by
      WHERE (r.status = 'pending' AND (r.target_tenant_id IS NULL OR r.target_tenant_id = ?)) OR (r.status != 'pending' AND r.decided_tenant_id = ?)
      ORDER BY r.status != 'pending', r.created_at DESC LIMIT 100`, user.tenantId, user.tenantId);
    ok(res, rows.map(view), { roles: ROLES });
  });

  const loadPending = (user, id) => {
    requirePermission(user, 'users.manage');
    const r = db.get("SELECT * FROM access_requests WHERE id = ? AND status = 'pending' AND (target_tenant_id IS NULL OR target_tenant_id = ?)", id, user.tenantId);
    if (!r) throw new HttpError(404, 'not_found', 'That request does not exist or was already decided.');
    return r;
  };

  router.on('POST', '/api/access-requests/:id/approve', async ({ req, res, user, params, ipHash }) => {
    const r = loadPending(user, params.id);
    const body = validate({ role: { type: 'string', required: true, values: ROLES }, note: { type: 'string', max: 500 } }, await readJson(req));
    if (db.get('SELECT 1 FROM users WHERE email = ?', r.email)) throw new HttpError(409, 'email_taken', `An account for ${r.email} already exists. Reject this request; the person can sign in with that account.`);
    if (db.get('SELECT 1 FROM user_identities WHERE provider = ? AND subject = ?', r.provider, r.subject)) throw new HttpError(409, 'identity_in_use', 'This sign-in is already linked to another user.');
    const id = crypto.randomUUID();
    db.tx(() => {
      // No usable password: this person signs in with the provider account that asked. A Supervisor can set a password later.
      db.run('INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)', id, user.tenantId, r.email, r.name, body.role, hashPassword(randomToken(32)));
      db.run('INSERT INTO user_identities (provider, subject, user_id, email) VALUES (?, ?, ?, ?)', r.provider, r.subject, id, r.email);
      db.run("UPDATE access_requests SET status = 'approved', decided_at = ?, decided_by = ?, decided_tenant_id = ?, decided_role = ?, decision_note = ?, user_id = ? WHERE id = ?",
        nowIso(), user.id, user.tenantId, body.role, body.note ?? null, id, r.id);
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'access.approved', targetType: 'access_request', targetId: r.id, ipHash, details: { email: r.email, provider: r.provider, role: body.role, newUserId: id, note: body.note } });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'user.created', targetType: 'user', targetId: id, ipHash, details: { role: body.role, via: 'access_request' } });
    ok(res, { userId: id, request: view(db.get('SELECT * FROM access_requests WHERE id = ?', r.id)) });
  });

  router.on('POST', '/api/access-requests/:id/reject', async ({ req, res, user, params, ipHash }) => {
    const r = loadPending(user, params.id);
    const body = validate({ note: { type: 'string', max: 500 } }, await readJson(req));
    db.run("UPDATE access_requests SET status = 'rejected', decided_at = ?, decided_by = ?, decided_tenant_id = ?, decision_note = ? WHERE id = ?", nowIso(), user.id, user.tenantId, body.note ?? null, r.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'access.rejected', targetType: 'access_request', targetId: r.id, ipHash, details: { email: r.email, provider: r.provider, note: body.note } });
    ok(res, { request: view(db.get('SELECT * FROM access_requests WHERE id = ?', r.id)) });
  });
}

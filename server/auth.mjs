// @ts-check
import { nowIso } from './db.mjs';
import { HttpError, parseCookies, serializeCookie } from './http.mjs';
import { randomToken, safeEqual, sha256 } from './security.mjs';

/** What each role may do. Checked on every API route. */
export const ROLE_PERMISSIONS = Object.freeze({
  admin: ['search.run', 'records.read', 'sources.read', 'sources.manage', 'uploads.create', 'export.create', 'evaluate.write', 'history.read_own', 'history.read_all', 'audit.read', 'users.manage', 'settings.manage', 'usage.read'],
  records_officer: ['search.run', 'records.read', 'sources.read', 'sources.manage', 'uploads.create', 'export.create', 'evaluate.write', 'history.read_own', 'usage.read'],
  reviewer: ['search.run', 'records.read', 'sources.read', 'evaluate.write', 'history.read_own'],
  auditor: ['sources.read', 'history.read_all', 'audit.read', 'usage.read']
});
export const ROLES = Object.freeze(Object.keys(ROLE_PERMISSIONS));

/** @param {{role: string} | null | undefined} user @param {string} perm */
export const can = (user, perm) => Boolean(user && ROLE_PERMISSIONS[user.role]?.includes(perm));

/**
 * @typedef {{id: string, tenantId: string, email: string, name: string, role: string, csrfToken: string, sessionHash: string}} SessionUser
 */

export class Sessions {
  /** @param {import('./db.mjs').Database} db @param {import('./config.mjs').AppConfig} config */
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.cookieName = config.secureCookies ? '__Host-prs_session' : 'prs_session';
  }

  /** @param {{id: string, tenant_id: string}} user @returns {{token: string, csrf: string, cookie: string}} */
  create(user) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    const now = new Date();
    const expires = new Date(now.getTime() + this.config.sessionTtlHours * 3600_000);
    this.db.run('INSERT INTO sessions (token_hash, user_id, tenant_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha256(token), user.id, user.tenant_id, csrf, now.toISOString(), expires.toISOString(), now.toISOString());
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', now.toISOString());
    const cookie = serializeCookie(this.cookieName, token, { secure: this.config.secureCookies, maxAge: this.config.sessionTtlHours * 3600, sameSite: 'Lax' });
    return { token, csrf, cookie };
  }

  /** @param {import('node:http').IncomingMessage} req @returns {SessionUser | null} */
  fromRequest(req) {
    const token = parseCookies(req.headers.cookie)[this.cookieName];
    if (!token) return null;
    const hash = sha256(token);
    const row = this.db.get(`SELECT s.token_hash, s.csrf_token, s.expires_at, s.last_seen_at, u.id, u.tenant_id, u.email, u.name, u.role, u.disabled
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, hash);
    if (!row || row.disabled || row.expires_at < nowIso()) return null;
    // Touch at most once a minute.
    if (Date.parse(row.last_seen_at) < Date.now() - 60_000) this.db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', nowIso(), hash);
    return { id: row.id, tenantId: row.tenant_id, email: row.email, name: row.name, role: row.role, csrfToken: row.csrf_token, sessionHash: hash };
  }

  /** @param {string} sessionHash */
  destroy(sessionHash) { this.db.run('DELETE FROM sessions WHERE token_hash = ?', sessionHash); }
  /** @param {string} userId */
  destroyAllFor(userId) { this.db.run('DELETE FROM sessions WHERE user_id = ?', userId); }

  clearCookie() { return serializeCookie(this.cookieName, '', { secure: this.config.secureCookies, maxAge: 0 }); }
}

/**
 * Cross-site request forgery defence for state-changing requests:
 * the X-CSRF-Token header must match the session's token, and a present
 * Origin header must match this server.
 * @param {import('node:http').IncomingMessage} req @param {SessionUser} user @param {string} publicUrl
 */
export function checkCsrf(req, user, publicUrl) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET')) return;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    const host = req.headers.host;
    const allowed = [new URL(publicUrl).origin, host ? `http://${host}` : '', host ? `https://${host}` : ''];
    if (!allowed.includes(origin)) throw new HttpError(403, 'bad_origin', 'This request came from another site and was blocked.');
  }
  const header = req.headers['x-csrf-token'];
  if (typeof header !== 'string' || !safeEqual(header, user.csrfToken)) {
    throw new HttpError(403, 'csrf_failed', 'Your session token is missing or out of date. Reload the page and try again.');
  }
}

/** @param {SessionUser | null} user @param {string} perm */
export function requirePermission(user, perm) {
  if (!user) throw new HttpError(401, 'not_signed_in', 'Sign in to continue.');
  if (!can(user, perm)) throw new HttpError(403, 'forbidden', 'Your role does not allow this action.');
  return user;
}

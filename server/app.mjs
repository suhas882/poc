// @ts-check
/**
 * Application wiring: builds services from config, registers routes, serves
 * the allowlisted static files, and applies security headers, CSRF checks,
 * rate limits and audit logging around every API call.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { Database, nowIso } from './db.mjs';
import { HttpError, Router, SECURITY_HEADERS, ok, sendError, sendJson, readJson, validate } from './http.mjs';
import { Sessions, checkCsrf, can, requirePermission, ROLES, ROLE_PERMISSIONS } from './auth.mjs';
import { AuditLog } from './audit.mjs';
import { DUMMY_HASH, RateLimiter, Vault, hashIp, hashPassword, passwordProblem, verifyPassword } from './security.mjs';
import { createAnthropicProvider } from './ai/anthropic.mjs';
import { withUsageTracking } from './ai/provider.mjs';
import { createEmbedder } from './search/embeddings.mjs';
import { GmailConnector } from './connectors/gmail.mjs';
import { DatabaseConnector } from './connectors/database.mjs';
import { PhoneLinkConnector, isPhoneLink } from './connectors/phonelink.mjs';
import { startSync } from './routes/sources.mjs';
import { registerDemoStateRoutes } from './routes/demo-state.mjs';
import { seedSyntheticSource } from './connectors/synthetic.mjs';
import { registerSourceRoutes } from './routes/sources.mjs';
import { registerSearchRoutes } from './routes/search.mjs';
import { registerAdminRoutes } from './routes/admin.mjs';
import { applyRetention } from './retention.mjs';
import { consentRequired } from './consent.mjs';

/** Static files the server may send. Nothing else on disk is reachable. */
const PAGES = ['index.html', 'search.html', 'evaluation.html', 'sources.html', 'history.html', 'audit.html', 'settings.html', 'login.html', 'consent.html', 'POC-VIDEO.html'];
const STATIC = new Map([
  ...PAGES.map(p => [`/${p}`, [p, 'text/html; charset=utf-8']]),
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/PITCH-VIDEO-SCRIPT.md', ['PITCH-VIDEO-SCRIPT.md', 'text/markdown; charset=utf-8']],
  ['/video-output/bellevue-public-records-poc-walkthrough.mp4', ['video-output/bellevue-public-records-poc-walkthrough.mp4', 'video/mp4']]
].map(([k, v]) => [k, /** @type {[string, string]} */ (v)]));
const CLIENT_JS = /^\/client\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\.js$/;

/**
 * @param {import('./config.mjs').AppConfig} config
 * @param {{fetch?: typeof fetch, log?: (...a: any[]) => void, connectDatabase?: Function, sqliteConnectorDir?: string, aiProvider?: any, embedder?: any}} [deps]
 */
export function createApp(config, deps = {}) {
  const log = deps.log ?? console.log;
  const db = new Database(config.dbPath);
  db.migrate();
  const vault = Vault.fromConfig(config, (m) => log(m));
  const audit = new AuditLog(db);
  const sessions = new Sessions(db, config);
  const doFetch = deps.fetch ?? fetch;

  const baseProvider = deps.aiProvider !== undefined ? deps.aiProvider : (config.anthropic.apiKey ? createAnthropicProvider(config.anthropic, { fetch: doFetch }) : null);
  const ai = baseProvider && !config.demoOnly ? withUsageTracking(baseProvider, db, config.anthropic) : null;
  let embedder = null, embedderError = null;
  try { embedder = deps.embedder !== undefined ? deps.embedder : createEmbedder(config.embeddings, { fetch: doFetch }); } catch (err) { embedderError = err instanceof Error ? err.message : String(err); }

  const services = {
    config, db, vault, audit, sessions, ai, embedder, embedderError, log,
    gmail: new GmailConnector({ db, config, vault, fetch: doFetch }),
    phonelink: new PhoneLinkConnector({ db, config }),
    database: new DatabaseConnector({ db, config, vault, connectOverride: deps.connectDatabase, sqliteDir: deps.sqliteConnectorDir }),
    limits: {
      login: new RateLimiter(config.rateLimits.loginPerWindow, 15 * 60_000),
      api: new RateLimiter(config.rateLimits.apiPerMinute, 60_000),
      search: new RateLimiter(config.rateLimits.searchPerMinute, 60_000)
    },
    /** @type {Map<string, Promise<unknown>>} sync jobs in flight, by source id */
    running: new Map()
  };

  const router = new Router();
  registerAuthRoutes(router, services);
  registerSourceRoutes(router, services);
  registerSearchRoutes(router, services);
  registerAdminRoutes(router, services);
  registerDemoStateRoutes(router, services);

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const ip = (config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, data: { status: 'ok', demoOnly: config.demoOnly } });
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/')) {
        if (config.demoOnly && url.pathname !== '/api/auth/status' && !url.pathname.startsWith('/api/demo-state')) throw new HttpError(404, 'demo_only', 'This server runs the synthetic demo only. Real-data features are switched off (DEMO_ONLY=true).');
        const user = sessions.fromRequest(req);
        const rate = services.limits.api.take(user ? `u:${user.id}` : `ip:${ip}`);
        if (!rate.allowed) throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.', { retryAfter: rate.retryAfter });
        const match = router.match(req.method || 'GET', url.pathname);
        if (!match) throw new HttpError(404, 'not_found', 'There is no API endpoint at this address.');
        if ('methodNotAllowed' in match) throw new HttpError(405, 'method_not_allowed', 'This endpoint does not accept that method.');
        if (user && !url.pathname.startsWith('/oauth/')) checkCsrf(req, user, config.publicUrl);
        const ctx = { req, res, url, params: match.params, user, ip, ipHash: hashIp(ip, config.ipHashSalt || 'prs'), services };
        await match.handler(ctx);
        return;
      }
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        const user = sessions.fromRequest(req);
        if (err.status === 403) audit.write({ tenantId: user?.tenantId, userId: user?.id, action: 'access.denied', targetType: 'endpoint', targetId: `${req.method} ${url.pathname}`, outcome: 'denied', ipHash: hashIp(ip, config.ipHashSalt || 'prs'), details: { code: err.code } });
      }
      sendError(res, err, (...a) => log(...a));
    }
  }

  // Housekeeping: retention and expired sessions, now and daily.
  const runRetention = () => { try { applyRetention(db, config, audit); } catch (err) { log('[retention] failed:', err); } };
  runRetention();
  const timer = setInterval(runRetention, 24 * 3600_000);
  timer.unref();

  // Phone Link: pick up new texts automatically whenever Phone Link's file changes.
  const phoneTick = () => {
    for (const src of db.all("SELECT * FROM sources WHERE type = 'messages' AND status != 'disconnected'")) {
      try { if (isPhoneLink(src) && !services.running.has(src.id) && services.phonelink.isStale(src)) startSync(services, src, null, 'automatic'); }
      catch (err) { log('[phonelink] auto-sync skipped:', err instanceof Error ? err.message : err); }
    }
  };
  const phoneTimer = config.phonelink.syncMinutes > 0 ? setInterval(phoneTick, config.phonelink.syncMinutes * 60_000) : null;
  phoneTimer?.unref();

  return {
    handler, services, db,
    async close() { clearInterval(timer); if (phoneTimer) clearInterval(phoneTimer); await Promise.allSettled([...services.running.values()]); db.close(); }
  };
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
  let entry = STATIC.get(url.pathname);
  if (!entry && CLIENT_JS.test(url.pathname)) entry = [url.pathname.slice(1), 'text/javascript; charset=utf-8'];
  const file = entry ? path.join(ROOT, entry[0]) : null;
  if (!entry || !file || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) {
    return sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Page not found.' } });
  }
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------------- auth, users bootstrap, system status ---------------- */

const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

/** @param {Router} router */
function registerAuthRoutes(router, s) {
  const { db, sessions, audit, config } = s;

  router.on('GET', '/api/auth/status', ({ res, user }) => {
    const setupRequired = !config.demoOnly && !db.get('SELECT 1 FROM users LIMIT 1');
    ok(res, {
      demoOnly: config.demoOnly,
      setupRequired,
      user: user ? { id: user.id, name: user.name, email: user.email, role: user.role, permissions: ROLE_PERMISSIONS[user.role] } : null,
      consentRequired: user ? consentRequired(db, user) : false,
      csrfToken: user?.csrfToken ?? null
    });
  });

  router.on('POST', '/api/auth/setup', async (ctx) => {
    const { req, res, ip, ipHash } = ctx;
    if (db.get('SELECT 1 FROM users LIMIT 1')) throw new HttpError(409, 'already_set_up', 'This server already has an administrator. Sign in instead.');
    const body = validate({ orgName: { type: 'string', required: true, max: 120 }, name: { type: 'string', required: true, max: 120 }, email: { type: 'string', required: true, max: 254, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, patternMessage: 'must be an email address' }, password: { type: 'string', required: true, trim: false, max: 200 }, setupToken: { type: 'string', max: 200 } }, await readJson(req));
    if (!isLoopback(ip) && !(config.setupToken && body.setupToken === config.setupToken)) {
      throw new HttpError(403, 'setup_locked', 'The first administrator can only be created from this computer (localhost) or with the SETUP_TOKEN set on the server.');
    }
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, 'weak_password', problem);
    const tenantId = crypto.randomUUID(), userId = crypto.randomUUID();
    db.tx(() => {
      db.run('INSERT INTO tenants (id, name) VALUES (?, ?)', tenantId, body.orgName);
      db.run('INSERT INTO users (id, tenant_id, email, name, role, password_hash, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)', userId, tenantId, body.email.toLowerCase(), body.name, 'admin', hashPassword(body.password), nowIso());
    });
    seedSyntheticSource(db, tenantId);
    audit.write({ tenantId, userId, action: 'auth.setup', targetType: 'user', targetId: userId, ipHash });
    const session = sessions.create({ id: userId, tenant_id: tenantId });
    sendJson(res, 201, { ok: true, data: { csrfToken: session.csrf } }, { 'Set-Cookie': session.cookie });
  });

  router.on('POST', '/api/auth/login', async ({ req, res, ip, ipHash }) => {
    const body = validate({ email: { type: 'string', required: true, max: 254 }, password: { type: 'string', required: true, trim: false, max: 200 } }, await readJson(req));
    const key = `${ip}|${body.email.toLowerCase()}`;
    const limit = s.limits.login.take(key);
    if (!limit.allowed) throw new HttpError(429, 'too_many_attempts', `Too many sign-in attempts. Try again in ${Math.ceil(limit.retryAfter / 60)} minutes.`);
    const u = db.get('SELECT * FROM users WHERE email = ?', body.email.toLowerCase());
    const locked = u?.locked_until && u.locked_until > nowIso();
    const valid = verifyPassword(body.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !valid || u.disabled || locked) {
      if (u && !valid) {
        const fails = u.failed_logins + 1;
        db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', fails, fails >= 8 ? new Date(Date.now() + 15 * 60_000).toISOString() : u.locked_until, u.id);
      }
      audit.write({ tenantId: u?.tenant_id, userId: u?.id, action: 'auth.login_failed', outcome: 'failure', ipHash, details: { reason: !u ? 'unknown_email' : locked ? 'locked' : u.disabled ? 'disabled' : 'bad_password' } });
      throw new HttpError(401, 'invalid_credentials', locked ? 'This account is temporarily locked after repeated failed sign-ins. Try again in 15 minutes.' : 'That email and password don’t match an active account.');
    }
    s.limits.login.reset(key);
    db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', nowIso(), u.id);
    const session = sessions.create(u);
    audit.write({ tenantId: u.tenant_id, userId: u.id, action: 'auth.login', ipHash });
    sendJson(res, 200, { ok: true, data: { csrfToken: session.csrf, user: { id: u.id, name: u.name, email: u.email, role: u.role, permissions: ROLE_PERMISSIONS[u.role] } } }, { 'Set-Cookie': session.cookie });
  });

  router.on('POST', '/api/auth/logout', ({ res, user, ipHash }) => {
    if (user) { sessions.destroy(user.sessionHash); audit.write({ tenantId: user.tenantId, userId: user.id, action: 'auth.logout', ipHash }); }
    sendJson(res, 200, { ok: true, data: {} }, { 'Set-Cookie': sessions.clearCookie() });
  });

  router.on('GET', '/api/system/status', ({ res, user }) => {
    requirePermission(user, 'sources.read');
    const has = (m) => { try { return fs.existsSync(path.join(ROOT, 'node_modules', m)); } catch { return false; } };
    ok(res, {
      ai: { configured: Boolean(s.ai), provider: s.ai?.name ?? null, model: s.ai?.model ?? null },
      embeddings: { configured: Boolean(s.embedder), provider: s.embedder?.provider ?? null, model: s.embedder?.model ?? null, error: s.embedderError },
      gmail: { configured: s.gmail.configured, redirectUri: config.google.redirectUri },
      encryption: { configured: Boolean(s.vault), source: config.encryptionKey ? 'environment' : s.vault ? 'development key file' : 'missing' },
      ocr: { enabled: config.ocr.enabled, installed: has('tesseract.js') },
      drivers: { postgres: has('pg'), mysql: has('mysql2'), sqlite: true },
      limits: { uploadMaxBytes: config.uploads.maxBytes },
      roles: ROLES.map(r => ({ id: r, permissions: ROLE_PERMISSIONS[r] })),
      canManageSettings: can(user, 'settings.manage')
    });
  });
}

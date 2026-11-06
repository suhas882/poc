// @ts-check
/**
 * QR-assisted connections for Gmail, Google Drive, Outlook mail, OneDrive, SharePoint and Microsoft Teams.
 *
 * Why QR-assisted OAuth and not a device-code flow: Google's device flow does not allow the Gmail or Drive read
 * scopes, and Microsoft's device-code flow is a common phishing route that many organizations block with Conditional
 * Access. So the phone runs the same OAuth 2.0 authorization-code flow with PKCE that the computer would, against the
 * same registered redirect URI. Nothing new needs to be registered with Google or Microsoft.
 *
 * Flow and safeguards:
 *  1. The signed-in person picks an app on the computer: POST /api/connections/qr/start. The attempt is bound to that
 *     user and to that browser session, gets a 256-bit random reference (only its hash is stored), a two-digit match
 *     number, and 3 minutes to be opened.
 *  2. The QR code holds only https://<site>/qr/<reference>. No token, code, password or secret.
 *  3. The phone shows which website account and organization the connection is for and the match number, and asks
 *     the person to continue only if the same number is on their computer. Opening the link (GET) changes nothing,
 *     so link previews cannot use it up; the "Continue" button (POST, same origin) claims the attempt exactly once.
 *  4. The phone goes to Google's or Microsoft's own consent page. The OAuth state (stored server-side with the PKCE
 *     verifier) carries the attempt id, and the attempt records the state's hash.
 *  5. The provider's callback is accepted for this attempt only if the state matches the attempt, the attempt is
 *     still being authorized (not cancelled or expired), and the code exchange succeeds and the needed scope was
 *     granted. Only then is the source created for the attempt's user and the attempt marked connected. A scan is
 *     never treated as success.
 *  6. The computer polls GET /api/connections/qr/status/:id (same user and session only) and updates the page.
 * Tokens stay encrypted on the server exactly as for a normal connection; the phone gets no session on this site.
 */
import crypto from 'node:crypto';
import { HttpError, ok, readJson, SECURITY_HEADERS, validate } from '../http.mjs';
import { can, requirePermission } from '../auth.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { randomToken, RateLimiter, sha256 } from '../security.mjs';
import { parseSiteUrl } from '../connectors/microsoft.mjs';
import { afterConnect } from './sources.mjs';

export const QR_APPS = Object.freeze({
  gmail: { provider: 'google', name: 'Gmail' },
  gdrive: { provider: 'google', name: 'Google Drive' },
  outlook: { provider: 'microsoft', name: 'Outlook mail' },
  onedrive: { provider: 'microsoft', name: 'OneDrive' },
  sharepoint: { provider: 'microsoft', name: 'SharePoint' },
  teams: { provider: 'microsoft', name: 'Microsoft Teams' }
});
const PROVIDER_NAME = { google: 'Google', microsoft: 'Microsoft' };
export const QR_SCAN_TTL_MS = 3 * 60_000;      // to open the code on the phone
const AUTHORIZE_TTL_MS = 10 * 60_000;           // to finish the provider's sign-in after that (the OAuth state's lifetime)
const MAX_OPEN_PER_USER = 5;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}` : ''; };

/**
 * A small self-contained page for the phone, in the site's style. No scripts, so it works under the site's CSP.
 * `formTargets`: extra origins a form on this page may end up at. Browsers apply form-action to the redirect after
 * a form post too, so the "Continue" button needs the provider's sign-in origin (and only that one) allowed.
 */
function page(res, status, title, body, formTargets = []) {
  const headers = { ...SECURITY_HEADERS };
  if (formTargets.length) headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace("form-action 'self'", `form-action 'self' ${formTargets.join(' ')}`);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/styles.css"></head>
<body class="qr-page"><main class="card qr-phone-card">${body}</main></body></html>`);
}
const message = (res, status, title, text, kind = 'error') => page(res, status, title,
  `<h1>${esc(title)}</h1><div class="alert alert-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><p>${esc(text)}</p></div><p class="hint">You can close this page.</p>`);

/** @param {import('../http.mjs').Router} router */
export function registerQrConnectRoutes(router, s) {
  const { db, audit } = s;
  const startLimit = new RateLimiter(20, 10 * 60_000);

  const userById = (id) => {
    const u = db.get('SELECT id, tenant_id, email, name, role, disabled FROM users WHERE id = ?', id);
    return u && !u.disabled ? { id: u.id, tenantId: u.tenant_id, email: u.email, name: u.name, role: u.role } : null;
  };
  /** Expire what has run out of time. Pending: not opened in time. Authorizing: the OAuth state ran out. */
  const expireOld = () => {
    const now = nowIso();
    const stale = db.all(`SELECT id, state_hash FROM qr_connect_attempts WHERE (status = 'pending' AND expires_at < ?) OR (status = 'authorizing' AND opened_at < ?)`,
      now, new Date(Date.now() - AUTHORIZE_TTL_MS).toISOString());
    for (const a of stale) {
      db.run("UPDATE qr_connect_attempts SET status = 'expired', finished_at = ? WHERE id = ? AND status IN ('pending', 'authorizing')", now, a.id);
      if (a.state_hash) db.run('DELETE FROM oauth_states WHERE state_hash = ?', a.state_hash);
    }
    db.run('DELETE FROM qr_connect_attempts WHERE created_at < ?', new Date(Date.now() - 7 * 86400_000).toISOString());
  };
  const connectorFor = (app) => QR_APPS[app].provider === 'google' ? s.gmail : s.microsoft;
  const ownAttempt = (user, id) => {
    const a = db.get('SELECT * FROM qr_connect_attempts WHERE id = ? AND user_id = ? AND session_hash = ?', String(id), user.id, user.sessionHash);
    if (!a) throw new HttpError(404, 'not_found', 'That QR connection does not exist, or it was started in another browser.');
    return a;
  };
  const view = (a) => ({
    attemptId: a.id, app: a.app, appName: QR_APPS[a.app]?.name ?? a.app, provider: QR_APPS[a.app]?.provider ?? null, status: a.status, matchCode: a.match_code,
    expiresAt: a.expires_at, openedAt: a.opened_at, finishedAt: a.finished_at, account: a.account, sourceId: a.source_id, error: a.error
  });

  /* ---------------- the computer (signed in) ---------------- */

  router.on('POST', '/api/connections/qr/start', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'sources.manage');
    s.realGate(user);
    const body = validate({
      app: { type: 'string', values: Object.keys(QR_APPS), required: true },
      visibility: { type: 'string', values: ['org', 'owner', 'roles'], default: 'owner' },
      shareWithRoles: { type: 'array', items: { type: 'string', max: 40 }, max: 4, default: [] },
      siteUrl: { type: 'string', max: 500, default: '' },
      query: { type: 'string', max: 500, default: s.config.gmail.defaultQuery }
    }, await readJson(req));
    const limit = startLimit.take(`u:${user.id}`);
    if (!limit.allowed) throw new HttpError(429, 'rate_limited', 'Too many QR codes in a short time. Wait a few minutes.', { retryAfter: limit.retryAfter });
    // Fail now, on the computer, if the server cannot finish this connection (not configured, no encryption key, bad site).
    connectorFor(body.app).assertReady();
    if (body.app === 'sharepoint') parseSiteUrl(body.siteUrl);
    expireOld();
    if (db.get("SELECT COUNT(*) AS n FROM qr_connect_attempts WHERE user_id = ? AND status IN ('pending', 'authorizing')", user.id).n >= MAX_OPEN_PER_USER) {
      throw new HttpError(429, 'too_many_attempts', 'You have several QR connections open. Finish or cancel one first.');
    }
    const ref = randomToken(32);
    const id = crypto.randomUUID();
    const matchCode = String(crypto.randomInt(10, 100));
    const expiresAt = new Date(Date.now() + QR_SCAN_TTL_MS).toISOString();
    const options = body.app === 'gmail' ? { visibility: body.visibility, shareWithRoles: body.shareWithRoles, query: body.query }
      : body.app === 'sharepoint' ? { visibility: body.visibility, shareWithRoles: body.shareWithRoles, siteUrl: body.siteUrl }
      : { visibility: body.visibility, shareWithRoles: body.shareWithRoles };
    db.run(`INSERT INTO qr_connect_attempts (id, ref_hash, tenant_id, user_id, session_hash, app, options, match_code, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, sha256(ref), user.tenantId, user.id, user.sessionHash, body.app, JSON.stringify(options), matchCode, nowIso(), expiresAt);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'qr_connect.started', targetType: 'connector', targetId: body.app, ipHash, details: { attemptId: id } });
    ok(res, { ...view(db.get('SELECT * FROM qr_connect_attempts WHERE id = ?', id)), qrPath: `/qr/${ref}` }, undefined, 201);
  });

  router.on('GET', '/api/connections/qr/status/:id', ({ res, user, params }) => {
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    expireOld();
    ok(res, view(ownAttempt(user, params.id)));
  });

  router.on('POST', '/api/connections/qr/cancel', async ({ req, res, user, ipHash }) => {
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    const body = validate({ attemptId: { type: 'string', required: true, max: 60 } }, await readJson(req));
    const a = ownAttempt(user, body.attemptId);
    if (db.run("UPDATE qr_connect_attempts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('pending', 'authorizing')", nowIso(), a.id).changes) {
      // The provider's callback for this attempt can no longer succeed.
      if (a.state_hash) db.run('DELETE FROM oauth_states WHERE state_hash = ?', a.state_hash);
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'qr_connect.cancelled', targetType: 'connector', targetId: a.app, ipHash, details: { attemptId: a.id } });
    }
    ok(res, view(db.get('SELECT * FROM qr_connect_attempts WHERE id = ?', a.id)));
  });

  /* ---------------- the phone (no session on this site) ---------------- */

  const openLimit = new RateLimiter(60, 60_000);
  /** The provider's sign-in origin, from configuration (https://accounts.google.com, https://login.microsoftonline.com). */
  const signInOrigin = (provider) => new URL(provider === 'google' ? s.config.google.authUrl : s.config.microsoft.authBase).origin;
  const attemptByRef = (ref) => /^[A-Za-z0-9_-]{30,80}$/.test(ref) ? db.get('SELECT * FROM qr_connect_attempts WHERE ref_hash = ?', sha256(ref)) : null;
  const notUsable = (res, a) => {
    if (!a) return message(res, 404, 'QR code not recognized', 'This QR code is not valid. Start “Connect via QR” again on your computer.');
    const why = { connected: 'This QR code was already used, and the connection is complete.', cancelled: 'This connection was cancelled on the computer.',
      expired: 'This QR code has expired. Start “Connect via QR” again on your computer.', authorizing: 'This QR code was already used. Each code works only once.',
      failed: 'This connection attempt ended. Start “Connect via QR” again on your computer.' }[a.status];
    return message(res, 410, 'QR code no longer valid', why || 'This QR code can no longer be used.');
  };

  router.on('GET', '/qr/:ref', ({ res, params, ip }) => {
    if (!openLimit.take(`ip:${ip}`).allowed) return message(res, 429, 'Too many requests', 'Wait a minute and try again.');
    expireOld();
    const a = attemptByRef(params.ref);
    if (!a || a.status !== 'pending') return notUsable(res, a);
    const owner = userById(a.user_id);
    if (!owner) return message(res, 403, 'Not available', 'The account that made this QR code can no longer connect sources.');
    const org = db.get('SELECT name FROM tenants WHERE id = ?', a.tenant_id)?.name ?? '';
    const app = QR_APPS[a.app];
    const provider = PROVIDER_NAME[app.provider];
    const action = `/qr/${esc(params.ref)}`;
    page(res, 200, `Connect ${app.name}`, `
  <p class="micro">Public Records AI Search</p>
  <h1>Connect ${esc(app.name)}</h1>
  <p>You are about to connect your ${esc(app.name)} account to this website, for:</p>
  <dl class="meta-list"><dt>Website account</dt><dd>${esc(owner.name)} (${esc(maskEmail(owner.email))})</dd><dt>Organization</dt><dd>${esc(org)}</dd></dl>
  <div class="qr-match"><span class="helper">Number on your computer</span><b>${esc(a.match_code)}</b></div>
  <div class="alert alert-warn" role="note"><p><b>Continue only if your computer shows the number ${esc(a.match_code)}</b> and you started this yourself. If someone sent you this code, cancel.</p></div>
  <ul>
    <li>${esc(provider)} will ask you to sign in and to allow read-only access. This website never sees your password.</li>
    <li>Nothing is connected until you approve on ${esc(provider)}’s page.</li>
  </ul>
  <form method="post" action="${action}/continue"><button class="button primary" type="submit">Continue to ${esc(provider)}</button></form>
  <form method="post" action="${action}/cancel"><button class="button secondary" type="submit">Cancel</button></form>`, [signInOrigin(app.provider)]);
  });

  /** Same-origin check for the phone's form posts. The unguessable reference in the path is the other half. */
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return true; // some browsers omit it on top-level form posts
    try { return new URL(origin).host === req.headers.host || new URL(origin).origin === new URL(s.config.publicUrl).origin; } catch { return false; }
  };

  router.on('POST', '/qr/:ref/continue', async ({ req, res, params, ip, ipHash }) => {
    if (!openLimit.take(`ip:${ip}`).allowed) return message(res, 429, 'Too many requests', 'Wait a minute and try again.');
    if (!sameOrigin(req)) return message(res, 403, 'Not allowed', 'This request did not come from this website.');
    expireOld();
    const a = attemptByRef(params.ref);
    // Claim the attempt exactly once; a second tap, a replay or an expired code stops here.
    if (!a || db.run("UPDATE qr_connect_attempts SET status = 'authorizing', opened_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?", nowIso(), a.id, nowIso()).changes !== 1) {
      return notUsable(res, a && db.get('SELECT * FROM qr_connect_attempts WHERE id = ?', a.id));
    }
    const fail = (msg) => {
      db.run("UPDATE qr_connect_attempts SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'authorizing'", msg, nowIso(), a.id);
      return message(res, 400, 'Could not continue', msg);
    };
    const owner = userById(a.user_id);
    if (!owner || !can(owner, 'sources.manage')) return fail('The account that made this QR code can no longer connect sources.');
    try {
      s.realGate(owner);
      const result = connectorFor(a.app).authorize(owner, { kind: a.app, ...parseJson(a.options, {}), qrAttemptId: a.id });
      db.run('UPDATE qr_connect_attempts SET state_hash = ? WHERE id = ?', result.stateHash, a.id);
      audit.write({ tenantId: a.tenant_id, userId: a.user_id, action: 'qr_connect.opened', targetType: 'connector', targetId: a.app, ipHash, details: { attemptId: a.id, scopes: result.scopes } });
      res.writeHead(303, { Location: result.url, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end();
    } catch (err) {
      if (!(err instanceof HttpError)) s.log('[qr-connect] continue failed:', err);
      return fail(err instanceof HttpError ? err.message : 'The connection could not be started. Try again on your computer.');
    }
  });

  router.on('POST', '/qr/:ref/cancel', ({ req, res, params, ipHash }) => {
    if (!sameOrigin(req)) return message(res, 403, 'Not allowed', 'This request did not come from this website.');
    const a = attemptByRef(params.ref);
    if (a && db.run("UPDATE qr_connect_attempts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'pending'", nowIso(), a.id).changes) {
      audit.write({ tenantId: a.tenant_id, userId: a.user_id, action: 'qr_connect.cancelled', targetType: 'connector', targetId: a.app, ipHash, details: { attemptId: a.id, from: 'phone' } });
    }
    return message(res, 200, 'Cancelled', 'Nothing was connected. You can close this page.', 'info');
  });

  /* ---------------- the provider's callback, when it belongs to a QR attempt ---------------- */

  /**
   * Called by the existing OAuth callback routes before they look for a signed-in user. Returns false when the state
   * is not from a QR attempt (the normal flow then continues unchanged); otherwise answers the phone itself.
   */
  s.qrConnect = {
    async handleCallback(provider, { res, url, ipHash }) {
      const state = String(url.searchParams.get('state') || '');
      if (!state) return false;
      const st = db.get('SELECT options FROM oauth_states WHERE state_hash = ?', sha256(state));
      const attemptId = st ? parseJson(st.options, {}).qrAttemptId : null;
      const a = attemptId
        ? db.get('SELECT * FROM qr_connect_attempts WHERE id = ?', attemptId)
        : db.get('SELECT * FROM qr_connect_attempts WHERE state_hash = ?', sha256(state)); // a cancelled/expired attempt whose state was removed
      if (!a) return false;
      if (QR_APPS[a.app]?.provider !== provider) { message(res, 400, 'Could not connect', 'This sign-in response does not match the QR connection.'); return true; }
      if (a.state_hash !== sha256(state) || a.status !== 'authorizing') {
        if (st) db.run('DELETE FROM oauth_states WHERE state_hash = ?', sha256(state));
        notUsable(res, a);
        return true;
      }
      const params = Object.fromEntries(url.searchParams);
      const finish = (status, fields) => db.run(`UPDATE qr_connect_attempts SET status = ?, account = ?, source_id = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'authorizing'`,
        status, fields.account ?? null, fields.sourceId ?? null, fields.error ?? null, nowIso(), a.id).changes === 1;
      const owner = userById(a.user_id);
      try {
        if (!owner) throw new HttpError(403, 'user_disabled', 'The website account that started this connection is no longer active.');
        requirePermission(owner, 'sources.manage');
        s.realGate(owner);
        // The connector re-checks the state (single use, expiry, same user and organization), exchanges the code with
        // the PKCE verifier and checks the granted scope. Only then does a source exist.
        const result = await connectorFor(a.app).handleCallback(owner, params);
        const row = db.get('SELECT * FROM sources WHERE id = ?', result.sourceId);
        if (!finish('connected', { account: result.email ?? row?.account_label ?? null, sourceId: result.sourceId })) {
          // Cancelled on the computer while the provider page was open: keep nothing.
          message(res, 409, 'Cancelled', 'This connection was cancelled on the computer, so it was not completed.');
          return true;
        }
        audit.write({ tenantId: owner.tenantId, userId: owner.id, action: 'source.connected', targetType: 'source', targetId: result.sourceId, ipHash, details: { type: a.app, via: 'qr', attemptId: a.id, reconnected: result.reconnected } });
        afterConnect(s, row, owner, result.reconnected ? 'reconnect' : 'initial', ipHash);
        page(res, 200, 'Connected', `<h1>${esc(QR_APPS[a.app].name)} is connected</h1>
  <div class="alert alert-ok" role="status"><p>Connected${result.email ? ` as ${esc(result.email)}` : ''}. Your computer shows it now.</p></div>
  <p class="hint">You can close this page. This phone is not signed in to the website.</p>`);
      } catch (err) {
        const msg = err instanceof HttpError ? err.message : 'Connecting failed. Try again on your computer.';
        if (!(err instanceof HttpError)) s.log('[qr-connect] callback failed:', err);
        finish('failed', { error: msg });
        audit.write({ tenantId: a.tenant_id, userId: a.user_id, action: 'source.connected', targetType: 'connector', targetId: a.app, outcome: 'failure', ipHash, details: { via: 'qr', attemptId: a.id, code: err instanceof HttpError ? err.code : 'error' } });
        message(res, 400, 'Not connected', msg);
      }
      return true;
    }
  };
}

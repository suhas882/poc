// @ts-check
/**
 * Sign in with Google or Microsoft (OpenID Connect, authorization code with PKCE and a nonce).
 *
 * Only for people a Supervisor has already added: the provider's verified email must match an active user, and
 * the first sign-in links the provider's stable account ID to that user. No account is ever created here, and no
 * provider password is seen. Sign-in asks only for identity (openid, email, profile); reading mail or files is a
 * separate, per-source consent on Connected Sources.
 *
 * The one-time state, PKCE verifier and nonce travel in a short-lived encrypted cookie, so sign-in reuses the
 * redirect addresses already registered for the connectors without being confused with them.
 * The tokens from sign-in are used once to read the identity and then dropped; they are never stored.
 */
import crypto from 'node:crypto';
import { HttpError, parseCookies, serializeCookie } from './http.mjs';
import { nowIso } from './db.mjs';
import { randomToken } from './security.mjs';
import { explainOAuthError } from './connectors/registry.mjs';

export const SIGNIN_COOKIE = 'prs_signin';
export const REQUEST_COOKIE = 'prs_access_request';
const REQUEST_TTL_S = 30 * 60;
const TTL_S = 600;
/** Microsoft's tenant ID for personal accounts (Outlook.com, Hotmail, Live). */
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** Read a JWT's claims. The token comes straight from the provider's token endpoint over TLS (OIDC Core 3.1.3.7). */
function claims(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

export class SignIn {
  /** @param {{db: import('./db.mjs').Database, config: import('./config.mjs').AppConfig, vault: import('./security.mjs').Vault | null, fetch?: typeof fetch}} deps */
  constructor({ db, config, vault, fetch: f }) {
    this.db = db;
    this.config = config;
    this.vault = vault;
    this.fetch = f ?? fetch;
  }

  /** Which buttons the sign-in page shows. Never on the Tier 0 demo server, which has no real accounts. */
  available() {
    const on = this.config.realSources && Boolean(this.vault);
    return {
      google: on && Boolean(this.config.google.clientId && this.config.google.clientSecret),
      microsoft: on && Boolean(this.config.microsoft.clientId && this.config.microsoft.clientSecret)
    };
  }

  /** @param {'google' | 'microsoft'} provider @param {string} next where to go afterwards (a path on this site) */
  start(provider, next) {
    if (!this.available()[provider]) throw new HttpError(404, 'signin_unavailable', `Signing in with ${provider === 'google' ? 'Google' : 'Microsoft'} is not set up on this server.`);
    const vault = /** @type {import('./security.mjs').Vault} */ (this.vault);
    const state = randomToken(24), verifier = randomToken(48), nonce = randomToken(24);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const safeNext = /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : '/';
    const cookie = serializeCookie(SIGNIN_COOKIE, vault.seal({ provider, state, verifier, nonce, next: safeNext, exp: Date.now() + TTL_S * 1000 }),
      { path: '/oauth/', secure: this.config.secureCookies, maxAge: TTL_S, sameSite: 'Lax' });
    let url;
    if (provider === 'google') {
      const g = this.config.google;
      url = new URL(g.authUrl);
      url.search = new URLSearchParams({ client_id: g.clientId, redirect_uri: g.redirectUri, response_type: 'code', scope: 'openid email profile',
        access_type: 'online', prompt: 'select_account', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    } else {
      const m = this.config.microsoft;
      url = new URL(`${m.authBase}/${m.tenant}/oauth2/v2.0/authorize`);
      // User.Read lets the work-account sign-in read the user principal name from Microsoft Graph (see finish()).
      url.search = new URLSearchParams({ client_id: m.clientId, redirect_uri: m.redirectUri, response_type: 'code', response_mode: 'query',
        scope: 'openid email profile User.Read', prompt: 'select_account', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    }
    return { url: url.toString(), cookie };
  }

  /**
   * Link another provider's account to the person who is already signed in (for example Microsoft after Google).
   * Bound to this exact session: the callback must arrive in the same session, so a link cannot be planted by
   * someone else, replayed, or completed in another browser. The provider account is linked because the person
   * authenticated as it, never because an email address matches.
   * @param {'google' | 'microsoft'} provider @param {{id: string, sessionHash: string}} user
   */
  startLink(provider, user) {
    const { url, cookie } = this.start(provider, '/sources.html');
    const vault = /** @type {import('./security.mjs').Vault} */ (this.vault);
    const raw = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
    const c = { ...vault.open(raw), mode: 'link', userId: user.id, sessionHash: user.sessionHash };
    return { url, cookie: serializeCookie(SIGNIN_COOKIE, vault.seal(c), { path: '/oauth/', secure: this.config.secureCookies, maxAge: TTL_S, sameSite: 'Lax' }) };
  }

  /**
   * Finish a link started by startLink(). Throws when the session changed, the identity is invalid, or the provider
   * account already belongs to someone else.
   * @returns {Promise<{provider: string, subject: string, email: string, alreadyLinked: boolean}>}
   */
  async finishLink(provider, pending, query, user) {
    if (!user || user.id !== pending.userId || user.sessionHash !== pending.sessionHash) {
      throw new HttpError(403, 'link_session_mismatch', 'This link was started in a different session. Sign in and start linking again.');
    }
    if (pending.exp < Date.now()) throw new HttpError(400, 'signin_expired', 'Linking took too long. Start again.');
    if (query.error) throw new HttpError(400, 'link_declined', query.error === 'access_denied' && !/AADSTS/.test(String(query.error_description || '')) ? 'Linking was cancelled; nothing was changed.' : explainOAuthError(provider, String(query.error), String(query.error_description || '')));
    if (!query.code) throw new HttpError(400, 'invalid_callback', 'The response is incomplete. Start linking again.');
    const identity = provider === 'google' ? await this.google(String(query.code), pending) : await this.microsoft(String(query.code), pending);
    const owner = this.db.get('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?', provider, identity.subject);
    if (owner && owner.user_id !== user.id) throw new HttpError(409, 'identity_in_use', `This ${provider === 'google' ? 'Google' : 'Microsoft'} account (${identity.email}) is already linked to another user here. Nothing was changed.`);
    if (owner) this.db.run('UPDATE user_identities SET last_used_at = ?, email = ? WHERE provider = ? AND subject = ?', nowIso(), identity.email, provider, identity.subject);
    else this.db.run('INSERT INTO user_identities (provider, subject, user_id, email, last_used_at) VALUES (?, ?, ?, ?, ?)', provider, identity.subject, user.id, identity.email, nowIso());
    return { ...identity, alreadyLinked: Boolean(owner) };
  }

  /** The provider accounts linked to a user (for showing them; subjects stay on the server). */
  identities(userId) {
    return this.db.all('SELECT provider, email, created_at AS linkedAt, last_used_at AS lastUsedAt FROM user_identities WHERE user_id = ? ORDER BY provider', userId);
  }

  /** The decrypted sign-in cookie if this callback belongs to a sign-in (state matches), else null: it is a connector callback. */
  pending(req, provider, state) {
    const raw = parseCookies(req.headers.cookie || '')[SIGNIN_COOKIE];
    if (!raw || !this.vault || !state) return null;
    let c;
    try { c = this.vault.open(raw); } catch { return null; }
    return c && c.provider === provider && c.state === state ? c : null;
  }

  clearCookie() { return serializeCookie(SIGNIN_COOKIE, '', { path: '/oauth/', secure: this.config.secureCookies, maxAge: 0 }); }

  /**
   * After a verified sign-in with no matching account, the identity travels to the access-request page in this
   * short-lived encrypted cookie. The applicant can type an organization and a reason, never their identity.
   */
  requestCookie(identity) {
    const vault = /** @type {import('./security.mjs').Vault} */ (this.vault);
    const value = vault.seal({ provider: identity.provider, subject: identity.subject, email: identity.email, name: identity.name || identity.email, exp: Date.now() + REQUEST_TTL_S * 1000 });
    return serializeCookie(REQUEST_COOKIE, value, { path: '/api/access-requests', secure: this.config.secureCookies, maxAge: REQUEST_TTL_S, sameSite: 'Lax' });
  }

  /** The verified identity waiting to ask for access, or null. */
  requestIdentity(req) {
    const raw = parseCookies(req.headers.cookie || '')[REQUEST_COOKIE];
    if (!raw || !this.vault) return null;
    try { const c = this.vault.open(raw); return c && c.exp > Date.now() ? c : null; } catch { return null; }
  }

  /**
   * Exchange the code, read the verified identity and find the matching user.
   * @returns {Promise<{user: any, identity: {provider: string, subject: string, email: string}, next: string, linked: boolean}>}
   */
  async finish(provider, pending, { code, error, error_description: errorDescription }) {
    if (pending.exp < Date.now()) throw new HttpError(400, 'signin_expired', 'The sign-in took too long. Start again.');
    if (error) throw new HttpError(400, 'signin_declined', error === 'access_denied' && !/AADSTS/.test(String(errorDescription || '')) ? 'Sign-in was cancelled.' : explainOAuthError(provider, String(error), String(errorDescription || '')));
    if (!code) throw new HttpError(400, 'invalid_callback', 'The sign-in response is incomplete. Start again.');
    const identity = provider === 'google' ? await this.google(String(code), pending) : await this.microsoft(String(code), pending);

    // A known link wins; otherwise link to the active user with this verified email.
    const linked = this.db.get(`SELECT u.* FROM user_identities i JOIN users u ON u.id = i.user_id JOIN tenants t ON t.id = u.tenant_id
      WHERE i.provider = ? AND i.subject = ? AND t.is_demo = 0`, provider, identity.subject);
    const user = linked ?? this.db.get('SELECT u.* FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ? AND t.is_demo = 0', identity.email);
    // No account: the caller offers an access request for this verified identity. Nothing is created here.
    if (!user) throw new HttpError(403, 'no_account', `There is no account for ${identity.email} here. Ask a Supervisor to add you (Settings → Users), then sign in again.`, { email: identity.email, identity });
    if (user.disabled) throw new HttpError(403, 'account_disabled', 'This account is disabled. Ask a Supervisor.');
    // The email match is only for a person's first sign-in with this provider. Once one account of this provider is
    // linked, a different account that shows the same email is refused instead of being linked as a second key.
    if (!linked && this.db.get('SELECT 1 FROM user_identities WHERE user_id = ? AND provider = ?', user.id, provider)) {
      throw new HttpError(403, 'identity_mismatch', `This ${provider === 'google' ? 'Google' : 'Microsoft'} account is not the one linked to ${user.email}. Sign in with the linked account, or ask a Supervisor.`);
    }
    if (linked) this.db.run('UPDATE user_identities SET last_used_at = ?, email = ? WHERE provider = ? AND subject = ?', nowIso(), identity.email, provider, identity.subject);
    else this.db.run('INSERT INTO user_identities (provider, subject, user_id, email, last_used_at) VALUES (?, ?, ?, ?, ?)', provider, identity.subject, user.id, identity.email, nowIso());
    return { user, identity, next: pending.next, linked: !linked };
  }

  async tokens(url, params, label) {
    const res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.id_token) {
      const why = [json.error, json.error_description].filter(x => typeof x === 'string').join(': ').split(/\r?\n/)[0].slice(0, 200);
      throw new HttpError(502, 'signin_token_failed', `${label} did not accept the sign-in${why ? ` (${why})` : ''}. Start again.`);
    }
    return json;
  }

  async google(code, pending) {
    const g = this.config.google;
    const t = await this.tokens(g.tokenUrl, { code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: g.redirectUri, grant_type: 'authorization_code', code_verifier: pending.verifier }, 'Google');
    const c = claims(t.id_token);
    if (!c || !['https://accounts.google.com', 'accounts.google.com'].includes(c.iss) || c.aud !== g.clientId || c.nonce !== pending.nonce || Number(c.exp) * 1000 < Date.now()) {
      throw new HttpError(401, 'signin_invalid_token', 'Google’s sign-in answer could not be verified. Start again.');
    }
    if (c.email_verified !== true || !c.email) throw new HttpError(403, 'email_not_verified', 'This Google account has no verified email address.');
    return { provider: 'google', subject: String(c.sub), email: String(c.email).toLowerCase(), name: String(c.name || c.email).slice(0, 120) };
  }

  async microsoft(code, pending) {
    const m = this.config.microsoft;
    const t = await this.tokens(`${m.authBase}/${m.tenant}/oauth2/v2.0/token`, { code, client_id: m.clientId, client_secret: m.clientSecret, redirect_uri: m.redirectUri, grant_type: 'authorization_code', code_verifier: pending.verifier, scope: 'openid email profile User.Read' }, 'Microsoft');
    const c = claims(t.id_token);
    if (!c || !c.tid || c.iss !== `${m.authBase}/${c.tid}/v2.0` || c.aud !== m.clientId || c.nonce !== pending.nonce || Number(c.exp) * 1000 < Date.now()) {
      throw new HttpError(401, 'signin_invalid_token', 'Microsoft’s sign-in answer could not be verified. Start again.');
    }
    // Personal accounts: the address is the Microsoft account itself. Work accounts: the user principal name, which
    // must sit on a domain the organization verified, rather than the editable "mail" attribute.
    let email = '';
    if (c.tid === MSA_TENANT) email = String(c.email || c.preferred_username || '');
    else {
      const me = await this.fetch(`${m.graphBase}/me?$select=userPrincipalName`, { headers: { authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(20000) });
      email = me.ok ? String((await me.json()).userPrincipalName || '') : '';
    }
    if (!email.includes('@')) throw new HttpError(403, 'email_not_verified', 'This Microsoft account has no usable sign-in address.');
    return { provider: 'microsoft', subject: `${c.tid}:${c.oid || c.sub}`, email: email.toLowerCase(), name: String(c.name || email).slice(0, 120) };
  }
}

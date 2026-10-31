// @ts-check
/**
 * Demo mode keeps what people enter (search plans, review marks and notes, relevance labels, the activity log)
 * in SQLite, so it survives reloads, private windows and switching between localhost and 127.0.0.1.
 * Only synthetic demo data is stored here; real records never are.
 */
import crypto from 'node:crypto';
import { HttpError, ok, parseCookies, readJson } from '../http.mjs';
import { nowIso, parseJson } from '../db.mjs';

export const DEMO_KEYS = Object.freeze(['synthetic-search-events', 'synthetic-search-plan', 'synthetic-active-request-id', 'synthetic-demo-actor',
  'synthetic-review-marks', 'synthetic-review-notes', 'synthetic-label-votes']);
const MAX_VALUE = 1_000_000;
const DEVICE_COOKIE = 'prs_device';

/** @param {import('../http.mjs').Router} router */
export function registerDemoStateRoutes(router, s) {
  const { db, config } = s;
  const secure = config.publicUrl.startsWith('https://');

  /** Who this demo workspace belongs to; issues a device cookie for people who are not signed in. */
  function ownerOf(req, res, user) {
    let device = parseCookies(req.headers.cookie || '')[DEVICE_COOKIE];
    if (!device || !/^[a-f0-9]{32}$/.test(device)) {
      device = crypto.randomBytes(16).toString('hex');
      res.setHeader('Set-Cookie', `${DEVICE_COOKIE}=${device}; Path=/; Max-Age=${400 * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    }
    const deviceOwner = `device:${device}`;
    if (!user) return deviceOwner;
    const userOwner = `user:${user.id}`;
    // First time signed in on this browser: keep what was done here before signing in.
    if (!db.get('SELECT 1 FROM demo_state WHERE owner = ? LIMIT 1', userOwner)) {
      db.run('INSERT OR IGNORE INTO demo_state (owner, key, value, updated_at) SELECT ?, key, value, updated_at FROM demo_state WHERE owner = ?', userOwner, deviceOwner);
    }
    return userOwner;
  }

  /** Anonymous writes have no session token, so require a same-site custom header (cross-site forms cannot send it). */
  function guardWrite(req, user) {
    if (user) return; // the CSRF token check already ran for signed-in users
    if (req.headers['x-requested-with'] !== 'prs') throw new HttpError(403, 'bad_request_origin', 'This request was blocked.');
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}` && origin !== new URL(config.publicUrl).origin) {
      throw new HttpError(403, 'bad_origin', 'This request came from another site and was blocked.');
    }
  }

  const checkKey = (key) => { if (!DEMO_KEYS.includes(key)) throw new HttpError(404, 'unknown_key', 'That demo setting does not exist.'); };

  router.on('GET', '/api/demo-state', ({ req, res, user }) => {
    const owner = ownerOf(req, res, user);
    const out = {};
    for (const r of db.all('SELECT key, value, updated_at FROM demo_state WHERE owner = ?', owner)) out[r.key] = { value: parseJson(r.value, null), updatedAt: r.updated_at };
    ok(res, out);
  });

  router.on('PUT', '/api/demo-state/:key', async ({ req, res, user, params }) => {
    guardWrite(req, user);
    checkKey(params.key);
    const body = await readJson(req);
    if (!body || !('value' in body)) throw new HttpError(400, 'missing_value', 'Send { "value": ... }.');
    const text = JSON.stringify(body.value);
    if (text.length > MAX_VALUE) throw new HttpError(413, 'too_large', 'This demo data is too large to save.');
    const owner = ownerOf(req, res, user);
    db.run(`INSERT INTO demo_state (owner, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, owner, params.key, text, nowIso());
    ok(res, { saved: true });
  });

  router.on('DELETE', '/api/demo-state/:key', ({ req, res, user, params }) => {
    guardWrite(req, user);
    checkKey(params.key);
    db.run('DELETE FROM demo_state WHERE owner = ? AND key = ?', ownerOf(req, res, user), params.key);
    ok(res, { deleted: true });
  });
}
